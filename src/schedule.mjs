// CRUD bảng lịch + nhặt dòng đến hạn.
//
// Mọi hàm nhận `sql` làm tham số đầu thay vì tự gọi getSql(), để test truyền
// vào client trỏ database riêng mà không phải đụng biến môi trường.
const COLS = ["name", "run_at", "storyboard", "note", "enabled",
              "status", "attempts", "job_id", "video_link", "last_error"];

/** Trạng thái "đang bay" — đã rời pending nhưng chưa tới đích. */
const IN_FLIGHT = ["claimed", "queued", "running"];

export async function listRows(sql) {
  return sql`SELECT * FROM schedule ORDER BY run_at ASC, id ASC`;
}

export async function getRow(sql, id) {
  const [row] = await sql`SELECT * FROM schedule WHERE id = ${id}`;
  return row || null;
}

export async function createRow(sql, { name, runAt, storyboard, note = "", enabled = true }) {
  const [row] = await sql`
    INSERT INTO schedule (name, run_at, storyboard, note, enabled)
    VALUES (${name}, ${runAt}, ${storyboard}, ${note}, ${enabled})
    RETURNING *`;
  return row;
}

export async function updateRow(sql, id, patch) {
  const allowed = { name: patch.name, run_at: patch.runAt, storyboard: patch.storyboard, note: patch.note };
  const set = Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined));
  if (Object.keys(set).length === 0) return getRow(sql, id);

  const [row] = await sql`
    UPDATE schedule SET ${sql(set)}, updated_at = now() WHERE id = ${id} RETURNING *`;
  return row || null;
}

export async function setEnabled(sql, id, enabled) {
  const [row] = await sql`
    UPDATE schedule SET enabled = ${enabled}, updated_at = now() WHERE id = ${id} RETURNING *`;
  return row || null;
}

export async function deleteRow(sql, id) {
  const rows = await sql`DELETE FROM schedule WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function markRow(sql, id, patch) {
  // Key lạ phải nổ ngay, không được âm thầm rơi mất — im lặng ở đây là dữ
  // liệu (job_id, video_link, ...) tưởng đã lưu mà thật ra chưa bao giờ vào DB.
  const unknown = Object.keys(patch).filter((k) => !COLS.includes(k));
  if (unknown.length) throw new Error(`markRow: cột không hợp lệ: ${unknown.join(", ")}`);

  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (Object.keys(set).length === 0) return getRow(sql, id);

  const [row] = await sql`
    UPDATE schedule SET ${sql(set)}, updated_at = now() WHERE id = ${id} RETURNING *`;
  return row || null;
}

/**
 * Nhặt MỘT dòng đến hạn, nguyên tử.
 *
 * FOR UPDATE SKIP LOCKED là mấu chốt: kể cả hai tick chạy chồng lên nhau, hay
 * sau này chạy nhiều instance server, một dòng lịch không bao giờ bị dựng
 * thành hai video. Đây là lý do kỹ thuật để chọn PostgreSQL, không chỉ vì
 * server đã có sẵn nó.
 */
export async function claimDue(sql) {
  const [row] = await sql`
    UPDATE schedule
       SET status = 'claimed', claimed_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM schedule
        WHERE enabled AND status = 'pending' AND run_at <= now()
        ORDER BY run_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING *`;
  return row || null;
}

/**
 * Nhặt MỘT dòng theo id, nguyên tử — dùng cho nút "Chạy ngay".
 *
 * claimDue nhặt theo giờ hẹn; hàm này nhặt theo id nhưng vẫn giữ nguyên tính
 * nguyên tử. Nếu không có nó, đường chạy tay đi vòng qua FOR UPDATE SKIP LOCKED
 * và hai request đồng thời sẽ dựng hai video từ một dòng lịch.
 *
 * Trả null khi dòng không tồn tại HOẶC đang ở trạng thái không cho chạy lại.
 */
export async function claimById(sql, id) {
  const [row] = await sql`
    UPDATE schedule
       SET status = 'claimed', claimed_at = now(), updated_at = now()
     WHERE id = ${id}
       AND status IN ('pending', 'failed', 'missed', 'done')
     RETURNING *`;
  return row || null;
}

/**
 * Server chết đúng khoảnh khắc giữa claim và enqueue thì dòng kẹt ở 'claimed'.
 * Quá staleMs thì trả về pending để tick sau nhặt lại.
 *
 * `claimed_at IS NULL` cũng phải được cứu: markRow có thể tạo ra một dòng
 * status='claimed' mà claimed_at chưa bao giờ được set (COLS không có cột
 * này), và `NULL < now() - interval` luôn cho NULL nên WHERE thường sẽ âm
 * thầm bỏ qua dòng đó mãi mãi nếu không xử lý riêng.
 *
 * staleMs được ép về tối thiểu 1 giây (Math.max) để staleMs <= 0 hay NaN
 * không biến thành `claimed_at < now()` — tức reset luôn cả dòng vừa claim
 * xong, đúng thứ tính năng này sinh ra để ngăn.
 */
export async function reclaimStale(sql, staleMs) {
  const seconds = Math.max(1, Math.round(staleMs / 1000) || 1);
  const rows = await sql`
    UPDATE schedule
       SET status = 'pending', claimed_at = NULL, updated_at = now()
     WHERE status = 'claimed'
       AND (claimed_at IS NULL
            OR claimed_at < now() - ${`${seconds} seconds`}::interval)
     RETURNING id`;
  return rows.length;
}

export async function rowsInFlight(sql) {
  return sql`SELECT * FROM schedule WHERE status IN ${sql(IN_FLIGHT)} ORDER BY run_at ASC`;
}

export async function resetToPending(sql, id) {
  const [row] = await sql`
    UPDATE schedule
       SET status = 'pending', claimed_at = NULL, job_id = NULL, updated_at = now()
     WHERE id = ${id}
     RETURNING *`;
  return row || null;
}

/**
 * Xếp lại lịch cho một lần thử nữa: về pending, dời run_at tới mốc chờ, tăng
 * attempts. Gộp thành một câu lệnh để không có khoảnh khắc nào dòng ở trạng
 * thái nửa vời mà tick khác nhặt mất.
 */
export async function scheduleRetry(sql, id, { attempts, runAt, lastError }) {
  // postgres.js ném UNDEFINED_VALUE nếu nội suy giá trị undefined — đúng vào
  // nhánh retry, tức đúng lúc hệ thống đã hỏng sẵn. ?? null giữ NULL hợp lệ
  // trong SQL mà không nổ khi người gọi quên truyền lastError.
  const [row] = await sql`
    UPDATE schedule
       SET status = 'pending', claimed_at = NULL, job_id = NULL,
           attempts = ${attempts}, run_at = ${runAt}, last_error = ${lastError ?? null},
           updated_at = now()
     WHERE id = ${id}
     RETURNING *`;
  return row || null;
}

// Bộ hẹn giờ — quyết định dòng lịch nào được chạy, chạy bù, hay bỏ lỡ.
//
// Phần trên file là HÀM THUẦN: không đọc DB, không ghi file, không gọi
// Date.now(). Mọi mốc thời gian đi vào qua tham số. Nhờ vậy test được biên
// giới nửa đêm và "trễ đúng 8 tiếng 1 phút" mà không phải chờ thật.
//
// Ghi chú: các import dưới đây phục vụ phần orchestration ở cuối file (vòng
// tick). Gom lên đầu file cho dễ đọc — brief gốc đặt chúng ngay trên phần
// orchestration, ESM hoist import nên vị trí không ảnh hưởng hành vi.
import { claimDue, markRow, reclaimStale, resetToPending, rowsInFlight, scheduleRetry } from "./schedule.mjs";
import { readStatus } from "./store.mjs";

/** Mã lỗi đáng thử lại — xem bảng trong spec mục 3. */
export const RETRYABLE_CODES = new Set(["interrupted", "render_failed", "internal_error"]);

/**
 * @returns {"run"|"wait"|"miss"}
 *   run  — đến hạn, còn trong ngưỡng chạy bù
 *   wait — chưa tới giờ, đang tắt, hoặc không ở trạng thái pending
 *   miss — quá ngưỡng, sẽ không bao giờ chạy
 */
export function decideAction({ now, runAt, enabled, status, graceMs }) {
  if (!enabled) return "wait";
  if (status !== "pending") return "wait";

  const late = now.getTime() - runAt.getTime();
  if (late < 0) return "wait";
  return late > graceMs ? "miss" : "run";
}

/**
 * Lỗi dữ liệu (storyboard sai, audio câm) chạy lại 100 lần vẫn hỏng y hệt,
 * mà mỗi lần tốn 45-70 phút CPU và chặn các dòng lịch phía sau.
 */
export function isRetryable(code, attempts, maxAttempts) {
  if (attempts >= maxAttempts) return false;
  return RETRYABLE_CODES.has(code);
}

// ── Vòng tick ───────────────────────────────────────────────────────────────
// Mỗi tick làm hai việc: nhặt dòng đến hạn, và đối soát dòng đang bay.
// Việc thứ hai khiến hệ thống TỰ LÀNH sau khi server restart — không cần
// logic khôi phục riêng.

const CLAIM_STALE_MS = 600_000; // 10 phút kẹt ở 'claimed' = server đã chết giữa chừng
const DRAIN_CAP = 20;           // chặn vòng lặp vô hạn nếu claimDue có bug

/**
 * Mốc tick gần nhất — /health phơi ra để giám sát ngoài phát hiện tick chết.
 *
 * Hai mốc tách riêng cố ý: `startedAt` cập nhật ngay khi tick bắt đầu, dù sau
 * đó có văng lỗi hay không; `succeededAt` chỉ cập nhật khi tick chạy hết
 * không ném lỗi ra ngoài. Nếu chỉ có một mốc gán ở đầu hàm, database sập giữa
 * tick vẫn khiến /health thấy mốc mới tinh mỗi chu kỳ — báo xanh trong khi
 * không video nào được xử lý. Lệch nhau kéo dài giữa hai mốc = tick đang chết.
 */
let lastTickStartedAt = null;
let lastTickSucceededAt = null;
export const lastTick = () => ({ startedAt: lastTickStartedAt, succeededAt: lastTickSucceededAt });

/** Bắn cảnh báo, nuốt mọi lỗi: chuông báo cháy hỏng không được làm cháy nhà. */
async function alertWebhook(payload) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* bỏ qua */ }
}

/**
 * Đọc số từ biến môi trường, rơi về mặc định nếu không parse được.
 *
 * `Number("30s")` là NaN — nếu không chặn ở đây, NaN sẽ chảy thẳng vào
 * `setInterval(run, NaN)` (bị ép về 1ms, đập database liên tục) hoặc vào
 * `late > graceMs` (NaN so sánh luôn false, nghĩa là không dòng nào bị đánh
 * "missed" nữa — hỏng im lặng đúng thứ tính năng này sinh ra để bắt).
 */
function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

export function schedulerConfig() {
  return {
    tickMs: numEnv("SCHEDULE_TICK_MS", 30_000),
    graceMs: numEnv("SCHEDULE_GRACE_HOURS", 8) * 3600 * 1000,
    maxAttempts: numEnv("SCHEDULE_MAX_ATTEMPTS", 2),
    retryDelayMs: numEnv("SCHEDULE_RETRY_DELAY_MS", 300_000),
    claimStaleMs: CLAIM_STALE_MS,
  };
}

/** Đối soát một dòng đang bay với status.json của job tương ứng. */
async function reconcileRow(sql, row, cfg, log) {
  if (!row.job_id) {
    // Dòng ở queued/running mà job_id NULL là dữ liệu hỏng — reclaimStale chỉ
    // cứu 'claimed' nên nếu return câm ở đây, dòng này kẹt vĩnh viễn, không
    // log, không cảnh báo, không ai biết video không bao giờ được dựng.
    log(`lịch #${row.id}: đang ${row.status} nhưng không có job_id, trả về pending`);
    await resetToPending(sql, row.id);
    return;
  }
  const job = readStatus(row.job_id);

  // Thư mục job biến mất (bị xoá tay) — coi như chưa chạy, cho thử lại.
  if (!job) {
    log(`lịch #${row.id}: không thấy job ${row.job_id}, trả về pending`);
    await resetToPending(sql, row.id);
    return;
  }

  if (job.status === "done") {
    await markRow(sql, row.id, {
      status: "done",
      video_link: job.drive?.link || null,
      last_error: null,
    });
    log(`lịch #${row.id}: xong → ${job.drive?.link || "(chưa cấu hình Drive)"}`);
    return;
  }

  if (job.status === "failed") {
    const code = job.error?.code || null;
    const attempts = row.attempts + 1;

    if (isRetryable(code, row.attempts, cfg.maxAttempts)) {
      // Dời run_at tới tương lai gần — tick sau retryDelayMs sẽ nhặt lại.
      await scheduleRetry(sql, row.id, {
        attempts,
        runAt: new Date(Date.now() + cfg.retryDelayMs),
        lastError: code,
      });
      log(`lịch #${row.id}: lỗi ${code}, thử lại lần ${attempts}/${cfg.maxAttempts} sau ${cfg.retryDelayMs / 60000} phút`);
      return;
    }

    await markRow(sql, row.id, {
      status: "failed",
      attempts,
      last_error: `${code}: ${job.error?.message || ""}`.slice(0, 500),
    });
    log(`lịch #${row.id}: lỗi ${code}, dừng`);
    await alertWebhook({
      event: "schedule_failed",
      schedule_id: row.id, name: row.name, job_id: row.job_id,
      error: { code, message: String(job.error?.message || "").slice(0, 300) },
    });
    return;
  }

  if (job.status === "cancelled") {
    await markRow(sql, row.id, { status: "failed", last_error: "job bị huỷ" });
    return;
  }

  // Job còn đang chạy — đồng bộ nhãn để UI hiện đúng.
  if (row.status !== "running") await markRow(sql, row.id, { status: "running" });
}

export async function tick({ sql, now = new Date(), enqueueJob, log = () => {}, cfg = schedulerConfig() }) {
  lastTickStartedAt = new Date().toISOString();

  // ── Việc 1: đối soát dòng đang bay ────────────────────────────────────────
  for (const row of await rowsInFlight(sql)) {
    if (row.status === "claimed") continue; // để reclaimStale lo
    try {
      await reconcileRow(sql, row, cfg, log);
    } catch (e) {
      log(`lịch #${row.id}: lỗi đối soát — ${e.message}`);
    }
  }

  const reclaimed = await reclaimStale(sql, cfg.claimStaleMs);
  if (reclaimed) log(`trả ${reclaimed} dòng kẹt ở claimed về pending`);

  // ── Việc 2: nhặt dòng đến hạn ─────────────────────────────────────────────
  // claimDue đã đổi dòng sang 'claimed' trước khi vòng lặp này chạm tới nó —
  // nếu thân vòng lặp ném lỗi (vd. markRow lỗi mạng) mà không có try/catch
  // riêng cho từng dòng, cả tick văng giữa chừng: các dòng đến hạn còn lại
  // trong lượt này bị bỏ qua, còn dòng đang cầm kẹt ở 'claimed' tới khi
  // reclaimStale cứu về (tối đa CLAIM_STALE_MS sau).
  for (let i = 0; i < DRAIN_CAP; i++) {
    const row = await claimDue(sql);
    if (!row) break;

    try {
      const action = decideAction({
        now,
        runAt: new Date(row.run_at),
        enabled: row.enabled,
        status: "pending", // vừa được nhặt từ pending, claimDue đã đảm bảo
        graceMs: cfg.graceMs,
      });

      if (action === "miss") {
        log(`lịch #${row.id} "${row.name}": BỎ LỠ — trễ quá ngưỡng`);
        // Đây là kiểu hỏng im lặng đúng nghĩa: không job nào fail, không log
        // lỗi, chỉ đơn giản là video không xuất hiện. Không báo thì không ai
        // biết — nên bắn cảnh báo TRƯỚC khi ghi DB. Nếu markRow ném lỗi ngay
        // sau, cảnh báo "bỏ lỡ" vẫn đã đi; đảo ngược thứ tự sẽ nuốt mất nó.
        // Không await: alertWebhook tự nuốt lỗi bên trong, chờ nó chỉ tốn tới
        // 10s timeout × tối đa DRAIN_CAP dòng mỗi tick mà không đổi kết quả.
        void alertWebhook({
          event: "schedule_missed",
          schedule_id: row.id, name: row.name,
          run_at: row.run_at,
          message: `Bỏ lỡ lịch "${row.name}" — trễ quá ${cfg.graceMs / 3600000} tiếng`,
        });
        await markRow(sql, row.id, {
          status: "missed",
          last_error: `Trễ quá ${cfg.graceMs / 3600000} tiếng so với giờ hẹn`,
        });
        continue;
      }

      // try chỉ bọc enqueueJob: nếu nó thành công rồi markRow mới ném, dòng
      // KHÔNG được đánh 'failed' — job đã vào hàng đợi thật, video vẫn sẽ
      // dựng và lên Drive, đánh 'failed' ở đây sẽ làm mất link vĩnh viễn vì
      // đối soát không bao giờ chạm lại trạng thái cuối.
      let jobId;
      try {
        jobId = await enqueueJob(row);
      } catch (e) {
        await markRow(sql, row.id, { status: "failed", last_error: `Không tạo được job: ${e.message}`.slice(0, 500) });
        log(`lịch #${row.id}: không tạo được job — ${e.message}`);
        continue;
      }
      await markRow(sql, row.id, { status: "queued", job_id: jobId, last_error: null });
      log(`lịch #${row.id} "${row.name}": đã đẩy vào hàng đợi (job ${jobId})`);
    } catch (e) {
      log(`lịch #${row.id}: lỗi xử lý dòng đến hạn — ${e.message}`);
    }
  }

  lastTickSucceededAt = new Date().toISOString();
}

let timer = null;

export function startScheduler({ sql, enqueueJob, log = console.log }) {
  const cfg = schedulerConfig();
  if (timer) return;

  // Một tick có thể chạy lâu hơn tickMs (vd. DRAIN_CAP dòng, mỗi dòng chờ
  // webhook). claimDue nguyên tử nên không nhân đôi job, nhưng nếu tick mới
  // khởi động trong lúc tick cũ chưa xong, hai reconcileRow có thể cùng đụng
  // một dòng và ghi đè lẫn nhau. Cờ running chặn việc đó.
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick({ sql, now: new Date(), enqueueJob, log, cfg });
    } catch (e) {
      log(`[scheduler] tick lỗi: ${e.message}`);
    } finally {
      running = false;
    }
  };

  timer = setInterval(run, cfg.tickMs);
  timer.unref?.(); // đừng giữ tiến trình sống chỉ vì bộ đếm giờ
  run();

  log(`[scheduler] tick mỗi ${cfg.tickMs / 1000}s · ngưỡng chạy bù ${cfg.graceMs / 3600000}h · giờ hiện tại ${new Date().toLocaleString("vi-VN")}`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

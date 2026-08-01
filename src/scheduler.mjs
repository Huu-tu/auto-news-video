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

/** Mốc tick gần nhất — /health phơi ra để giám sát ngoài phát hiện tick chết. */
let lastTickAt = null;
export const lastTick = () => lastTickAt;

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

export function schedulerConfig() {
  return {
    tickMs: Number(process.env.SCHEDULE_TICK_MS || 30_000),
    graceMs: Number(process.env.SCHEDULE_GRACE_HOURS || 8) * 3600 * 1000,
    maxAttempts: Number(process.env.SCHEDULE_MAX_ATTEMPTS || 2),
    retryDelayMs: Number(process.env.SCHEDULE_RETRY_DELAY_MS || 300_000),
    claimStaleMs: CLAIM_STALE_MS,
  };
}

/** Đối soát một dòng đang bay với status.json của job tương ứng. */
async function reconcileRow(sql, row, cfg, log) {
  if (!row.job_id) return;
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
  lastTickAt = new Date().toISOString();

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
  for (let i = 0; i < DRAIN_CAP; i++) {
    const row = await claimDue(sql);
    if (!row) break;

    const action = decideAction({
      now,
      runAt: new Date(row.run_at),
      enabled: row.enabled,
      status: "pending", // vừa được nhặt từ pending, claimDue đã đảm bảo
      graceMs: cfg.graceMs,
    });

    if (action === "miss") {
      await markRow(sql, row.id, {
        status: "missed",
        last_error: `Trễ quá ${cfg.graceMs / 3600000} tiếng so với giờ hẹn`,
      });
      log(`lịch #${row.id} "${row.name}": BỎ LỠ — trễ quá ngưỡng`);
      // Đây là kiểu hỏng im lặng đúng nghĩa: không job nào fail, không log lỗi,
      // chỉ đơn giản là video không xuất hiện. Không báo thì không ai biết.
      await alertWebhook({
        event: "schedule_missed",
        schedule_id: row.id, name: row.name,
        run_at: row.run_at,
        message: `Bỏ lỡ lịch "${row.name}" — trễ quá ${cfg.graceMs / 3600000} tiếng`,
      });
      continue;
    }

    try {
      const jobId = await enqueueJob(row);
      await markRow(sql, row.id, { status: "queued", job_id: jobId, last_error: null });
      log(`lịch #${row.id} "${row.name}": đã đẩy vào hàng đợi (job ${jobId})`);
    } catch (e) {
      await markRow(sql, row.id, { status: "failed", last_error: `Không tạo được job: ${e.message}`.slice(0, 500) });
      log(`lịch #${row.id}: không tạo được job — ${e.message}`);
    }
  }
}

let timer = null;

export function startScheduler({ sql, enqueueJob, log = console.log }) {
  const cfg = schedulerConfig();
  if (timer) return;

  const run = async () => {
    try {
      await tick({ sql, now: new Date(), enqueueJob, log, cfg });
    } catch (e) {
      log(`[scheduler] tick lỗi: ${e.message}`);
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

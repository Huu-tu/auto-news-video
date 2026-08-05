import { claimDue, markRow, reclaimStale, resetToPending, rowsInFlight, scheduleRetry } from "./schedule.mjs";
import { clearScheduleInput, readStatus } from "./store.mjs";

export const RETRYABLE_CODES = new Set(["interrupted", "render_failed", "internal_error"]);

export function humanizeMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} tiếng`;
  return `${Math.round(h / 24)} ngày`;
}

export function decideAction({ now, runAt, enabled, status, graceMs }) {
  if (!enabled) return "wait";
  if (status !== "pending") return "wait";

  const late = now.getTime() - runAt.getTime();
  if (late < 0) return "wait";
  return late > graceMs ? "miss" : "run";
}


export function isRetryable(code, attempts, maxAttempts) {
  if (attempts >= maxAttempts) return false;
  return RETRYABLE_CODES.has(code);
}


const CLAIM_STALE_MS = 600_000; 
const DRAIN_CAP = 20;           

let lastTickStartedAt = null;
let lastTickSucceededAt = null;
export const lastTick = () => ({ startedAt: lastTickStartedAt, succeededAt: lastTickSucceededAt });

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
  } catch {  }
}

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

async function reconcileRow(sql, row, cfg, log) {
  if (!row.job_id) {
    log(`lịch #${row.id}: đang ${row.status} nhưng không có job_id, trả về pending`);
    await resetToPending(sql, row.id);
    return;
  }
  const job = await readStatus(row.job_id);

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

    const freed = clearScheduleInput(row.id);
    if (freed) log(`lịch #${row.id}: dọn ${(freed / 1048576).toFixed(1)} MB file gốc`);
    return;
  }

  if (job.status === "failed") {
    const code = job.error?.code || null;
    const attempts = row.attempts + 1;

    if (isRetryable(code, row.attempts, cfg.maxAttempts)) {
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

  if (row.status !== "running") await markRow(sql, row.id, { status: "running" });
}

export async function tick({ sql, now = new Date(), enqueueJob, log = () => {}, cfg = schedulerConfig() }) {
  lastTickStartedAt = new Date().toISOString();

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

  for (let i = 0; i < DRAIN_CAP; i++) {
    const row = await claimDue(sql);
    if (!row) break;

    try {
      const action = decideAction({
        now,
        runAt: new Date(row.run_at),
        enabled: row.enabled,
        status: "pending", 
        graceMs: cfg.graceMs,
      });

      if (action === "miss") {
        const lateFor = humanizeMs(now.getTime() - new Date(row.run_at).getTime());
        const reason = `Trễ ${lateFor} so với giờ hẹn (ngưỡng ${cfg.graceMs / 3600000} tiếng)`;
        log(`lịch #${row.id} "${row.name}": BỎ LỠ — ${reason}`);
        void alertWebhook({
          event: "schedule_missed",
          schedule_id: row.id, name: row.name,
          run_at: row.run_at,
          message: `Bỏ lỡ lịch "${row.name}" — ${reason}`,
        });
        await markRow(sql, row.id, { status: "missed", last_error: reason });
        continue;
      }

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

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick({ sql, now: new Date(), enqueueJob, log, cfg });
    } catch (e) {
      log(`tick lỗi: ${e.message}`);
    } finally {
      running = false;
    }
  };

  timer = setInterval(run, cfg.tickMs);
  timer.unref?.();
  run();

  log(`tick mỗi ${cfg.tickMs / 1000}s · ngưỡng chạy bù ${cfg.graceMs / 3600000}h · giờ hiện tại ${new Date().toLocaleString("vi-VN")}`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

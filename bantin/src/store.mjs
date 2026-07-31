// Job store — hệ thống file, không database.
// Mỗi job là một thư mục work/<job_id>/ tự mô tả: xoá thư mục = xoá job.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WORK_DIR = resolve(process.env.WORK_DIR || "./work");

/** Trạng thái không phải điểm cuối — job đang chạy dở. */
export const ACTIVE = ["queued", "transcribing", "ad_scan", "aligning", "planning", "building", "checking", "rendering", "uploading"];
const TERMINAL = ["done", "failed", "cancelled"];

export function isTerminal(status) {
  return TERMINAL.includes(status);
}

export function jobDir(id) {
  return join(WORK_DIR, id);
}

export function newJobId() {
  const t = Date.now().toString(36);
  return `job_${t}${randomBytes(4).toString("hex")}`;
}

export function initStore() {
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(join(WORK_DIR, "_idem"), { recursive: true });
}

/** Ghi status.json kiểu atomic — đọc song song không bao giờ thấy file nửa vời. */
export function writeStatus(id, status) {
  const dir = jobDir(id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.status.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n");
  renameSync(tmp, join(dir, "status.json"));
}

export function readStatus(id) {
  const p = join(jobDir(id), "status.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function patchStatus(id, patch) {
  const cur = readStatus(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  writeStatus(id, next);
  return next;
}

export function setStage(id, name, progress = null, detail = null) {
  return patchStatus(id, { status: name, stage: { name, progress, detail } });
}

export function addWarning(id, code, message) {
  const cur = readStatus(id);
  if (!cur) return;
  patchStatus(id, { warnings: [...(cur.warnings || []), { code, message }] });
}

export function log(id, line) {
  const rec = { t: new Date().toISOString(), line: String(line).replace(/\s+$/, "") };
  try {
    appendFileSync(join(jobDir(id), "logs.ndjson"), JSON.stringify(rec) + "\n");
  } catch {
    /* log không bao giờ được làm job chết */
  }
}

export function readLogs(id, limit = 500) {
  const p = join(jobDir(id), "logs.ndjson");
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { t: null, line: l };
    }
  });
}

export function listJobs({ status, limit = 100 } = {}) {
  if (!existsSync(WORK_DIR)) return [];
  const out = [];
  for (const name of readdirSync(WORK_DIR)) {
    if (!name.startsWith("job_")) continue;
    const s = readStatus(name);
    if (!s) continue;
    if (status && s.status !== status) continue;
    out.push(s);
  }
  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return out.slice(0, limit);
}

// ── Idempotency ──────────────────────────────────────────────────────────────
// Client retry với cùng Idempotency-Key sẽ nhận lại job cũ thay vì tạo job trùng.
const idemPath = (key) => join(WORK_DIR, "_idem", createHash("sha256").update(key).digest("hex").slice(0, 32) + ".json");

export function lookupIdempotency(key) {
  const p = idemPath(key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")).job_id;
  } catch {
    return null;
  }
}

export function saveIdempotency(key, jobId) {
  writeFileSync(idemPath(key), JSON.stringify({ key, job_id: jobId, at: new Date().toISOString() }));
}

/**
 * Job đang ở trạng thái ACTIVE khi tiến trình khởi động lại = job bị cắt ngang.
 * Đánh dấu failed thay vì để nó treo mãi ở "rendering" — im lặng trông y hệt
 * đang chạy, đó là kiểu lỗi tệ nhất trong một pipeline không có callback.
 */
export function reapInterrupted() {
  let n = 0;
  for (const s of listJobs({ limit: 10000 })) {
    if (isTerminal(s.status)) continue;
    writeStatus(s.job_id, {
      ...s,
      status: "failed",
      stage: { name: "failed", progress: null, detail: null },
      error: { code: "interrupted", stage: s.status, message: "Tiến trình khởi động lại khi job đang chạy", retryable: true },
      updated_at: new Date().toISOString(),
    });
    n++;
  }
  return n;
}

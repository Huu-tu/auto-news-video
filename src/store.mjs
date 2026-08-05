import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const WORK_DIR = resolve(process.env.WORK_DIR || "./work");

export const ACTIVE = ["queued", "transcribing", "ad_scan", "aligning", "planning", "building", "checking", "rendering", "uploading"];
const TERMINAL = ["done", "failed", "cancelled"];

export function isTerminal(status) {
  return TERMINAL.includes(status);
}

export function jobDir(id) {
  return join(WORK_DIR, id);
}

export function scheduleDir(id) {
  return join(WORK_DIR, "schedule", String(id));
}

export function clearScheduleInput(id) {
  const dir = join(scheduleDir(id), "input");
  if (!existsSync(dir)) return 0;

  let freed = 0;
  const walk = (p) => {
    const st = statSync(p);
    if (!st.isDirectory()) return (freed += st.size);
    for (const f of readdirSync(p)) walk(join(p, f));
  };
  try {
    walk(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return 0; 
  }
  return freed;
}

export function scheduleInputExists(id) {
  const dir = join(scheduleDir(id), "input");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f));
}

export function newJobId() {
  const t = Date.now().toString(36);
  return `job_${t}${randomBytes(4).toString("hex")}`;
}

export function initStore() {
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(join(WORK_DIR, "_idem"), { recursive: true });
}

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

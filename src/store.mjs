import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getSql } from "./db.mjs";

export const WORK_DIR = resolve(process.env.WORK_DIR || "./work");

export const ACTIVE = ["queued", "transcribing", "ad_scan", "aligning", "planning", "building", "checking", "rendering", "uploading"];
const TERMINAL = ["done", "failed", "cancelled"];

const COLUMNS = ["job_id", "status", "created_at", "started_at", "updated_at"];

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
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

function rowToStatus(row) {
  if (!row) return null;
  return {
    ...row.data,
    job_id: row.job_id,
    status: row.status,
    created_at: iso(row.created_at),
    started_at: iso(row.started_at),
    updated_at: iso(row.updated_at),
    queue_position: row.queue_position ?? null,
  };
}


function splitStatus(status) {
  const data = { ...status };
  for (const c of COLUMNS) delete data[c];
  return data;
}

export async function writeStatus(id, status, sql = getSql()) {
  const data = splitStatus(status);
  const [row] = await sql`
    INSERT INTO job (job_id, status, created_at, started_at, updated_at, data)
    VALUES (
      ${id},
      ${status.status},
      ${status.created_at ? new Date(status.created_at) : new Date()},
      ${status.started_at ? new Date(status.started_at) : null},
      ${new Date()},
      ${sql.json(data)}
    )
    ON CONFLICT (job_id) DO UPDATE SET
      status     = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      updated_at = EXCLUDED.updated_at,
      data       = EXCLUDED.data
    RETURNING *`;
  mkdirSync(jobDir(id), { recursive: true });
  return rowToStatus(row);
}

export async function readStatus(id, sql = getSql()) {
  const [row] = await sql`
    SELECT j.*, q.n AS queue_position
      FROM job j
      LEFT JOIN (
        SELECT job_id, row_number() OVER (ORDER BY created_at, job_id)::int n
          FROM job WHERE status = 'queued'
      ) q ON q.job_id = j.job_id
     WHERE j.job_id = ${id}`;
  return rowToStatus(row);
}

export async function patchStatus(id, patch, sql = getSql()) {
  const cur = await readStatus(id, sql);
  if (!cur) return null;
  return writeStatus(id, { ...cur, ...patch }, sql);
}

export async function setStage(id, name, progress = null, detail = null, sql = getSql()) {
  return patchStatus(id, { status: name, stage: { name, progress, detail } }, sql);
}

export async function addWarning(id, code, message, sql = getSql()) {
  const cur = await readStatus(id, sql);
  if (!cur) return null;
  return patchStatus(id, { warnings: [...(cur.warnings || []), { code, message }] }, sql);
}

export async function listJobs({ status, limit = 100 } = {}, sql = getSql()) {
  const rows = await sql`
    SELECT j.*, q.n AS queue_position
      FROM job j
      LEFT JOIN (
        SELECT job_id, row_number() OVER (ORDER BY created_at, job_id)::int n
          FROM job WHERE status = 'queued'
      ) q ON q.job_id = j.job_id
     ${status ? sql`WHERE j.status = ${status}` : sql``}
     ORDER BY j.created_at DESC
     LIMIT ${limit}`;
  return rows.map(rowToStatus);
}

export function log(id, line) {
  const rec = { t: new Date().toISOString(), line: String(line).replace(/\s+$/, "") };
  try {
    mkdirSync(jobDir(id), { recursive: true });
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

const idemKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 32);

export async function lookupIdempotency(key, sql = getSql()) {
  const [row] = await sql`SELECT job_id FROM job_idempotency WHERE key = ${idemKey(key)}`;
  return row?.job_id ?? null;
}

export async function saveIdempotency(key, jobId, sql = getSql()) {
  await sql`
    INSERT INTO job_idempotency (key, job_id) VALUES (${idemKey(key)}, ${jobId})
    ON CONFLICT (key) DO NOTHING`;
}

export async function requeueUnstarted(sql = getSql()) {
  const rows = await sql`
    UPDATE job
       SET status = 'queued', updated_at = now()
     WHERE status <> 'queued'
       AND started_at IS NULL
       AND NOT (status = ANY(${TERMINAL}))
     RETURNING job_id`;
  return rows.length;
}

export async function reapInterrupted(sql = getSql()) {
  const rows = await sql`
    UPDATE job
       SET status = 'failed',
           updated_at = now(),
           data = data
             || jsonb_build_object('stage', jsonb_build_object('name','failed','progress',null,'detail',null))
             || jsonb_build_object('error', jsonb_build_object(
                  'code','interrupted',
                  'stage', COALESCE(data->'stage'->>'name', status),
                  'message','Tiến trình khởi động lại khi job đang chạy',
                  'retryable', true))
     WHERE started_at IS NOT NULL
       AND NOT (status = ANY(${TERMINAL}))
     RETURNING job_id`;
  return rows.length;
}

export async function claimNextQueued(sql = getSql()) {
  const [row] = await sql`
    UPDATE job
       SET status = 'claimed', started_at = now(), updated_at = now()
     WHERE job_id = (
       SELECT job_id FROM job
        WHERE status = 'queued'
        ORDER BY created_at, job_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING *`;
  return rowToStatus(row);
}

export async function countQueued(sql = getSql()) {
  const [row] = await sql`SELECT count(*)::int n FROM job WHERE status = 'queued'`;
  return row.n;
}

export async function queuePosition(id, sql = getSql()) {
  const [row] = await sql`
    SELECT n FROM (
      SELECT job_id, row_number() OVER (ORDER BY created_at, job_id)::int n
        FROM job WHERE status = 'queued'
    ) t WHERE job_id = ${id}`;
  return row?.n ?? null;
}

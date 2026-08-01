// API + UI. Một tiến trình, một cổng.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";

import { listTemplates, runJob } from "./pipeline.mjs";
import { renderPage } from "./ui.mjs";
import {
  ACTIVE,
  initStore,
  isTerminal,
  jobDir,
  listJobs,
  log,
  lookupIdempotency,
  newJobId,
  patchStatus,
  readLogs,
  readStatus,
  reapInterrupted,
  saveIdempotency,
  writeStatus,
} from "./store.mjs";
import { getSql, initSchema } from "./db.mjs";
import { validateScheduleInput } from "./schedule-validate.mjs";
import { brandFromParams, parseStoryboard } from "./storyboard.mjs";
import { createRow, deleteRow, getRow, listRows, markRow, setEnabled } from "./schedule.mjs";
import { lastTick, startScheduler } from "./scheduler.mjs";
import { scheduleDir } from "./store.mjs";
import { probeDuration } from "./adscan.mjs";

const PORT = Number(process.env.PORT || 8080);
const API_TOKEN = process.env.API_TOKEN || "";
const MAX_AUDIO = 50 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;

initStore();
const reaped = reapInterrupted();
if (reaped) console.log(`[store] đánh dấu failed cho ${reaped} job bị cắt ngang`);

// ── Bảng lịch ────────────────────────────────────────────────────────────────
// PostgreSQL giờ là bắt buộc cho tính năng lịch. Thiếu DATABASE_URL hay không
// kết nối được thì thoát rõ ràng bằng tiếng Việt — không để lộ stack trace,
// và không âm thầm chạy tiếp thiếu tính năng (không có chế độ không-database).
let sql;
try {
  sql = getSql();
  await initSchema(sql);
} catch (e) {
  console.error(`Không kết nối được PostgreSQL: ${e.message}. Bảng lịch cần DATABASE_URL — xem .env.example.`);
  process.exit(1);
}

// ── Hàng đợi: FIFO, concurrency 1 ────────────────────────────────────────────
// Render đã ăn hết CPU; chạy hai job song song chỉ làm cả hai cùng chậm.
const queue = [];
let running = null;
const children = new Map();

function enqueue(jobId) {
  queue.push(jobId);
  refreshQueuePositions();
  pump();
}

function refreshQueuePositions() {
  queue.forEach((id, i) => patchStatus(id, { queue_position: i + 1 }));
}

async function pump() {
  if (running || queue.length === 0) return;
  const jobId = queue.shift();
  refreshQueuePositions();
  const s = readStatus(jobId);
  if (!s || isTerminal(s.status)) return pump();

  running = jobId;
  patchStatus(jobId, { queue_position: 0, started_at: new Date().toISOString() });
  const kids = new Set();
  children.set(jobId, kids);

  try {
    await runJob(jobId, { registerChild: (c) => kids.add(c) });
  } catch (e) {
    console.error(`[job ${jobId}]`, e);
  } finally {
    children.delete(jobId);
    running = null;
    setImmediate(pump);
  }
}

/**
 * Dựng một job từ dòng lịch: copy file người dùng đã upload sang thư mục job,
 * ghi storyboard từ DB ra file, rồi đẩy vào đúng hàng đợi mà API vẫn dùng.
 *
 * COPY chứ không move: thư mục lịch là nguồn để chạy lại, dọn dẹp job không
 * được làm mất nó.
 */
async function createJobFromSchedule(row) {
  const jobId = newJobId();
  const dir = jobDir(jobId);
  const inputDir = join(dir, "input");
  mkdirSync(join(inputDir, "images"), { recursive: true });

  const src = join(scheduleDir(row.id), "input");
  if (!existsSync(src)) throw new Error(`Không thấy dữ liệu của lịch #${row.id} tại ${src}`);
  cpSync(src, inputDir, { recursive: true });

  writeFileSync(join(inputDir, "storyboard.md"), row.storyboard);

  const { params } = parseStoryboard(row.storyboard);
  const brand = brandFromParams(params);

  writeStatus(jobId, {
    job_id: jobId,
    status: "queued",
    stage: { name: "queued", progress: 0, detail: null },
    template: "vn-news-vertical",
    brand,
    options: {},
    drive: { filename: `${row.name.replace(/[^\p{L}\p{N}]+/gu, "-")}-{date}-{job_id}.mp4` },
    metadata: { schedule_id: row.id, schedule_name: row.name },
    queue_position: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    timings_sec: {},
    warnings: [],
    artifacts: {},
    error: null,
  });

  log(jobId, `job tạo từ lịch #${row.id} "${row.name}"`);
  enqueue(jobId);
  return jobId;
}

startScheduler({ sql, enqueueJob: createJobFromSchedule, log: (m) => console.log(`[scheduler] ${m}`) });

// ── App ──────────────────────────────────────────────────────────────────────
const app = new Hono();

const unauthorized = (c) => c.json({ error: { code: "unauthorized", message: "Thiếu hoặc sai token" } }, 401);

function tokenFrom(c) {
  const h = c.req.header("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const cookie = c.req.header("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)bantin_token=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return c.req.query("token") || "";
}

app.use("*", async (c, next) => {
  if (!API_TOKEN) {
    return c.json({ error: { code: "not_configured", message: "Chưa đặt API_TOKEN — xem .env.example" } }, 500);
  }
  if (c.req.path === "/health") return next();
  if (tokenFrom(c) !== API_TOKEN) {
    return c.req.path.startsWith("/v1/") ? unauthorized(c) : c.html(renderPage.login(), 401);
  }
  return next();
});

app.get("/health", (c) =>
  c.json({ ok: true, running, queued: queue.length, last_tick: lastTick(), now: new Date().toISOString() }),
);

// ── UI ───────────────────────────────────────────────────────────────────────
app.get("/", (c) => {
  // Đặt cookie khi vào bằng ?token= để lần sau khỏi dán lại
  const t = c.req.query("token");
  if (t) c.header("set-cookie", `bantin_token=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  return c.html(renderPage.dashboard({ templates: listTemplates(), jobs: listJobs({ limit: 50 }) }));
});

// ── Templates ────────────────────────────────────────────────────────────────
app.get("/v1/templates", (c) => c.json({ templates: listTemplates() }));

// ── Tạo job ──────────────────────────────────────────────────────────────────
app.post("/v1/jobs", async (c) => {
  const idemKey = c.req.header("idempotency-key");
  if (idemKey) {
    const existing = lookupIdempotency(idemKey);
    if (existing) {
      const s = readStatus(existing);
      if (s) return c.json({ ...s, idempotent_replay: true }, 200);
    }
  }

  let body;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (e) {
    return c.json({ error: { code: "bad_multipart", message: String(e.message) } }, 400);
  }

  let payload = {};
  if (typeof body.payload === "string") {
    try {
      payload = JSON.parse(body.payload);
    } catch (e) {
      return c.json({ error: { code: "bad_payload", message: `payload không phải JSON hợp lệ: ${e.message}` } }, 400);
    }
  }

  // ── Gom file ───────────────────────────────────────────────────────────────
  const files = [];
  let total = 0;
  for (const [k, v] of Object.entries(body)) {
    for (const f of Array.isArray(v) ? v : [v]) {
      if (typeof f === "string" || !f || typeof f.arrayBuffer !== "function") continue;
      files.push({ field: k, file: f });
      total += f.size || 0;
    }
  }
  if (total > MAX_TOTAL) {
    return c.json({ error: { code: "payload_too_large", message: `Tổng ${Math.round(total / 1048576)} MB > 100 MB` } }, 413);
  }

  const audio = files.find((f) => f.field === "audio");
  if (!audio) return c.json({ error: { code: "missing_audio", message: "Thiếu field multipart 'audio'" } }, 400);
  if ((audio.file.size || 0) > MAX_AUDIO) {
    return c.json({ error: { code: "audio_too_large", message: "File giọng đọc > 50 MB" } }, 413);
  }

  const sbFile = files.find((f) => f.field === "storyboard");
  const storyboardText = typeof payload.storyboard === "string" ? payload.storyboard : null;
  if (!sbFile && !storyboardText) {
    return c.json({ error: { code: "missing_storyboard", message: "Cần field 'storyboard' (file .md) hoặc payload.storyboard" } }, 400);
  }

  // ── Ghi ra đĩa ─────────────────────────────────────────────────────────────
  const jobId = newJobId();
  const dir = jobDir(jobId);
  const inputDir = join(dir, "input");
  mkdirSync(join(inputDir, "images"), { recursive: true });

  const writeUpload = async (f, dest) => writeFileSync(dest, Buffer.from(await f.arrayBuffer()));

  const audioExt = (audio.file.name || "vo.mp3").match(/\.[a-z0-9]+$/i)?.[0] || ".mp3";
  await writeUpload(audio.file, join(inputDir, `vo${audioExt}`));

  if (sbFile) await writeUpload(sbFile.file, join(inputDir, "storyboard.md"));
  else writeFileSync(join(inputDir, "storyboard.md"), storyboardText);

  for (const { field, file } of files) {
    if (!field.startsWith("image_")) continue;
    if ((file.size || 0) > MAX_IMAGE) {
      return c.json({ error: { code: "image_too_large", message: `${field} > 10 MB` } }, 413);
    }
    const id = field.slice("image_".length);
    const ext = (file.name || "").match(/\.[a-z0-9]+$/i)?.[0] || ".png";
    await writeUpload(file, join(inputDir, "images", `${id}${ext}`));
  }

  const status = {
    job_id: jobId,
    status: "queued",
    stage: { name: "queued", progress: 0, detail: null },
    template: payload.template || "vn-news-vertical",
    brand: payload.brand || {},
    options: payload.options || {},
    drive: payload.drive || {},
    metadata: payload.metadata || {},
    queue_position: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    timings_sec: {},
    warnings: [],
    artifacts: {},
    error: null,
  };
  writeStatus(jobId, status);
  log(jobId, `job tạo từ ${files.length} file (${Math.round(total / 1048576)} MB)`);
  if (idemKey) saveIdempotency(idemKey, jobId);

  // Đọc vị trí TRƯỚC khi enqueue: pump() chạy đồng bộ ngay trong enqueue và có
  // thể đã nhấc job ra khỏi hàng đợi, khiến indexOf trả -1.
  const position = running ? queue.length + 1 : 0;
  enqueue(jobId);

  return c.json(
    {
      job_id: jobId,
      status: "queued",
      queue_position: position,
      status_url: `/v1/jobs/${jobId}`,
      created_at: status.created_at,
    },
    202,
  );
});

// ── Đọc job ──────────────────────────────────────────────────────────────────
app.get("/v1/jobs", (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  return c.json({ jobs: listJobs({ status, limit }), running, queued: queue.length });
});

app.get("/v1/jobs/:id", (c) => {
  const s = readStatus(c.req.param("id"));
  return s ? c.json(s) : c.json({ error: { code: "not_found" } }, 404);
});

app.get("/v1/jobs/:id/logs", (c) => {
  const id = c.req.param("id");
  if (!readStatus(id)) return c.json({ error: { code: "not_found" } }, 404);
  return c.json({ logs: readLogs(id, Math.min(Number(c.req.query("limit") || 500), 5000)) });
});

app.post("/v1/jobs/:id/cancel", (c) => {
  const id = c.req.param("id");
  const s = readStatus(id);
  if (!s) return c.json({ error: { code: "not_found" } }, 404);
  if (isTerminal(s.status)) return c.json({ error: { code: "already_terminal", message: s.status } }, 409);

  patchStatus(id, { cancel_requested: true });
  const i = queue.indexOf(id);
  if (i >= 0) {
    queue.splice(i, 1);
    patchStatus(id, { status: "cancelled", stage: { name: "cancelled", progress: null, detail: null } });
    refreshQueuePositions();
  } else {
    for (const child of children.get(id) || []) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* tiến trình con có thể đã chết */
      }
    }
  }
  return c.json(readStatus(id));
});

// ── Tiến độ realtime cho UI ──────────────────────────────────────────────────
app.get("/v1/jobs/:id/events", (c) => {
  const id = c.req.param("id");
  if (!readStatus(id)) return c.json({ error: { code: "not_found" } }, 404);

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let last = "";
      const tick = () => {
        const s = readStatus(id);
        if (!s) return;
        const json = JSON.stringify(s);
        if (json !== last) {
          last = json;
          controller.enqueue(enc.encode(`data: ${json}\n\n`));
        }
        if (isTerminal(s.status)) {
          clearInterval(timer);
          controller.close();
        }
      };
      const timer = setInterval(tick, 1500);
      tick();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
});

// ── File của job ─────────────────────────────────────────────────────────────
function sendFile(c, path, type) {
  if (!existsSync(path)) return c.json({ error: { code: "not_found" } }, 404);
  const size = statSync(path).size;
  c.header("content-type", type);
  c.header("content-length", String(size));
  return c.body(Readable.toWeb(createReadStream(path)));
}

app.get("/v1/jobs/:id/video", (c) => {
  const id = c.req.param("id");
  const p = join(jobDir(id), "output.mp4");
  c.header("content-disposition", `inline; filename="${id}.mp4"`);
  return sendFile(c, p, "video/mp4");
});

app.get("/v1/jobs/:id/files/:name", (c) => {
  const name = c.req.param("name");
  if (!/^[\w.-]+$/.test(name)) return c.json({ error: { code: "bad_name" } }, 400);
  return sendFile(c, join(jobDir(c.req.param("id")), name), "application/json; charset=utf-8");
});

// Phục vụ thư mục project để <hyperframes-player> xem trước không cần render
app.get("/v1/jobs/:id/project/*", (c) => {
  const id = c.req.param("id");
  const rest = c.req.path.split(`/v1/jobs/${id}/project/`)[1] || "index.html";
  const rel = normalize(decodeURIComponent(rest || "index.html"));
  if (rel.startsWith("..")) return c.json({ error: { code: "bad_path" } }, 400);
  const p = join(jobDir(id), "project", rel === "" ? "index.html" : rel);
  const ext = p.split(".").pop().toLowerCase();
  const types = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return sendFile(c, p, types[ext] || "application/octet-stream");
});

// ── Lịch tạo video ───────────────────────────────────────────────────────────
app.get("/schedule", async (c) => {
  // plan_source nằm trong status.json của job, không có trong bảng schedule.
  // Ghép vào đây để bảng lịch hiện được cảnh báo "fallback" — dấu hiệu bước
  // LLM không chạy, mà job vẫn báo done.
  const rows = (await listRows(sql)).map((r) => ({
    ...r,
    plan_source: r.job_id ? readStatus(r.job_id)?.plan_source || null : null,
  }));
  return c.html(renderPage.schedule({ rows }));
});

app.get("/v1/schedule", async (c) => c.json({ rows: await listRows(sql) }));

app.post("/schedule", async (c) => {
  const body = await c.req.parseBody({ all: true });

  const name = String(body.name || "").trim();
  const date = String(body.date || "").trim();
  const time = String(body.time || "").trim();
  const storyboard = String(body.storyboard || "");
  const note = String(body.note || "");
  const enabled = body.enabled === "on";

  if (!name || !date || !time) {
    return c.html(renderPage.scheduleError("Thiếu tên, ngày hoặc giờ"), 400);
  }

  // Giờ nhập là giờ địa phương của server (TZ=Asia/Ho_Chi_Minh).
  const runAt = new Date(`${date}T${time}:00`);
  if (Number.isNaN(runAt.getTime())) {
    return c.html(renderPage.scheduleError("Ngày giờ không hợp lệ"), 400);
  }

  const files = [];
  for (const [k, v] of Object.entries(body)) {
    for (const f of Array.isArray(v) ? v : [v]) {
      if (typeof f === "string" || !f || typeof f.arrayBuffer !== "function") continue;
      files.push({ field: k, file: f });
    }
  }
  const audio = files.find((f) => f.field === "audio");
  if (!audio) return c.html(renderPage.scheduleError("Thiếu file ghi âm"), 400);

  const images = files.filter((f) => f.field === "images" && f.file.name);
  const imageIds = images.map((f) => f.file.name.replace(/\.[a-z0-9]+$/i, ""));

  // Vòng 1 — chỉ storyboard. Chặn sớm để không tạo dòng rác trong DB.
  const early = validateScheduleInput({ storyboardText: storyboard, imageIds, audioDurationSec: 0 });
  if (!early.ok) return c.html(renderPage.scheduleError(early.errors.join(" · ")), 400);

  const row = await createRow(sql, { name, runAt, storyboard, note, enabled });

  const inputDir = join(scheduleDir(row.id), "input");
  mkdirSync(join(inputDir, "images"), { recursive: true });
  const write = async (f, dest) => writeFileSync(dest, Buffer.from(await f.arrayBuffer()));

  const ext = (audio.file.name || "vo.mp3").match(/\.[a-z0-9]+$/i)?.[0] || ".mp3";
  const audioPath = join(inputDir, `vo${ext}`);
  await write(audio.file, audioPath);
  for (const im of images) await write(im.file, join(inputDir, "images", im.file.name));

  // Vòng 2 — giờ mới đo được thời lượng audio. Đây là kiểm tra đáng giá nhất:
  // audio không khớp storyboard sẽ ra align_failed sau ~25 phút chạy thật.
  let audioDurationSec = 0;
  try {
    audioDurationSec = await probeDuration(audioPath);
  } catch {
    /* thiếu ffprobe thì bỏ qua kiểm tra này, không chặn người dùng */
  }
  const full = validateScheduleInput({ storyboardText: storyboard, imageIds, audioDurationSec });

  if (full.warnings.length) {
    return c.html(renderPage.scheduleSaved({ row, check: full, audioDurationSec }));
  }
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/toggle", async (c) => {
  const row = await getRow(sql, c.req.param("id"));
  if (row) await setEnabled(sql, row.id, !row.enabled);
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/run", async (c) => {
  const row = await getRow(sql, c.req.param("id"));
  if (!row) return c.redirect("/schedule", 303);
  try {
    const jobId = await createJobFromSchedule(row);
    await markRow(sql, row.id, { status: "queued", job_id: jobId, last_error: null });
  } catch (e) {
    await markRow(sql, row.id, { status: "failed", last_error: e.message.slice(0, 500) });
  }
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/delete", async (c) => {
  const id = c.req.param("id");
  const row = await getRow(sql, id);
  if (row) {
    // Xoá dòng DB và thư mục file trong cùng một thao tác — đây chính là
    // lý do gộp hai nút thành một: hai nguồn sự thật không được lệch nhau.
    await deleteRow(sql, id);
    rmSync(scheduleDir(id), { recursive: true, force: true });
  }
  return c.redirect("/schedule", 303);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`bantin-studio: http://localhost:${info.port}`);
  console.log(API_TOKEN ? `UI: http://localhost:${info.port}/?token=<API_TOKEN>` : "⚠ chưa đặt API_TOKEN");
});

export { app, ACTIVE };

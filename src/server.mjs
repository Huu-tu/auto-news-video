import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
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
  scheduleDir,
  writeStatus,
} from "./store.mjs";
import { getSql, initSchema } from "./db.mjs";
import { validateScheduleInput } from "./schedule-validate.mjs";
import { brandFromParams, parseStoryboard } from "./storyboard.mjs";
import { claimById, createRow, deleteRow, getRow, listRows, markRow, setEnabled, updateRow } from "./schedule.mjs";
import { lastTick, startScheduler } from "./scheduler.mjs";
import { probeDuration } from "./adscan.mjs";

const PORT = Number(process.env.PORT || 8080);
const API_TOKEN = process.env.API_TOKEN || "";
const MAX_AUDIO = 50 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;

initStore();
const reaped = reapInterrupted();
if (reaped) console.log(`[store] đánh dấu failed cho ${reaped} job bị cắt ngang`);

let sql;
try {
  sql = getSql();
  await initSchema(sql);
} catch (e) {
  const hint = e.message.includes("DATABASE_URL") ? "" : " Bảng lịch cần DATABASE_URL — xem .env.example.";
  console.error(`Không kết nối được PostgreSQL: ${e.message}.${hint}`);
  process.exit(1);
}

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

  const rawTimeout = Number(process.env.JOB_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 7_200_000;
  const job = runJob(jobId, { registerChild: (c) => kids.add(c) });

  let timer = null;
  let killTimer = null;

  try {
    const timedOut = await new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
      job.then(() => resolve(false), () => resolve(false));
    });
    clearTimeout(timer);

    if (timedOut) {
      for (const child of kids) {
        try { child.kill("SIGTERM"); } catch { /* có thể đã chết */ }
      }
      killTimer = setTimeout(() => {
        for (const child of kids) {
          try { child.kill("SIGKILL"); } catch { /* đã chết */ }
        }
      }, 10_000);

      await job.catch(() => {});
      clearTimeout(killTimer); // child chết sạch rồi thì đừng giữ timer 10s treo

      try {
        const cur = readStatus(jobId);
        if (cur && ["done", "cancelled"].includes(cur.status)) {
          log(jobId, `bỏ qua ghi timeout: job đã ${cur.status}`);
        } else {
          patchStatus(jobId, {
            status: "failed",
            stage: { name: "failed", progress: null, detail: null },
            error: {
              code: "timeout",
              stage: "unknown",
              message: `Job vượt trần ${Math.round(timeoutMs / 60000)} phút — đã dừng để giải phóng hàng đợi`,
              retryable: false,
            },
          });
          log(jobId, `FAILED [timeout] quá ${Math.round(timeoutMs / 60000)} phút`);
        }
      } catch (e) {
        console.error(`[job ${jobId}] không ghi được trạng thái timeout:`, e);
      }
    }
  } catch (e) {
    console.error(`[job ${jobId}]`, e);
  } finally {
    children.delete(jobId);
    running = null;
    setImmediate(pump);
  }
}

async function createJobFromSchedule(row) {
  const jobId = newJobId();
  const dir = jobDir(jobId);
  const inputDir = join(dir, "input");
  mkdirSync(join(inputDir, "images"), { recursive: true });

  const src = join(scheduleDir(row.id), "input");
  const hasAudio = existsSync(src) && readdirSync(src).some((f) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f));
  if (!hasAudio) throw new Error(`Lịch #${row.id} không có file giọng đọc trong ${src}`);
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
  if (!API_TOKEN) return next();
  if (c.req.path === "/health") return next();
  if (tokenFrom(c) !== API_TOKEN) {
    return c.req.path.startsWith("/v1/") ? unauthorized(c) : c.html(renderPage.login(), 401);
  }
  return next();
});

app.get("/health", (c) => {
  const { startedAt, succeededAt } = lastTick();
  const okAt = succeededAt ? Date.parse(succeededAt) : null;
  const tickStale = okAt !== null && Date.now() - okAt > 600_000;
  const body = {
    ok: !tickStale,
    running,
    queued: queue.length,
    last_tick_started_at: startedAt,
    last_tick_ok_at: succeededAt,
    now: new Date().toISOString(),
  };
  return c.json(body, tickStale ? 503 : 200);
});

app.get("/", (c) => {
  const t = c.req.query("token");
  if (t) c.header("set-cookie", `bantin_token=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  return c.html(renderPage.dashboard({ templates: listTemplates(), jobs: listJobs({ limit: 50 }) }));
});

app.get("/v1/templates", (c) => c.json({ templates: listTemplates() }));

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

function cancelJob(jobId) {
  const s = readStatus(jobId);
  if (!s || isTerminal(s.status)) return;

  patchStatus(jobId, { cancel_requested: true });
  const i = queue.indexOf(jobId);
  if (i >= 0) {
    queue.splice(i, 1);
    patchStatus(jobId, { status: "cancelled", stage: { name: "cancelled", progress: null, detail: null } });
    refreshQueuePositions();
  } else {
    for (const child of children.get(jobId) || []) {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }
  }
}

app.post("/v1/jobs/:id/cancel", (c) => {
  const id = c.req.param("id");
  const s = readStatus(id);
  if (!s) return c.json({ error: { code: "not_found" } }, 404);
  if (isTerminal(s.status)) return c.json({ error: { code: "already_terminal", message: s.status } }, 409);

  cancelJob(id);
  return c.json(readStatus(id));
});

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

app.get("/schedule", async (c) => {
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

  const timeNorm = /^\d{1,2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const runAt = new Date(`${date}T${timeNorm}`);
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
  if ((audio.file.size || 0) > MAX_AUDIO) {
    return c.html(renderPage.scheduleError("File ghi âm > 50 MB"), 413);
  }

  const images = files.filter((f) => f.field === "images" && f.file.name);
  const safeImages = images
    .map((f) => ({ ...f, safeName: basename(f.file.name).replace(/[^\p{L}\p{N}._-]/gu, "_") }))
    .filter((f) => f.safeName && !f.safeName.startsWith("."));

  let total = audio.file.size || 0;
  for (const im of safeImages) {
    if ((im.file.size || 0) > MAX_IMAGE) {
      return c.html(renderPage.scheduleError(`Ảnh ${im.safeName} > 10 MB`), 413);
    }
    total += im.file.size || 0;
  }
  if (total > MAX_TOTAL) {
    return c.html(renderPage.scheduleError(`Tổng ${Math.round(total / 1048576)} MB > 100 MB`), 413);
  }

  const imageIds = safeImages.map((f) => f.safeName.replace(/\.[a-z0-9]+$/i, ""));

  const early = validateScheduleInput({ storyboardText: storyboard, imageIds, audioDurationSec: 0 });
  if (!early.ok) return c.html(renderPage.scheduleError(early.errors.join(" · ")), 400);

  const row = await createRow(sql, { name, runAt, storyboard, note, enabled });

  const inputDir = join(scheduleDir(row.id), "input");
  const write = async (f, dest) => writeFileSync(dest, Buffer.from(await f.arrayBuffer()));

  const ext = (audio.file.name || "vo.mp3").match(/\.[a-z0-9]+$/i)?.[0] || ".mp3";
  const audioPath = join(inputDir, `vo${ext}`);

  try {
    mkdirSync(join(inputDir, "images"), { recursive: true });
    await write(audio.file, audioPath);
    for (const im of safeImages) await write(im.file, join(inputDir, "images", im.safeName));
  } catch (e) {
    await deleteRow(sql, row.id);
    rmSync(scheduleDir(row.id), { recursive: true, force: true });
    return c.html(renderPage.scheduleError(`Ghi file thất bại: ${e.message}`), 500);
  }

  let audioDurationSec = 0;
  try {
    audioDurationSec = await probeDuration(audioPath);
  } catch {
  }
  const full = validateScheduleInput({ storyboardText: storyboard, imageIds, audioDurationSec });

  if (full.warnings.length) {
    return c.html(renderPage.scheduleSaved({ row, check: full, audioDurationSec }));
  }
  return c.redirect("/schedule", 303);
});

function parseScheduleId(c) {
  const id = Number(c.req.param("id"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

app.post("/schedule/:id/toggle", async (c) => {
  const id = parseScheduleId(c);
  if (id === null) return c.redirect("/schedule", 303);
  const row = await getRow(sql, id);
  if (row) await setEnabled(sql, row.id, !row.enabled);
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/edit", async (c) => {
  const id = parseScheduleId(c);
  if (id === null) return c.redirect("/schedule", 303);

  const body = await c.req.parseBody({ all: true });
  const name = String(body.name || "").trim();
  const date = String(body.date || "").trim();
  const time = String(body.time || "").trim();
  const storyboard = String(body.storyboard || "");
  const note = String(body.note || "");

  if (!name || !date || !time) return c.html(renderPage.scheduleError("Thiếu tên, ngày hoặc giờ"), 400);

  const timeNorm = /^\d{1,2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const runAt = new Date(`${date}T${timeNorm}`);
  if (Number.isNaN(runAt.getTime())) return c.html(renderPage.scheduleError("Ngày giờ không hợp lệ"), 400);

  const check = validateScheduleInput({ storyboardText: storyboard, imageIds: [], audioDurationSec: 0 });
  if (!check.ok) return c.html(renderPage.scheduleError(check.errors.join(" · ")), 400);

  await updateRow(sql, id, { name, runAt, storyboard, note });

  const cur = await getRow(sql, id);
  if (cur && ["failed", "missed", "done"].includes(cur.status)) {
    await markRow(sql, id, { status: "pending", attempts: 0, job_id: null, last_error: null });
  }

  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/run", async (c) => {
  const id = parseScheduleId(c);
  if (id === null) return c.redirect("/schedule", 303);

  const row = await claimById(sql, id);
  if (!row) return c.redirect("/schedule", 303); // không tồn tại, hoặc đang bay

  try {
    const jobId = await createJobFromSchedule(row);
    await markRow(sql, row.id, { status: "queued", job_id: jobId, last_error: null });
  } catch (e) {
    await markRow(sql, row.id, { status: "failed", last_error: e.message.slice(0, 500) });
  }
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/delete", async (c) => {
  const id = parseScheduleId(c);
  if (id === null) return c.redirect("/schedule", 303);
  const row = await getRow(sql, id);
  if (row) {
    if (row.job_id && ["queued", "running", "claimed"].includes(row.status)) {
      cancelJob(row.job_id);
    }
    await deleteRow(sql, row.id);
    rmSync(scheduleDir(row.id), { recursive: true, force: true });
  }
  return c.redirect("/schedule", 303);
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`bantin-studio: http://localhost:${info.port}`);
  console.log(
    API_TOKEN
      ? `UI: http://localhost:${info.port}/?token=<API_TOKEN>`
      : `UI: http://localhost:${info.port}  ⚠ KHÔNG XÁC THỰC — API_TOKEN trống, ai vào được cổng cũng toàn quyền`,
  );
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `Cổng ${PORT} đang bị chiếm — nhiều khả năng còn một tiến trình server cũ chưa tắt.\n` +
        `  Tìm và tắt:  npx kill-port ${PORT}\n` +
        `  Hoặc trên Windows PowerShell:\n` +
        `    Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
        `  Hoặc chạy cổng khác:  PORT=8081 npm start`,
    );
    process.exit(1);
  }
  throw e;
});

export { app, ACTIVE };

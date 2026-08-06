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
  requeueUnstarted,
  claimNextQueued,
  countQueued,
  queuePosition,
  saveIdempotency,
  scheduleDir,
  scheduleInputExists,
  writeStatus,
} from "./store.mjs";
import { getSql, initSchema } from "./db.mjs";
import { validateRunAt, validateScheduleInput } from "./schedule-validate.mjs";
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

let sql;
try {
  sql = getSql();
  await initSchema(sql);
} catch (e) {
  const hint = e.message.includes("DATABASE_URL") ? "" : " Bảng lịch cần DATABASE_URL — xem .env.example.";
  console.error(`Không kết nối được PostgreSQL: ${e.message}.${hint}`);
  process.exit(1);
}

const reaped = await reapInterrupted();
if (reaped) console.log(`[store] đánh dấu failed cho ${reaped} job bị cắt ngang`);
const requeued = await requeueUnstarted();
if (requeued) console.log(`[store] trả ${requeued} job chưa kịp chạy về hàng đợi`);

let running = null;
const children = new Map();

async function enqueue(jobId) {
  await patchStatus(jobId, { status: "queued" });
  pump();
}

async function pump() {
  if (running) return;

  const claimed = await claimNextQueued();
  if (!claimed) return;

  const jobId = claimed.job_id;
  running = jobId;
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
      clearTimeout(killTimer); 

      try {
        const cur = await readStatus(jobId);
        if (cur && ["done", "cancelled"].includes(cur.status)) {
          log(jobId, `bỏ qua ghi timeout: job đã ${cur.status}`);
        } else {
          await patchStatus(jobId, {
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

  await writeStatus(jobId, {
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
  await enqueue(jobId);
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

app.get("/health", async (c) => {
  const { startedAt, succeededAt } = lastTick();
  const okAt = succeededAt ? Date.parse(succeededAt) : null;
  const tickStale = okAt !== null && Date.now() - okAt > 600_000;
  const body = {
    ok: !tickStale,
    running,
    queued: await countQueued(),
    last_tick_started_at: startedAt,
    last_tick_ok_at: succeededAt,
    now: new Date().toISOString(),
  };
  return c.json(body, tickStale ? 503 : 200);
});

app.get("/", async (c) => {
  const t = c.req.query("token");
  if (t) c.header("set-cookie", `bantin_token=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  return c.html(renderPage.dashboard({ templates: listTemplates(), jobs: await listJobs({ limit: 50 }) }));
});

app.get("/v1/templates", async (c) => c.json({ templates: listTemplates() }));

app.post("/v1/jobs", async (c) => {
  const idemKey = c.req.header("idempotency-key");
  if (idemKey) {
    const existing = await lookupIdempotency(idemKey);
    if (existing) {
      const s = await readStatus(existing);
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
    image_urls: Array.isArray(payload.image_urls) ? payload.image_urls : [],
    queue_position: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    timings_sec: {},
    warnings: [],
    artifacts: {},
    error: null,
  };
  await writeStatus(jobId, status);
  log(jobId, `job tạo từ ${files.length} file (${Math.round(total / 1048576)} MB)`);
  if (idemKey) await saveIdempotency(idemKey, jobId);

  await enqueue(jobId);
  const position = await queuePosition(jobId);

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

app.get("/v1/jobs", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  return c.json({ jobs: await listJobs({ status, limit }), running, queued: await countQueued() });
});

app.get("/v1/jobs/:id", async (c) => {
  const s = await readStatus(c.req.param("id"));
  return s ? c.json(s) : c.json({ error: { code: "not_found" } }, 404);
});

app.get("/v1/jobs/:id/logs", async (c) => {
  const id = c.req.param("id");
  if (!(await readStatus(id))) return c.json({ error: { code: "not_found" } }, 404);
  return c.json({ logs: readLogs(id, Math.min(Number(c.req.query("limit") || 500), 5000)) });
});

async function cancelJob(jobId) {
  const s = await readStatus(jobId);
  if (!s || isTerminal(s.status)) return;

  await patchStatus(jobId, { cancel_requested: true });

  if (s.status === "queued") {
    await patchStatus(jobId, { status: "cancelled", stage: { name: "cancelled", progress: null, detail: null } });
  } else {
    for (const child of children.get(jobId) || []) {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }
  }
}

app.post("/v1/jobs/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const s = await readStatus(id);
  if (!s) return c.json({ error: { code: "not_found" } }, 404);
  if (isTerminal(s.status)) return c.json({ error: { code: "already_terminal", message: s.status } }, 409);

  await cancelJob(id);
  return c.json(await readStatus(id));
});

app.get("/v1/jobs/:id/events", async (c) => {
  const id = c.req.param("id");
  if (!(await readStatus(id))) return c.json({ error: { code: "not_found" } }, 404);

  let timer = null;
  let closed = false;
  const stop = () => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let last = "";
      const tick = async () => {
        if (closed) return;
        const s = await readStatus(id);
        if (!s) return;
        const json = JSON.stringify(s);
        try {
          if (json !== last) {
            last = json;
            controller.enqueue(enc.encode(`data: ${json}\n\n`));
          }
          if (isTerminal(s.status)) {
            stop();
            controller.close();
          }
        } catch {
          stop(); 
        }
      };
      timer = setInterval(tick, 1500);
      tick();
    },
    cancel() {
      stop();
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

app.get("/v1/jobs/:id/video", async (c) => {
  const id = c.req.param("id");
  const p = join(jobDir(id), "output.mp4");
  c.header("content-disposition", `inline; filename="${id}.mp4"`);
  return sendFile(c, p, "video/mp4");
});

app.get("/v1/jobs/:id/files/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[\w.-]+$/.test(name)) return c.json({ error: { code: "bad_name" } }, 400);
  return sendFile(c, join(jobDir(c.req.param("id")), name), "application/json; charset=utf-8");
});

app.get("/v1/jobs/:id/project/*", async (c) => {
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
  const rows = await Promise.all(
    (await listRows(sql)).map(async (r) => ({
      ...r,
      plan_source: r.job_id ? (await readStatus(r.job_id))?.plan_source || null : null,
    })),
  );
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
  const runAtError = validateRunAt(runAt);
  if (runAtError) return c.html(renderPage.scheduleError(runAtError), 400);

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
  const takenNames = new Set();
  const safeImages = images
    .map((f) => ({ ...f, safeName: basename(f.file.name).replace(/[^\p{L}\p{N}._-]/gu, "_") }))
    .filter((f) => f.safeName && !f.safeName.startsWith("."))
    .map((f) => {
      let name = f.safeName;
      if (takenNames.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        let n = 2;
        while (takenNames.has(`${stem}-${n}${ext}`)) n++;
        name = `${stem}-${n}${ext}`;
      }
      takenNames.add(name);
      return { ...f, safeName: name };
    });

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

  const current = await getRow(sql, id);
  const unchanged = current && Math.abs(new Date(current.run_at).getTime() - runAt.getTime()) < 1000;
  const runAtError = unchanged ? null : validateRunAt(runAt);
  if (runAtError) return c.html(renderPage.scheduleError(runAtError), 400);

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

  if (!scheduleInputExists(id)) {
    return c.html(
      renderPage.scheduleError(
        "Lịch này đã dựng xong và file gốc đã được dọn để tiết kiệm đĩa. " +
          "Muốn dựng lại thì tạo lịch mới và tải lên giọng đọc + ảnh.",
      ),
      409,
    );
  }

  const row = await claimById(sql, id);
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
      ? `UI: http://localhost:${info.port}`
      : `UI: http://localhost:${info.port} `,
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

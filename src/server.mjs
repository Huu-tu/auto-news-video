// API + UI. Một tiến trình, một cổng.
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

// ── Bảng lịch ────────────────────────────────────────────────────────────────
// PostgreSQL giờ là bắt buộc cho tính năng lịch. Thiếu DATABASE_URL hay không
// kết nối được thì thoát rõ ràng bằng tiếng Việt — không để lộ stack trace,
// và không âm thầm chạy tiếp thiếu tính năng (không có chế độ không-database).
let sql;
try {
  sql = getSql();
  await initSchema(sql);
} catch (e) {
  // e.message của getSql() khi thiếu biến môi trường đã tự nhắc DATABASE_URL —
  // đừng lặp lại câu đó, chỉ nối hậu tố khi thông điệp gốc chưa nhắc tới.
  const hint = e.message.includes("DATABASE_URL") ? "" : " Bảng lịch cần DATABASE_URL — xem .env.example.";
  console.error(`Không kết nối được PostgreSQL: ${e.message}.${hint}`);
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

  // Trần thời gian cho cả job: ffmpeg, transcribe.py, align_script.py,
  // hyperframes render và fetch upload Drive đều không có gì tự chặn. Một
  // tiến trình con không thoát sẽ làm await runJob() treo vĩnh viễn, running
  // không được giải phóng, và hàng đợi đứng im — đặc biệt nguy hiểm khi chạy
  // theo lịch lúc 3h sáng không có ai bấm Huỷ.
  // Number("120m") hay Number("2h") đều ra NaN — setTimeout(fn, NaN) bị Node
  // ép về 1ms, giết MỌI job gần như ngay lập tức với mã "timeout" (không
  // retryable). .env.example mô tả biến này bằng phút nên rất dễ viết nhầm
  // đơn vị; chốt lại bằng Number.isFinite thay vì import numEnv() từ
  // scheduler.mjs để khỏi tạo phụ thuộc chéo không cần thiết.
  const rawTimeout = Number(process.env.JOB_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 7_200_000;
  const job = runJob(jobId, { registerChild: (c) => kids.add(c) });

  let timer = null;
  let killTimer = null;

  try {
    // KHÔNG dùng Promise.race + reject: reject sẽ ném ngay lập tức và nhảy
    // qua đoạn chờ runJob dọn dẹp, khiến mã "timeout" bị runJob ghi đè ngay
    // sau đó (render_failed chẳng hạn). Dùng promise phân xử trả về boolean.
    const timedOut = await new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
      job.then(() => resolve(false), () => resolve(false));
    });
    clearTimeout(timer);

    if (timedOut) {
      // Dùng lại đúng cơ chế của nút Huỷ: giết tiến trình con để runJob
      // thoát ra, rồi ghi đè trạng thái bằng mã "timeout".
      for (const child of kids) {
        try { child.kill("SIGTERM"); } catch { /* có thể đã chết */ }
      }
      killTimer = setTimeout(() => {
        for (const child of kids) {
          try { child.kill("SIGKILL"); } catch { /* đã chết */ }
        }
      }, 10_000);

      // Chờ runJob settle THẬT rồi mới ghi đè — nếu không nó sẽ ghi đè ngược lại.
      await job.catch(() => {});
      clearTimeout(killTimer); // child chết sạch rồi thì đừng giữ timer 10s treo

      try {
        // await job.catch() ở trên đã chờ runJob chạy hết — nếu nó kịp
        // upload Drive và ghi "done" trước khi bị SIGTERM cắt ngang (job hoàn
        // tất ở phút 119:59 chẳng hạn), đọc lại trạng thái ở đây để không ghi
        // đè thành công thành thất bại: video đã lên Drive, file local đã bị
        // pipeline dọn, ghi "failed" lúc này chỉ xoá mất link mà không cứu
        // được gì.
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
    // Chỉ ba dòng giải phóng hàng đợi ở đây — không thao tác I/O nào, để
    // patchStatus ném lỗi (đĩa đầy, file khoá...) không bao giờ chặn được
    // đường giải phóng running/pump().
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
  // Kiểm tra CÓ FILE GIỌNG ĐỌC THẬT, không chỉ thư mục tồn tại: bước ghi file
  // lúc lưu lịch tự tạo sẵn thư mục images/ rỗng trước khi ghi audio (xem
  // mkdirSync bên dưới trong POST /schedule) — nếu ghi audio hỏng giữa chừng,
  // existsSync(src) vẫn true vì thư mục rỗng đã có, và cpSync sẽ copy một thư
  // mục rỗng thay vì báo lỗi ở đây.
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

app.get("/health", (c) => {
  // Phơi phẳng hai mốc thay vì trả object: giám sát ngoài (uptime-kuma, cron +
  // curl) thường so một field kiểu số/chuỗi thời gian với "now" bằng phép trừ
  // — so với một object sẽ luôn ra NaN và không bao giờ báo động dù tick chết.
  const { startedAt, succeededAt } = lastTick();
  // succeededAt null nghĩa là server vừa khởi động, chưa tick lần nào — đó
  // KHÔNG phải tick chết, nên không được coi là stale (okAt !== null lo việc
  // này). Bộ hẹn giờ chết thật sự (tick không còn chạy) mới trả 503 — HEALTHCHECK
  // trong Dockerfile dùng curl -fsS nên -f sẽ fail đúng lúc cần báo động.
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

/**
 * Huỷ một job đang bay: rút khỏi hàng đợi nếu chưa chạy, hoặc SIGTERM các
 * tiến trình con nếu đang chạy. Tách riêng để route xoá lịch (POST
 * /schedule/:id/delete) dùng lại đúng logic này thay vì viết lại kiểu khác —
 * hai chỗ khác nhau về cách huỷ (rẽ nhánh sai queue/running) là đúng loại lỗi
 * dễ để video vẫn render và lên Drive sau khi dòng lịch đã bị xoá.
 */
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
        /* tiến trình con có thể đã chết */
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

  // Giờ nhập là giờ địa phương của server (TZ=Asia/Ho_Chi_Minh). Input type="time"
  // của trình duyệt gửi "HH:MM", nhưng chấp nhận luôn "HH:MM:SS" cho chắc — thiếu
  // giây không được ép thẳng thành "...T07:30:15:00" (Invalid Date).
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
  // Tên file ảnh do client đặt — parseBody không lọc đường dẫn. basename() bỏ
  // mọi thư mục cha (chặn "../../../src/pipeline.mjs" ghi đè ra ngoài work/),
  // rồi lọc còn ký tự an toàn. Giữ nguyên phần trước dấu chấm: storyboard tham
  // chiếu ảnh theo đúng id đó (image_1.png → id image_1). \w chỉ khớp
  // [A-Za-z0-9_] nên "ảnh1.png" bị băm thành "_nh1.png" — không khớp id trong
  // storyboard, ảnh biến mất khỏi video mà không báo gì. Dùng \p{L}\p{N} để
  // giữ chữ Unicode (có dấu), chỉ loại ký tự thật sự nguy hiểm cho đường dẫn.
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

  // Vòng 1 — chỉ storyboard. Chặn sớm để không tạo dòng rác trong DB.
  const early = validateScheduleInput({ storyboardText: storyboard, imageIds, audioDurationSec: 0 });
  if (!early.ok) return c.html(renderPage.scheduleError(early.errors.join(" · ")), 400);

  const row = await createRow(sql, { name, runAt, storyboard, note, enabled });

  const inputDir = join(scheduleDir(row.id), "input");
  const write = async (f, dest) => writeFileSync(dest, Buffer.from(await f.arrayBuffer()));

  const ext = (audio.file.name || "vo.mp3").match(/\.[a-z0-9]+$/i)?.[0] || ".mp3";
  const audioPath = join(inputDir, `vo${ext}`);

  // Đĩa đầy hay tên file lạ giữa chừng không được để lại dòng DB mồ côi trỏ
  // vào thư mục rỗng/dở — hỏng thì xoá luôn dòng vừa tạo và dọn thư mục, coi
  // như request này chưa từng xảy ra.
  try {
    mkdirSync(join(inputDir, "images"), { recursive: true });
    await write(audio.file, audioPath);
    for (const im of safeImages) await write(im.file, join(inputDir, "images", im.safeName));
  } catch (e) {
    await deleteRow(sql, row.id);
    rmSync(scheduleDir(row.id), { recursive: true, force: true });
    return c.html(renderPage.scheduleError(`Ghi file thất bại: ${e.message}`), 500);
  }

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

/**
 * Ép id trong URL về số nguyên dương tường minh, KHÔNG dựa vào việc PostgreSQL
 * tự chối chuỗi lạ khi ép sang bigint. Cột id là bigint nhưng PostgreSQL vẫn
 * chấp nhận " 12", "+12", "012" ép về 12 — trong khi scheduleDir(" 12") lại
 * trỏ ra một thư mục khác (work/schedule/ 12). Chặn ở đây trước khi id chạm
 * tới cả getRow lẫn scheduleDir, để hai nguồn sự thật (DB, thư mục file)
 * không bao giờ lệch nhau vì khác cách hiểu cùng một id.
 */
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

  // Form sửa không có ô ảnh, nên chỉ kiểm tra được text — imageIds rỗng nghĩa
  // là mọi tham chiếu ảnh trong storyboard đều bị coi là "thiếu". Đây là kiểm
  // tra nông hơn vòng tạo mới (không có audioDurationSec, không biết ảnh cũ),
  // nhưng đủ chặn storyboard rỗng hoặc sai định dạng bảng.
  const check = validateScheduleInput({ storyboardText: storyboard, imageIds: [], audioDurationSec: 0 });
  if (!check.ok) return c.html(renderPage.scheduleError(check.errors.join(" · ")), 400);

  // Sửa không đụng tới file ghi âm/ảnh — chúng đã nằm sẵn trong
  // work/schedule/<id>/input/, form sửa không có ô upload. Muốn đổi file thì
  // xoá lịch tạo lại. Nếu dòng này đang "bay" (claimed/queued/running), job đã
  // copy file + storyboard sang thư mục riêng của job từ trước, nên sửa ở đây
  // không ảnh hưởng job đang chạy — chỉ có tác dụng cho lần chạy kế tiếp.
  await updateRow(sql, id, { name, runAt, storyboard, note });

  // Sửa giờ hẹn của một dòng đã kết thúc (lỗi, bỏ lỡ, xong) là ý định chạy
  // lại — updateRow không đụng status, và claimDue chỉ nhặt status='pending',
  // nên nếu không đặt lại ở đây, form nhận, giờ hiển thị đổi, nhưng dòng đứng
  // vĩnh viễn ở trạng thái cũ và không bao giờ được nhặt lại, không báo gì.
  const cur = await getRow(sql, id);
  if (cur && ["failed", "missed", "done"].includes(cur.status)) {
    await markRow(sql, id, { status: "pending", attempts: 0, job_id: null, last_error: null });
  }

  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/run", async (c) => {
  const id = parseScheduleId(c);
  if (id === null) return c.redirect("/schedule", 303);

  // claimById là UPDATE ... WHERE status IN (...) nguyên tử: hai request "Chạy
  // ngay" gần như đồng thời, hoặc route chạm đúng lúc tick đang claimDue, chỉ
  // đúng một bên khớp WHERE và nhặt được dòng — bên kia nhận null. Trước đây
  // route đọc bằng getRow rồi mới kiểm tra status (check-then-act không
  // nguyên tử): khe hở giữa đọc và ghi đủ để cả hai bên cùng thấy 'pending'
  // và cùng tạo job — hai video từ một dòng lịch, đúng thứ FOR UPDATE SKIP
  // LOCKED trong claimDue được dựng lên để chặn nhưng đường chạy tay đi vòng
  // qua vì không claim gì cả.
  const row = await claimById(sql, id);
  if (!row) return c.redirect("/schedule", 303); // không tồn tại, hoặc đang bay

  try {
    const jobId = await createJobFromSchedule(row);
    await markRow(sql, row.id, { status: "queued", job_id: jobId, last_error: null });
  } catch (e) {
    // Dòng đã bị claimById chuyển sang 'claimed' — không đánh 'failed' ở đây
    // thì nó kẹt vĩnh viễn. Nếu tiến trình chết đúng khoảnh khắc giữa hai dòng
    // trên, reclaimStale (vòng tick) sẽ cứu nó về 'pending' sau tối đa 10 phút.
    await markRow(sql, row.id, { status: "failed", last_error: e.message.slice(0, 500) });
  }
  return c.redirect("/schedule", 303);
});

app.post("/schedule/:id/delete", async (c) => {
  const id = parseScheduleId(c);
  if (id === null) return c.redirect("/schedule", 303);
  const row = await getRow(sql, id);
  if (row) {
    // Job đang bay không tự biết dòng lịch của nó vừa bị xoá — nó vẫn render
    // 45-70 phút rồi upload lên Drive với tên theo dòng đã xoá, và không cơ
    // chế nào chạm được nó nữa nếu ta không huỷ trước. Dùng đúng logic của
    // route huỷ job (cancelJob) chứ không viết lại rẽ nhánh queue/running.
    if (row.job_id && ["queued", "running", "claimed"].includes(row.status)) {
      cancelJob(row.job_id);
    }
    // Xoá dòng DB và thư mục file trong cùng một thao tác — đây chính là
    // lý do gộp hai nút thành một: hai nguồn sự thật không được lệch nhau.
    // Dùng row.id (giá trị đã qua DB) cho scheduleDir, không dùng id thô từ
    // URL — dù ở đây hai giá trị luôn khớp vì parseScheduleId đã ép Number.
    await deleteRow(sql, row.id);
    rmSync(scheduleDir(row.id), { recursive: true, force: true });
  }
  return c.redirect("/schedule", 303);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`bantin-studio: http://localhost:${info.port}`);
  console.log(API_TOKEN ? `UI: http://localhost:${info.port}/?token=<API_TOKEN>` : "⚠ chưa đặt API_TOKEN");
});

export { app, ACTIVE };

// Worker: chạy trọn một job từ input đến MP4 trên Drive.
//
// Mọi bước là script tất định, TRỪ bước `planning` gọi Claude Code — và bước đó
// có schema gác đầu ra + fallback, nên LLM hỏng cũng không giết job.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scanForAds } from "./adscan.mjs";
import { planChapters } from "./plan.mjs";
import { driveConfigured, uploadToDrive } from "./drive.mjs";
import { imageIdFromRef, parseStoryboard, toScriptText } from "./storyboard.mjs";
import { addWarning, jobDir, log, patchStatus, readStatus, setStage } from "./store.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

// templates/ mặc định nằm cạnh src/. Khi app là thư mục con của một repo lớn
// hơn (template dùng chung ở gốc repo), trỏ lại bằng TEMPLATES_DIR trong .env.
export const TEMPLATES_DIR = process.env.TEMPLATES_DIR
  ? resolve(ROOT, process.env.TEMPLATES_DIR)
  : existsSync(join(ROOT, "templates"))
    ? join(ROOT, "templates")
    : join(ROOT, "..", "templates");

// Khoảng lặng chèn đầu/cuối audio để thẻ intro và thẻ kết có chỗ thở.
// Phải khớp giữa audio đã pad và tham số của align_script.py, nếu lệch thì
// caption trôi khỏi giọng đọc.
const LEAD = 2.6;
const TAIL = 2.4;

class JobCancelled extends Error {}

/** Chạy lệnh, stream log vào job, ném lỗi kèm đuôi stderr nếu exit != 0. */
function run(jobId, cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    log(jobId, `$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd: opts.cwd || ROOT, env: { ...process.env, ...opts.env } });
    let tail = "";

    const onData = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      for (const line of s.split("\n")) if (line.trim()) log(jobId, line);
      opts.onLine?.(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    opts.register?.(child);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolvePromise(tail);
      reject(new Error(`${cmd} exit ${code}\n${tail.slice(-800)}`));
    });
  });
}

function checkCancelled(jobId) {
  const s = readStatus(jobId);
  if (s?.cancel_requested) throw new JobCancelled("Job bị huỷ theo yêu cầu");
}

function fail(jobId, code, stage, message, retryable = false) {
  patchStatus(jobId, {
    status: "failed",
    stage: { name: "failed", progress: null, detail: null },
    error: { code, stage, message: String(message).slice(0, 2000), retryable },
  });
  log(jobId, `FAILED [${code}] ${message}`);
}

async function alert(jobId, error) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: jobId, error }),
    });
  } catch {
    /* chuông báo cháy hỏng thì cũng không được làm job hỏng theo */
  }
}

/**
 * Video đã an toàn trên Drive thì các file nặng trong thư mục job không còn
 * giá trị. Giữ lại status.json, logs.ndjson, transcript.json, chapters.json
 * (vài trăm KB) để còn tra cứu.
 *
 * CHỈ gọi khi upload Drive THÀNH CÔNG — nếu không thì đây là bản sao duy nhất.
 */
export function cleanupAfterUpload(dir, onLog = () => {}) {
  const targets = [
    "output.mp4", "vo.mp3", "vo16k.wav", "vo-cut.mp3", "vo-final.mp3",
    "project", "input",
  ];

  let freed = 0;
  for (const name of targets) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      freed += dirSize(p);
      rmSync(p, { recursive: true, force: true });
    } catch (e) {
      onLog(`không xoá được ${name}: ${e.message}`);
    }
  }
  onLog(`dọn ${(freed / 1048576).toFixed(0)} MB (video đã an toàn trên Drive)`);
  return freed;
}

function dirSize(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, f) => n + dirSize(join(p, f)), 0);
}

export async function runJob(jobId, { registerChild } = {}) {
  const dir = jobDir(jobId);
  const inputDir = join(dir, "input");
  const projDir = join(dir, "project");
  const t0 = Date.now();
  const timings = {};
  const mark = (name, since) => (timings[name] = Math.round((Date.now() - since) / 1000));

  const status = readStatus(jobId);
  const opts = status.options || {};
  const brand = status.brand || {};
  const tpl = join(TEMPLATES_DIR, status.template || "vn-news-vertical");

  try {
    mkdirSync(projDir, { recursive: true });

    // ── 1. Storyboard → script.txt + bản đồ ảnh ─────────────────────────────
    let step = Date.now();
    setStage(jobId, "transcribing", 0, "chuẩn bị input");
    const sbPath = join(inputDir, "storyboard.md");
    if (!existsSync(sbPath)) throw Object.assign(new Error("Thiếu storyboard"), { code: "bad_input" });

    const { rows } = parseStoryboard(readFileSync(sbPath, "utf8"));
    if (rows.length === 0) {
      throw Object.assign(new Error("Không đọc được dòng lời thoại nào từ storyboard — kiểm tra bảng markdown"), {
        code: "bad_input",
      });
    }
    writeFileSync(join(dir, "script.txt"), toScriptText(rows));
    log(jobId, `storyboard: ${rows.length} dòng lời thoại`);

    // Ảnh client gửi lên: input/images/<id>.<ext>. Đường dẫn trong chapters phải
    // tính từ CWD lúc chạy build.mjs (= thư mục job), nên dùng đường dẫn tương đối.
    const imgDir = join(inputDir, "images");
    const images = existsSync(imgDir)
      ? readdirSync(imgDir).map((f) => ({
          id: f.replace(/\.[a-z0-9]+$/i, ""),
          relPath: join("input", "images", f),
        }))
      : [];
    log(jobId, `ảnh: ${images.length}`);

    // ── 2. Chuẩn hoá audio ──────────────────────────────────────────────────
    checkCancelled(jobId);
    const rawAudio = readdirSync(inputDir).find((f) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f));
    if (!rawAudio) throw Object.assign(new Error("Thiếu file giọng đọc"), { code: "bad_input" });

    const voMp3 = join(dir, "vo.mp3");
    const vo16k = join(dir, "vo16k.wav");
    await run(jobId, "ffmpeg", ["-y", "-v", "error", "-i", join(inputDir, rawAudio), "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-ac", "1", voMp3], { register: registerChild });
    await run(jobId, "ffmpeg", ["-y", "-v", "error", "-i", voMp3, "-ar", "16000", "-ac", "1", vo16k], { register: registerChild });

    // ── 3. Transcribe ───────────────────────────────────────────────────────
    checkCancelled(jobId);
    setStage(jobId, "transcribing", 0.1, "faster-whisper");
    const asrPath = join(dir, "asr.json");
    await run(
      jobId,
      "python3",
      [join(tpl, "transcribe.py"), vo16k, asrPath, process.env.WHISPER_MODEL || "large-v3", process.env.WHISPER_LANG || "vi"],
      { register: registerChild },
    );
    // ASR không ra segment nào = file không có tiếng nói (hoặc sai ngôn ngữ).
    // Chặn ngay ở đây: đi tiếp thì align_script.py chết với thông báo khó hiểu.
    const asr = JSON.parse(readFileSync(asrPath, "utf8"));
    if (!asr.segments || asr.segments.length === 0) {
      throw Object.assign(new Error(`Không nhận ra tiếng nói nào trong ${rawAudio} (${asr.duration || 0}s, ngôn ngữ ${process.env.WHISPER_LANG || "vi"})`), {
        code: "asr_empty",
      });
    }
    log(jobId, `ASR: ${asr.segments.length} segment / ${asr.duration}s`);
    mark("transcribing", step);

    // ── 4. Dò quảng cáo TTS ─────────────────────────────────────────────────
    checkCancelled(jobId);
    step = Date.now();
    setStage(jobId, "ad_scan", 0.3, "dò quảng cáo TTS");
    let asrForAlign = asrPath;
    let audioForBuild = voMp3;

    if (opts.ad_scan !== false) {
      const { cuts, findings, suppressed } = await scanForAds(voMp3, asr, (m) => log(jobId, m));
      if (suppressed) {
        addWarning(jobId, "ad_scan_suppressed", `Bỏ qua ${suppressed.cuts.length} lát cắt nghi dò sai (tổng ${suppressed.removed.toFixed(1)}s)`);
      }
      if (cuts.length) {
        writeFileSync(join(dir, "cuts.json"), JSON.stringify(cuts, null, 1));
        const cutMp3 = join(dir, "vo-cut.mp3");
        const cutJson = join(dir, "asr-cut.json");
        await run(jobId, "python3", [join(tpl, "cut_audio.py"), voMp3, join(dir, "cuts.json"), asrPath, cutMp3, cutJson], { register: registerChild });
        asrForAlign = cutJson;
        audioForBuild = cutMp3;
        for (const f of findings) addWarning(jobId, "ads_detected", f);
      } else {
        log(jobId, "không phát hiện quảng cáo");
      }
    }
    mark("ad_scan", step);

    // ── 5. Align kịch bản (caption đúng 100%) ───────────────────────────────
    checkCancelled(jobId);
    step = Date.now();
    setStage(jobId, "aligning", 0.35, "khớp kịch bản với timing");
    const transcriptPath = join(dir, "transcript.json");
    try {
      await run(jobId, "python3", [join(tpl, "align_script.py"), asrForAlign, join(dir, "script.txt"), transcriptPath, String(LEAD), String(TAIL)], { register: registerChild });
    } catch (e) {
      // align_script.py thoát sớm khi khớp < 50% — nghĩa là kịch bản gửi lên
      // không phải nội dung của file giọng đọc này.
      throw Object.assign(e, {
        code: /alignment too weak|no word timestamps/i.test(e.message) ? "align_failed" : "internal_error",
      });
    }

    // Audio phải pad đúng bằng LEAD/TAIL đã khai với align_script.py
    const voFinal = join(dir, "vo-final.mp3");
    await run(
      jobId,
      "ffmpeg",
      ["-y", "-v", "error", "-i", audioForBuild, "-af", `adelay=${Math.round(LEAD * 1000)}:all=1,apad=pad_dur=${TAIL}`, "-c:a", "libmp3lame", "-b:a", "192k", voFinal],
      { register: registerChild },
    );
    mark("aligning", step);

    // ── 6. Planning — bước DUY NHẤT dùng LLM ────────────────────────────────
    checkCancelled(jobId);
    step = Date.now();
    setStage(jobId, "planning", 0.4, "Claude Code soạn bản đồ cảnh");
    const plan = await planChapters({
      rows,
      brand,
      images,
      bin: process.env.CLAUDE_BIN || "claude",
      fallbackOnly: process.env.PLAN_FALLBACK_ONLY === "1" || opts.plan_mode === "fallback",
      onLog: (m) => log(jobId, m),
    });
    if (plan.source === "fallback") {
      addWarning(
        jobId,
        "plan_fallback",
        plan.attempts === 0
          ? "Bố cục mặc định theo cấu hình (plan_mode=fallback) — không gọi LLM"
          : `LLM không cho ra bản đồ cảnh hợp lệ sau ${plan.attempts} lần — dùng bố cục mặc định`,
      );
    }
    writeFileSync(join(dir, "chapters.src.json"), JSON.stringify(plan.cards, null, 1));
    await run(jobId, "node", [join(tpl, "mkchapters.mjs"), join(dir, "chapters.src.json"), transcriptPath, join(dir, "chapters.json")], { register: registerChild });
    mark("planning", step);

    // ── 7. Build composition ────────────────────────────────────────────────
    checkCancelled(jobId);
    step = Date.now();
    setStage(jobId, "building", 0.45, "sinh index.html");
    await run(
      jobId,
      "node",
      [
        join(tpl, "build.mjs"),
        "--out", projDir,
        "--audio", voFinal,
        "--transcript", transcriptPath,
        "--chapters", join(dir, "chapters.json"),
        "--brand", brand.name || "BẢN TIN",
        "--brand-sub", brand.sub || "TỔNG HỢP",
        "--date", brand.date || "",
        ...(opts.fps ? ["--fps", String(opts.fps)] : []),
      ],
      { cwd: dir, register: registerChild }, // CWD = thư mục job, vì img trong chapters là đường dẫn tương đối
    );
    mark("building", step);

    // ── 8. Lint + check ─────────────────────────────────────────────────────
    checkCancelled(jobId);
    step = Date.now();
    setStage(jobId, "checking", 0.5, "hyperframes lint + check");
    const hf = ["--yes", `hyperframes@${process.env.HYPERFRAMES_VERSION || "0.7.86"}`];
    try {
      await run(jobId, "npx", [...hf, "lint"], { cwd: projDir, register: registerChild });
    } catch (e) {
      throw Object.assign(e, { code: "lint_failed" });
    }
    try {
      await run(jobId, "npx", [...hf, "check"], { cwd: projDir, register: registerChild });
    } catch (e) {
      throw Object.assign(e, { code: "check_failed" });
    }
    mark("checking", step);

    // ── 9. Render ───────────────────────────────────────────────────────────
    checkCancelled(jobId);
    step = Date.now();
    setStage(jobId, "rendering", 0.55, "render MP4");
    const outMp4 = join(dir, "output.mp4");
    try {
      await run(
        jobId,
        "npx",
        [...hf, "render", "--workers", String(opts.workers || process.env.RENDER_WORKERS || 4), "--output", outMp4],
        {
          cwd: projDir,
          register: registerChild,
          onLine: (s) => {
            // CLI in tiến độ dạng "frame 8420/13590"
            const m = s.match(/(\d+)\s*\/\s*(\d+)/);
            if (m) {
              const p = Number(m[1]) / Number(m[2]);
              if (p >= 0 && p <= 1) setStage(jobId, "rendering", 0.55 + p * 0.35, `frame ${m[1]}/${m[2]}`);
            }
          },
        },
      );
    } catch (e) {
      throw Object.assign(e, { code: "render_failed" });
    }
    if (!existsSync(outMp4)) throw Object.assign(new Error("Render xong nhưng không thấy file MP4"), { code: "render_failed" });
    mark("rendering", step);

    // ── 10. Upload Drive ────────────────────────────────────────────────────
    checkCancelled(jobId);
    step = Date.now();
    const folderId = status.drive?.folder_id || process.env.GOOGLE_DRIVE_FOLDER_ID;
    let drive = { folder_id: folderId || null, file_id: null, filename: null, link: null };

    if (driveConfigured()) {
      setStage(jobId, "uploading", 0.92, "upload Google Drive");
      const filename = (status.drive?.filename || "bantin-{date}-{job_id}.mp4")
        .replace("{date}", (brand.date || new Date().toISOString().slice(0, 10)).replace(/[^\w-]+/g, "-"))
        .replace("{job_id}", jobId);
      const file = await uploadToDrive(outMp4, {
        folderId,
        filename,
        onProgress: (p) => setStage(jobId, "uploading", 0.92 + p * 0.07, `${Math.round(p * 100)}%`),
      });
      drive = { folder_id: folderId || null, file_id: file.id, filename: file.name, link: file.webViewLink };
      log(jobId, `Drive: ${file.webViewLink}`);
      cleanupAfterUpload(dir, (m) => log(jobId, m));
    } else {
      addWarning(jobId, "drive_not_configured", "Chưa cấu hình Google Drive — video chỉ nằm trên VPS");
      log(jobId, "bỏ qua upload: thiếu credential Drive");
    }
    mark("uploading", step);

    // ── Xong ────────────────────────────────────────────────────────────────
    const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
    patchStatus(jobId, {
      status: "done",
      stage: { name: "done", progress: 1, detail: null },
      timings_sec: { ...timings, total: Math.round((Date.now() - t0) / 1000) },
      plan_source: plan.source,
      drive,
      artifacts: {
        // File local đã bị dọn sau khi upload — trỏ thẳng sang Drive.
        video_url: drive.link || `/v1/jobs/${jobId}/video`,
        duration_sec: transcript.duration,
        transcript_url: `/v1/jobs/${jobId}/files/transcript.json`,
        chapters_url: `/v1/jobs/${jobId}/files/chapters.json`,
        project_url: `/v1/jobs/${jobId}/project/`,
      },
      error: null,
    });
    log(jobId, `DONE trong ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    if (e instanceof JobCancelled) {
      patchStatus(jobId, { status: "cancelled", stage: { name: "cancelled", progress: null, detail: null } });
      log(jobId, "CANCELLED");
      return;
    }
    const code = e.code && typeof e.code === "string" ? e.code : "internal_error";
    const stage = readStatus(jobId)?.status || "unknown";
    fail(jobId, code, stage, e.message);
    await alert(jobId, { code, stage, message: String(e.message).slice(0, 500) });
  }
}

/** Danh sách template có sẵn — UI và GET /v1/templates dùng chung. */
export function listTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(TEMPLATES_DIR, d.name);
      let description = "";
      const readme = join(dir, "README.md");
      if (existsSync(readme)) {
        const lines = readFileSync(readme, "utf8").split("\n");
        description = (lines.find((l) => l.trim() && !l.startsWith("#")) || "").trim();
      }
      return {
        id: d.name,
        description,
        width: 1080,
        height: 1920,
        kinds: ["intro", "divider", "headline", "story", "stat", "chart", "image", "tiles", "quote", "keys"],
        files: readdirSync(dir),
      };
    });
}

export { copyFileSync };

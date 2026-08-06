import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { scanForAds } from "./adscan.mjs";
import { planChapters, repairChaptersWithLlm, validateChapters } from "./plan.mjs";
import { runRepairLadder } from "./repair.mjs";
import { driveConfigured, uploadToDrive } from "./drive.mjs";
import { imageIdFromRef, parseStoryboard, toScriptText } from "./storyboard.mjs";
import { WORK_DIR, addWarning, jobDir, log, patchStatus, readStatus, setStage } from "./store.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

export const TEMPLATES_DIR = process.env.TEMPLATES_DIR
  ? resolve(ROOT, process.env.TEMPLATES_DIR)
  : existsSync(join(ROOT, "templates"))
    ? join(ROOT, "templates")
    : join(ROOT, "..", "templates");

const LEAD = 2.6;
const TAIL = 2.4;

const PYTHON = process.env.PYTHON_BIN || "python3";

class JobCancelled extends Error {}

function run(jobId, cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    log(jobId, `$ ${cmd} ${args.join(" ")}`);
    const env = { PYTHONIOENCODING: "utf-8", ...process.env, ...opts.env };
    const child = spawn(cmd, args, { cwd: opts.cwd || ROOT, env });
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

async function checkCancelled(jobId) {
  const s = await readStatus(jobId);
  if (s?.cancel_requested) throw new JobCancelled("Job bị huỷ theo yêu cầu");
}

function progressReporter(jobId, minGapMs = 1000) {
  let last = 0;
  return (name, progress, detail) => {
    const now = Date.now();
    if (now - last < minGapMs) return;
    last = now;
    setStage(jobId, name, progress, detail).catch((e) => log(jobId, `không ghi được tiến độ: ${e.message}`));
  };
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function looksLikeImage(b) {
  if (b.length < 12) return false;
  const hex = b.subarray(0, 4).toString("hex");
  if (hex.startsWith("89504e47")) return true; // PNG
  if (hex.startsWith("ffd8ff")) return true; // JPEG
  if (hex.startsWith("47494638")) return true; // GIF
  if (hex.startsWith("424d")) return true; // BMP
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return true;
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return true; // AVIF/HEIC
  return false;
}

export async function downloadImageUrls(jobId, list, imgDir) {
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) return 0;

  mkdirSync(imgDir, { recursive: true });
  let ok = 0;

  for (const it of items) {
    const ten = String(it?.ten || "").split(/[\\/]/).pop().replace(/[^\w.\-]/g, "");
    const url = String(it?.url || "");

    if (!/^[\w-]+\.[a-z0-9]+$/i.test(ten) || !/^https?:\/\//i.test(url)) {
      await addWarning(jobId, "image_download_failed", `Bỏ qua mục ảnh không hợp lệ: ${JSON.stringify(it).slice(0, 120)}`);
      continue;
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${(buf.length / 1048576).toFixed(1)} MB > 10 MB`);
      const ct = res.headers.get("content-type") || "";
      if (!looksLikeImage(buf) && !/^image\//i.test(ct)) {
        throw new Error(`nội dung không phải ảnh (content-type: ${ct || "không có"}, ${buf.length} B)`);
      }
      writeFileSync(join(imgDir, ten), buf);
      ok++;
    } catch (e) {
      await addWarning(jobId, "image_download_failed", `Không tải được "${ten}": ${e.message}`);
    }
  }

  log(jobId, `tải ảnh từ URL: ${ok}/${items.length}`);
  return ok;
}

async function fail(jobId, code, stage, message, retryable = false) {
  await patchStatus(jobId, {
    status: "failed",
    stage: { name: "failed", progress: null, detail: null },
    error: { code, stage, message: String(message).slice(0, 2000), retryable },
  });
  log(jobId, `FAILED [${code}] ${message}`);
}

const CALLBACK_TRIES = 3;

async function notifyCallback(jobId, url) {
  if (!url) return;
  const s = (await readStatus(jobId)) || {};
  const body = JSON.stringify({
    job_id: jobId,
    status: s.status || "unknown",
    artifacts: s.artifacts || {},
    drive: s.drive || {},
    timings_sec: s.timings_sec || {},
    warnings: s.warnings || [],
    error: s.error || null,
    metadata: s.metadata || {},
  });

  for (let i = 1; i <= CALLBACK_TRIES; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log(jobId, `callback đã gửi (${s.status})`);
      return;
    } catch (e) {
      log(jobId, `callback hỏng lần ${i}/${CALLBACK_TRIES}: ${e.message}`);
      if (i < CALLBACK_TRIES) await new Promise((r) => setTimeout(r, i * 5000));
    }
  }
  await addWarning(jobId, "callback_failed", `Không gọi được callback_url sau ${CALLBACK_TRIES} lần — n8n sẽ đợi tới khi hết Limit Wait Time`);
}

async function alert(jobId, error) {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: jobId, error }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
  }
}

export function cleanupAfterUpload(dir, onLog = () => {}) {
  const abs = resolve(dir || "");
  if (!abs.startsWith(resolve(WORK_DIR) + sep)) {
    onLog(`từ chối dọn "${dir}" — nằm ngoài WORK_DIR`);
    return 0;
  }

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
  const reportProgress = progressReporter(jobId);

  const status = await readStatus(jobId);
  const opts = status.options || {};
  const brand = status.brand || {};
  const tpl = join(TEMPLATES_DIR, status.template || "vn-news-vertical");

  try {
    mkdirSync(projDir, { recursive: true });

    let step = Date.now();
    await setStage(jobId, "transcribing", 0, "chuẩn bị input");
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

    const imgDir = join(inputDir, "images");
    await downloadImageUrls(jobId, status.image_urls, imgDir);

    const images = existsSync(imgDir)
      ? readdirSync(imgDir).map((f) => {
          const id = f.replace(/\.[a-z0-9]+$/i, "");
          const line = rows.findIndex((r) => imageIdFromRef(r.image) === id);
          return { id, relPath: join("input", "images", f), line: line >= 0 ? line : null };
        })
      : [];
    const placed = images.filter((im) => im.line !== null).length;
    log(jobId, `ảnh: ${images.length}${images.length ? ` (${placed} khớp dòng kịch bản)` : ""}`);
    for (const im of images.filter((i) => i.line === null)) {
      await addWarning(jobId, "image_unreferenced", `Ảnh "${im.id}" không được dòng nào trong storyboard nhắc tới — LLM tự chọn chỗ đặt`);
    }

    await checkCancelled(jobId);
    const rawAudio = readdirSync(inputDir).find((f) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f));
    if (!rawAudio) throw Object.assign(new Error("Thiếu file giọng đọc"), { code: "bad_input" });

    const voMp3 = join(dir, "vo.mp3");
    const vo16k = join(dir, "vo16k.wav");
    await run(jobId, "ffmpeg", ["-y", "-v", "error", "-i", join(inputDir, rawAudio), "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-ac", "1", voMp3], { register: registerChild });
    await run(jobId, "ffmpeg", ["-y", "-v", "error", "-i", voMp3, "-ar", "16000", "-ac", "1", vo16k], { register: registerChild });

    await checkCancelled(jobId);
    await setStage(jobId, "transcribing", 0.1, "faster-whisper");
    const asrPath = join(dir, "asr.json");
    await run(
      jobId,
      PYTHON,
      [join(tpl, "transcribe.py"), vo16k, asrPath, process.env.WHISPER_MODEL || "large-v3", process.env.WHISPER_LANG || "vi"],
      { register: registerChild },
    );
    const asr = JSON.parse(readFileSync(asrPath, "utf8"));
    if (!asr.segments || asr.segments.length === 0) {
      throw Object.assign(new Error(`Không nhận ra tiếng nói nào trong ${rawAudio} (${asr.duration || 0}s, ngôn ngữ ${process.env.WHISPER_LANG || "vi"})`), {
        code: "asr_empty",
      });
    }
    log(jobId, `ASR: ${asr.segments.length} segment / ${asr.duration}s`);
    mark("transcribing", step);

    await checkCancelled(jobId);
    step = Date.now();
    await setStage(jobId, "ad_scan", 0.3, "dò quảng cáo TTS");
    let asrForAlign = asrPath;
    let audioForBuild = voMp3;

    if (opts.ad_scan !== false) {
      const { cuts, findings, suppressed } = await scanForAds(voMp3, asr, (m) => log(jobId, m));
      if (suppressed) {
        await addWarning(jobId, "ad_scan_suppressed", `Bỏ qua ${suppressed.cuts.length} lát cắt nghi dò sai (tổng ${suppressed.removed.toFixed(1)}s)`);
      }
      if (cuts.length) {
        writeFileSync(join(dir, "cuts.json"), JSON.stringify(cuts, null, 1));
        const cutMp3 = join(dir, "vo-cut.mp3");
        const cutJson = join(dir, "asr-cut.json");
        await run(jobId, PYTHON, [join(tpl, "cut_audio.py"), voMp3, join(dir, "cuts.json"), asrPath, cutMp3, cutJson], { register: registerChild });
        asrForAlign = cutJson;
        audioForBuild = cutMp3;
        for (const f of findings) await addWarning(jobId, "ads_detected", f);
      } else {
        log(jobId, "không phát hiện quảng cáo");
      }
    }
    mark("ad_scan", step);

    await checkCancelled(jobId);
    step = Date.now();
    await setStage(jobId, "aligning", 0.35, "khớp kịch bản với timing");
    const transcriptPath = join(dir, "transcript.json");
    try {
      await run(jobId, PYTHON, [join(tpl, "align_script.py"), asrForAlign, join(dir, "script.txt"), transcriptPath, String(LEAD), String(TAIL)], { register: registerChild });
    } catch (e) {
      throw Object.assign(e, {
        code: /alignment too weak|no word timestamps/i.test(e.message) ? "align_failed" : "internal_error",
      });
    }

    const voFinal = join(dir, "vo-final.mp3");
    await run(
      jobId,
      "ffmpeg",
      ["-y", "-v", "error", "-i", audioForBuild, "-af", `adelay=${Math.round(LEAD * 1000)}:all=1,apad=pad_dur=${TAIL}`, "-c:a", "libmp3lame", "-b:a", "192k", voFinal],
      { register: registerChild },
    );
    mark("aligning", step);

    await checkCancelled(jobId);
    step = Date.now();
    await setStage(jobId, "planning", 0.4, "Claude Code soạn bản đồ cảnh");
    const plan = await planChapters({
      rows,
      brand,
      images,
      bin: process.env.CLAUDE_BIN || "claude",
      fallbackOnly: process.env.PLAN_FALLBACK_ONLY === "1" || opts.plan_mode === "fallback",
      onLog: (m) => log(jobId, m),
    });
    if (plan.source === "fallback") {
      await addWarning(
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

    await checkCancelled(jobId);
    step = Date.now();
    await setStage(jobId, "building", 0.45, "sinh index.html");
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
      { cwd: dir, register: registerChild }, 
    );
    mark("building", step);

    await checkCancelled(jobId);
    step = Date.now();
    await setStage(jobId, "checking", 0.5, "hyperframes check + thang sửa lỗi");
    const hf = ["--yes", `hyperframes@${process.env.HYPERFRAMES_VERSION || "0.7.86"}`];
    const sizeOverridesPath = join(dir, "size-overrides.json");
    const chaptersSrcPath = join(dir, "chapters.src.json");

    const runCheck = async () => {
      let raw = "";
      try {
        await run(jobId, "npx", [...hf, "check", "--json"], {
          cwd: projDir,
          register: registerChild,
          onLine: (s) => (raw += s),
        });
      } catch {
      }
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) {
        throw Object.assign(new Error("check --json không trả JSON đọc được"), { code: "check_failed" });
      }
      return JSON.parse(raw.slice(start, end + 1));
    };

    const rebuild = async ({ overrides, chapters }) => {
      writeFileSync(sizeOverridesPath, JSON.stringify(overrides, null, 1));
      writeFileSync(chaptersSrcPath, JSON.stringify(chapters, null, 1));
      await run(jobId, "node", [join(tpl, "mkchapters.mjs"), chaptersSrcPath, transcriptPath, join(dir, "chapters.json")], { register: registerChild });
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
          "--size-overrides", sizeOverridesPath,
          ...(opts.fps ? ["--fps", String(opts.fps)] : []),
        ],
        { cwd: dir, register: registerChild },
      );
    };

    const repairWithLlm = async ({ findings, chapters }) => {
      const cards = await repairChaptersWithLlm({
        findings,
        chapters,
        bin: process.env.CLAUDE_BIN || "claude",
        onLog: (m) => log(jobId, m),
      });
      if (!cards) return null;
      const { ok, errors } = validateChapters(cards, rows.length);
      if (!ok) {
        log(jobId, `bậc 2: schema sai — ${errors.slice(0, 3).join("; ")}`);
        return null;
      }
      return cards;
    };

    const ladder = await runRepairLadder({
      runCheck,
      rebuild,
      repairWithLlm,
      chapters: plan.cards,
      onLog: (m) => log(jobId, m),
    });

    writeFileSync(
      join(dir, "repair.json"),
      JSON.stringify({ repairs: ladder.repairs, overrides: ladder.overrides, remaining: ladder.quality }, null, 1),
    );
    await patchStatus(jobId, { repairs: ladder.repairs });

    if (ladder.blocking.length) {
      const first = ladder.blocking[0];
      throw Object.assign(
        new Error(`${ladder.blocking.length} lỗi chặn cứng, đầu tiên: [${first.section}] ${first.code} — ${first.message || ""}`),
        { code: "check_failed" },
      );
    }
    if (ladder.quality.length) {
      await addWarning(
        jobId,
        "quality_degraded",
        `Còn ${ladder.quality.length} lỗi chất lượng sau khi tự sửa (${ladder.quality.map((f) => f.code).join(", ")}) — vẫn render`,
      );
    }
    mark("checking", step);

    await checkCancelled(jobId);
    step = Date.now();
    await setStage(jobId, "rendering", 0.55, "render MP4");
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
            const m = s.match(/(\d+)\s*\/\s*(\d+)/);
            if (m) {
              const p = Number(m[1]) / Number(m[2]);
              if (p >= 0 && p <= 1) reportProgress("rendering", 0.55 + p * 0.35, `frame ${m[1]}/${m[2]}`);
            }
          },
        },
      );
    } catch (e) {
      throw Object.assign(e, { code: "render_failed" });
    }
    if (!existsSync(outMp4)) throw Object.assign(new Error("Render xong nhưng không thấy file MP4"), { code: "render_failed" });
    mark("rendering", step);

    await checkCancelled(jobId);
    step = Date.now();
    const folderId = status.drive?.folder_id || process.env.GOOGLE_DRIVE_FOLDER_ID;
    let drive = { folder_id: folderId || null, file_id: null, filename: null, link: null };

    if (driveConfigured()) {
      await setStage(jobId, "uploading", 0.92, "upload Google Drive");
      const filename = (status.drive?.filename || "bantin-{date}-{job_id}.mp4")
        .replace("{date}", (brand.date || new Date().toISOString().slice(0, 10)).replace(/[^\w-]+/g, "-"))
        .replace("{job_id}", jobId);
      const file = await uploadToDrive(outMp4, {
        folderId,
        filename,
        onProgress: (p) => reportProgress("uploading", 0.92 + p * 0.07, `${Math.round(p * 100)}%`),
      });
      drive = { folder_id: folderId || null, file_id: file.id, filename: file.name, link: file.webViewLink };
      log(jobId, `Drive: ${file.webViewLink}`);
      cleanupAfterUpload(dir, (m) => log(jobId, m));
    } else {
      await addWarning(jobId, "drive_not_configured", "Chưa cấu hình Google Drive — video chỉ nằm trên VPS");
      log(jobId, "bỏ qua upload: thiếu credential Drive");
    }
    mark("uploading", step);

    const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
    await patchStatus(jobId, {
      status: "done",
      stage: { name: "done", progress: 1, detail: null },
      timings_sec: { ...timings, total: Math.round((Date.now() - t0) / 1000) },
      plan_source: plan.source,
      drive,
      artifacts: {
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
      await patchStatus(jobId, { status: "cancelled", stage: { name: "cancelled", progress: null, detail: null } });
      log(jobId, "CANCELLED");
      return;
    }
    const code = e.code && typeof e.code === "string" ? e.code : "internal_error";
    const stage = (await readStatus(jobId))?.status || "unknown";
    await fail(jobId, code, stage, e.message);
    await alert(jobId, { code, stage, message: String(e.message).slice(0, 500) });
  } finally {
    await notifyCallback(jobId, status.callback_url);
  }
}

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

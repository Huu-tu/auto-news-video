import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const GAP_MIN = 3.0; 
const TAIL_MIN = 2.0; 
const SPEECH_DB = -40; 
const CUT_GAP = 0.6; 
const MAX_CUT_RATIO = 0.33; 

export async function probeDuration(file) {
  const { stdout } = await pexec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  return Number(stdout.trim());
}

export async function meanVolume(file, from, to) {
  const dur = Math.max(0.05, to - from);
  try {
    const { stderr } = await pexec("ffmpeg", [
      "-v", "info",
      "-ss", String(from),
      "-t", String(dur),
      "-i", file,
      "-af", "volumedetect",
      "-f", "null", "-",
    ]);
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export async function scanForAds(audioPath, transcript, onLog = () => {}) {
  const segs = transcript.segments || [];
  const duration = await probeDuration(audioPath);
  const cuts = [];
  const findings = [];

  if (segs.length === 0) {
    onLog("transcript rỗng — bỏ qua dò quảng cáo");
    return { cuts, findings, duration };
  }

  for (let i = 1; i < segs.length; i++) {
    const gap = segs[i].start - segs[i - 1].end;
    if (gap < GAP_MIN) continue;

    const db = await meanVolume(audioPath, segs[i - 1].end, segs[i].start);
    onLog(`gap ${gap.toFixed(1)}s tại ${segs[i - 1].end.toFixed(2)}s → mean ${db ?? "?"} dB`);
    if (db !== null && db > SPEECH_DB) {
      cuts.push({
        from: Number(segs[i - 1].end.toFixed(2)),
        to: Number(segs[i].start.toFixed(2)),
        gap: CUT_GAP,
        why: `Có tiếng nói trong khoảng lặng ${gap.toFixed(1)}s (mean ${db} dB) — nghi quảng cáo TTS`,
      });
      findings.push(`Quảng cáo giữa file tại ${segs[i - 1].end.toFixed(2)}s–${segs[i].start.toFixed(2)}s (${db} dB)`);
    }
  }

  const lastEnd = segs.length ? segs[segs.length - 1].end : 0;
  const tail = duration - lastEnd;
  if (tail >= TAIL_MIN) {
    const db = await meanVolume(audioPath, lastEnd, duration);
    onLog(`đuôi ${tail.toFixed(1)}s sau ${lastEnd.toFixed(2)}s → mean ${db ?? "?"} dB`);
    if (db !== null && db > SPEECH_DB) {
      cuts.push({
        from: Number(lastEnd.toFixed(2)),
        to: Number(duration.toFixed(2)),
        gap: 0,
        why: `Đuôi file còn tiếng nói ${tail.toFixed(1)}s (mean ${db} dB) — nghi quảng cáo TTS`,
      });
      findings.push(`Quảng cáo cuối file từ ${lastEnd.toFixed(2)}s (${db} dB)`);
    }
  }

  cuts.sort((a, b) => a.from - b.from);

  const removed = cuts.reduce((s, c) => s + (c.to - c.from - c.gap), 0);
  if (removed > duration * MAX_CUT_RATIO) {
    onLog(`bỏ qua ${cuts.length} lát cắt: tổng ${removed.toFixed(1)}s > ${Math.round(MAX_CUT_RATIO * 100)}% file (${duration.toFixed(1)}s) — nghi dò sai`);
    return { cuts: [], findings: [], duration, suppressed: { cuts, removed } };
  }

  return { cuts, findings, duration };
}

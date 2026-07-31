// Tự động phát hiện quảng cáo do nhà cung cấp TTS chèn vào file giọng đọc.
//
// Bối cảnh: TTS tiếng Việt bản free (vb.vn…) chèn câu quảng cáo vào giữa hoặc
// cuối file. VAD của whisper bỏ qua nó, nên nó KHÔNG có trong transcript nhưng
// VẪN NẰM TRONG AUDIO — dựng ra là video có tiếng quảng cáo mà caption không có.
//
// Hai kiểm tra, chạy cả hai (đây là bản tự động hoá của bước audit thủ công):
//   1. Khoảng trống > GAP_MIN giây giữa hai segment liên tiếp.
//   2. Đuôi file sau segment cuối: im lặng thật ≈ −91 dB, có tiếng nói ≈ −20 dB.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

const GAP_MIN = 3.0; // giây — khoảng lặng đáng ngờ giữa hai segment
const TAIL_MIN = 2.0; // giây — đuôi ngắn hơn thì không đáng soi
const SPEECH_DB = -40; // mean_volume cao hơn ngưỡng này = có tiếng nói, không phải im lặng
const CUT_GAP = 0.6; // giây im lặng chèn lại chỗ vừa cắt, giữ nhịp tự nhiên
const MAX_CUT_RATIO = 0.33; // cắt quá tỷ lệ này của file = nghi heuristic dò sai, bỏ hết

export async function probeDuration(file) {
  const { stdout } = await pexec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    file,
  ]);
  return Number(stdout.trim());
}

/** mean_volume (dB) của một cửa sổ thời gian. -91 ≈ im lặng tuyệt đối. */
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

/**
 * @returns {{ cuts: Array<{from:number,to:number,gap:number,why:string}>, findings: string[] }}
 */
export async function scanForAds(audioPath, transcript, onLog = () => {}) {
  const segs = transcript.segments || [];
  const duration = await probeDuration(audioPath);
  const cuts = [];
  const findings = [];

  // Không có segment nào thì không có gì để so — mọi thứ sau "segment cuối" là
  // cả file, và cắt theo đó sẽ xoá sạch giọng đọc. Để bước sau báo lỗi asr_empty.
  if (segs.length === 0) {
    onLog("transcript rỗng — bỏ qua dò quảng cáo");
    return { cuts, findings, duration };
  }

  // ── 1. Khoảng trống giữa các segment ──────────────────────────────────────
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

  // ── 2. Đuôi file sau segment cuối ─────────────────────────────────────────
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

  // Chốt an toàn: heuristic dB sai một lần mà cắt hết file thì job ra video câm.
  // Quảng cáo TTS thực tế chỉ vài giây; cắt quá 1/3 file là dấu hiệu dò sai.
  const removed = cuts.reduce((s, c) => s + (c.to - c.from - c.gap), 0);
  if (removed > duration * MAX_CUT_RATIO) {
    onLog(`bỏ qua ${cuts.length} lát cắt: tổng ${removed.toFixed(1)}s > ${Math.round(MAX_CUT_RATIO * 100)}% file (${duration.toFixed(1)}s) — nghi dò sai`);
    return { cuts: [], findings: [], duration, suppressed: { cuts, removed } };
  }

  return { cuts, findings, duration };
}

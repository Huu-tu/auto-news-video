import { imageIdFromRef, parseStoryboard } from "./storyboard.mjs";

const SYLLABLES_PER_MIN = 150;
const DURATION_TOLERANCE = 0.3; 

function graceMs() {
  const h = Number(process.env.SCHEDULE_GRACE_HOURS);
  return (Number.isFinite(h) ? h : 8) * 3600 * 1000;
}

export function validateRunAt(runAt, now = new Date()) {
  if (!(runAt instanceof Date) || Number.isNaN(runAt.getTime())) return "Ngày giờ không hợp lệ";
  const late = now.getTime() - runAt.getTime();
  const grace = graceMs();
  if (late <= grace) return null;

  const mins = Math.round(late / 60000);
  const when =
    mins < 60 ? `${mins} phút` : mins < 2880 ? `${Math.round(mins / 60)} tiếng` : `${Math.round(mins / 1440)} ngày`;
  return `Giờ hẹn đã qua ${when} trước, vượt ngưỡng chạy bù ${grace / 3600000} tiếng nên sẽ bị bỏ lỡ — chọn thời điểm khác, hoặc dùng "Chạy ngay" nếu muốn dựng luôn`;
}

export function validateScheduleInput({ storyboardText, imageIds = [], audioDurationSec = 0 }) {
  const errors = [];
  const warnings = [];

  const { rows } = parseStoryboard(storyboardText || "");

  if (rows.length === 0) {
    errors.push("Không đọc được dòng lời thoại nào từ storyboard — kiểm tra bảng markdown có cột 'Lời thoại' chưa");
    return { ok: false, errors, warnings, lineCount: 0, referencedImages: [] };
  }

  const referencedImages = [...new Set(rows.map((r) => imageIdFromRef(r.image)).filter(Boolean))];
  for (const id of referencedImages) {
    if (!imageIds.includes(id)) {
      warnings.push(`Storyboard tham chiếu ảnh "${id}" nhưng chưa upload — cảnh đó sẽ thiếu hình`);
    }
  }

  if (audioDurationSec > 0) {
    const syllables = rows.reduce((n, r) => n + r.text.split(/\s+/).filter(Boolean).length, 0);
    const estimated = (syllables / SYLLABLES_PER_MIN) * 60;
    const off = Math.abs(audioDurationSec - estimated) / estimated;

    if (off > DURATION_TOLERANCE) {
      warnings.push(
        `File ghi âm dài ${Math.round(audioDurationSec)}s nhưng kịch bản ước tính ${Math.round(estimated)}s ` +
          `— lệch ${Math.round(off * 100)}%. Kiểm tra xem file ghi âm có đúng là bản đọc của storyboard này không.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, lineCount: rows.length, referencedImages };
}

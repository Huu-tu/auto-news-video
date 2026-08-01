// Kiểm tra dữ liệu ngay lúc người dùng bấm Lưu, trước khi tốn một phút CPU nào.
//
// Đây là lợi ích lớn nhất của việc nhập liệu qua UI thay vì bảng tính: ba lỗi
// dưới đây vốn chỉ lộ ra sau 25-60 phút chạy, giờ lộ ra sau 2 giây.
import { imageIdFromRef, parseStoryboard } from "./storyboard.mjs";

// Tốc độ đọc tham khảo của giọng TTS tiếng Việt. Âm tiết ≈ từ cách nhau bởi
// khoảng trắng, nên đếm từ là đủ chính xác cho một ước lượng thô.
const SYLLABLES_PER_MIN = 150;
const DURATION_TOLERANCE = 0.3; // lệch quá 30% thì cảnh báo

/**
 * @returns {{ ok: boolean, errors: string[], warnings: string[],
 *             lineCount: number, referencedImages: string[] }}
 *   errors   — chặn lưu
 *   warnings — hiện nổi bật nhưng vẫn cho lưu
 */
export function validateScheduleInput({ storyboardText, imageIds = [], audioDurationSec = 0 }) {
  const errors = [];
  const warnings = [];

  const { rows } = parseStoryboard(storyboardText || "");

  // ── 1. Storyboard có đọc được không ──────────────────────────────────────
  if (rows.length === 0) {
    errors.push("Không đọc được dòng lời thoại nào từ storyboard — kiểm tra bảng markdown có cột 'Lời thoại' chưa");
    return { ok: false, errors, warnings, lineCount: 0, referencedImages: [] };
  }

  // ── 2. Ảnh storyboard nhắc tới đã upload đủ chưa ─────────────────────────
  const referencedImages = [...new Set(rows.map((r) => imageIdFromRef(r.image)).filter(Boolean))];
  for (const id of referencedImages) {
    if (!imageIds.includes(id)) {
      warnings.push(`Storyboard tham chiếu ảnh "${id}" nhưng chưa upload — cảnh đó sẽ thiếu hình`);
    }
  }

  // ── 3. Thời lượng audio có khớp kịch bản không ───────────────────────────
  // Lệch lớn = file ghi âm không phải bản đọc của storyboard này. Chạy thật
  // sẽ ra align_failed sau ~25 phút, hoặc tệ hơn là video dài mà caption chỉ
  // có ở một đoạn ngắn.
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

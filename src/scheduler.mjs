// Bộ hẹn giờ — quyết định dòng lịch nào được chạy, chạy bù, hay bỏ lỡ.
//
// Phần trên file là HÀM THUẦN: không đọc DB, không ghi file, không gọi
// Date.now(). Mọi mốc thời gian đi vào qua tham số. Nhờ vậy test được biên
// giới nửa đêm và "trễ đúng 8 tiếng 1 phút" mà không phải chờ thật.

/** Mã lỗi đáng thử lại — xem bảng trong spec mục 3. */
export const RETRYABLE_CODES = new Set(["interrupted", "render_failed", "internal_error"]);

/**
 * @returns {"run"|"wait"|"miss"}
 *   run  — đến hạn, còn trong ngưỡng chạy bù
 *   wait — chưa tới giờ, đang tắt, hoặc không ở trạng thái pending
 *   miss — quá ngưỡng, sẽ không bao giờ chạy
 */
export function decideAction({ now, runAt, enabled, status, graceMs }) {
  if (!enabled) return "wait";
  if (status !== "pending") return "wait";

  const late = now.getTime() - runAt.getTime();
  if (late < 0) return "wait";
  return late > graceMs ? "miss" : "run";
}

/**
 * Lỗi dữ liệu (storyboard sai, audio câm) chạy lại 100 lần vẫn hỏng y hệt,
 * mà mỗi lần tốn 45-70 phút CPU và chặn các dòng lịch phía sau.
 */
export function isRetryable(code, attempts, maxAttempts) {
  if (attempts >= maxAttempts) return false;
  return RETRYABLE_CODES.has(code);
}

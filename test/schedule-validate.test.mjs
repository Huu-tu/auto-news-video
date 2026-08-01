import { test } from "node:test";
import assert from "node:assert/strict";

import { validateScheduleInput } from "../src/schedule-validate.mjs";
import { brandFromParams, parseStoryboard } from "../src/storyboard.mjs";

const SB = `## Thông số dựng

- **Thương hiệu:** BẢN TIN · THỜI SỰ — trung lập
- **Ngày ghi trên thanh trên cùng (topbar):** 27 · 07 — ngày phát

| # | Thời điểm | Lời thoại | Thời lượng | Hình ảnh gợi ý | Ghi chú chuyển cảnh |
| --- | --- | --- | --- | --- | --- |
| — | nghỉ 1,2s | — | — | — | Cut |
| 16 | 3:15 | "Giá vàng thế giới sáng nay tăng mạnh lên sát bốn nghìn một trăm đô la một ounce." | 14s | /prompts /image/image_1.png | Giữ hình |
| 17 | 3:29 | "Đồng yên Nhật rơi xuống mức thấp nhất trong bốn mươi năm so với đô la Mỹ." | 16s | /prompts /image/image_2.png | Cut |
`;

test("chặn khi storyboard không có dòng thoại nào", () => {
  const r = validateScheduleInput({ storyboardText: "# Chỉ có tiêu đề", imageIds: [], audioDurationSec: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.lineCount, 0);
  assert.match(r.errors[0], /lời thoại/i);
});

test("đọc đúng số dòng thoại, bỏ dòng nghỉ", () => {
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1", "image_2"],
    audioDurationSec: 30,
  });
  assert.equal(r.ok, true);
  assert.equal(r.lineCount, 2);
  assert.deepEqual(r.referencedImages, ["image_1", "image_2"]);
});

test("cảnh báo khi thiếu ảnh mà storyboard tham chiếu", () => {
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1"],
    audioDurationSec: 30,
  });
  assert.equal(r.ok, true, "thiếu ảnh chỉ cảnh báo, không chặn lưu");
  assert.equal(r.warnings.filter((w) => w.includes("image_2")).length, 1);
});

test("cảnh báo khi audio dài hơn kịch bản quá nhiều", () => {
  // 2 dòng ~26 từ  ->  ước tính ~10s. Audio 887s = lệch cực lớn.
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1", "image_2"],
    audioDurationSec: 887,
  });
  assert.equal(r.ok, true, "lệch thời lượng chỉ cảnh báo");
  assert.equal(r.warnings.some((w) => /thời lượng|lệch/i.test(w)), true);
});

test("không cảnh báo thời lượng khi khớp nhau", () => {
  const r = validateScheduleInput({
    storyboardText: SB,
    imageIds: ["image_1", "image_2"],
    audioDurationSec: 11,
  });
  assert.equal(r.warnings.some((w) => /lệch/i.test(w)), false);
});

test("brandFromParams tách được tên, chuyên mục và ngày", () => {
  const { params } = parseStoryboard(SB);
  assert.deepEqual(brandFromParams(params), { name: "BẢN TIN", sub: "THỜI SỰ", date: "27 · 07" });
});

test("brandFromParams rơi về mặc định khi storyboard không khai", () => {
  assert.deepEqual(brandFromParams({}), { name: "BẢN TIN", sub: "TỔNG HỢP", date: "" });
});

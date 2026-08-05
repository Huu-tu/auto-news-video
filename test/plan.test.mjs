import { test } from "node:test";
import assert from "node:assert/strict";

import { validateChapters, fallbackChapters, HEAD_MAX } from "../src/plan.mjs";

const introCard = (head) => ({ line: "intro", kind: "intro", kicker: "ĐIỂM TIN NHANH", head, sub: "" });
const storyCard = (head) => ({ line: 0, kind: "story", cat: "THỜI SỰ", head, sub: "x" });

test("HEAD_MAX khai đủ ngưỡng cho các kind có head", () => {
  assert.equal(HEAD_MAX.intro, 28);
  assert.equal(HEAD_MAX.divider, 40);
  assert.equal(HEAD_MAX.story, 60);
  assert.equal(HEAD_MAX.quote, 120);
});

test("chặn head intro dài hơn 28 ký tự", () => {
  const head = "SJC: TỪ ĐỘC QUYỀN VÀNG MIẾNG ĐẾN BÊ BỐI CHẤN ĐỘNG";
  const { ok, errors } = validateChapters([introCard(head)], 1);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /head dài 49 ký tự, tối đa 28/.test(e)), true);
});

test("nhận head intro đúng 28 ký tự", () => {
  const head = "A".repeat(28);
  const { ok } = validateChapters([introCard(head)], 1);
  assert.equal(ok, true);
});

test("chặn head story dài hơn 60 ký tự", () => {
  const { ok, errors } = validateChapters([introCard("BẢN TIN"), storyCard("B".repeat(61))], 1);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /head dài 61 ký tự, tối đa 60/.test(e)), true);
});

test("chặn label của stat dài hơn 40 ký tự", () => {
  const card = { line: 0, kind: "stat", cat: "KINH TẾ", value: "6.255", unit: "tỷ", label: "C".repeat(41) };
  const { ok, errors } = validateChapters([introCard("BẢN TIN"), card], 1);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /label dài 41 ký tự, tối đa 40/.test(e)), true);
});

test("fallbackChapters tự nó phải qua được validateChapters", () => {
  const rows = [
    { text: "Giá vàng thế giới sáng nay tăng mạnh lên sát bốn nghìn một trăm đô la một ounce, mức cao nhất từ trước tới nay." },
    { text: "Đồng yên Nhật rơi xuống mức thấp nhất trong bốn mươi năm so với đô la Mỹ." },
  ];
  const cards = fallbackChapters(rows, { name: "BẢN TIN", sub: "THỜI SỰ", date: "" });
  const { ok, errors } = validateChapters(cards, rows.length);
  assert.equal(ok, true, `fallback không được tự vi phạm schema: ${errors.join("; ")}`);
});

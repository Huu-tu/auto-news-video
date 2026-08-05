import { test } from "node:test";
import assert from "node:assert/strict";

import { repairBadge } from "../src/ui.mjs";

test("không có sửa chữa thì không hiện badge", () => {
  assert.equal(repairBadge(undefined), "");
  assert.equal(repairBadge([]), "");
});

test("đếm riêng sửa tất định và sửa bằng LLM", () => {
  const b = repairBadge([
    { rung: 1, ok: true },
    { rung: 1, ok: true },
    { rung: 2, ok: true },
  ]);
  assert.match(b, /2 tự sửa/);
  assert.match(b, /1 LLM sửa/);
});

test("đếm cả lần sửa thất bại", () => {
  const b = repairBadge([{ rung: 2, ok: false, error: "từ chối" }]);
  assert.match(b, /1 không sửa được/);
});

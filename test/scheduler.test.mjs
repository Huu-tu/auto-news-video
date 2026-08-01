import { test } from "node:test";
import assert from "node:assert/strict";

import { decideAction, isRetryable } from "../src/scheduler.mjs";

const GRACE = 8 * 3600 * 1000; // 8 tiếng
const at = (s) => new Date(s);

test("decideAction: chưa tới giờ thì chờ", () => {
  const r = decideAction({
    now: at("2026-08-02T08:59:00+07:00"),
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "wait");
});

test("decideAction: đúng giờ thì chạy", () => {
  const r = decideAction({
    now: at("2026-08-02T09:00:00+07:00"),
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "run");
});

test("decideAction: trễ trong ngưỡng thì vẫn chạy bù", () => {
  const r = decideAction({
    now: at("2026-08-02T16:59:00+07:00"), // trễ 7h59
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "run");
});

test("decideAction: trễ quá ngưỡng thì bỏ lỡ", () => {
  const r = decideAction({
    now: at("2026-08-02T17:01:00+07:00"), // trễ 8h01
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: true, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "miss");
});

test("decideAction: tắt thì luôn chờ, kể cả quá hạn", () => {
  const r = decideAction({
    now: at("2026-08-03T09:00:00+07:00"),
    runAt: at("2026-08-02T09:00:00+07:00"),
    enabled: false, status: "pending", graceMs: GRACE,
  });
  assert.equal(r, "wait");
});

test("decideAction: trạng thái không phải pending thì không đụng tới", () => {
  for (const status of ["claimed", "queued", "running", "done", "failed", "missed"]) {
    const r = decideAction({
      now: at("2026-08-02T09:00:00+07:00"),
      runAt: at("2026-08-02T09:00:00+07:00"),
      enabled: true, status, graceMs: GRACE,
    });
    assert.equal(r, "wait", `status ${status} phải trả về wait`);
  }
});

test("isRetryable: lỗi tạm thời thì thử lại", () => {
  for (const code of ["interrupted", "render_failed", "internal_error"]) {
    assert.equal(isRetryable(code, 0, 2), true, code);
  }
});

test("isRetryable: lỗi dữ liệu thì dừng", () => {
  for (const code of ["bad_input", "asr_empty", "align_failed", "lint_failed", "check_failed", "timeout"]) {
    assert.equal(isRetryable(code, 0, 2), false, code);
  }
});

test("isRetryable: hết lượt thì dừng dù lỗi tạm thời", () => {
  assert.equal(isRetryable("render_failed", 2, 2), false);
  assert.equal(isRetryable("render_failed", 1, 2), true);
});

test("isRetryable: code rỗng hoặc lạ thì dừng", () => {
  assert.equal(isRetryable(null, 0, 2), false);
  assert.equal(isRetryable("khong_biet", 0, 2), false);
});

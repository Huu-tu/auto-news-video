import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

import { initSchema } from "../src/db.mjs";
import {
  claimDue, createRow, deleteRow, getRow, listRows, markRow, reclaimStale,
  resetToPending, rowsInFlight, scheduleRetry, setEnabled, updateRow,
} from "../src/schedule.mjs";

const URL = process.env.TEST_DATABASE_URL;
const skip = URL ? false : "cần TEST_DATABASE_URL trỏ tới một database dùng riêng cho test";

let sql;
const soon = () => new Date(Date.now() - 1000);       // đã đến hạn
const later = () => new Date(Date.now() + 3600_000);  // một tiếng nữa

before(async () => {
  if (!URL) return;
  sql = postgres(URL, { onnotice: () => {} });
  await initSchema(sql);
});

beforeEach(async () => {
  if (!URL) return;
  await sql`TRUNCATE schedule RESTART IDENTITY`;
});

after(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

const seed = (over = {}) =>
  createRow(sql, {
    name: "Tin tức vàng", runAt: later(), storyboard: "| Lời thoại |\n| --- |\n| Xin chào |",
    note: "", enabled: true, ...over,
  });

test("createRow rồi getRow trả về đúng dòng", { skip }, async () => {
  const created = await seed();
  assert.equal(created.name, "Tin tức vàng");
  assert.equal(created.status, "pending");
  assert.equal(created.attempts, 0);
  assert.equal(created.enabled, true);

  const found = await getRow(sql, created.id);
  assert.equal(found.id, created.id);
});

test("getRow trả null khi không có", { skip }, async () => {
  assert.equal(await getRow(sql, 999999), null);
});

test("listRows sắp xếp theo run_at tăng dần", { skip }, async () => {
  const b = await seed({ name: "sau", runAt: new Date(Date.now() + 7200_000) });
  const a = await seed({ name: "trước", runAt: later() });
  const rows = await listRows(sql);
  assert.deepEqual(rows.map((r) => r.id), [a.id, b.id]);
});

test("updateRow sửa được nội dung", { skip }, async () => {
  const r = await seed();
  const u = await updateRow(sql, r.id, { name: "Tên mới", note: "ghi chú" });
  assert.equal(u.name, "Tên mới");
  assert.equal(u.note, "ghi chú");
});

test("updateRow ánh xạ runAt (camelCase) sang cột run_at", { skip }, async () => {
  const r = await seed();
  const newRunAt = new Date(Date.now() + 9999_000);
  const u = await updateRow(sql, r.id, { runAt: newRunAt });
  assert.equal(u.run_at.getTime(), newRunAt.getTime());
});

test("setEnabled bật tắt được mà không đụng status", { skip }, async () => {
  const r = await seed();
  const off = await setEnabled(sql, r.id, false);
  assert.equal(off.enabled, false);
  assert.equal(off.status, "pending", "tắt không được làm mất trạng thái");
});

test("deleteRow xoá thật", { skip }, async () => {
  const r = await seed();
  assert.equal(await deleteRow(sql, r.id), true);
  assert.equal(await getRow(sql, r.id), null);
  assert.equal(await deleteRow(sql, r.id), false);
});

test("claimDue chỉ nhặt dòng đã đến hạn", { skip }, async () => {
  await seed({ name: "tương lai", runAt: later() });
  const due = await seed({ name: "đến hạn", runAt: soon() });

  const got = await claimDue(sql);
  assert.equal(got.id, due.id);
  assert.equal(got.status, "claimed");
  assert.ok(got.claimed_at);
});

test("claimDue bỏ qua dòng đang tắt", { skip }, async () => {
  await seed({ runAt: soon(), enabled: false });
  assert.equal(await claimDue(sql), null);
});

test("claimDue không nhặt lại dòng đã nhặt", { skip }, async () => {
  await seed({ runAt: soon() });
  assert.ok(await claimDue(sql));
  assert.equal(await claimDue(sql), null, "gọi lần hai phải trả null");
});

test("claimDue nhặt dòng cũ nhất trước", { skip }, async () => {
  const old = await seed({ name: "cũ", runAt: new Date(Date.now() - 7200_000) });
  await seed({ name: "mới", runAt: soon() });
  const got = await claimDue(sql);
  assert.equal(got.id, old.id);
});

test("claimDue: hai client tranh nhau chỉ một bên nhặt được", { skip }, async () => {
  await seed({ runAt: soon() });
  const a = postgres(URL, { onnotice: () => {} });
  const b = postgres(URL, { onnotice: () => {} });
  try {
    const [ra, rb] = await Promise.all([claimDue(a), claimDue(b)]);
    assert.equal([ra, rb].filter(Boolean).length, 1, "đúng một client được nhặt");
  } finally {
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
  }
});

test("markRow cập nhật trạng thái và lỗi", { skip }, async () => {
  const r = await seed();
  const m = await markRow(sql, r.id, { status: "failed", last_error: "align_failed", attempts: 1 });
  assert.equal(m.status, "failed");
  assert.equal(m.last_error, "align_failed");
  assert.equal(m.attempts, 1);
});

test("markRow ném lỗi khi patch có key lạ", { skip }, async () => {
  const r = await seed();
  await assert.rejects(
    () => markRow(sql, r.id, { videoLink: "https://example.com/v.mp4" }),
    /cột không hợp lệ/,
  );
});

test("rowsInFlight trả về dòng đang bay", { skip }, async () => {
  const a = await seed();
  await markRow(sql, a.id, { status: "running" });
  const b = await seed();
  await markRow(sql, b.id, { status: "done" });

  const flight = await rowsInFlight(sql);
  assert.deepEqual(flight.map((r) => r.id), [a.id]);
});

test("reclaimStale trả dòng kẹt ở claimed về pending", { skip }, async () => {
  const r = await seed({ runAt: soon() });
  await claimDue(sql);
  await sql`UPDATE schedule SET claimed_at = now() - interval '20 minutes' WHERE id = ${r.id}`;

  assert.equal(await reclaimStale(sql, 600_000), 1);
  assert.equal((await getRow(sql, r.id)).status, "pending");
});

test("reclaimStale không đụng dòng vừa nhặt", { skip }, async () => {
  await seed({ runAt: soon() });
  await claimDue(sql);
  assert.equal(await reclaimStale(sql, 600_000), 0);
});

test("resetToPending xoá claimed_at để nhặt lại được", { skip }, async () => {
  const r = await seed({ runAt: soon() });
  await claimDue(sql);
  const back = await resetToPending(sql, r.id);
  assert.equal(back.status, "pending");
  assert.equal(back.claimed_at, null);
  assert.ok(await claimDue(sql), "phải nhặt lại được");
});

test("scheduleRetry dời giờ hẹn và tăng attempts", { skip }, async () => {
  const r = await seed({ runAt: soon() });
  await claimDue(sql);
  const retryAt = new Date(Date.now() + 300_000);

  const back = await scheduleRetry(sql, r.id, { attempts: 1, runAt: retryAt, lastError: "render_failed" });
  assert.equal(back.status, "pending");
  assert.equal(back.attempts, 1);
  assert.equal(back.job_id, null);
  assert.equal(back.last_error, "render_failed");

  assert.equal(await claimDue(sql), null, "chưa tới giờ thử lại thì không được nhặt");
});

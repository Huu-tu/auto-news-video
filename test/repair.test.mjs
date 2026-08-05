import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKING_SECTIONS,
  REPAIRABLE_FIELDS,
  SIZE_STEPS,
  classifyFindings,
  planDeterministicFix,
  runRepairLadder,
  sceneIdFrom,
  validateRepairedChapters,
} from "../src/repair.mjs";

const report = (over = {}) => ({
  ok: false,
  strict: false,
  lint: { ok: true, errorCount: 0, findings: [] },
  runtime: { ok: true, errorCount: 0, findings: [] },
  layout: { ok: true, errorCount: 0, findings: [] },
  motion: { ok: true, errorCount: 0, findings: [] },
  contrast: { ok: true, errorCount: 0, findings: [] },
  snapshots: { enabled: false, files: [] },
  _meta: { version: "0.7.86" },
  ...over,
});

const overlap = {
  code: "content_overlap",
  severity: "error",
  selector: "span.pill",
  containerSelector: "#sc0-k",
  text: "BẢN TIN",
};

// ---- phân loại findings ----

test("BLOCKING_SECTIONS đúng hai mục lint và runtime", () => {
  assert.deepEqual([...BLOCKING_SECTIONS].sort(), ["lint", "runtime"]);
});

test("content_overlap của layout là lỗi chất lượng", () => {
  const { blocking, quality } = classifyFindings(report({ layout: { findings: [overlap] } }));
  assert.equal(blocking.length, 0);
  assert.equal(quality.length, 1);
  assert.equal(quality[0].section, "layout");
  assert.equal(quality[0].code, "content_overlap");
});

test("lỗi runtime là chặn cứng", () => {
  const f = { code: "runtime_error", severity: "error", message: "boom" };
  const { blocking, quality } = classifyFindings(report({ runtime: { findings: [f] } }));
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].section, "runtime");
  assert.equal(quality.length, 0);
});

test("lint mức warning không phải lỗi, không vào nhóm nào", () => {
  const f = { code: "studio_missing_editable_id", severity: "warning" };
  const { blocking, quality } = classifyFindings(report({ lint: { findings: [f] } }));
  assert.equal(blocking.length, 0);
  assert.equal(quality.length, 0);
});

test("lint mức error là chặn cứng", () => {
  const f = { code: "broken_html", severity: "error" };
  const { blocking } = classifyFindings(report({ lint: { findings: [f] } }));
  assert.equal(blocking.length, 1);
});

test("mục lạ chưa biết mặc định xếp vào chất lượng", () => {
  const f = { code: "some_future_check", severity: "error" };
  const { blocking, quality } = classifyFindings(report({ caption: { findings: [f] } }));
  assert.equal(blocking.length, 0);
  assert.equal(quality.length, 1);
  assert.equal(quality[0].section, "caption");
});

test("bỏ qua snapshots và _meta vì không có mảng findings", () => {
  const r = classifyFindings(report());
  assert.equal(r.blocking.length, 0);
  assert.equal(r.quality.length, 0);
});

test("report rỗng hoặc null không làm nổ", () => {
  assert.deepEqual(classifyFindings(null), { blocking: [], quality: [] });
  assert.deepEqual(classifyFindings({}), { blocking: [], quality: [] });
});

// ---- luật sửa bậc 1 ----

const q = (over = {}) => ({
  code: "content_overlap",
  severity: "error",
  section: "layout",
  selector: "span.pill",
  containerSelector: "#sc0-k",
  ...over,
});

test("sceneIdFrom rút scene từ containerSelector", () => {
  assert.equal(sceneIdFrom(q()), "sc0");
});

test("sceneIdFrom rút scene từ selector khi containerSelector không có scene", () => {
  assert.equal(sceneIdFrom(q({ containerSelector: ".topbar", selector: "#sc12-h" })), "sc12");
});

test("sceneIdFrom trả null khi không bên nào là scene", () => {
  assert.equal(sceneIdFrom(q({ containerSelector: ".topbar", selector: "span.pill" })), null);
});

test("bậc 1 hạ một bậc cỡ chữ cho scene bị đè", () => {
  const { overrides, actions } = planDeterministicFix([q()]);
  assert.deepEqual(overrides, { sc0: "len2" });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].rung, 1);
  assert.equal(actions[0].scene, "sc0");
  assert.equal(actions[0].finding_code, "content_overlap");
});

test("gọi lần hai thì hạ tiếp một bậc nữa", () => {
  const first = planDeterministicFix([q()]);
  const second = planDeterministicFix([q()], first.overrides);
  assert.deepEqual(second.overrides, { sc0: "len3" });
  assert.equal(second.actions.length, 1);
});

test("hết bậc thì không sinh hành động nào", () => {
  const { overrides, actions } = planDeterministicFix([q()], { sc0: SIZE_STEPS[SIZE_STEPS.length - 1] });
  assert.deepEqual(overrides, { sc0: "len4" });
  assert.equal(actions.length, 0, "actions rỗng là tín hiệu bậc 1 đã hết đường");
});

test("bỏ qua finding không có trong bảng ánh xạ", () => {
  const { actions } = planDeterministicFix([q({ code: "contrast_aa_failure" })]);
  assert.equal(actions.length, 0);
});

test("bỏ qua content_overlap không gắn với scene nào", () => {
  const { actions } = planDeterministicFix([q({ containerSelector: ".topbar", selector: "span.pill" })]);
  assert.equal(actions.length, 0);
});

test("không sửa object overrides được truyền vào", () => {
  const current = { sc0: "len2" };
  planDeterministicFix([q()], current);
  assert.deepEqual(current, { sc0: "len2" }, "phải trả bản sao, không đụng đầu vào");
});

// ---- hợp đồng bậc 2 ----

const base = () => [
  { line: "intro", kind: "intro", kicker: "ĐIỂM TIN NHANH", head: "BẢN TIN", sub: "" },
  { line: 0, kind: "image", img: "input/images/image_1.png", cat: "THỜI SỰ", head: "TIÊU ĐỀ MỘT" },
  { line: 2, kind: "divider", head: "CẢM ƠN QUÝ VỊ ĐÃ THEO DÕI" },
];

test("REPAIRABLE_FIELDS đúng ba trường nội dung", () => {
  assert.deepEqual([...REPAIRABLE_FIELDS].sort(), ["head", "kicker", "sub"]);
});

test("nhận khi chỉ đổi head", () => {
  const after = base();
  after[1].head = "TIÊU ĐỀ NGẮN HƠN";
  const { ok } = validateRepairedChapters(base(), after);
  assert.equal(ok, true);
});

test("từ chối khi số cảnh đổi", () => {
  const { ok, errors } = validateRepairedChapters(base(), base().slice(0, 2));
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /số cảnh đổi: 3 → 2/.test(e)), true);
});

test("từ chối khi line đổi — đổi line là caption trôi khỏi giọng đọc", () => {
  const after = base();
  after[1].line = 1;
  const { ok, errors } = validateRepairedChapters(base(), after);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /cảnh 1: "line" bị đổi/.test(e)), true);
});

test("từ chối khi kind đổi", () => {
  const after = base();
  after[1].kind = "story";
  const { ok, errors } = validateRepairedChapters(base(), after);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /"kind" bị đổi/.test(e)), true);
});

test("từ chối khi img đổi", () => {
  const after = base();
  after[1].img = "input/images/image_9.png";
  const { ok, errors } = validateRepairedChapters(base(), after);
  assert.equal(ok, false);
  assert.equal(errors.some((e) => /"img" bị đổi/.test(e)), true);
});

test("từ chối khi output không phải mảng", () => {
  const { ok, errors } = validateRepairedChapters(base(), { cards: [] });
  assert.equal(ok, false);
  assert.equal(errors.length, 1);
});

// ---- điều phối thang ----

const clean = () => report();
const withOverlap = (scene = "sc0") =>
  report({ layout: { findings: [{ ...overlap, containerSelector: `#${scene}-k` }] } });

const chapters = () => [
  { line: "intro", kind: "intro", kicker: "K", head: "TIÊU ĐỀ RẤT DÀI CẦN THU NHỎ LẠI", sub: "" },
];

// runCheck giả: trả lần lượt các report đã dựng sẵn
const scriptedCheck = (reports) => {
  let i = 0;
  return async () => reports[Math.min(i++, reports.length - 1)];
};

test("check sạch ngay lần đầu thì không sửa gì", async () => {
  let rebuilt = 0;
  const r = await runRepairLadder({
    runCheck: scriptedCheck([clean()]),
    rebuild: async () => { rebuilt++; },
    repairWithLlm: async () => { throw new Error("không được gọi LLM"); },
    chapters: chapters(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.repairs.length, 0);
  assert.equal(rebuilt, 0);
  assert.equal(r.checks, 1);
});

test("lỗi chặn cứng thì fail ngay, không vào thang", async () => {
  const blocking = report({ runtime: { findings: [{ code: "runtime_error", severity: "error" }] } });
  const r = await runRepairLadder({
    runCheck: scriptedCheck([blocking]),
    rebuild: async () => { throw new Error("không được build lại"); },
    repairWithLlm: async () => { throw new Error("không được gọi LLM"); },
    chapters: chapters(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.repairs.length, 0);
});

test("bậc 1 sửa xong thì không đụng tới bậc 2", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), clean()]),
    rebuild: async () => {},
    repairWithLlm: async () => { throw new Error("không được gọi LLM"); },
    chapters: chapters(),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.overrides, { sc0: "len2" });
  assert.equal(r.repairs.filter((x) => x.rung === 1).length, 1);
  assert.equal(r.repairs.every((x) => x.rung === 1), true);
});

test("bậc 1 chỉ chạy tối đa maxDeterministic vòng", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), withOverlap(), withOverlap(), clean()]),
    rebuild: async () => {},
    repairWithLlm: async () => null,
    chapters: chapters(),
    maxDeterministic: 2,
    maxLlm: 0,
  });
  assert.equal(r.repairs.filter((x) => x.rung === 1).length, 2);
});

test("bậc 2 chạy khi bậc 1 hết đường và kết quả hợp lệ được nhận", async () => {
  const fixed = chapters();
  fixed[0].head = "NGẮN";
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), withOverlap(), withOverlap(), clean()]),
    rebuild: async () => {},
    repairWithLlm: async () => fixed,
    chapters: chapters(),
    maxDeterministic: 2,
  });
  assert.equal(r.ok, true);
  assert.equal(r.chapters[0].head, "NGẮN");
  assert.equal(r.repairs.some((x) => x.rung === 2 && x.ok === true), true);
});

test("bậc 2 từ chối kết quả phá hợp đồng và không dùng nó", async () => {
  const bad = chapters();
  bad[0].line = 3; // đổi line — cấm
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap(), withOverlap(), withOverlap()]),
    rebuild: async () => {},
    repairWithLlm: async () => bad,
    chapters: chapters(),
    maxDeterministic: 1,
    maxLlm: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.chapters[0].line, "intro", "chapters gốc phải được giữ nguyên");
  assert.equal(r.repairs.some((x) => x.rung === 2 && x.ok === false), true);
});

test("hết cả thang thì trả ok=false nhưng vẫn có quality để bậc 3 xử", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap()]),
    rebuild: async () => {},
    repairWithLlm: async () => null,
    chapters: chapters(),
    maxDeterministic: 1,
    maxLlm: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 0, "không có lỗi chặn cứng thì job vẫn phải render được");
  assert.equal(r.quality.length > 0, true);
});

test("lỗi ném ra từ repairWithLlm không làm nổ thang", async () => {
  const r = await runRepairLadder({
    runCheck: scriptedCheck([withOverlap()]),
    rebuild: async () => {},
    repairWithLlm: async () => { throw new Error("claude timeout sau 300000ms"); },
    chapters: chapters(),
    maxDeterministic: 0,
    maxLlm: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.repairs.some((x) => x.rung === 2 && x.ok === false), true);
});

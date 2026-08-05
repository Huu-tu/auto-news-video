// Thang sửa lỗi chất lượng cho bước checking của pipeline.
// Bậc 1 sửa tất định, bậc 2 nhờ Claude Code sửa nội dung, bậc 3 render bất chấp.
// Xem docs/superpowers/specs/2026-08-05-thang-sua-loi-thiet-ke.md
//
// Module này KHÔNG được import gì từ repo — plan.mjs import ngược lại nó.

// Lỗi ở hai mục này nghĩa là composition không render nổi — người phải sửa.
export const BLOCKING_SECTIONS = ["lint", "runtime"];

// Khoá cấp cao nhất của check --json không phải là mục kiểm tra.
const NOT_A_SECTION = new Set(["ok", "strict", "snapshots", "_meta"]);

export function classifyFindings(report) {
  const blocking = [];
  const quality = [];

  for (const [section, value] of Object.entries(report || {})) {
    if (NOT_A_SECTION.has(section)) continue;
    if (!value || !Array.isArray(value.findings)) continue;

    for (const f of value.findings) {
      // Chỉ error mới đáng xử lý; lint đang trả 7 warning mỗi lần chạy.
      if (f?.severity !== "error") continue;
      const tagged = { ...f, section };
      if (BLOCKING_SECTIONS.includes(section)) blocking.push(tagged);
      else quality.push(tagged); // mục lạ mặc định là chất lượng — nghiêng về không đứt quãng
    }
  }

  return { blocking, quality };
}

// id scene do build.mjs sinh ra là sc0, sc1… và các con là sc0-k, sc0-t, sc0-h…
const SCENE_RE = /#(sc\d+)(?:-[a-z0-9]+)?/i;

export const SIZE_STEPS = ["len2", "len3", "len4"];

export function sceneIdFrom(finding) {
  for (const sel of [finding?.containerSelector, finding?.selector]) {
    if (typeof sel !== "string") continue;
    const m = sel.match(SCENE_RE);
    if (m) return m[1];
  }
  return null;
}

// Bảng ánh xạ cố ý bắt đầu nhỏ. Nhật ký sửa sẽ chỉ ra nên thêm dòng nào.
export function planDeterministicFix(qualityFindings, currentOverrides = {}) {
  const overrides = { ...currentOverrides };
  const actions = [];

  for (const f of qualityFindings || []) {
    if (f?.code !== "content_overlap") continue;

    const scene = sceneIdFrom(f);
    if (!scene) continue;

    const at = SIZE_STEPS.indexOf(overrides[scene]);
    if (at >= SIZE_STEPS.length - 1) continue; // đã ở bậc nhỏ nhất

    overrides[scene] = SIZE_STEPS[at + 1]; // indexOf trả -1 khi chưa đặt → bậc đầu tiên
    actions.push({ rung: 1, finding_code: f.code, scene, action: `size:${overrides[scene]}` });
  }

  return { overrides, actions };
}

// LLM ở bậc 2 chỉ được sửa chữ, không được đụng vào cấu trúc.
export const REPAIRABLE_FIELDS = ["head", "sub", "kicker"];

// "line" quyết định "start" sau khi qua mkchapters.mjs — đổi nó là caption
// trôi khỏi giọng đọc, đúng cái bẫy LEAD/TAIL trong CLAUDE.md.
const FROZEN_FIELDS = ["kind", "line", "img"];

export function validateRepairedChapters(original, repaired) {
  if (!Array.isArray(repaired)) return { ok: false, errors: ["output không phải mảng"] };

  const errors = [];
  if (repaired.length !== original.length) {
    errors.push(`số cảnh đổi: ${original.length} → ${repaired.length}`);
  }

  const n = Math.min(original.length, repaired.length);
  for (let i = 0; i < n; i++) {
    for (const f of FROZEN_FIELDS) {
      const a = JSON.stringify(original[i]?.[f]);
      const b = JSON.stringify(repaired[i]?.[f]);
      if (a !== b) errors.push(`cảnh ${i}: "${f}" bị đổi (${a} → ${b})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function runRepairLadder({
  runCheck,
  rebuild,
  repairWithLlm,
  chapters,
  maxDeterministic = 2,
  maxLlm = 2,
  onLog = () => {},
}) {
  const repairs = [];
  let overrides = {};
  let currentChapters = chapters;
  let checks = 0;

  const check = async () => {
    checks++;
    return classifyFindings(await runCheck());
  };

  let { blocking, quality } = await check();
  const done = () => ({
    ok: blocking.length === 0 && quality.length === 0,
    blocking,
    quality,
    repairs,
    chapters: currentChapters,
    overrides,
    checks,
  });

  if (blocking.length) {
    onLog(`check: ${blocking.length} lỗi chặn cứng — không sửa tự động được`);
    return done();
  }
  if (!quality.length) return done();

  // ---- bậc 1: sửa tất định ----
  for (let i = 0; i < maxDeterministic; i++) {
    const { overrides: next, actions } = planDeterministicFix(quality, overrides);
    if (!actions.length) break; // hết đường

    overrides = next;
    for (const a of actions) repairs.push({ ...a, ok: true });
    onLog(`bậc 1 vòng ${i + 1}: ${actions.map((a) => `${a.scene}→${a.action}`).join(", ")}`);

    await rebuild({ overrides, chapters: currentChapters });
    ({ blocking, quality } = await check());
    if (blocking.length) return done();
    if (!quality.length) return done();
  }

  // ---- bậc 2: Claude Code sửa nội dung ----
  for (let i = 0; i < maxLlm; i++) {
    let candidate = null;
    let why = null;
    try {
      candidate = await repairWithLlm({ findings: quality, chapters: currentChapters });
    } catch (e) {
      why = e.message;
    }

    if (!candidate) {
      repairs.push({ rung: 2, finding_code: quality[0]?.code || null, action: "llm_no_result", ok: false, error: why });
      onLog(`bậc 2 vòng ${i + 1}: không nhận được kết quả${why ? ` — ${why}` : ""}`);
      break;
    }

    const { ok: valid, errors } = validateRepairedChapters(currentChapters, candidate);
    if (!valid) {
      repairs.push({ rung: 2, finding_code: quality[0]?.code || null, action: "llm_rejected", ok: false, error: errors.join("; ") });
      onLog(`bậc 2 vòng ${i + 1}: từ chối kết quả — ${errors.join("; ")}`);
      continue;
    }

    currentChapters = candidate;
    repairs.push({ rung: 2, finding_code: quality[0]?.code || null, action: "llm_rewrote_text", ok: true });
    onLog(`bậc 2 vòng ${i + 1}: nhận bản sửa nội dung từ LLM`);

    await rebuild({ overrides, chapters: currentChapters });
    ({ blocking, quality } = await check());
    if (blocking.length) return done();
    if (!quality.length) return done();
  }

  // ---- bậc 3: sàn an toàn — caller vẫn render, chỉ cảnh báo ----
  onLog(`hết thang, còn ${quality.length} lỗi chất lượng — vẫn render`);
  return done();
}

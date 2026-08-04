import { spawn } from "node:child_process";

const KINDS = {
  intro: ["kicker", "head"],
  divider: ["head"],
  headline: ["idx", "cat", "head"],
  story: ["cat", "head"],
  stat: ["cat", "value", "label"],
  chart: ["cat", "head", "bars"],
  image: ["img", "cat", "head"],
  tiles: ["cat", "tiles"],
  quote: ["head"],
  keys: ["cat", "keys"],
};

const KIND_ALIAS = { outro: "divider", ending: "divider", section: "divider", point: "story", fact: "stat" };

export function normalizeKinds(cards) {
  const changed = [];
  if (!Array.isArray(cards)) return { cards, changed };
  for (const c of cards) {
    if (c && typeof c === "object" && KIND_ALIAS[c.kind]) {
      changed.push(`${c.kind} -> ${KIND_ALIAS[c.kind]}`);
      c.kind = KIND_ALIAS[c.kind];
    }
  }
  return { cards, changed };
}

export function validateChapters(cards, lineCount) {
  const errors = [];
  if (!Array.isArray(cards)) return { ok: false, errors: ["output không phải mảng"] };
  if (cards.length === 0) return { ok: false, errors: ["mảng rỗng"] };

  let prevLine = -1;
  cards.forEach((c, i) => {
    const at = `cảnh ${i}`;
    if (!c || typeof c !== "object") {
      errors.push(`${at}: không phải object`);
      return;
    }
    if (!KINDS[c.kind]) {
      errors.push(`${at}: kind "${c.kind}" không hợp lệ (hợp lệ: ${Object.keys(KINDS).join(", ")})`);
      return;
    }
    for (const f of KINDS[c.kind]) {
      if (c[f] === undefined || c[f] === null || c[f] === "") errors.push(`${at} (${c.kind}): thiếu field "${f}"`);
    }
    if (c.kind === "chart" && !Array.isArray(c.bars)) errors.push(`${at}: bars phải là mảng`);
    if (c.kind === "tiles" && !Array.isArray(c.tiles)) errors.push(`${at}: tiles phải là mảng`);
    if (c.kind === "keys" && !Array.isArray(c.keys)) errors.push(`${at}: keys phải là mảng`);

    const L = c.line;
    if (L === "intro") {
      if (i !== 0) errors.push(`${at}: line "intro" phải là cảnh đầu tiên`);
      return;
    }
    if (L === "outro") {
      if (i !== cards.length - 1) errors.push(`${at}: line "outro" phải là cảnh cuối cùng`);
      return;
    }
    if (!Number.isInteger(L) || L < 0 || L >= lineCount) {
      errors.push(`${at}: line ${JSON.stringify(L)} ngoài khoảng 0..${lineCount - 1}`);
      return;
    }
    if (L <= prevLine) errors.push(`${at}: line ${L} không tăng so với cảnh trước (${prevLine})`);
    prevLine = L;
  });

  return { ok: errors.length === 0, errors };
}

export function fallbackChapters(rows, brand) {
  const cards = [
    { line: "intro", kind: "intro", kicker: "ĐIỂM TIN NHANH", head: brand.name || "BẢN TIN", sub: brand.date || "" },
  ];
  rows.forEach((r, i) => {
    const head = r.text.split(/[,.]/)[0].slice(0, 70).trim();
    cards.push({
      line: i,
      kind: "story",
      cat: brand.sub || "TIN TỔNG HỢP",
      head: head || `Tin ${i + 1}`,
      sub: r.text.slice(0, 120),
    });
  });
  cards.push({ line: "outro", kind: "divider", head: "CẢM ƠN QUÝ VỊ ĐÃ THEO DÕI" });
  return cards;
}

function buildPrompt({ rows, brand, images, errors = [] }) {
  const correction = errors.length
    ? `\n\nLẦN TRƯỚC BẠN TRẢ SAI, sửa đúng những điểm này:\n${errors.slice(0, 8).map((e) => `- ${e}`).join("\n")}\n`
    : "";
  const script = rows.map((r, i) => `${i}: ${r.text}`).join("\n");
  const imgList = images.length
    ? [
        ...images.map((im) =>
          im.line !== null
            ? `- "img": "${im.relPath}"  → đặt ở dòng ${im.line}`
            : `- "img": "${im.relPath}"  → chưa gắn dòng nào, tự chọn dòng hợp nội dung nhất`,
        ),
        "",
        `BẮT BUỘC: dùng hết ${images.length} ảnh trên, mỗi ảnh đúng một cảnh "kind": "image".`,
        'Chép nguyên văn đường dẫn vào field "img". Không bỏ sót ảnh nào.',
      ].join("\n")
    : '(không có ảnh — tuyệt đối không dùng kind "image")';

  return `Bạn đang soạn bản đồ cảnh cho một video bản tin tiếng Việt dọc 9:16.

ĐẦU RA: CHỈ một mảng JSON hợp lệ, không markdown, không giải thích, không dấu \`\`\`.

Mỗi phần tử là một cảnh, có:
- "line": số thứ tự DÒNG kịch bản mà cảnh bắt đầu (xem danh sách dưới), phải TĂNG DẦN.
  Riêng cảnh ĐẦU dùng "line": "intro", cảnh CUỐI dùng "line": "outro".
  CHÚ Ý: "outro" chỉ là giá trị của "line", KHÔNG có kind nào tên "outro".
  Thẻ kết thúc dùng "kind": "divider" với head kiểu "CẢM ƠN QUÝ VỊ ĐÃ THEO DÕI".
- "kind" và các field bắt buộc tương ứng:
  intro    → kicker, head, sub
  divider  → head                       (thẻ ngăn, vd "NHỮNG TIN CHÍNH")
  headline → idx ("01"), cat, head, sub (thẻ điểm tin đầu bản tin)
  story    → cat, head, sub             (thẻ tin chi tiết — dùng nhiều nhất)
  stat     → cat, value, unit, label    (value là số thuần để chạy count-up, vd "6.255")
  chart    → cat, head, sub, bars[{label,value,pct(0-100),hi?,trend?}]
  tiles    → cat, head, tiles[{value,label,note?}], foot?
  quote    → head (câu nói), sub (TÊN · CHỨC DANH)
  keys     → cat, keys[chuỗi ngắn <16 ký tự], sub?
  image    → img, cat, head, sub?, tag?

QUY TẮC:
- head viết HOA hoặc Title Case, ngắn gọn, tối đa ~70 ký tự.
- cat là nhãn danh mục ngắn, viết HOA (vd "TÀI CHÍNH · THẾ GIỚI").
- Số liệu nổi bật trong lời thoại → ưu tiên kind "stat" hoặc "tiles" thay vì "story".
- KHÔNG bịa số liệu, tên riêng, chức danh không có trong kịch bản.
- KHÔNG mạo danh báo/đài có thật.
- Mỗi dòng kịch bản chỉ được gắn nhiều nhất một cảnh.

Thương hiệu: ${brand.name || "BẢN TIN"} · ${brand.sub || ""} — ngày ${brand.date || "(không rõ)"}

Ảnh có sẵn:
${imgList}

Kịch bản (index: nội dung):
${script}${correction}`;
}

function runClaude(prompt, { bin, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const extra = (process.env.CLAUDE_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);
    const child = spawn(bin, ["-p", "--output-format", "json", ...extra], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timeout sau ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 500)}`));
      resolve(out);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function extractJsonArray(raw) {
  let text = raw.trim();

  try {
    const envelope = JSON.parse(text);
    if (envelope && typeof envelope.result === "string") text = envelope.result;
    else if (Array.isArray(envelope)) return envelope;
  } catch {
  }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1];

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("không tìm thấy mảng JSON trong output");
  return JSON.parse(text.slice(start, end + 1));
}

export async function planChapters({ rows, brand, images, bin = "claude", fallbackOnly = false, retries = 2, onLog = () => {} }) {
  if (fallbackOnly) {
    onLog("PLAN_FALLBACK_ONLY=1 → bỏ qua LLM");
    return { cards: fallbackChapters(rows, brand), source: "fallback", attempts: 0, errors: [] };
  }

  const allErrors = [];
  let lastErrors = [];

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      onLog(`gọi claude (lần ${attempt}/${retries + 1})`);
      const raw = await runClaude(buildPrompt({ rows, brand, images, errors: lastErrors }), { bin });
      const parsed = extractJsonArray(raw);
      const { cards, changed } = normalizeKinds(parsed);
      if (changed.length) onLog(`chuẩn hoá kind: ${changed.join(", ")}`);
      const { ok, errors } = validateChapters(cards, rows.length);
      if (ok) {
        onLog(`✓ nhận ${cards.length} cảnh từ LLM`);
        return { cards, source: "llm", attempts: attempt, errors: [] };
      }
      onLog(`✗ schema sai: ${errors.slice(0, 5).join("; ")}`);
      lastErrors = errors;
      allErrors.push(...errors);
    } catch (e) {
      onLog(`✗ lỗi gọi claude: ${e.message}`);
      allErrors.push(e.message);
    }
  }

  onLog("dùng bố cục fallback");
  return { cards: fallbackChapters(rows, brand), source: "fallback", attempts: retries + 1, errors: allErrors };
}


const SEP_ROW = /^\|[\s:|-]+\|$/;

function splitRow(line) {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

function plain(s) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

function plainPath(s) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim();
}

function stripQuotes(s) {
  return s.replace(/^["“”'']+/, "").replace(/["“”'']+$/, "").trim();
}

function findCol(header, ...keywords) {
  const norm = header.map((h) => plain(h).toLowerCase());
  for (const kw of keywords) {
    const i = norm.findIndex((h) => h.includes(kw));
    if (i >= 0) return i;
  }
  return -1;
}

export function parseStoryboard(md) {
  const lines = md.split(/\r?\n/);

  const params = {};
  for (const l of lines) {
    const m = l.match(/^\s*[-*]\s+\*\*(.+?)\s*:?\*\*\s*:?\s*(.+?)\s*$/);
    if (m) params[plain(m[1]).toLowerCase()] = plain(m[2]);
  }

  let header = null;
  let cols = null;
  const rows = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      continue;
    }
    if (SEP_ROW.test(line)) continue;

    const cells = splitRow(line);
    if (!header) {
      header = cells;
      cols = {
        n: findCol(header, "#", "stt"),
        time: findCol(header, "thời điểm", "thoi diem", "timecode"),
        text: findCol(header, "lời thoại", "loi thoai", "thoại", "script"),
        dur: findCol(header, "thời lượng", "thoi luong"),
        image: findCol(header, "hình ảnh", "hinh anh", "image"),
        note: findCol(header, "ghi chú", "ghi chu", "note"),
      };
      if (cols.text < 0) header = null; 
      continue;
    }

    const get = (i) => (i >= 0 && i < cells.length ? plain(cells[i]) : "");
    const text = stripQuotes(get(cols.text));
    const n = get(cols.n);

    if (!text || text === "—" || text === "-") continue;

    let image = (cols.image >= 0 && cols.image < cells.length ? plainPath(cells[cols.image]) : "") || null;
    if (image === "—" || image === "-") image = null;

    rows.push({ n, time: get(cols.time), text, dur: get(cols.dur), image, note: get(cols.note) });
  }

  return { params, rows };
}

export function toScriptText(rows) {
  return rows.map((r) => r.text.replace(/\s+/g, " ").trim()).join("\n") + "\n";
}

const IMAGE_FILE = /([\w.\-]+)\.(png|jpe?g|webp|gif|avif)\b/i;

export function imageIdFromRef(ref) {
  if (!ref) return null;
  const m = String(ref).match(IMAGE_FILE);
  if (!m) return null;
  const id = m[1].split(/[\\/]/).pop().trim();
  return id || null;
}

const PLACEHOLDER = /(để trống|điền theo|điền vào|tùy bạn|tuỳ bạn|ví dụ|nếu muốn|theo ngày bạn)/i;

function usable(s, maxLen) {
  const v = String(s || "").trim();
  if (!v || v.length > maxLen || PLACEHOLDER.test(v)) return "";
  return v;
}

export function brandFromParams(params = {}) {
  const clean = (s) => String(s || "").split("—")[0].trim();

  const [rawName, rawSub] = clean(params["thương hiệu"]).split("·").map((s) => s.trim());
  const date = usable(clean(params["ngày ghi trên thanh trên cùng (topbar)"] || params["ngày"]), 24);

  return {
    name: usable(rawName, 24) || "BẢN TIN",
    sub: usable(rawSub, 24) || "TỔNG HỢP",
    date,
  };
}

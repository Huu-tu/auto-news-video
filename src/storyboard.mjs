
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
      if (cols.text < 0) header = null; // không phải bảng kịch bản, thử bảng sau
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

export function imageIdFromRef(ref) {
  if (!ref) return null;
  const base = ref.split(/[\\/]/).pop() || ref;
  const noExt = base.replace(/\.[a-z0-9]+$/i, "");
  const id = noExt.trim();
  return id && !/^(cut|zoom|fade|giữ hình|text overlay)/i.test(id) ? id : null;
}

export function brandFromParams(params = {}) {
  const clean = (s) => String(s || "").split("—")[0].trim();

  const [name, sub] = clean(params["thương hiệu"]).split("·").map((s) => s.trim());
  const date = clean(params["ngày ghi trên thanh trên cùng (topbar)"] || params["ngày"]);

  return { name: name || "BẢN TIN", sub: sub || "TỔNG HỢP", date: date || "" };
}

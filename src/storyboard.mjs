// Parse storyboard markdown (đúng định dạng bảng bạn đang viết tay) thành
// script.txt + bản đồ ảnh. Không bắt đổi format — cột nào thiếu thì bỏ qua.
//
// Bảng mong đợi:
//   | #  | Thời điểm | Lời thoại | Thời lượng | Hình ảnh gợi ý | Ghi chú chuyển cảnh |
//
// Dòng "nghỉ 1,2s" (cột # là "—") không phải lời thoại → không vào script.txt.

const SEP_ROW = /^\|[\s:|-]+\|$/;

function splitRow(line) {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

/** Bỏ ** __ ` và link markdown để lấy chữ đọc được. */
function plain(s) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * Như plain() nhưng GIỮ dấu gạch dưới — dùng cho ô đường dẫn file.
 * `image_1.png` mà bị xoá `_` sẽ thành id "image1", không khớp field multipart
 * `image_image_1` client gửi lên, và ảnh sẽ im lặng biến mất khỏi video.
 */
function plainPath(s) {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim();
}

/** Lời thoại thường nằm trong ngoặc kép — bỏ ngoặc ngoài cùng. */
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

/**
 * @returns {{ params: object, rows: Array<{n:string,time:string,text:string,dur:string,image:string|null,note:string}> }}
 */
export function parseStoryboard(md) {
  const lines = md.split(/\r?\n/);

  // ── Thông số dựng: các dòng "- **Khoá:** giá trị" ────────────────────────
  const params = {};
  for (const l of lines) {
    const m = l.match(/^\s*[-*]\s+\*\*(.+?)\s*:?\*\*\s*:?\s*(.+?)\s*$/);
    if (m) params[plain(m[1]).toLowerCase()] = plain(m[2]);
  }

  // ── Bảng kịch bản ────────────────────────────────────────────────────────
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

    // dòng nghỉ / phân cách: không có lời thoại thật
    if (!text || text === "—" || text === "-") continue;

    let image = (cols.image >= 0 && cols.image < cells.length ? plainPath(cells[cols.image]) : "") || null;
    if (image === "—" || image === "-") image = null;

    rows.push({ n, time: get(cols.time), text, dur: get(cols.dur), image, note: get(cols.note) });
  }

  return { params, rows };
}

/** script.txt cho align_script.py — mỗi dòng một câu, thứ tự = index segment. */
export function toScriptText(rows) {
  return rows.map((r) => r.text.replace(/\s+/g, " ").trim()).join("\n") + "\n";
}

/**
 * Cột "Hình ảnh gợi ý" trong storyboard hay ghi đường dẫn kiểu
 * `/prompts /image/image_2.png`. Chỉ lấy phần tên file không đuôi làm id, để
 * khớp với field multipart `image_<id>` client gửi lên.
 */
export function imageIdFromRef(ref) {
  if (!ref) return null;
  const base = ref.split(/[\\/]/).pop() || ref;
  const noExt = base.replace(/\.[a-z0-9]+$/i, "");
  const id = noExt.trim();
  return id && !/^(cut|zoom|fade|giữ hình|text overlay)/i.test(id) ? id : null;
}

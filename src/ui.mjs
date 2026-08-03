import { html, raw } from "hono/html";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);

const STATUS_LABEL = {
  queued: "chờ",
  transcribing: "nhận dạng",
  ad_scan: "dò quảng cáo",
  aligning: "khớp kịch bản",
  planning: "soạn cảnh",
  building: "dựng HTML",
  checking: "kiểm tra",
  rendering: "render",
  uploading: "tải lên Drive",
  done: "xong",
  failed: "lỗi",
  cancelled: "đã huỷ",
};

const SCHEDULE_LABEL = {
  pending: "🕐 Chờ đến giờ",
  claimed: "⏱ Đang nhận",
  queued: "📋 Trong hàng đợi",
  running: "⏳ Đang chạy",
  done: "✅ Xong",
  failed: "❌ Lỗi",
  missed: "⚠️ Bỏ lỡ",
};

const fmtDate = (d) => new Date(d).toLocaleDateString("vi-VN");
const fmtTime = (d) => new Date(d).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

const dateInputValue = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const timeInputValue = (d) => {
  const x = new Date(d);
  return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
};

const CSS = `
:root{--bg:#0e1116;--panel:#161b22;--line:#242c37;--fg:#e6edf3;--dim:#8b98a5;--red:#d21422;--green:#2ea043;--amber:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:inherit}
header{display:flex;align-items:baseline;gap:14px;padding:18px 24px;border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:17px;letter-spacing:.02em}
header .pill{background:var(--red);color:#fff;font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;letter-spacing:.08em}
header .stat{margin-left:auto;color:var(--dim);font-size:13px}
main{max-width:1100px;margin:0 auto;padding:24px}
h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin:32px 0 12px;font-weight:600}
h2:first-child{margin-top:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.tpl{display:flex;gap:16px;align-items:flex-start}
.tpl .meta{flex:1;min-width:0}
.tpl h3{margin:0 0 4px;font-size:15px}
.tpl p{margin:0 0 10px;color:var(--dim);font-size:13px}
.kinds{display:flex;flex-wrap:wrap;gap:5px}
.kinds span{background:#1f2630;border:1px solid var(--line);color:var(--dim);font-size:11px;padding:2px 7px;border-radius:5px;font-family:ui-monospace,monospace}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em;padding:0 10px 8px}
td{padding:10px;border-top:1px solid var(--line);vertical-align:middle}
tr:hover td{background:#1a212b}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:7px;vertical-align:middle}
.s-done .dot{background:var(--green)}.s-failed .dot,.s-cancelled .dot{background:var(--red)}
.s-active .dot{background:var(--amber);animation:pulse 1.4s infinite}
@keyframes pulse{50%{opacity:.25}}
.bar{height:4px;background:#232b36;border-radius:99px;overflow:hidden;min-width:90px}
.bar i{display:block;height:100%;background:var(--amber);transition:width .4s}
.btn{display:inline-block;background:#222b36;border:1px solid var(--line);color:var(--fg);padding:5px 11px;border-radius:6px;font-size:13px;text-decoration:none;cursor:pointer}
.btn:hover{border-color:#3a4553}
.btn.primary{background:var(--red);border-color:var(--red);color:#fff}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:var(--dim)}
.warn{color:var(--amber);font-size:12px}
.empty{color:var(--dim);padding:28px;text-align:center;border:1px dashed var(--line);border-radius:10px}
dialog{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:12px;max-width:min(920px,92vw);width:100%;padding:0}
dialog::backdrop{background:#000a}
dialog .head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
dialog .body{padding:18px;max-height:70vh;overflow:auto}
pre{background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12px;line-height:1.5;margin:0}
video,hyperframes-player{width:100%;max-height:60vh;background:#000;border-radius:8px}
label{display:block;font-size:13px;color:var(--dim);margin:12px 0 4px}
input[type=text],input[type=file],textarea{width:100%;background:#0b0e13;border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:8px 10px;font:inherit;font-size:13px}
textarea{min-height:120px;font-family:ui-monospace,monospace}
.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
@media(max-width:720px){.row{grid-template-columns:1fr}.tpl{flex-direction:column}}
nav{display:flex;gap:18px;padding:0 24px 12px;border-bottom:1px solid var(--line)}
nav a{color:var(--dim);text-decoration:none;font-size:14px;padding:6px 0}
nav a.on{color:var(--fg);box-shadow:inset 0 -2px 0 var(--red)}
form.inline{display:inline}
.sw{background:none;border:0;cursor:pointer;font-size:15px;padding:2px 6px}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;color:var(--dim);margin-bottom:5px}
.field input,.field textarea{width:100%;background:#0e1116;border:1px solid var(--line);
  border-radius:6px;color:var(--fg);padding:8px 10px;font:inherit}
.field textarea{min-height:150px;font-family:ui-monospace,monospace;font-size:13px}
.row2{display:flex;gap:14px}.row2>*{flex:1}
.err{background:#3a1416;border:1px solid var(--red);border-radius:8px;padding:14px;margin-bottom:18px}
`;

function statusClass(s) {
  if (s === "done") return "s-done";
  if (s === "failed") return "s-failed";
  if (s === "cancelled") return "s-cancelled";
  return "s-active";
}

function fmtDur(sec) {
  if (!sec && sec !== 0) return "—";
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

function fmtClock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())} · ${d.getDate()}/${d.getMonth() + 1}`;
}

function fmtRunDur(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}` : `${m}m${String(Math.round(sec % 60)).padStart(2, "0")}s`;
}

function runElapsed(j) {
  const total = j.timings_sec?.total;
  if (typeof total === "number") return fmtRunDur(total);
  if (!j.started_at) return "";
  if (["done", "failed", "cancelled"].includes(j.status)) return "";
  return fmtRunDur(Math.max(0, (Date.now() - Date.parse(j.started_at)) / 1000));
}

function jobRow(j) {
  const pct = Math.round((j.stage?.progress || 0) * 100);
  const active = !["done", "failed", "cancelled"].includes(j.status);
  return `<tr class="${statusClass(j.status)}" data-job="${esc(j.job_id)}">
    <td><span class="dot"></span>${esc(STATUS_LABEL[j.status] || j.status)}
      ${j.queue_position ? `<span class="mono">#${j.queue_position}</span>` : ""}</td>
    <td><div class="mono">${esc(j.job_id)}</div>${esc(j.brand?.sub || j.metadata?.channel || "")}</td>
    <td>${esc(j.brand?.date || "")}</td>
    <td><div class="mono">${esc(fmtClock(j.started_at || j.created_at))}</div>
      ${runElapsed(j) ? `<div class="mono" style="opacity:.65">${esc(runElapsed(j))}</div>` : ""}</td>
    <td>${active ? `<div class="bar"><i style="width:${pct}%"></i></div><div class="mono">${esc(j.stage?.detail || "")}</div>` : fmtDur(j.artifacts?.duration_sec)}</td>
    <td>${j.warnings?.length ? `<span class="warn" title="${esc(j.warnings.map((w) => w.message).join(" · "))}">${j.warnings.length} cảnh báo</span>` : ""}
        ${j.plan_source === "fallback" ? '<span class="warn">fallback</span>' : ""}</td>
    <td style="text-align:right;white-space:nowrap">
      ${j.status === "done" && !j.drive?.link ? `<a class="btn" href="#" onclick="preview('${esc(j.job_id)}');return false">▶ xem</a>` : ""}
      ${j.drive?.link ? `<a class="btn" href="${esc(j.drive.link)}" target="_blank" rel="noopener">Drive</a>` : ""}
      ${j.status === "failed" ? `<a class="btn" href="#" onclick="showLogs('${esc(j.job_id)}');return false">log</a>` : ""}
      ${active ? `<a class="btn" href="#" onclick="cancelJob('${esc(j.job_id)}');return false">huỷ</a>` : ""}
    </td>
  </tr>`;
}

function templateCard(t) {
  return `<div class="card tpl">
    <div class="meta">
      <h3>${esc(t.id)}</h3>
      <p>${esc(t.description || "")}</p>
      <div class="mono" style="margin-bottom:8px">${t.width}×${t.height} · 9:16 · ${t.files.length} file</div>
      <div class="kinds">${t.kinds.map((k) => `<span>${esc(k)}</span>`).join("")}</div>
    </div>
    <a class="btn primary" href="#" onclick="document.getElementById('new').showModal();return false">Tạo video</a>
  </div>`;
}

function page(inner) {
  return html`<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bản tin Studio</title><style>${raw(CSS)}</style>
</head><body>
<header><span class="pill">BẢN TIN</span><h1>Studio</h1></header>
${inner}
</body></html>`;
}

function nav(active) {
  const item = (href, label) =>
    html`<a href="${href}" class="${href === active ? "on" : ""}">${label}</a>`;
  return html`<nav>${item("/", "Video")}${item("/schedule", "Lịch")}</nav>`;
}

function scheduleRow(r) {
  let detail = "";
  if (r.status === "done" && r.video_link) {
    const safeLink = /^https:\/\//.test(String(r.video_link)) ? r.video_link : null;
    detail = safeLink
      ? html` · <a href="${safeLink}" target="_blank" rel="noopener">mở video</a>`
      : html` · <span class="mono">${r.video_link}</span>`;
  } else if (r.last_error) {
    detail = html` · <span class="warn">${String(r.last_error).slice(0, 90)}</span>`;
  }

  const plan = r.plan_source === "fallback" ? html` <span class="warn">fallback</span>` : "";

  const post = (path, label, title) => html`
    <form class="inline" method="post" action="/schedule/${r.id}/${path}">
      <button class="btn" title="${title}">${label}</button></form>`;

  return html`<tr>
    <td class="mono">${r.id}</td>
    <td>${fmtDate(r.run_at)}</td>
    <td>${fmtTime(r.run_at)}</td>
    <td>${r.name}</td>
    <td><form class="inline" method="post" action="/schedule/${r.id}/toggle">
          <button class="sw" title="${r.enabled ? "Đang bật — bấm để tắt" : "Đang tắt — bấm để bật"}">
            ${r.enabled ? "🟢" : "⚪"}</button></form></td>
    <td>${SCHEDULE_LABEL[r.status] || r.status}${detail}${plan}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn" title="Sửa tên, giờ, storyboard, ghi chú — không đổi file ghi âm/ảnh"
              onclick="document.getElementById('edit-${r.id}').showModal()">Sửa</button>
      ${post("run", "Chạy ngay", "Bỏ qua giờ hẹn, đẩy vào hàng đợi luôn")}
      ${post("delete", "Xoá", "Xoá cả dòng lịch lẫn file đã upload")}
    </td>
  </tr>`;
}

function editDialog(r) {
  return html`<dialog id="edit-${r.id}">
    <form method="post" action="/schedule/${r.id}/edit">
      <div class="head"><strong>Sửa lịch #${r.id}</strong>
        <button type="button" class="btn" style="margin-left:auto"
                onclick="document.getElementById('edit-${r.id}').close()">Đóng</button></div>
      <div class="body">
        <div class="field"><label>Tên</label><input name="name" required value="${r.name}" /></div>
        <div class="row2">
          <div class="field"><label>Ngày</label>
            <input type="date" name="date" required value="${dateInputValue(r.run_at)}" /></div>
          <div class="field"><label>Giờ</label>
            <input type="time" name="time" required value="${timeInputValue(r.run_at)}" /></div>
        </div>
        <div class="field"><label>Storyboard (dán bảng markdown)</label>
          <textarea name="storyboard" required>${r.storyboard}</textarea></div>
        <div class="field"><label>Ghi chú</label><input name="note" value="${r.note || ""}" /></div>
        <button class="btn primary" type="submit">Lưu thay đổi</button>
      </div>
    </form>
  </dialog>`;
}

function addDialog() {
  return html`<dialog id="add">
    <form method="post" action="/schedule" enctype="multipart/form-data">
      <div class="head"><strong>Thêm lịch</strong>
        <button type="button" class="btn" style="margin-left:auto"
                onclick="document.getElementById('add').close()">Đóng</button></div>
      <div class="body">
        <div class="field"><label>Tên</label><input name="name" required placeholder="Tin tức vàng" /></div>
        <div class="row2">
          <div class="field"><label>Ngày</label><input type="date" name="date" required /></div>
          <div class="field"><label>Giờ</label><input type="time" name="time" required value="09:00" /></div>
        </div>
        <div class="field"><label>Storyboard (dán bảng markdown)</label>
          <textarea name="storyboard" required placeholder="| # | Thời điểm | Lời thoại | ..."></textarea></div>
        <div class="field"><label>File ghi âm</label>
          <input type="file" name="audio" accept="audio/*" required /></div>
        <div class="field"><label>Hình ảnh (đặt tên file trùng id trong storyboard, vd image_1.png)</label>
          <input type="file" name="images" accept="image/*" multiple /></div>
        <div class="field"><label>Ghi chú</label><input name="note" /></div>
        <div class="field"><label><input type="checkbox" name="enabled" checked /> Bật ngay</label></div>
        <button class="btn primary" type="submit">Lưu lịch</button>
      </div>
    </form>
  </dialog>`;
}

export const renderPage = {
  login() {
    return `<!doctype html><meta charset="utf-8"><title>Bản tin Studio</title><style>${CSS}</style>
      <main><h2>Cần token</h2><div class="card">Mở lại trang kèm token: <span class="mono">/?token=&lt;API_TOKEN&gt;</span></div></main>`;
  },

  dashboard({ templates, jobs }) {
    const active = jobs.filter((j) => !["done", "failed", "cancelled"].includes(j.status)).length;
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bản tin Studio</title><style>${CSS}</style>
<script src="https://cdn.jsdelivr.net/npm/@hyperframes/player/dist/hyperframes-player.global.js" defer></script>
</head><body>
<header>
  <span class="pill">BẢN TIN</span><h1>Studio</h1>
  <span class="stat">${jobs.length} job · ${active} đang chạy</span>
</header>
${nav("/")}
<main>
  <h2>Template</h2>
  ${templates.length ? templates.map(templateCard).join("") : '<div class="empty">Chưa có template nào trong templates/</div>'}

  <h2>Video</h2>
  ${
    jobs.length
      ? `<table><thead><tr><th>Trạng thái</th><th>Job</th><th title="Chữ in trên thanh đầu video, lấy từ storyboard — không phải lúc job chạy">Ngày trên video</th><th title="Lúc job bắt đầu chạy, và tổng thời gian chạy">Chạy lúc</th><th>Tiến độ / độ dài</th><th></th><th></th></tr></thead>
         <tbody id="rows">${jobs.map(jobRow).join("")}</tbody></table>`
      : '<div class="empty">Chưa có video nào. Bấm “Tạo video” ở trên.</div>'
  }
</main>

<dialog id="new"><form class="body" id="f" onsubmit="return submitJob(event)">
  <h3 style="margin:0 0 4px">Tạo video mới</h3>
  <div class="mono" style="margin-bottom:8px">Gửi storyboard + giọng đọc. Ảnh đặt tên trùng tên trong cột “Hình ảnh gợi ý”.</div>
  <div class="row">
    <div><label>Thương hiệu</label><input type="text" name="brand" value="BẢN TIN"></div>
    <div><label>Chuyên mục</label><input type="text" name="brand_sub" value="THỜI SỰ"></div>
    <div><label>Ngày phát (topbar)</label><input type="text" name="date" placeholder="27 · 07"></div>
  </div>
  <label>Giọng đọc (mp3/wav, ≤50 MB)</label><input type="file" name="audio" accept="audio/*" required>
  <label>Storyboard (.md)</label><input type="file" name="storyboard" accept=".md,.markdown,.txt">
  <label>… hoặc dán thẳng nội dung storyboard</label><textarea name="storyboard_text" placeholder="| # | Thời điểm | Lời thoại | ..."></textarea>
  <label>Ảnh (chọn nhiều, ≤10 MB mỗi file)</label><input type="file" name="images" accept="image/*" multiple>

  <label style="margin-top:16px">Chạy lúc — để trống thì dựng ngay</label>
  <div class="row2">
    <input type="date" name="run_date">
    <input type="time" name="run_time" value="09:00">
  </div>
  <div class="mono" style="margin-top:6px;color:var(--dim);font-size:12px">
    Điền ngày giờ = tạo một dòng ở trang <b>Lịch</b> thay vì dựng ngay, và sửa lại được sau.
    Khi đó thương hiệu · chuyên mục · ngày topbar lấy từ mục “Thông số dựng” trong storyboard,
    không lấy từ ba ô trên.
  </div>
  <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
    <a class="btn" href="#" onclick="document.getElementById('new').close();return false">Huỷ</a>
    <button class="btn primary" type="submit">Bắt đầu dựng</button>
  </div>
  <div id="err" class="warn" style="margin-top:10px"></div>
</form></dialog>

<dialog id="view"><div class="head"><b id="viewTitle"></b>
  <a class="btn" style="margin-left:auto" href="#" onclick="document.getElementById('view').close();return false">đóng</a></div>
  <div class="body" id="viewBody"></div></dialog>

<script>
const tok = new URLSearchParams(location.search).get('token');
const q = tok ? '?token=' + encodeURIComponent(tok) : '';
const api = (p, o) => fetch('/v1' + p + (p.includes('?') ? '&' : '?') + (tok ? 'token=' + encodeURIComponent(tok) : ''), o);

async function submitJob(e){
  e.preventDefault();
  const f = e.target, err = document.getElementById('err');

  // Có điền "Chạy lúc" thì đi ĐƯỜNG KHÁC HẲN: không tạo job chạy ngay mà ghi
  // một dòng vào bảng lịch, để vòng tick nhặt khi tới giờ. Nhờ vậy nó sửa/xoá
  // /bật tắt được, còn job ở /v1/jobs thì tạo xong là chạy, không quay lại được.
  if (f.run_date.value) {
    if (!f.run_time.value) { err.textContent = 'Đã chọn ngày thì phải chọn giờ'; return false; }
    err.textContent = 'đang tạo lịch…';

    // Bảng lịch lưu storyboard dạng TEXT trong DB (sửa được ngay trên UI), nên
    // nếu người dùng chọn file .md thì phải đọc nội dung ra ở đây.
    const sb = f.storyboard.files.length ? await f.storyboard.files[0].text() : f.storyboard_text.value;
    if (!sb.trim()) { err.textContent = 'Thiếu storyboard'; return false; }

    const sd = new FormData();
    sd.append('name', ((f.brand_sub.value || f.brand.value || 'Bản tin').trim() + (f.date.value ? ' · ' + f.date.value : '')));
    sd.append('date', f.run_date.value);
    sd.append('time', f.run_time.value);
    sd.append('storyboard', sb);
    sd.append('note', '');
    sd.append('enabled', 'on');
    sd.append('audio', f.audio.files[0]);
    for (const img of f.images.files) sd.append('images', img);

    const r = await fetch('/schedule' + q, { method: 'POST', body: sd });
    if (!r.ok) { err.textContent = 'không tạo được lịch (HTTP ' + r.status + ')'; return false; }
    location.href = '/schedule' + q;   // sang thẳng trang Lịch để thấy dòng vừa tạo
    return false;
  }

  err.textContent = 'đang tải lên…';
  const fd = new FormData();
  fd.append('payload', JSON.stringify({
    template: 'vn-news-vertical',
    brand: { name: f.brand.value, sub: f.brand_sub.value, date: f.date.value },
    storyboard: f.storyboard.files.length ? undefined : f.storyboard_text.value,
  }));
  fd.append('audio', f.audio.files[0]);
  if (f.storyboard.files.length) fd.append('storyboard', f.storyboard.files[0]);
  for (const img of f.images.files) fd.append('image_' + img.name.replace(/\\.[a-z0-9]+$/i,''), img);

  const res = await api('/jobs', { method: 'POST', body: fd });
  const j = await res.json();
  if (!res.ok) { err.textContent = (j.error && j.error.message) || 'lỗi'; return false; }
  location.href = '/' + q;
  return false;
}

async function cancelJob(id){
  if (!confirm('Huỷ job ' + id + '?')) return;
  await api('/jobs/' + id + '/cancel', { method: 'POST' });
  location.reload();
}

async function showLogs(id){
  const r = await api('/jobs/' + id + '/logs');
  const { logs } = await r.json();
  document.getElementById('viewTitle').textContent = 'Log · ' + id;
  document.getElementById('viewBody').innerHTML = '<pre>' + logs.map(l => l.line).join('\\n').replace(/[<&]/g, m => m === '<' ? '&lt;' : '&amp;') + '</pre>';
  document.getElementById('view').showModal();
}

function preview(id){
  document.getElementById('viewTitle').textContent = id;
  document.getElementById('viewBody').innerHTML =
    '<video controls autoplay src="/v1/jobs/' + id + '/video' + (tok ? '?token=' + encodeURIComponent(tok) : '') + '"></video>';
  document.getElementById('view').showModal();
}

// Job đang chạy: cập nhật tiến độ tại chỗ, không reload cả trang
for (const tr of document.querySelectorAll('tr.s-active')) {
  const id = tr.dataset.job;
  const es = new EventSource('/v1/jobs/' + id + '/events' + (tok ? '?token=' + encodeURIComponent(tok) : ''));
  es.onmessage = (ev) => {
    const j = JSON.parse(ev.data);
    const bar = tr.querySelector('.bar i'), det = tr.querySelector('.bar + .mono');
    if (bar) bar.style.width = Math.round((j.stage?.progress || 0) * 100) + '%';
    if (det) det.textContent = j.stage?.detail || '';
    tr.querySelector('td').firstChild.nextSibling.textContent = ' ' + (j.status || '');
    if (['done','failed','cancelled'].includes(j.status)) { es.close(); location.reload(); }
  };
}
</script>
</body></html>`;
  },

  schedule({ rows }) {
    const body = rows.length === 0
      ? html`<div class="empty">Chưa có lịch nào. Bấm “+ Thêm lịch” để tạo.</div>`
      : html`<table>
          <thead><tr>
            <th>ID</th><th>Ngày</th><th>Giờ</th><th>Tên</th>
            <th>Chạy?</th><th>Trạng thái</th><th></th>
          </tr></thead>
          <tbody>${rows.map(scheduleRow)}</tbody>
         </table>`;

    return page(html`
      ${nav("/schedule")}
      <main>
        <h2>Lịch tạo video
          <button class="btn primary" style="float:right"
                  onclick="document.getElementById('add').showModal()">+ Thêm lịch</button>
        </h2>
        ${body}
        ${rows.map(editDialog)}
        ${addDialog()}
      </main>`);
  },

  scheduleError(message) {
    return page(html`
      ${nav("/schedule")}
      <main>
        <div class="err"><strong>Không lưu được</strong><br />${message}</div>
        <a class="btn" href="/schedule">← Quay lại</a>
      </main>`);
  },

  scheduleSaved({ row, check, audioDurationSec }) {
    return page(html`
      ${nav("/schedule")}
      <main>
        <h2>Đã lưu lịch #${row.id} — nhưng có cảnh báo</h2>
        <div class="err">
          <ul>${check.warnings.map((w) => html`<li>${w}</li>`)}</ul>
        </div>
        <div class="card mono">
          ${check.lineCount} dòng lời thoại ·
          ${check.referencedImages.length} ảnh được tham chiếu ·
          file ghi âm ${Math.round(audioDurationSec)}s
        </div>
        <p>Lịch đã được lưu. Sửa lại hoặc xoá nếu thấy sai.</p>
        <a class="btn primary" href="/schedule">← Về danh sách</a>
      </main>`);
  },
};

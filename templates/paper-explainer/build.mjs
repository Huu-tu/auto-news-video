#!/usr/bin/env node
// ============================================================================
// PAPER EXPLAINER — composition builder (giấy cắt xếp lớp, dọc 9:16)
//
// Cùng hợp đồng dữ liệu với vn-news-vertical (transcript + chapters + audio),
// khác hoàn toàn về tạo hình. Dùng cho tin tức và video chia sẻ kiến thức.
//
// Usage:
//   node build.mjs --out <projectDir> --audio <mp3> \
//        --transcript <transcript.json> --chapters <chapters.json> \
//        [--brand "GÓC NHÌN"] [--brand-sub "KIẾN THỨC"] [--date "27 · 07"] \
//        [--kicker "CHUYỆN HÔM NAY"] [--fps 25]
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const A = {};
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const need = (k) => {
  if (!A[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
  return A[k];
};
const OUT = resolve(need("out"));
const AUDIO = resolve(need("audio"));
const TRANSCRIPT = resolve(A.transcript || join(OUT, "transcript.json"));
const CHAPTERS_PATH = resolve(A.chapters || join(OUT, "chapters.json"));
const FPS = Number(A.fps || 25);
const BRAND = A.brand || "GÓC NHÌN";
const BRAND_SUB = A["brand-sub"] || "KIẾN THỨC";
const DATE = A.date || "";
const KICKER = A.kicker || "CHUYỆN HÔM NAY";

const T = JSON.parse(readFileSync(TRANSCRIPT, "utf8"));
const CHAPTERS = JSON.parse(readFileSync(CHAPTERS_PATH, "utf8"));
const CSS = readFileSync(join(HERE, "paper.css"), "utf8");

let FIXES = [];
try {
  FIXES = Object.entries(JSON.parse(readFileSync(join(OUT, "fixes.json"), "utf8")));
} catch {
  /* không có bảng sửa — caption giữ nguyên văn */
}
const fix = (s) => FIXES.reduce((acc, [a, b]) => acc.split(a).join(b), s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const segs = T.segments;
const audioLen = T.duration || (segs.length ? segs[segs.length - 1].end : 0);
const TOTAL = Math.min(audioLen, Math.max(T.duration || 0, segs.length ? segs[segs.length - 1].end : 0) + 0.4);
const D = TOTAL.toFixed(2);
const r2 = (n) => Math.round(n * 100) / 100;

// ---- captions: cắt segment dài thành cue ngắn theo word timing ----
const MAX_CHARS = 64;
const MAX_DUR = 3.2;
function chunkSegment(s) {
  const words = s.words && s.words.length ? s.words : null;
  if (!words) return [{ start: s.start, end: s.end, text: s.text }];
  const out = [];
  let cur = [];
  let curStart = null;
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.w).join("").trim();
    if (text) out.push({ start: curStart, end: cur[cur.length - 1].end, text });
    cur = [];
    curStart = null;
  };
  for (const w of words) {
    if (curStart === null) curStart = w.start;
    cur.push(w);
    const text = cur.map((x) => x.w).join("").trim();
    const dur = w.end - curStart;
    const endsPunct = /[,.;:!?]$/.test(w.w.trim());
    if (text.length >= MAX_CHARS || dur >= MAX_DUR || (endsPunct && text.length >= 34)) flush();
  }
  flush();
  return out;
}
const cues = segs.flatMap(chunkSegment).sort((a, b) => a.start - b.start);
const caps = [];
let cursor = 0;
for (let i = 0; i < cues.length; i++) {
  const c = cues[i];
  const next = cues[i + 1];
  const start = Math.max(c.start, cursor);
  const rawEnd = next ? Math.min(next.start, c.end + 0.4) : c.end + 0.4;
  const dur = r2(rawEnd - start) - 0.01;
  const text = fix(c.text);
  if (!text || dur < 0.2) continue;
  caps.push({ start: r2(start), dur: r2(dur), text });
  cursor = r2(start) + r2(dur);
}
const capHTML = caps
  .map(
    (c, i) =>
      `      <div class="caprail clip" id="cap${i}" data-start="${c.start}" data-duration="${c.dur}" data-track-index="10"><div class="cap">${esc(c.text)}</div></div>`,
  )
  .join("\n");

// ---- ảnh: copy vào assets/img/, dedupe ----
const PHOTOS = new Map();
function photoSrc(p) {
  const abs = resolve(p);
  if (!PHOTOS.has(abs)) {
    let name = basename(abs).replace(/[^\w.\-]/g, "_");
    const taken = new Set(PHOTOS.values());
    while (taken.has(`assets/img/${name}`)) name = `_${name}`;
    PHOTOS.set(abs, `assets/img/${name}`);
  }
  return PHOTOS.get(abs);
}

// ---- thẻ cảnh ----
const sceneHTML = CHAPTERS.map((ch, i) => {
  const next = CHAPTERS[i + 1];
  const dur = ((next ? next.start : TOTAL) - ch.start).toFixed(2);
  const id = `sc${i}`;
  const cut = `c${i % 4}`;
  // .tab phải là ANH EM của .sheet, không phải con: clip-path trên .sheet cắt
  // mọi thứ bên trong, kể cả phần tab cố tình nhô ra ngoài mép giấy.
  const tabFor = (text, blue) => (text ? `<div class="tab${blue ? " blue" : ""}" id="${id}-tab">${esc(text)}</div>` : "");
  const open = (extra = "", tabText = "", tabBlue = false) =>
    `        <section class="scene clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          <div class="card">
            ${tabFor(tabText, tabBlue)}
            <div class="sheet ${cut}${extra}" id="${id}-sheet"><div class="underlay"></div>`;
  const close = `            </div>
          </div>
        </section>`;

  if (ch.kind === "intro")
    return `${open()}
            <div class="intro-kicker" id="${id}-k">${esc(ch.kicker || KICKER)}</div>
            <div class="cutout intro-title" id="${id}-t">${esc(ch.head || BRAND)}</div>
            <div class="rule" id="${id}-u"></div>
            ${ch.sub ? `<div class="intro-sub" id="${id}-d">${esc(ch.sub)}</div>` : ""}
${close}`;

  if (ch.kind === "divider")
    return `${open(" divider")}
            <div class="cutout divider-text" id="${id}-t">${esc(ch.head)}</div>
${close}`;

  if (ch.kind === "story")
    return `${open("", ch.cat)}
            <div class="headline" id="${id}-h">${esc(ch.head)}</div>
            ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
${close}`;

  if (ch.kind === "stat")
    return `${open("", ch.cat, true)}
            <div class="cutout stat-value" id="${id}-v" data-count="${esc(ch.value)}"><span id="${id}-n">${esc(ch.value)}</span></div>
            ${ch.unit ? `<div class="stat-unit">${esc(ch.unit)}</div>` : ""}
            ${ch.label ? `<div class="stat-label" id="${id}-l">${esc(ch.label)}</div>` : ""}
${close}`;

  if (ch.kind === "image") {
    const src = photoSrc(ch.img);
    const fit = ch.fit === "contain" ? " contain" : "";
    const ratio = ch.ratio ? ` style="aspect-ratio:${ch.ratio}"` : "";
    return `${open("", ch.cat)}
            <div class="photo" id="${id}-p">
              <div class="photo-frame${fit}"${ratio}><img id="${id}-i" src="${src}" alt="" /></div>
              ${ch.tag ? `<div class="photo-tag" id="${id}-g">${esc(ch.tag)}</div>` : ""}
            </div>
            ${ch.head ? `<div class="headline sm" id="${id}-h" style="margin-top:38px">${esc(ch.head)}</div>` : ""}
            ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
${close}`;
  }

  if (ch.kind === "tiles")
    return `${open("", ch.cat, true)}
            ${ch.head ? `<div class="headline sm" id="${id}-h">${esc(ch.head)}</div>` : ""}
            <div class="tiles">
${(ch.tiles || [])
  .map(
    (t, j) => `              <div class="tile" id="${id}-t${j}">
                <div class="tile-value">${esc(t.value)}</div>
                <div class="tile-label">${esc(t.label)}</div>
                ${t.note ? `<div class="tile-note">${esc(t.note)}</div>` : ""}
              </div>`,
  )
  .join("\n")}
            </div>
            ${ch.foot ? `<div class="foot-note" id="${id}-f">${esc(ch.foot)}</div>` : ""}
${close}`;

  if (ch.kind === "quote")
    return `${open()}
            <div class="quote-mark" id="${id}-q">&ldquo;</div>
            <div class="quote-text" id="${id}-t">${esc(ch.head)}</div>
            ${ch.sub ? `<div class="quote-by" id="${id}-b">${esc(ch.sub)}</div>` : ""}
${close}`;

  if (ch.kind === "keys")
    return `${open("", ch.cat)}
            <div class="keys">
${(ch.keys || [])
  .map((k, j) => `              <div class="key${String(k).length > 16 ? " long" : ""}" id="${id}-k${j}">${esc(k)}</div>`)
  .join("\n")}
            </div>
            ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
${close}`;

  if (ch.kind === "chart")
    return `${open("", ch.cat, true)}
            ${ch.head ? `<div class="headline sm" id="${id}-h">${esc(ch.head)}</div>` : ""}
            ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
            <div class="bars">
${(ch.bars || [])
  .map(
    (b, j) => `              <div class="bar">
                <div class="bar-val" id="${id}-cv${j}" data-count="${esc(b.value)}">${esc(b.value)}</div>
                <div class="bar-col${b.hi ? " hi" : ""}${b.trend === "up" ? " up" : ""}" id="${id}-cb${j}" style="height:${Math.max(4, Math.round((Number(b.pct) || 0) * 0.86))}%"></div>
              </div>`,
  )
  .join("\n")}
            </div>
            <div class="bar-labels">
${(ch.bars || []).map((b) => `              <span>${esc(b.label)}</span>`).join("\n")}
            </div>
${close}`;

  // mặc định = headline montage
  return `${open("", ch.cat)}
            ${ch.idx ? `<div class="eyebrow">${esc(ch.idx)}</div>` : ""}
            <div class="headline" id="${id}-h">${esc(ch.head)}</div>
            ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
${close}`;
}).join("\n");

// ---- chuyển động: tờ giấy được ĐẶT XUỐNG, không trượt vào ----
const anim = CHAPTERS.map((ch, i) => {
  const id = `#sc${i}`;
  const s = ch.start;
  const lines = [];
  // cử chỉ chung cho mọi cảnh: hạ giấy xuống bàn, hơi xoay, bóng siết lại
  lines.push(`      tl.from("${id}-sheet",{y:-26,rotation:${i % 2 ? 0.9 : -0.9},scale:1.03,autoAlpha:0,duration:0.52,ease:"power3.out",transformOrigin:"50% 0%"},${s});`);
  if (ch.cat) lines.push(`      tl.from("${id}-tab",{y:26,autoAlpha:0,duration:0.4,ease:"power3.out"},${r2(s + 0.18)});`);

  if (ch.kind === "intro") {
    lines.push(`      tl.from("${id}-k",{y:16,autoAlpha:0,duration:0.4,ease:"power3.out"},${r2(s + 0.28)});`);
    lines.push(`      tl.from("${id}-t",{y:34,autoAlpha:0,duration:0.6,ease:"power4.out"},${r2(s + 0.38)});`);
    lines.push(`      tl.from("${id}-u",{scaleX:0,transformOrigin:"left center",duration:0.45,ease:"power3.out"},${r2(s + 0.72)});`);
    if (ch.sub) lines.push(`      tl.from("${id}-d",{y:18,autoAlpha:0,duration:0.45,ease:"power3.out"},${r2(s + 0.85)});`);
    return lines.join("\n");
  }
  if (ch.kind === "divider") {
    lines.push(`      tl.from("${id}-t",{scale:0.94,autoAlpha:0,duration:0.42,ease:"power3.out"},${r2(s + 0.22)});`);
    return lines.join("\n");
  }
  if (ch.kind === "stat") {
    lines.push(`      tl.from("${id}-v",{y:26,autoAlpha:0,duration:0.5,ease:"power4.out"},${r2(s + 0.26)});`);
    lines.push(`      countUp("${id}-n",${r2(s + 0.26)},0.9);`);
    if (ch.label) lines.push(`      tl.from("${id}-l",{y:20,autoAlpha:0,duration:0.45,ease:"power3.out"},${r2(s + 0.62)});`);
    return lines.join("\n");
  }
  if (ch.kind === "image") {
    const next = CHAPTERS[i + 1];
    const d = (next ? next.start : TOTAL) - ch.start;
    lines.push(`      tl.from("${id}-p",{y:24,autoAlpha:0,duration:0.5,ease:"power3.out"},${r2(s + 0.22)});`);
    if (ch.fit !== "contain")
      lines.push(`      tl.fromTo("${id}-i",{scale:1.02},{scale:1.12,duration:${r2(d)},ease:"none"},${s});`);
    if (ch.tag) lines.push(`      tl.from("${id}-g",{x:-18,autoAlpha:0,duration:0.4,ease:"power3.out"},${r2(s + 0.7)});`);
    if (ch.head) lines.push(`      tl.from("${id}-h",{y:22,autoAlpha:0,duration:0.45,ease:"power4.out"},${r2(s + 0.5)});`);
    if (ch.sub) lines.push(`      tl.from("${id}-s",{y:18,autoAlpha:0,duration:0.4,ease:"power3.out"},${r2(s + 0.64)});`);
    return lines.join("\n");
  }
  if (ch.kind === "tiles") {
    if (ch.head) lines.push(`      tl.from("${id}-h",{y:22,autoAlpha:0,duration:0.45,ease:"power4.out"},${r2(s + 0.26)});`);
    (ch.tiles || []).forEach((_t, j) => {
      lines.push(`      tl.from("${id}-t${j}",{y:24,autoAlpha:0,duration:0.42,ease:"power3.out"},${r2(s + 0.42 + j * 0.1)});`);
    });
    if (ch.foot) lines.push(`      tl.from("${id}-f",{autoAlpha:0,duration:0.4},${r2(s + 0.58 + (ch.tiles || []).length * 0.1)});`);
    return lines.join("\n");
  }
  if (ch.kind === "quote") {
    lines.push(`      tl.from("${id}-q",{y:-16,autoAlpha:0,duration:0.42,ease:"power3.out"},${r2(s + 0.22)});`);
    lines.push(`      tl.from("${id}-t",{y:26,autoAlpha:0,duration:0.55,ease:"power4.out"},${r2(s + 0.34)});`);
    if (ch.sub) lines.push(`      tl.from("${id}-b",{x:-18,autoAlpha:0,duration:0.45,ease:"power3.out"},${r2(s + 0.66)});`);
    return lines.join("\n");
  }
  if (ch.kind === "keys") {
    (ch.keys || []).forEach((_k, j) => {
      lines.push(`      tl.from("${id}-k${j}",{x:-30,rotation:${j % 2 ? 1.2 : -1.2},autoAlpha:0,duration:0.44,ease:"power4.out"},${r2(s + 0.3 + j * 0.24)});`);
    });
    if (ch.sub) lines.push(`      tl.from("${id}-s",{y:18,autoAlpha:0,duration:0.4,ease:"power3.out"},${r2(s + 0.4 + (ch.keys || []).length * 0.24)});`);
    return lines.join("\n");
  }
  if (ch.kind === "chart") {
    if (ch.head) lines.push(`      tl.from("${id}-h",{y:22,autoAlpha:0,duration:0.45,ease:"power4.out"},${r2(s + 0.26)});`);
    if (ch.sub) lines.push(`      tl.from("${id}-s",{y:16,autoAlpha:0,duration:0.4,ease:"power3.out"},${r2(s + 0.4)});`);
    (ch.bars || []).forEach((_b, j) => {
      const at = r2(s + 0.52 + j * 0.16);
      lines.push(`      tl.fromTo("${id}-cb${j}",{scaleY:0},{scaleY:1,duration:0.65,ease:"power3.out"},${at});`);
      lines.push(`      tl.from("${id}-cv${j}",{autoAlpha:0,duration:0.45},${r2(at + 0.18)});`);
      lines.push(`      countUp("${id}-cv${j}",${r2(at + 0.1)},0.7);`);
    });
    return lines.join("\n");
  }
  lines.push(`      tl.from("${id}-h",{y:24,autoAlpha:0,duration:0.48,ease:"power4.out"},${r2(s + 0.26)});`);
  if (ch.sub) lines.push(`      tl.from("${id}-s",{y:18,autoAlpha:0,duration:0.42,ease:"power3.out"},${r2(s + 0.42)});`);
  return lines.join("\n");
}).join("\n");

const html = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
${CSS}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="1080" data-height="1920" data-fps="${FPS}">
      <div class="board"></div>
      <div class="grain"></div>

      <div class="masthead clip" data-start="0" data-duration="${D}" data-track-index="5">
        <span class="wordmark">${esc(BRAND)}</span>
        <span class="wordmark-sub">${esc(BRAND_SUB)}</span>
        <span class="datetag">${esc(DATE)}</span>
      </div>
      <div class="tape l clip" data-start="0" data-duration="${D}" data-track-index="6"></div>
      <div class="tape r clip" data-start="0" data-duration="${D}" data-track-index="3"></div>

      <div class="caprail-bg clip" data-start="0" data-duration="${D}" data-track-index="4"></div>
      <div class="track clip" data-start="0" data-duration="${D}" data-track-index="7"><div id="fill" class="fill"></div></div>
      <div class="colophon clip" data-start="0" data-duration="${D}" data-track-index="8">${esc(BRAND)} · ${esc(BRAND_SUB)}</div>

      <div class="stage">
${sceneHTML}
      </div>

${capHTML}

      <audio id="vo" src="assets/intro.mp3" data-start="0" data-duration="${D}" data-track-index="20" data-volume="1"></audio>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#fill",{scaleX:0},{scaleX:1,ease:"none",duration:${D}},0);

      // count-up seek-safe: đọc số kiểu Việt ("6.255", "74,8"), tween 0 -> giá trị
      // trên timeline, định dạng lại mỗi onUpdate (kể cả khi seek).
      function viFmt(n, dec) {
        const fixed = n.toFixed(dec);
        const parts = fixed.split(".");
        parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ".");
        return dec > 0 ? parts[0] + "," + parts[1] : parts[0];
      }
      function countUp(id, at, dur) {
        const el = document.querySelector(id);
        if (!el) return;
        const holder = el.closest("[data-count]") || el;
        const raw = (holder.getAttribute("data-count") || el.getAttribute("data-count") || "").trim();
        const m = raw.match(/^(\\d[\\d.]*)(,\\d+)?$/);
        if (!m) return;
        const dec = m[2] ? m[2].slice(1).length : 0;
        const target = parseFloat(m[1].replace(/\\./g, "") + (m[2] ? "." + m[2].slice(1) : ""));
        const o = { v: 0 };
        tl.to(o, { v: target, duration: dur, ease: "power1.out", onUpdate: () => { el.textContent = viFmt(o.v, dec); } }, at);
      }
${anim}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

mkdirSync(join(OUT, "assets"), { recursive: true });
copyFileSync(AUDIO, join(OUT, "assets/intro.mp3"));
if (PHOTOS.size) {
  mkdirSync(join(OUT, "assets/img"), { recursive: true });
  for (const [src, rel] of PHOTOS) copyFileSync(src, join(OUT, rel));
}
writeFileSync(join(OUT, "index.html"), html);
console.log(
  `✓ wrote ${join(OUT, "index.html")} — ${D}s, ${CHAPTERS.length} scenes, ${caps.length} captions, ${PHOTOS.size} photos, ${FPS}fps`,
);

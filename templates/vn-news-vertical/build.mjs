#!/usr/bin/env node
// ============================================================================
// VN NEWS VERTICAL — composition builder (reusable template)
// Turns a transcript (+ chapter map + audio) into a HyperFrames index.html.
//
// Usage:
//   node build.mjs --out <projectDir> --audio <mp3> \
//        --transcript <transcript.json> --chapters <chapters.json> \
//        [--brand "BẢN TIN"] [--brand-sub "TỔNG HỢP"] [--date "Chiều 18 · 07"] \
//        [--kicker "ĐIỂM TIN NHANH"] [--fps 25]
//
// transcript.json shape (from transcribe.py / faster-whisper):
//   { "duration": <sec>, "segments": [ { start, end, text, words:[{w,start,end}] } ] }
// chapters.json shape: array of scene cards, see chapters.example.json.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- tiny arg parser ----
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
const BRAND = A.brand || "BẢN TIN";
const BRAND_SUB = A["brand-sub"] || "TỔNG HỢP";
const DATE = A.date || "";
const KICKER = A.kicker || "ĐIỂM TIN NHANH";

const T = JSON.parse(readFileSync(TRANSCRIPT, "utf8"));
const CHAPTERS = JSON.parse(readFileSync(CHAPTERS_PATH, "utf8"));
const CSS = readFileSync(join(HERE, "news.css"), "utf8");

// ---- optional ASR corrections: fixes.json in the project dir { "wrong":"right" } ----
let FIXES = [];
try {
  const f = JSON.parse(readFileSync(join(OUT, "fixes.json"), "utf8"));
  FIXES = Object.entries(f);
} catch {
  /* no fixes file — captions stay fully verbatim */
}
const fix = (s) => FIXES.reduce((acc, [a, b]) => acc.split(a).join(b), s);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const segs = T.segments;
const audioLen = T.duration || (segs.length ? segs[segs.length - 1].end : 0);
const TOTAL = Math.min(audioLen, Math.max(T.duration || 0, segs.length ? segs[segs.length - 1].end : 0) + 0.4);
const D = TOTAL.toFixed(2);

// ---- captions: split long segments into short readable cues on word timings ----
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
const r2 = (n) => Math.round(n * 100) / 100;
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

// ---- photos referenced by image scenes: copied into assets/img/, deduped ----
const PHOTOS = new Map(); // absolute source path -> "assets/img/<file>"
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

// ---- scene cards from chapters (track 1) ----
const sceneHTML = CHAPTERS.map((ch, i) => {
  const next = CHAPTERS[i + 1];
  const dur = ((next ? next.start : TOTAL) - ch.start).toFixed(2);
  const id = `sc${i}`;
  if (ch.kind === "intro")
    return `        <section class="scene clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          <div class="kicker" id="${id}-k">${esc(ch.kicker || KICKER)}</div>
          <div class="intro-title" id="${id}-t">${esc(ch.head || BRAND)}</div>
          <div class="intro-underline" id="${id}-u"></div>
          <div class="intro-date" id="${id}-d">${esc(ch.sub || "")}</div>
        </section>`;
  if (ch.kind === "divider")
    return `        <section class="scene clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          <div><div class="divider-txt" id="${id}-t">${esc(ch.head)}</div><div class="divider-rule"></div></div>
        </section>`;
  if (ch.kind === "story")
    return `        <section class="scene clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          <div class="loc" id="${id}-l"><span class="loc-dot"></span><span class="loc-txt">${esc(ch.cat)}</span></div>
          <div class="headline" id="${id}-h">${esc(ch.head)}</div>
          ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
        </section>`;
  if (ch.kind === "stat") {
    // 300px only fits ~5 glyphs across the 936px stage — step the size down for
    // longer numbers ("4.106,5", "187.000") instead of letting them run off-canvas.
    const vlen = String(ch.value ?? "").length;
    const vcls = vlen >= 8 ? "stat-value xs" : vlen >= 6 ? "stat-value sm" : "stat-value";
    return `        <section class="scene clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          ${ch.cat ? `<span class="cat" id="${id}-c">${esc(ch.cat)}</span>` : ""}
          <div class="${vcls}" id="${id}-v"><span class="stat-num" id="${id}-n" data-count="${esc(String(ch.value ?? ""))}">${esc(String(ch.value ?? ""))}</span>${ch.unit ? `<span class="stat-unit">${esc(ch.unit)}</span>` : ""}</div>
          ${ch.label ? `<div class="stat-label" id="${id}-l">${esc(ch.label)}</div>` : ""}
        </section>`;
  }
  if (ch.kind === "image") {
    const src = photoSrc(ch.img);
    // fit:"contain" is for graphics/charts (nothing may be cropped); default
    // cover crops a photo to the card. ratio overrides the 16/9 card shape.
    const pcls = ch.fit === "contain" ? "photo photo-contain" : "photo";
    const pstyle = ch.ratio ? ` style="aspect-ratio:${Number(ch.ratio)}"` : "";
    return `        <section class="scene scene-img clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          ${ch.cat ? `<span class="cat" id="${id}-c">${esc(ch.cat)}</span>` : ""}
          <div class="${pcls}" id="${id}-p"${pstyle}>
            <img id="${id}-i" src="${esc(src)}" alt="${esc(ch.head || ch.cat || "")}" data-layout-allow-overflow />
            <div class="photo-grade"></div>
            ${ch.tag ? `<div class="photo-tag" id="${id}-g">${esc(ch.tag)}</div>` : ""}
          </div>
          ${ch.head ? `<div class="headline sm" id="${id}-h">${esc(ch.head)}</div>` : ""}
          ${ch.sub ? `<div class="subhead sm" id="${id}-s">${esc(ch.sub)}</div>` : ""}
        </section>`;
  }
  if (ch.kind === "tiles") {
    const tiles = (ch.tiles || [])
      .map(
        (t, j) => `            <div class="tile" id="${id}-t${j}">
              <div class="tile-val" data-count="${esc(String(t.value ?? ""))}">${esc(String(t.value ?? ""))}</div>
              <div class="tile-label">${esc(t.label || "")}</div>
              ${t.note ? `<div class="tile-note">${esc(t.note)}</div>` : ""}
            </div>`,
      )
      .join("\n");
    return `        <section class="scene scene-tiles clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          ${ch.cat ? `<span class="cat" id="${id}-c">${esc(ch.cat)}</span>` : ""}
          ${ch.head ? `<div class="tiles-head" id="${id}-h">${esc(ch.head)}</div>` : ""}
          <div class="tiles">
${tiles}
          </div>
          ${ch.foot ? `<div class="tiles-foot" id="${id}-f">${esc(ch.foot)}</div>` : ""}
        </section>`;
  }
  if (ch.kind === "quote") {
    return `        <section class="scene scene-quote clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          <div class="qmark" id="${id}-q">&ldquo;</div>
          <div class="quote" id="${id}-t">${esc(ch.head)}</div>
          <div class="qby" id="${id}-b"><span class="qrule"></span>${esc(ch.sub || "")}</div>
        </section>`;
  }
  if (ch.kind === "keys") {
    // long keys wrap badly at 96px — drop a size class rather than making the
    // caller specify one.
    const kcls = (ch.keys || []).some((k) => k.length > 16) ? "keys sm" : "keys";
    const keys = (ch.keys || [])
      .map(
        (k, j) =>
          `            <div class="key" id="${id}-k${j}"><span class="key-dot"></span>${esc(k)}</div>`,
      )
      .join("\n");
    return `        <section class="scene scene-keys clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          ${ch.cat ? `<span class="cat" id="${id}-c">${esc(ch.cat)}</span>` : ""}
          <div class="${kcls}">
${keys}
          </div>
          ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
        </section>`;
  }
  if (ch.kind === "chart") {
    const bars = (ch.bars || []).map((b, j) => {
      const h = Math.max(4, Math.min(100, Number(b.pct) || 0));
      const cls = b.trend === "up" ? "chart-bar up" : b.hi ? "chart-bar hi" : "chart-bar";
      return `            <div class="chart-col">
              <div class="chart-val" id="${id}-cv${j}" data-count="${b.value ?? ""}">${esc(String(b.value ?? ""))}</div>
              <div class="${cls}" id="${id}-cb${j}" style="height:${h}%"></div>
              <div class="chart-xlabel">${esc(b.label || "")}</div>
            </div>`;
    }).join("\n");
    return `        <section class="scene clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          ${ch.cat ? `<span class="cat" id="${id}-c">${esc(ch.cat)}</span>` : ""}
          ${ch.head ? `<div class="chart-head" id="${id}-h">${esc(ch.head)}</div>` : ""}
          ${ch.sub ? `<div class="chart-sub" id="${id}-s">${esc(ch.sub)}</div>` : ""}
          <div class="chart-bars">
${bars}
          </div>
        </section>`;
  }
  return `        <section class="scene clip" id="${id}" data-start="${ch.start}" data-duration="${dur}" data-track-index="1">
          <div class="idx">${ch.idx ?? ""}</div>
          <span class="cat">${esc(ch.cat)}</span>
          <div class="headline" id="${id}-h">${esc(ch.head)}</div>
          ${ch.sub ? `<div class="subhead" id="${id}-s">${esc(ch.sub)}</div>` : ""}
        </section>`;
}).join("\n");

// ---- entrance animations ----
const anim = CHAPTERS.map((ch, i) => {
  const id = `#sc${i}`;
  const s = ch.start;
  if (ch.kind === "intro")
    return `      tl.from("${id}-k",{y:24,autoAlpha:0,duration:0.5,ease:"power3.out"},${s + 0.15});
      tl.from("${id}-t",{y:60,autoAlpha:0,duration:0.7,ease:"power4.out"},${s + 0.3});
      tl.from("${id}-u",{scaleX:0,transformOrigin:"left center",duration:0.5,ease:"power3.out"},${s + 0.65});
      tl.from("${id}-d",{y:20,autoAlpha:0,duration:0.5,ease:"power3.out"},${s + 0.8});`;
  if (ch.kind === "divider")
    return `      tl.from("${id}-t",{scale:0.9,autoAlpha:0,duration:0.35,ease:"power3.out"},${s + 0.05});`;
  if (ch.kind === "story")
    return `      tl.from("${id}-l",{x:-30,autoAlpha:0,duration:0.45,ease:"power3.out"},${s + 0.1});
      tl.from("${id}-h",{y:44,autoAlpha:0,duration:0.5,ease:"power4.out"},${s + 0.25});${ch.sub ? `\n      tl.from("${id}-s",{y:26,autoAlpha:0,duration:0.5,ease:"power3.out"},${s + 0.42});` : ""}`;
  if (ch.kind === "stat") {
    const lines = [];
    if (ch.cat) lines.push(`      tl.from("${id}-c",{y:20,autoAlpha:0,duration:0.4,ease:"power3.out"},${s + 0.1});`);
    lines.push(`      tl.from("${id}-v",{scale:0.6,autoAlpha:0,duration:0.6,ease:"back.out(1.5)"},${s + 0.2});`);
    lines.push(`      countUp("${id}-n",${s + 0.2},0.9);`);
    if (ch.label) lines.push(`      tl.from("${id}-l",{y:26,autoAlpha:0,duration:0.5,ease:"power3.out"},${s + 0.5});`);
    return lines.join("\n");
  }
  if (ch.kind === "image") {
    const next = CHAPTERS[i + 1];
    const dur = (next ? next.start : TOTAL) - ch.start;
    const lines = [];
    if (ch.cat) lines.push(`      tl.from("${id}-c",{y:20,autoAlpha:0,duration:0.4,ease:"power3.out"},${s + 0.1});`);
    lines.push(`      tl.from("${id}-p",{y:44,autoAlpha:0,duration:0.6,ease:"power3.out"},${s + 0.12});`);
    // slow Ken Burns across the whole scene — linear so a seek lands identically.
    // Skipped for contain: scaling up would crop the graphic it must show whole.
    if (ch.fit !== "contain")
      lines.push(`      tl.fromTo("${id}-i",{scale:1.02},{scale:1.13,duration:${r2(dur)},ease:"none"},${s});`);
    if (ch.tag) lines.push(`      tl.from("${id}-g",{x:-24,autoAlpha:0,duration:0.45,ease:"power3.out"},${s + 0.75});`);
    if (ch.head) lines.push(`      tl.from("${id}-h",{y:34,autoAlpha:0,duration:0.5,ease:"power4.out"},${s + 0.42});`);
    if (ch.sub) lines.push(`      tl.from("${id}-s",{y:24,autoAlpha:0,duration:0.45,ease:"power3.out"},${s + 0.58});`);
    return lines.join("\n");
  }
  if (ch.kind === "tiles") {
    const lines = [];
    if (ch.cat) lines.push(`      tl.from("${id}-c",{y:20,autoAlpha:0,duration:0.4,ease:"power3.out"},${s + 0.1});`);
    if (ch.head) lines.push(`      tl.from("${id}-h",{y:30,autoAlpha:0,duration:0.5,ease:"power4.out"},${s + 0.2});`);
    (ch.tiles || []).forEach((_t, j) => {
      lines.push(`      tl.from("${id}-t${j}",{y:32,autoAlpha:0,duration:0.5,ease:"power3.out"},${r2(s + 0.35 + j * 0.12)});`);
    });
    if (ch.foot)
      lines.push(`      tl.from("${id}-f",{autoAlpha:0,duration:0.5},${r2(s + 0.5 + (ch.tiles || []).length * 0.12)});`);
    return lines.join("\n");
  }
  if (ch.kind === "quote")
    return `      tl.from("${id}-q",{y:-26,autoAlpha:0,duration:0.5,ease:"power3.out"},${s + 0.08});
      tl.from("${id}-t",{y:40,autoAlpha:0,duration:0.6,ease:"power4.out"},${s + 0.2});
      tl.from("${id}-b",{x:-26,autoAlpha:0,duration:0.5,ease:"power3.out"},${s + 0.5});`;
  if (ch.kind === "keys") {
    const lines = [];
    if (ch.cat) lines.push(`      tl.from("${id}-c",{y:20,autoAlpha:0,duration:0.4,ease:"power3.out"},${s + 0.1});`);
    (ch.keys || []).forEach((_k, j) => {
      lines.push(`      tl.from("${id}-k${j}",{x:-44,autoAlpha:0,duration:0.5,ease:"power4.out"},${r2(s + 0.2 + j * 0.28)});`);
    });
    if (ch.sub)
      lines.push(`      tl.from("${id}-s",{y:24,autoAlpha:0,duration:0.45,ease:"power3.out"},${r2(s + 0.3 + (ch.keys || []).length * 0.28)});`);
    return lines.join("\n");
  }
  if (ch.kind === "chart") {
    const lines = [];
    if (ch.cat) lines.push(`      tl.from("${id}-c",{y:20,autoAlpha:0,duration:0.4,ease:"power3.out"},${s + 0.1});`);
    if (ch.head) lines.push(`      tl.from("${id}-h",{y:30,autoAlpha:0,duration:0.5,ease:"power4.out"},${s + 0.2});`);
    if (ch.sub) lines.push(`      tl.from("${id}-s",{y:20,autoAlpha:0,duration:0.4,ease:"power3.out"},${s + 0.35});`);
    (ch.bars || []).forEach((_b, j) => {
      const at = s + 0.5 + j * 0.18;
      lines.push(`      tl.fromTo("${id}-cb${j}",{scaleY:0},{scaleY:1,duration:0.7,ease:"power3.out"},${at});`);
      lines.push(`      tl.from("${id}-cv${j}",{autoAlpha:0,duration:0.5},${at + 0.2});`);
      lines.push(`      countUp("${id}-cv${j}",${at + 0.1},0.7);`);
    });
    return lines.join("\n");
  }
  return `      tl.from("${id}-h",{y:44,autoAlpha:0,duration:0.5,ease:"power4.out"},${s + 0.1});${ch.sub ? `\n      tl.from("${id}-s",{y:26,autoAlpha:0,duration:0.5,ease:"power3.out"},${s + 0.24});` : ""}`;
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
      <div class="bg"></div>
      <div class="vignette"></div>
      <div class="topbar clip" data-start="0" data-duration="${D}" data-track-index="5">
        <div class="brand"><span class="pill">${esc(BRAND)}</span><span class="brand-sub">${esc(BRAND_SUB)}</span></div>
        <span class="datetag">${esc(DATE)}</span>
      </div>
      <div class="topline clip" data-start="0" data-duration="${D}" data-track-index="6"></div>
      <div class="caprail-bg clip" data-start="0" data-duration="${D}" data-track-index="4"></div>
      <div class="track clip" data-start="0" data-duration="${D}" data-track-index="7"><div id="fill" class="fill"></div></div>
      <div class="foot clip" data-start="0" data-duration="${D}" data-track-index="8">${esc(BRAND_SUB ? BRAND + " " + BRAND_SUB : BRAND)}</div>

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

      // seek-safe count-up: parses a Vietnamese number ("6.255", "74,8"), tweens
      // 0 -> value on the timeline, reformatting on every onUpdate (incl. seek).
      function viFmt(n, dec) {
        const fixed = n.toFixed(dec);
        const parts = fixed.split(".");
        parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ".");
        return dec > 0 ? parts[0] + "," + parts[1] : parts[0];
      }
      function countUp(id, at, dur) {
        const el = document.getElementById(id);
        if (!el) return;
        const raw = (el.getAttribute("data-count") || "").trim();
        const m = raw.match(/^(\\d[\\d.]*)(,\\d+)?$/); // pure VN number only
        if (!m) return; // ranges / text stay static
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

#!/usr/bin/env node
// chapters.src.json (scene cards keyed by script LINE) + transcript.json
//   -> chapters.json (the same cards keyed by START SECOND, what build.mjs eats)
//
// Keeping the source keyed by line means a re-transcribe / re-timed voiceover
// only needs this script re-run; the scene map itself never carries timestamps.
//
// Usage: node mkchapters.mjs <chapters.src.json> <transcript.json> <chapters.json>
import { readFileSync, writeFileSync } from "node:fs";

const [SRC, TR, OUT] = process.argv.slice(2);
const src = JSON.parse(readFileSync(SRC, "utf8"));
const segs = JSON.parse(readFileSync(TR, "utf8")).segments;

// a card appears just BEFORE its line is spoken, so the voice lands on it
const PREROLL = 0.3;

const out = src.map((ch, i) => {
  const { line, ...card } = ch;
  let start;
  if (line === "intro") start = 0;
  else if (line === "outro") start = segs[segs.length - 1].end + 0.15;
  else {
    const seg = segs[line];
    if (!seg) throw new Error(`chapter ${i}: no transcript line ${line}`);
    // never eat into the previous card by more than the gap that exists
    const prevEnd = line > 0 ? segs[line - 1].end : 0;
    start = Math.max(prevEnd + 0.05, seg.start - PREROLL, 0);
  }
  return { start: Math.round(start * 100) / 100, ...card };
});

for (let i = 1; i < out.length; i++)
  if (out[i].start <= out[i - 1].start)
    throw new Error(`chapter ${i} (${out[i].start}s) does not advance past ${i - 1} (${out[i - 1].start}s)`);

writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`✓ ${OUT} — ${out.length} scenes`);
for (const c of out) console.log(`  ${String(c.start).padStart(7)}s  ${c.kind.padEnd(7)} ${c.head || c.cat || ""}`);

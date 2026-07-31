#!/usr/bin/env python3
"""Cut regions out of the voiceover and re-time the ASR transcript to match.

Each cut in cuts.json is {"from","to","gap","why"}: the [from,to) span is dropped
from the audio and replaced by `gap` seconds of silence, so a cut that removes a
provider ad still leaves a natural pause. Word timings after a cut shift by
(to - from - gap); anything inside a cut collapses onto its start.

Usage: cut_audio.py <in.mp3> <cuts.json> <asr.json> <out.mp3> <out.json>
"""
import json, subprocess, sys

IN_MP3, CUTS_PATH, IN_JSON, OUT_MP3, OUT_JSON = sys.argv[1:6]
cuts = sorted(json.load(open(CUTS_PATH, encoding="utf-8")), key=lambda c: c["from"])

DUR = float(subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", IN_MP3],
    capture_output=True, text=True, check=True).stdout.strip())

# ---- audio: keep the spans between cuts, splice `gap` seconds of silence in ----
parts, filters, prev = [], [], 0.0
for i, c in enumerate(cuts):
    filters.append(f"[0:a]atrim={prev}:{c['from']},asetpts=N/SR/TB[k{i}]")
    parts.append(f"[k{i}]")
    if c["gap"] > 0:
        filters.append(f"anullsrc=r=44100:cl=mono,atrim=0:{c['gap']},asetpts=N/SR/TB[g{i}]")
        parts.append(f"[g{i}]")
    prev = c["to"]
# a cut that runs to the end of the file (trailing ad) leaves nothing to keep —
# appending an empty atrim there would break concat.
if prev < DUR - 0.01:
    filters.append(f"[0:a]atrim={prev},asetpts=N/SR/TB[kN]")
    parts.append("[kN]")
filters.append("".join(parts) + f"concat=n={len(parts)}:v=0:a=1[out]")

subprocess.run(
    ["ffmpeg", "-y", "-v", "error", "-i", IN_MP3, "-filter_complex", ";".join(filters),
     "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-ac", "1", OUT_MP3],
    check=True,
)

# ---- transcript: shift every timestamp through the same edit ----
def remap(t):
    shift = 0.0
    for c in cuts:
        if t >= c["to"]:
            shift += c["to"] - c["from"] - c["gap"]
        elif t > c["from"]:
            return round(c["from"] - shift + c["gap"] / 2, 3)  # inside a cut
    return round(t - shift, 3)

tr = json.load(open(IN_JSON, encoding="utf-8"))
removed = sum(c["to"] - c["from"] - c["gap"] for c in cuts)
for s in tr["segments"]:
    s["start"], s["end"] = remap(s["start"]), remap(s["end"])
    for w in s.get("words", []):
        w["start"], w["end"] = remap(w["start"]), remap(w["end"])
tr["duration"] = round(tr["duration"] - removed, 3)
json.dump(tr, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print(f"cut {len(cuts)} region(s), removed {removed:.2f}s -> {OUT_MP3} ({tr['duration']:.2f}s), {OUT_JSON}")
for c in cuts:
    print(f"  [{c['from']:.2f} → {c['to']:.2f}]  {c['why'][:80]}")

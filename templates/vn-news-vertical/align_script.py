#!/usr/bin/env python3
"""Replace ASR text with the original script, keeping ASR word timings.

The ASR transcript is only used as a *timing* source: script words are aligned
to ASR words with difflib, matched words inherit the ASR timing, and unmatched
words are interpolated linearly between the surrounding anchors. Output is a
transcript.json (same shape as transcribe.py) whose text is 100% the script —
one segment per script line, so chapter starts can be read straight off it.

Usage: align_script.py <asr transcript.json> <script.txt> <out transcript.json>
                       [lead-in seconds] [tail seconds]

lead-in/tail must match the silence padded onto the rendered audio track; every
timing is shifted by lead-in and the reported duration covers both pads.
"""
import json, re, sys, unicodedata
from difflib import SequenceMatcher

ASR_PATH, SCRIPT_PATH, OUT_PATH = sys.argv[1], sys.argv[2], sys.argv[3]
LEAD = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
TAIL = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0

def norm(tok: str) -> str:
    """lowercase, strip diacritics + punctuation — for matching only."""
    t = unicodedata.normalize("NFD", tok.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = t.replace("đ", "d")
    return re.sub(r"[^\w]", "", t)

asr = json.load(open(ASR_PATH, encoding="utf-8"))
awords = [w for s in asr["segments"] for w in s.get("words", [])]
if not awords:
    sys.exit("ASR transcript has no word timestamps")
AUDIO_DUR = float(asr.get("duration") or awords[-1]["end"])

lines = [l.strip() for l in open(SCRIPT_PATH, encoding="utf-8") if l.strip()]
swords, sline = [], []
for i, line in enumerate(lines):
    for tok in line.split():
        swords.append(tok)
        sline.append(i)

a_norm = [norm(w["w"]) for w in awords]
s_norm = [norm(w) for w in swords]

# anchors: script index -> (start, end) taken from the matched ASR word
anchor = {}
for tag, i1, i2, j1, j2 in SequenceMatcher(None, a_norm, s_norm, autojunk=False).get_opcodes():
    if tag != "equal":
        continue
    for k in range(i2 - i1):
        aw = awords[i1 + k]
        anchor[j1 + k] = (float(aw["start"]), float(aw["end"]))

matched = len(anchor)
print(f"aligned {matched}/{len(swords)} script words ({matched / len(swords):.1%}) to {len(awords)} ASR words")
if matched < len(swords) * 0.5:
    sys.exit("alignment too weak — check that script.txt matches the audio")

# fill gaps by linear interpolation between the nearest anchors on both sides
idx = sorted(anchor)
times = [None] * len(swords)
for j in range(len(swords)):
    if j in anchor:
        times[j] = anchor[j]
        continue
    prev = next_ = None
    for k in idx:
        if k < j:
            prev = k
        elif k > j:
            next_ = k
            break
    if prev is None and next_ is None:
        times[j] = (0.0, AUDIO_DUR)
    elif prev is None:
        st = max(0.0, anchor[next_][0] - 0.35 * (next_ - j))
        times[j] = (st, anchor[next_][0])
    elif next_ is None:
        en = min(AUDIO_DUR, anchor[prev][1] + 0.35 * (j - prev))
        times[j] = (anchor[prev][1], en)
    else:
        a0, a1 = anchor[prev][1], anchor[next_][0]
        span, n = max(0.0, a1 - a0), next_ - prev
        times[j] = (a0 + span * (j - prev - 1) / n, a0 + span * (j - prev) / n)

# monotonic, non-degenerate
cursor = 0.0
for j in range(len(swords)):
    st, en = times[j]
    st = max(st, cursor)
    en = max(en, st + 0.06)
    times[j] = (st, en)
    cursor = st + 0.02

segments = []
for i, line in enumerate(lines):
    js = [j for j in range(len(swords)) if sline[j] == i]
    words = [
        {"w": (" " if k else "") + swords[j],
         "start": round(times[j][0] + LEAD, 3), "end": round(times[j][1] + LEAD, 3)}
        for k, j in enumerate(js)
    ]
    segments.append({
        "start": round(times[js[0]][0] + LEAD, 3),
        "end": round(times[js[-1]][1] + LEAD, 3),
        "text": line,
        "words": words,
    })

json.dump({"duration": round(LEAD + AUDIO_DUR + TAIL, 3), "segments": segments},
          open(OUT_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"wrote {OUT_PATH} — {len(segments)} segments")
for s in segments:
    print(f"  [{s['start']:6.2f} → {s['end']:6.2f}]  {s['text'][:70]}")

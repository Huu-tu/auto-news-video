#!/usr/bin/env python3
# Transcribe an audio file to a transcript.json with word-level timestamps,
# using faster-whisper (CTranslate2). Vietnamese-capable, runs on CPU.
#
# Usage:
#   python3 transcribe.py <audio.mp3> <out/transcript.json> [model] [lang]
# Defaults: model=large-v3  lang=vi
#
# Writes both transcript.json (final) and transcript.jsonl (incremental,
# survives a crash). Install once:  pip install --user faster-whisper
import json, sys, time, os
from faster_whisper import WhisperModel

AUDIO = sys.argv[1]
OUT = sys.argv[2]
MODEL = sys.argv[3] if len(sys.argv) > 3 else "large-v3"
LANG = sys.argv[4] if len(sys.argv) > 4 else "vi"
JSONL = OUT.rsplit(".", 1)[0] + ".jsonl"

t0 = time.time()
print(f"loading {MODEL} (int8)...", flush=True)
model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4)
segments, info = model.transcribe(
    AUDIO, language=LANG, beam_size=1, vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=400),
    word_timestamps=True, condition_on_previous_text=False,
)
print(f"duration={info.duration:.1f}s lang={info.language} ({info.language_probability:.2f})", flush=True)

out = []
with open(JSONL, "w", encoding="utf-8") as jf:
    for seg in segments:
        words = [{"w": w.word, "start": round(w.start, 3), "end": round(w.end, 3)} for w in (seg.words or [])]
        rec = {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(), "words": words}
        out.append(rec)
        jf.write(json.dumps(rec, ensure_ascii=False) + "\n"); jf.flush(); os.fsync(jf.fileno())
        print(f"[{seg.end:7.2f}] {seg.text.strip()}", flush=True)

json.dump({"duration": info.duration, "segments": out}, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"DONE {len(out)} segments in {time.time()-t0:.1f}s -> {OUT}", flush=True)

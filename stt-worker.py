#!/usr/bin/env python3
"""Persistent STT worker — keeps the Whisper model loaded in memory.
Reads WAV file paths from stdin (one per line), writes transcriptions to stdout."""

import sys
import os
from faster_whisper import WhisperModel

model_size = os.environ.get("WHISPER_MODEL", "base.en")
print(f"[stt-worker] Loading model: {model_size}", file=sys.stderr, flush=True)
model = WhisperModel(model_size, device="auto", compute_type="auto")
print(f"[stt-worker] Model loaded, ready.", file=sys.stderr, flush=True)

# Signal ready
print("READY", flush=True)

for line in sys.stdin:
    wav_path = line.strip()
    if not wav_path:
        continue
    try:
        segments, _ = model.transcribe(wav_path, language="en", beam_size=5)
        text = " ".join(s.text.strip() for s in segments)
        print(text, flush=True)
    except Exception as e:
        print(f"[stt-worker] Error: {e}", file=sys.stderr, flush=True)
        print("", flush=True)  # empty line = no transcription

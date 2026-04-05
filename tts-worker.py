#!/usr/bin/env python3
"""Persistent TTS worker — keeps sherpa-onnx model loaded in memory.

Reads JSON commands from stdin (one per line):
  {"text": "Hello world", "out": "/tmp/clawptt-tts-abc.pcm"}

Writes 16kHz mono s16le PCM to the output path.
Prints "READY" on startup, then "OK" or "ERROR <msg>" per request.
"""

import sys
import os
import json
import numpy as np
import sherpa_onnx

TARGET_RATE = int(os.environ.get("TTS_SAMPLE_RATE", "16000"))

# ── Load model once ─────────────────────────────────────────────
model_path = os.environ.get("TTS_MODEL", "")
tokens_path = os.environ.get("TTS_TOKENS", "")
data_dir = os.environ.get("TTS_DATA_DIR", "")

print(f"[tts-worker] Loading model: {os.path.basename(model_path)}", file=sys.stderr, flush=True)

config = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model=model_path,
            tokens=tokens_path,
            data_dir=data_dir,
        ),
        num_threads=2,
    ),
)
tts = sherpa_onnx.OfflineTts(config)

print(f"[tts-worker] Model loaded, target rate: {TARGET_RATE}Hz", file=sys.stderr, flush=True)
print("READY", flush=True)


def resample(samples, orig_rate, target_rate):
    """Resample audio using linear interpolation. Good enough for voice on radio."""
    if orig_rate == target_rate:
        return samples
    ratio = target_rate / orig_rate
    target_len = int(len(samples) * ratio)
    x_orig = np.arange(len(samples))
    x_new = np.linspace(0, len(samples) - 1, target_len)
    return np.interp(x_new, x_orig, samples)


# ── Request loop ────────────────────────────────────────────────
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        cmd = json.loads(line)
        text = cmd["text"]
        out_path = cmd["out"]

        audio = tts.generate(text, sid=0, speed=1.0)
        samples = np.array(audio.samples, dtype=np.float32)

        # Resample to target rate if model outputs at a different rate
        samples = resample(samples, audio.sample_rate, TARGET_RATE)

        # float32 → int16
        pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)

        with open(out_path, "wb") as f:
            f.write(pcm.tobytes())

        print("OK", flush=True)
    except Exception as e:
        print(f"[tts-worker] Error: {e}", file=sys.stderr, flush=True)
        print("ERROR", flush=True)

# ClawPTT — Context for AI Assistants

## What this is

ClawPTT is a Zello Work voice bridge for OpenClaw. It puts an AI agent on a PTT radio channel: users key up and speak, ClawPTT transcribes the audio (local faster-whisper or Zello server-side), sends it to an LLM, converts the response to speech, and streams audio back. Text in, audio out. Single Node.js process with persistent Python workers.

## File map

```
index.js       — Package entry point. Re-exports createBridge, ZelloAPI, startAPI.
cli.js         — CLI entry point (bin). Reads env vars, creates bridge, starts it.
bridge.js      — createBridge() factory. Zello WebSocket, LLM routing, persistent
                 STT/TTS workers, Opus codec, streaming. No module-level side effects.
api.js         — startAPI() function. HTTP REST API server (port 18790). Wraps zello.js.
zello.js       — ZelloAPI class. Zello Work REST API client (users, channels,
                 locations, history, media, roles). Session auth with auto-reauth.
stt-worker.py  — Persistent STT worker. Keeps faster-whisper model loaded in memory.
                 Reads WAV paths from stdin, writes transcriptions to stdout.
tts-worker.py  — Persistent TTS worker. Keeps sherpa-onnx model loaded in memory.
                 Reads JSON commands from stdin, outputs 16kHz PCM files.
```

## Architecture

```
Inbound:  Zello PTT → Opus decode → PCM → WAV header (JS) → faster-whisper worker → text
          (or Zello server-side transcription via STT_METHOD=zello-transcription)
Outbound: LLM text → persistent TTS worker → 16kHz PCM → Opus encode → Zello stream
```

No ffmpeg dependency. WAV headers are written in JS (44 bytes). TTS worker resamples to 16kHz in numpy. Both workers stay loaded between requests — model load happens once at startup, not per request.

## Two-tier agent pattern

The voice agent (Tier 1) has a limited skill set (~9 skills) for fast inference (~1.5s). Questions it can't answer are gated to a research agent (Tier 2) that runs asynchronously and posts results to a text channel (Slack). The voice channel is never blocked.

**Gate rule:** If the voice agent can answer in 1-2 sentences with its own tools, it does. Otherwise it says "That needs [research agent]. Want me to route it?" and spawns the research agent async (fire-and-forget). Never awaits the research agent inline — dead air on radio is failure.

## Key constraints

- **Skill count affects latency directly.** 55 skills = ~20K token prompt = intermittent vLLM timeouts. 9 skills = ~6K tokens = stable 1.5s. Only add skills the voice agent actually needs.
- **Ollama is 50-80x slower than vLLM on GPU.** On DGX Spark / any NVIDIA GPU, vLLM with FP8 gives ~0.3s inference. Ollama GGUF gives ~16-26s. Never put Ollama models in the voice fallback chain.
- **Fallback chain:** vLLM (local, ~1.5s via gateway) → Anthropic Sonnet (cloud, ~4s). Two steps. No intermediate.
- **Conversation history:** Rolling buffer per channel (10 turns, 5min TTL). Managed in bridge.js `channelHistory` Map.
- **Persistent workers are critical.** STT model load = ~2s, TTS model load = ~3-5s. Workers stay loaded between requests. Never spawn a fresh Python process per request.
- **Opus codec:** Prefers native `@discordjs/opus` (C bindings), falls back to `opusscript` (pure JS/wasm). Native is ~10x faster for real-time encode/decode.

## Configuration

**CLI mode:** All via environment variables. Run with `node cli.js` or `npx clawptt`.

**Library mode:** Pass options to `createBridge({ zello, llm, tts, stt, history, api, systemPrompt })`. Returns `{ start(), stop() }`. See JSDoc in bridge.js.

Key env vars (CLI):
- `ZELLO_NETWORK`, `ZELLO_BOT_USER`, `ZELLO_BOT_PASS`, `ZELLO_BRIDGE_CHANNELS` — Zello connection
- `GATEWAY_TOKEN`, `OPENCLAW_AGENT` — OpenClaw LLM routing
- `VENV_PYTHON`, `TTS_VOICE` — TTS (Python with sherpa-onnx)
- `STT_METHOD` — `faster-whisper` (default, local) or `zello-transcription` (server-side)
- `WHISPER_MODEL` — faster-whisper model size (default: `base.en`)
- `ZELLO_API_KEY` — enables REST API (optional)
- `LLM_BACKEND` — `openclaw` (default) or `local` (any OpenAI-compatible endpoint)

## What NOT to do

- **Don't add Ollama models to the voice fallback chain.** They're too slow for voice on GPU hardware. Use them for non-latency-critical agents (cron jobs, heartbeats) only.
- **Don't increase the voice agent's skill count without measuring.** Every skill adds ~200-500 tokens to the prompt. Test latency after adding skills.
- **Don't await research agent spawns inline.** The research agent takes 30-120s. Always fire-and-forget and respond to radio immediately.
- **Don't spawn fresh Python processes per request.** Use the persistent STT/TTS workers. Model load overhead destroys voice latency.
- **Don't add ffmpeg back as a dependency.** WAV headers are generated in JS, resampling happens in the TTS worker. ffmpeg is not needed.
- **Don't add module-level side effects to bridge.js.** It's a factory — all state must be encapsulated in createBridge() closures.

## Deployment

Runs as a systemd user service (`clawptt.service`). Depends on `openclaw-gateway.service`. The REST API runs on port 18790 in the same process. No separate containers or services needed.

## Docs

- `README.md` — Landing page, quick start
- `docs/INSTALLATION.md` — Full guide: Zello setup, agent design, model selection, gate protocol, REST API, production deployment

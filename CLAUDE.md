# ClawPTT — Context for AI Assistants

## What this is

ClawPTT is a Zello Work voice bridge for OpenClaw. It puts an AI agent on a PTT radio channel: users key up and speak, ClawPTT receives the transcription from Zello, sends it to an LLM, converts the response to speech, and streams audio back. Text in, audio out. Single Node.js process.

## File map

```
bridge.js    (612 lines)  — Main process. Zello WebSocket connection, LLM routing,
                            TTS, Opus encode, audio streaming, conversation history.
api.js       (120 lines)  — HTTP REST API server (port 18790). Wraps zello.js.
                            Runs in-process with bridge. Activates when ZELLO_API_KEY is set.
zello.js     (400 lines)  — ZelloAPI class. Zello Work REST API client (users, channels,
                            locations, history, media, roles). Session auth with auto-reauth.
stt-worker.py (27 lines)  — Legacy. Whisper STT worker. NOT USED in normal operation.
                            Zello handles STT server-side. This file exists for edge cases only.
```

## Architecture

```
Inbound:  Zello PTT → on_transcription event (text) → LLM → response text
Outbound: response text → sherpa-onnx TTS (WAV) → ffmpeg (PCM) → Opus encode → Zello stream
```

There is NO inbound audio decoding. Zello transcribes speech server-side and delivers text via WebSocket `on_transcription` events. The `@discordjs/opus` dependency is used for outbound encoding only.

## Two-tier agent pattern

The voice agent (Tier 1) has a limited skill set (~9 skills) for fast inference (~1.5s). Questions it can't answer are gated to a research agent (Tier 2) that runs asynchronously and posts results to a text channel (Slack). The voice channel is never blocked.

**Gate rule:** If the voice agent can answer in 1-2 sentences with its own tools, it does. Otherwise it says "That needs [research agent]. Want me to route it?" and spawns the research agent async (fire-and-forget). Never awaits the research agent inline — dead air on radio is failure.

## Key constraints

- **Skill count affects latency directly.** 55 skills = ~20K token prompt = intermittent vLLM timeouts. 9 skills = ~6K tokens = stable 1.5s. Only add skills the voice agent actually needs.
- **Ollama is 50-80x slower than vLLM on GPU.** On DGX Spark / any NVIDIA GPU, vLLM with FP8 gives ~0.3s inference. Ollama GGUF gives ~16-26s. Never put Ollama models in the voice fallback chain.
- **Fallback chain:** vLLM (local, ~1.5s via gateway) → Anthropic Sonnet (cloud, ~4s). Two steps. No intermediate.
- **Conversation history:** Rolling buffer per channel (10 turns, 5min TTL). Managed in bridge.js `channelHistory` Map.

## Configuration

All via environment variables. See `.env.example`. Key vars:
- `ZELLO_NETWORK`, `ZELLO_BOT_USER`, `ZELLO_BOT_PASS`, `ZELLO_BRIDGE_CHANNELS` — Zello connection
- `GATEWAY_TOKEN`, `OPENCLAW_AGENT` — OpenClaw LLM routing
- `VENV_PYTHON`, `TTS_VOICE` — TTS (Python with sherpa-onnx)
- `ZELLO_API_KEY` — enables REST API (optional)
- `LLM_BACKEND` — `openclaw` (default) or `local` (any OpenAI-compatible endpoint)

## What NOT to do

- **Don't add inbound Opus decoding back.** It was removed intentionally. Zello handles STT server-side. The old decode path (Opus → PCM → WAV → Whisper) added 268MB RAM, a Python worker process, and ~500ms latency for zero benefit.
- **Don't add Ollama models to the voice fallback chain.** They're too slow for voice on GPU hardware. Use them for non-latency-critical agents (cron jobs, heartbeats) only.
- **Don't increase the voice agent's skill count without measuring.** Every skill adds ~200-500 tokens to the prompt. Test latency after adding skills.
- **Don't await research agent spawns inline.** The research agent takes 30-120s. Always fire-and-forget and respond to radio immediately.
- **Don't add `faster-whisper` back as a dependency.** It was the STT engine for local transcription. Removed when we switched to Zello server-side transcription.

## Deployment

Runs as a systemd user service (`clawptt.service`). Depends on `openclaw-gateway.service`. The REST API runs on port 18790 in the same process. No separate containers or services needed.

## Docs

- `README.md` — Landing page, quick start
- `docs/INSTALLATION.md` — Full guide: Zello setup, agent design, model selection, gate protocol, REST API, production deployment

<p align="center">
  <img src="assets/clawtalk-icon-white-clean.png" alt="ClawPTT" width="128">
</p>

# ClawPTT

Zello Work voice bridge and REST API for OpenClaw. Connects push-to-talk radio to AI agents via real-time speech-to-speech processing, and exposes the Zello Work admin/data API as HTTP endpoints.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ ClawPTT (single Node.js process)                                      │
│                                                                        │
│  bridge.js ─── Voice Bridge (WebSocket streaming API)                  │
│  │  Zello PTT → text (server-side STT) → LLM → TTS → Opus → Zello   │
│  │  Conversation history (rolling buffer, 10 turns, 5min TTL)         │
│  │  Retry logic: 6 attempts, exponential backoff for start_stream     │
│  │                                                                     │
│  ├── api.js ── REST API server (port 18790)                           │
│  │   Uses zello.js for all Zello Work admin/data operations           │
│  │   Users, channels, locations, history, media, roles                │
│  │                                                                     │
│  └── zello.js ─ ZelloAPI class (REST client)                          │
│      Session auth, auto-reauth, all Zello Work REST endpoints         │
└──────────────────────────────────────────────────────────────────────┘
```

### Voice bridge (bridge.js)

1. User presses PTT on Zello, speaks
2. Zello delivers transcription text via WebSocket (`on_transcription` event)
3. Text sent to LLM (OpenClaw gateway or any OpenAI-compatible endpoint)
4. Response converted to speech by sherpa-onnx/Piper TTS
5. Opus-encoded audio streamed back to Zello

Inbound is text — Zello handles speech-to-text server-side. A local faster-whisper fallback exists for networks without Zello transcription. Outbound is audio (TTS → Opus encode → stream).

Supports channel broadcasts, direct messages, and per-channel conversation history.

### REST API (api.js + zello.js)

Runs in-process with the voice bridge on port 18790. Single Zello session shared across all callers.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/users` | GET/POST/DELETE | List, create, delete users |
| `/channels` | GET/POST/DELETE | List, create, delete channels |
| `/channels/members` | POST/DELETE | Add/remove channel members |
| `/contacts` | POST/DELETE | Add/remove user contacts |
| `/roles` | GET/POST/DELETE | Channel roles |
| `/roles/assign` | POST | Assign users to roles |
| `/locations` | GET | GPS locations (bounding box or all active) |
| `/locations/user` | GET | Per-user location and history (GeoJSON) |
| `/history` | GET | Message history metadata |
| `/media` | GET | Media download URLs (voice MP3, image JPG) |
| `/session/refresh` | POST | Refresh Zello API session |

Auth: `Authorization: Bearer <token>` (defaults to `GATEWAY_TOKEN`).

Activates when `ZELLO_API_KEY` is set in the environment. Without it, only the voice bridge runs.

## Prerequisites

- **Node.js** >= 18
- **Python 3** with `faster-whisper` and `sherpa-onnx` packages
- **ffmpeg**
- A **Zello Work** network with API access
- An LLM endpoint: **OpenClaw** gateway or any OpenAI-compatible API

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/fgutzwiller/ClawPTT.git
cd ClawPTT
npm install

# 2. Set up Python dependencies
python3 -m venv .venv
.venv/bin/pip install faster-whisper sherpa-onnx numpy

# 3. Download a TTS voice model
mkdir -p ~/.clawptt/tts/models
cd ~/.clawptt/tts/models
curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2 | tar xjf -

# 4. Configure
cp .env.example .env
# Edit .env with your Zello credentials and LLM endpoint

# 5. Run
VENV_PYTHON=.venv/bin/python3 ./run.sh
```

## Configuration

Copy `.env.example` to `.env` and set your values.

### Zello Work
| Variable | Description |
|----------|-------------|
| `ZELLO_NETWORK` | Your Zello Work network name |
| `ZELLO_BOT_USER` | Bot username |
| `ZELLO_BOT_PASS` | Bot password |
| `ZELLO_BRIDGE_CHANNELS` | Channels to join (comma-separated) |

### Zello REST API
| Variable | Description |
|----------|-------------|
| `ZELLO_API_KEY` | API key from Zello admin console (enables the REST API) |
| `ZELLO_ADMIN_USER` | Admin username (falls back to `ZELLO_BOT_USER`) |
| `ZELLO_ADMIN_PASS` | Admin password (falls back to `ZELLO_BOT_PASS`) |
| `CLAWPTT_API_PORT` | REST API port (default: `18790`) |
| `CLAWPTT_API_TOKEN` | API auth token (default: `GATEWAY_TOKEN`) |

### LLM Backend
| Variable | Description |
|----------|-------------|
| `LLM_BACKEND` | `openclaw` (default) or `local` |
| `GATEWAY_TOKEN` | OpenClaw gateway auth token |
| `OPENCLAW_GATEWAY` | Gateway URL (default: `http://127.0.0.1:18789`) |
| `OPENCLAW_AGENT` | Agent ID to route voice to (default: `main`) |

For the `local` backend (any OpenAI-compatible API):
| Variable | Description |
|----------|-------------|
| `LOCAL_LLM_URL` | API endpoint |
| `LOCAL_LLM_API_KEY` | API key |
| `LOCAL_LLM_MODEL` | Model ID |
| `AGENT_SYSTEM_PROMPT` | System prompt for the local model |

### Conversation History
| Variable | Description |
|----------|-------------|
| `HISTORY_MAX_TURNS` | Max conversation turns to retain (default: `10`) |
| `HISTORY_TTL_MS` | History TTL in milliseconds (default: `300000` / 5 min) |

### STT / TTS
| Variable | Description |
|----------|-------------|
| `WHISPER_MODEL` | Whisper model size: `base.en`, `small.en`, `medium.en`, `large-v3` |
| `TTS_VOICE` | Piper voice: `en_US-lessac-high`, `en_US-hfc_male-medium`, `en_GB-alan-medium` |
| `VENV_PYTHON` | Path to Python with faster-whisper + sherpa-onnx |
| `SHERPA_ONNX_DIR` | TTS model directory (default: `~/.clawptt/tts`) |

Browse all voices: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models

## OpenClaw setup

1. Enable the chat completions endpoint in `openclaw.json`:
   ```json
   { "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }
   ```
2. Create a dedicated agent for voice, or use an existing one
3. Set `OPENCLAW_AGENT` to the agent ID

The agent controls which model, tools, and search providers are used. ClawPTT just sends text and speaks the response.

## Running as a service

```bash
cat > ~/.config/systemd/user/clawptt.service << 'EOF'
[Unit]
Description=ClawPTT Voice Bridge
After=openclaw-gateway.service
Wants=openclaw-gateway.service

[Service]
Type=simple
ExecStart=/path/to/clawptt/run.sh
WorkingDirectory=/path/to/clawptt
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now clawptt
```

## Detailed setup

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for:
- Step-by-step Zello Work configuration
- Agent design for voice
- Model and latency recommendations
- Search and tool configuration
- Production deployment

## License

MIT

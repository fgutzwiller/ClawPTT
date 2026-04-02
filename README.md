# ClawPTT

Zello Work voice bridge for OpenClaw. Connects push-to-talk radio to AI agents via real-time speech-to-speech processing.

ClawPTT handles voice I/O only. All intelligence (model, tools, search, persona) lives in the agent behind the LLM endpoint.

## How it works

```
Zello PTT → Opus decode → faster-whisper STT → LLM → sherpa-onnx TTS → Opus encode → Zello PTT
```

1. User presses PTT on Zello, audio streams to ClawPTT via WebSocket
2. Opus frames decoded to PCM, transcribed by faster-whisper (persistent worker)
3. Text sent to LLM (OpenClaw gateway or any OpenAI-compatible endpoint)
4. Response converted to speech by sherpa-onnx/Piper TTS
5. Audio streamed back to Zello

Supports both channel broadcasts and direct messages.

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
.venv/bin/pip install faster-whisper sherpa-onnx

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

Copy `.env.example` to `.env` and set your values. Key settings:

### Zello Work
| Variable | Description |
|----------|-------------|
| `ZELLO_NETWORK` | Your Zello Work network name |
| `ZELLO_BOT_USER` | Bot username |
| `ZELLO_BOT_PASS` | Bot password |
| `ZELLO_BRIDGE_CHANNELS` | Channels to join (comma-separated) |

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
# Create a systemd user service
cat > ~/.config/systemd/user/clawptt.service << 'EOF'
[Unit]
Description=ClawPTT Voice Bridge

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

## Troubleshooting

**Bridge won't connect to Zello** — Verify credentials. The bot user must be a member of the configured channels. Channels must be in the user's contact list (join from the Zello app first).

**403 from OpenClaw** — Ensure `gateway.http.endpoints.chatCompletions.enabled` is `true` and your gateway version supports it (>= 2026.3.31).

**No audio response** — Check that the TTS voice model is downloaded and `VENV_PYTHON` points to a Python with `sherpa-onnx` installed.

**High latency** — Use a smaller Whisper model (`base.en`), a local LLM, or both. The persistent STT worker avoids model reload overhead.

## License

MIT

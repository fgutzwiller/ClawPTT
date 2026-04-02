<p align="center">
  <img src="assets/clawtalk-icon-white-clean.png" alt="ClawPTT" width="256">
</p>

# ClawPTT

AI on push-to-talk radio. Key up, ask a question, get a spoken answer — everyone on the channel hears it.

ClawPTT connects [Zello Work](https://zellowork.com) PTT networks to AI agents via [OpenClaw](https://github.com/nicepkg/openclaw) (or any OpenAI-compatible endpoint). Text in from Zello's server-side transcription, audio out via offline TTS. Single Node.js process, no cloud dependency for routine queries.

## How it works

```
You (PTT radio) → Zello transcribes → ClawPTT → LLM agent → TTS → Opus audio → You hear the answer
```

Quick questions (weather, calendar, locations) are answered in 2-5 seconds on local inference. Complex questions are gated to a research agent that runs asynchronously and posts results to a text channel — the radio is never blocked.

Also includes a REST API (port 18790) for Zello Work admin operations: user management, GPS locations, message history, channel configuration.

## Quick start

```bash
git clone https://github.com/fgutzwiller/ClawPTT.git
cd ClawPTT
npm install

# TTS dependencies
python3 -m venv .venv
.venv/bin/pip install sherpa-onnx numpy

# Download a voice model
mkdir -p ~/.clawptt/tts/models && cd ~/.clawptt/tts/models
curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2 | tar xjf -

# Configure and run
cp .env.example .env    # edit with your Zello + LLM credentials
VENV_PYTHON=.venv/bin/python3 ./run.sh
```

## Requirements

- Node.js >= 18
- Python 3 with `sherpa-onnx` (TTS only — inbound STT is handled by Zello)
- ffmpeg
- Zello Work network with transcription enabled
- OpenClaw gateway or any OpenAI-compatible LLM endpoint

## Documentation

See **[docs/INSTALLATION.md](docs/INSTALLATION.md)** for the full guide:

- Why ClawPTT exists (design philosophy from HAM radio, tactical comms, cybersecurity)
- Architecture overview and component demarcation
- Zello Work setup (user, channel, subscription — step by step)
- Two-tier agent design (fast voice agent + async research agent)
- Model selection and latency budget (why vLLM >> Ollama on GPU)
- Skill filtering for voice performance (55 skills = timeouts, 9 skills = 1.5s)
- Gate protocol for deep research (async handoff to text channel)
- REST API reference (users, channels, locations, history, media)
- Production deployment (systemd, monitoring, capacity)

## Configuration

All config via environment variables. Copy `.env.example` and edit:

```bash
# Minimum required
ZELLO_NETWORK=your-network
ZELLO_BOT_USER=your-bot
ZELLO_BOT_PASS=your-password
ZELLO_BRIDGE_CHANNELS=your-channel
GATEWAY_TOKEN=your-openclaw-token
OPENCLAW_AGENT=your-agent-id
VENV_PYTHON=.venv/bin/python3
```

See `.env.example` for all options (REST API, TTS voice, local LLM, conversation history).

## License

MIT

<img src="../assets/clawtalk-icon-white-clean.png" alt="ClawPTT" width="192">

# ClawPTT — Installation and Configuration Guide

## Why ClawPTT Exists

Push-to-talk radio is the fastest human-to-human communication protocol ever designed. One button, instant transmission, no dialing, no ringing, no "can you hear me." In field operations — military, emergency services, logistics, security — PTT is the standard because it's the only interface that works when your hands are full, your eyes are elsewhere, and you need an answer now.

AI assistants today live behind screens. You type, you wait, you read. That's fine at a desk. It's useless on a radio net, in a vehicle, on a job site, or in any situation where voice is the only viable interface.

ClawPTT bridges this gap. It puts an AI agent on a PTT radio channel. You key up, ask a question, release. The agent answers on the same channel, in spoken voice, in seconds. Everyone monitoring the channel hears both the question and the answer — shared situational awareness, the way radio is supposed to work.

### Background

This project comes from the intersection of three domains:

**Amateur radio (HAM).** The radio operator's instinct is efficiency: minimum bandwidth, maximum information density, standardized protocols. ClawPTT borrows from this culture — the voice agent's system prompt enforces one-sentence responses, plain English prowords ("Copy", "Negative", "Stand by", "Affirm"), no filler, no pleasantries, no markdown. Numbers are spelled out for TTS clarity ("forty-two", not "42"). The PACE fallback pattern (Primary → Alternate → Contingency → Emergency) maps directly to the model routing chain: local vLLM → cloud Sonnet → manual → offline.

**Tactical communications.** Military and security comms operate on the principle that the channel is shared, contested, and time-constrained. ClawPTT is designed with this in mind: the voice agent holds the channel only as long as necessary, gates complex queries to async text channels instead of blocking the radio, and follows a PACE-like fallback architecture (Primary: local vLLM → Alternate: cloud Sonnet → Contingency: manual → Emergency: offline).

**Cybersecurity and infrastructure.** The system runs sovereign — local inference on your own hardware, no data leaving your network for routine queries. Cloud models are fallbacks, not defaults. The Zello REST API runs in-process (not as a separate service) to minimize attack surface. Credentials are never in config files, always in environment variables.

### What ClawPTT actually does

1. Someone keys up on Zello (phone, desktop, or hardware radio via gateway)
2. Zello transcribes the speech server-side and delivers text to ClawPTT
3. ClawPTT sends the text to an AI agent (local or cloud LLM via OpenClaw)
4. The agent's response is converted to speech (offline TTS) and streamed back as Opus audio
5. Everyone on the channel hears the answer

Text in, audio out. The voice agent can check weather, pull calendar events, search the web, look up GPS locations, query databases — anything the agent has tools for. Complex questions that need deep research are gated: the voice agent responds immediately ("Routed to research. Check Slack.") and the heavy work runs asynchronously on a more capable model, posting results to a text channel.

### Design principles

- **Speed over completeness.** A 2-second partial answer beats a 30-second perfect one. On radio, silence is failure.
- **Minimal skill surface.** The voice agent carries only the tools it needs (~10 skills). Everything else routes through a coordinator agent with full capabilities. Fewer skills = smaller prompt = faster inference.
- **Async gate for deep work.** Questions requiring multi-step research, document drafting, or write operations are escalated to a research agent that runs asynchronously. The voice channel is never blocked.
- **Sovereign inference.** Primary model runs locally (vLLM on GPU). Cloud is fallback only. Your voice data and agent responses stay on your infrastructure for routine operations.
- **Channel-agnostic architecture.** The two-tier pattern (fast voice agent + async research agent) works for any transport: Zello PTT, WhatsApp voice, Discord, Telegram, phone calls. ClawPTT implements the Zello transport; the agent architecture is reusable.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Component Demarcation](#component-demarcation)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Agent Design for Voice](#agent-design-for-voice)
- [Model Recommendations](#model-recommendations)
- [Search and Tool Configuration](#search-and-tool-configuration)
- [Gate Settings and Execution Policy](#gate-settings-and-execution-policy)
- [Zello Work REST API](#zello-work-rest-api)
- [NemoClaw Integration](#nemoclaw-integration)
- [Production Deployment](#production-deployment)

---

## Architecture Overview

ClawPTT is the voice transport layer in a three-tier stack:

```
┌─────────────────────────────────────────────────────────────┐
│                    Zello Work Network                        │
│             (PTT radio — phones, desktops, radios)          │
└─────────────────────────┬───────────────────────────────────┘
                          │ WebSocket
                          │ Inbound: on_transcription (text)
                          │ Outbound: Opus audio stream
┌─────────────────────────▼───────────────────────────────────┐
│                         ClawPTT                             │
│                                                             │
│  Inbound:  text from Zello (server-side STT)               │
│  Outbound: sherpa-onnx TTS → Opus encode → Zello stream    │
│                                                             │
│  Also:                                                      │
│  • Text sanitization (markdown → spoken word)               │
│  • Conversation history (rolling buffer per channel)        │
│  • Zello REST API (admin/data, port 18790)                  │
│  • DM and channel support                                   │
│                                                             │
│  Does NOT handle: model selection, tools, search, persona   │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP (OpenAI-compatible chat/completions)
┌─────────────────────────▼───────────────────────────────────┐
│                    OpenClaw Gateway                          │
│                                                             │
│  Agent orchestration:                                       │
│  • Model routing (primary + fallbacks)                      │
│  • Tool execution (web search, calendars, APIs)             │
│  • Memory and session management                            │
│  • Agent persona and system prompts                         │
│  • Subagent delegation (Tier 1 → Tier 2 async gate)        │
│                                                             │
│  Optional: NemoClaw layer for security guardrails           │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                       LLM Backends                          │
│                                                             │
│  Local:  vLLM (primary, FP8, ~0.3s inference)              │
│  Cloud:  Anthropic, NVIDIA NIM (fallback + research)       │
│  Hybrid: local primary with cloud fallback                  │
└─────────────────────────────────────────────────────────────┘
```

**Inbound flow:** Zello delivers transcription text via `on_transcription` WebSocket events (server-side STT). ClawPTT receives text directly — no Opus decoding, no local STT model, no audio processing on the inbound path. Text in, audio out.

## Component Demarcation

Understanding what belongs where is critical for a clean deployment.

### ClawPTT is responsible for:

| Concern | Details |
|---------|---------|
| Zello transport | WebSocket connection, authentication, channel management, reconnect |
| Inbound text | Receives transcription text from Zello (server-side STT). Local Whisper fallback available. |
| Outbound audio | TTS → Opus encode (16kHz mono) → stream to Zello at 60ms intervals |
| Text-to-speech | sherpa-onnx with Piper VITS voices, fully offline |
| Text sanitization | Strips markdown, URLs, emojis, special characters before TTS |
| Conversation history | Rolling buffer per channel (10 turns, 5min TTL) |
| Zello REST API | In-process admin/data API on port 18790 (users, channels, locations, history) |

### ClawPTT does NOT handle:

| Concern | Where it belongs |
|---------|-----------------|
| Which LLM model to use | OpenClaw agent config (`model.primary`, `model.fallbacks`) |
| Web search / real-time data | OpenClaw agent tools (Brave, Perplexity plugins) |
| Calendar, email, APIs | OpenClaw agent tools and MCP servers |
| Agent persona / system prompt | OpenClaw agent directory (`AGENT.md` or system config) |
| Memory and context | OpenClaw session management |
| Security guardrails | NemoClaw (optional) |
| Tool approval gates | OpenClaw `exec` and `tools` config |

**Design principle:** ClawPTT converts voice to text and text to voice. Everything in between is the agent's job. This means you can swap agents, models, and tools without touching ClawPTT.

---

## Prerequisites

### System requirements

- **Node.js** >= 18 (22+ recommended for native Opus bindings)
- **Python 3.10+** with pip (for TTS only — `sherpa-onnx` package)
- **ffmpeg** (for TTS audio conversion)
- **OpenClaw** >= 2026.3.31 (with `chatCompletions` HTTP endpoint)

Inbound speech-to-text is handled by Zello's server-side transcription — no local STT model needed.

### Zello Work

- A Zello Work network with API access
- A dedicated bot user account (not admin — use a service account)
- The bot user must be a member of target channels
- Zello Work API key (from the Zello admin console)

---

## Zello Work Configuration

### How Zello PTT works

Zello Work is a push-to-talk (PTT) radio platform. It operates like traditional two-way radio but over IP. Users press a button to transmit voice; everyone listening on the same channel hears it in real-time.

There are two communication modes:

- **Channels** — group radio. Anyone in the channel hears every transmission. Multiple users can listen simultaneously, one transmits at a time.
- **Direct messages (DMs)** — private 1:1 communication between two users.

ClawPTT supports both, but **channels are the recommended configuration**.

### Why channels, not direct messages

The bot user (your AI agent) should sit in a **channel**, not just exist as a contact for DMs. This is both a technical constraint and a design choice.

**Technical: Zello's WebSocket API is channel-centric.** The streaming API only receives audio and transcriptions from channels the bot user is subscribed to. There is no "listen to all incoming DMs" mode — DMs work reactively (someone must initiate a DM to the bot), but the bot cannot discover, list, or proactively monitor DMs. Channels are the reliable, deterministic inbound path. The bot subscribes to a channel once and receives every transmission on it — predictably, permanently, with no user action required.

**Design: channels provide shared situational awareness.** When the bot is in a channel, everyone monitoring hears both the question and the AI response. A dispatcher hears what field workers are asking. A supervisor hears what the team needs. On radio, information is ambient by design. The bot sits on a channel the same way a human dispatcher sits on a channel — always listening, always available, transmissions are shared.

**Channels match PTT radio conventions.** In real-world PTT deployments (security, logistics, field ops, emergency response), communication happens on channels. Users are trained to select a channel and transmit. DMs are an afterthought in radio culture. Putting the AI on a channel means zero behavior change for the team.

**Channels support multi-party interaction.** User A asks a question, the AI responds, User B hears the answer and adds context. This natural radio flow doesn't work in DMs where each conversation is isolated.

**Channels are operationally visible.** An admin or supervisor can monitor the AI channel to audit what's being asked and answered. DM conversations are invisible to the team.

**DMs still work** — ClawPTT handles them correctly (replies go back to the sender). But they're reactive, invisible to the team, and not the recommended primary interaction model.

### Recommended Zello setup

```
┌─────────────────────────────────────────────┐
│              Zello Work Network              │
│                                              │
│   Channels:                                  │
│   ├── Everyone        (team comms, no bot)   │
│   ├── AI-Dispatch     (bot listens here)     │
│   └── Operations      (team comms, no bot)   │
│                                              │
│   Users:                                     │
│   ├── admin           (network admin)        │
│   ├── field-1         (field worker)         │
│   ├── field-2         (field worker)         │
│   ├── dispatch        (dispatcher)           │
│   └── ai-voice        (ClawPTT bot) ◄────── │
│                                              │
└─────────────────────────────────────────────┘
```

**Key decisions:**

| Decision | Recommendation | Why |
|----------|---------------|-----|
| Dedicated channel for AI | Yes | Keeps AI traffic separate from operational chatter |
| Bot on "Everyone" channel | No | Too noisy — bot responds to everything, disrupts team comms |
| Bot user as admin | No | Use a service account with minimal permissions |
| Multiple AI channels | Optional | Useful for topic separation (e.g., logistics-ai, intel-ai) |
| Bot listens to DMs | Automatic | ClawPTT handles DMs by default, no extra config needed |

### Step 1: Authenticate with the Zello REST API

All API operations require an authenticated session. You'll need your network admin credentials and API key (from the Zello Work admin console under Settings > API).

<details>
<summary><b>Via API</b></summary>

```bash
# Set your credentials
NETWORK="your-network"
API_KEY="your-api-key"
ADMIN_USER="admin"
ADMIN_PASS="your-admin-password"

# Get a session token
TOKEN_RES=$(curl -sS "https://$NETWORK.zellowork.com/user/gettoken")
TOKEN=$(echo "$TOKEN_RES" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['token'])")
SID=$(echo "$TOKEN_RES" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['sid'])")

# Build the auth hash: md5(md5(password) + token + api_key)
PASS_HASH=$(echo -n "$ADMIN_PASS" | md5sum | cut -d' ' -f1)
AUTH_HASH=$(echo -n "${PASS_HASH}${TOKEN}${API_KEY}" | md5sum | cut -d' ' -f1)

# Log in
curl -sS "https://$NETWORK.zellowork.com/user/login?sid=$SID" \
  -d "username=$ADMIN_USER&password=$AUTH_HASH"

# All subsequent commands use ?sid=$SID for authentication
```

</details>

<details>
<summary><b>Via admin console</b></summary>

1. Go to `https://your-network.zellowork.com/admin`
2. Log in with your admin credentials
3. The admin console provides a UI for all user and channel operations below

</details>

### Step 2: Create the bot user

<details>
<summary><b>Via API</b></summary>

```bash
# Hash the bot password (Zello expects md5-hashed passwords)
BOT_PASS="your-bot-password"
BOT_PASS_HASH=$(echo -n "$BOT_PASS" | md5sum | cut -d' ' -f1)

# Create the user
curl -sS "https://$NETWORK.zellowork.com/user/save?sid=$SID" \
  -d "name=ai-voice&password=$BOT_PASS_HASH&full_name=AI+Voice&job=Voice+Assistant&limited_access=true"
```

</details>

<details>
<summary><b>Via admin console</b></summary>

1. Go to **Users** > **Add User**
2. Set username (e.g., `ai-voice`), password, display name
3. Set Job/Title to something descriptive (e.g., "Voice Assistant")
4. Enable **Limited access** to restrict unnecessary DM initiation
5. Leave **Admin** unchecked
6. Click **Save**

</details>

The bot user should have:
- `limited_access: true` — restricts unnecessary 1:1 conversation initiation
- `admin: false` — no admin console access
- A descriptive `full_name` and `job` so team members recognize it in the contacts list

### Step 3: Create a channel

<details>
<summary><b>Via API</b></summary>

```bash
# Create a shared (group) channel
curl -sS "https://$NETWORK.zellowork.com/channel/add/name/AI-Dispatch/shared/true?sid=$SID"
```

</details>

<details>
<summary><b>Via admin console</b></summary>

1. Go to **Channels** > **Add Channel**
2. Set name (e.g., `AI-Dispatch`)
3. Set type to **Group** (shared) — everyone in the channel hears every transmission
4. Leave **Invisible** unchecked
5. Click **Save**

</details>

### Step 4: Add users to the channel

<details>
<summary><b>Via API</b></summary>

```bash
# Add the bot user
curl -sS "https://$NETWORK.zellowork.com/user/addto/AI-Dispatch?sid=$SID" \
  -d "login[]=ai-voice"

# Add team members who should have AI access
curl -sS "https://$NETWORK.zellowork.com/user/addto/AI-Dispatch?sid=$SID" \
  -d "login[]=field-1&login[]=field-2&login[]=dispatch"
```

</details>

<details>
<summary><b>Via admin console</b></summary>

1. Go to **Channels** > click on `AI-Dispatch`
2. Click **Add Users**
3. Select `ai-voice` (the bot) and any team members who need AI access
4. Click **Save**

</details>

### Step 5: Subscribe the bot to the channel (required)

This step is critical and **cannot be done via the REST API**.

The Zello Work **streaming WebSocket API** (which ClawPTT uses for real-time audio) only sees channels that are in the bot user's **app-level contact list**. The REST API creates server-side membership, but the WebSocket API requires the channel to appear in the user's subscribed contact list.

**You must do this once manually:**

1. Install the **Zello Work app** on a phone or desktop
2. **Log in as the bot user** (e.g., `ai-voice`)
3. Go to **Channels** > **Browse** > find your channel (e.g., `AI-Dispatch`)
4. **Tap/click to subscribe** to the channel
5. Log out of the bot account

After this one-time step, the channel persists across WebSocket reconnects. You don't need to keep the app running.

**How to tell if this step was missed:** ClawPTT logs `channel not found` at startup despite the user being a member via REST API. The fix is always the one-time app subscription.

### Step 6: Verify the setup

<details>
<summary><b>Via API</b></summary>

```bash
# Check the user exists and is in the channel
curl -sS "https://$NETWORK.zellowork.com/user/get/login/ai-voice?sid=$SID"

# Check the channel exists and has members
curl -sS "https://$NETWORK.zellowork.com/channel/get/name/AI-Dispatch?sid=$SID"
```

</details>

<details>
<summary><b>Via admin console</b></summary>

1. Go to **Users** > click on `ai-voice` > verify `AI-Dispatch` appears under Channels
2. Go to **Channels** > click on `AI-Dispatch` > verify `ai-voice` appears in member list

</details>

<details>
<summary><b>Via ClawPTT logs</b></summary>

Start ClawPTT and check for successful connection:

```
[clawptt] Logged in as ai-voice on channels: AI-Dispatch
[clawptt] Channel AI-Dispatch: 3 users online
```

If you see `channel not found`, go back to Step 5.

</details>

### Channel configuration options

| Setting | Value | Purpose |
|---------|-------|---------|
| `shared` | `true` | Group channel — all members hear all transmissions |
| `invisible` | `false` | Keep the channel visible so users can find it |
| `dispatch` | `false` | Dispatch mode creates a queue — not needed for AI |
| `full_duplex` | `false` | Standard PTT (one speaker at a time) |

### Multiple channels

ClawPTT can join multiple channels simultaneously:

```bash
ZELLO_BRIDGE_CHANNELS=AI-Dispatch,AI-Intel,AI-Logistics
```

The bot listens on all configured channels and responds on whichever channel the transmission came from. Each channel shares the same agent — if you need different agents per channel, run multiple ClawPTT instances.

### Network sizing

Zello Work has per-network user limits depending on your plan. The bot user counts as one user. Plan accordingly if you're near the limit.

The WebSocket streaming API supports joining up to **100 channels** per connection.

### Hardware

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| TTS (sherpa-onnx) | CPU only, 512MB RAM | CPU is fine |
| Local LLM (optional) | 16GB VRAM | 24GB+ VRAM |

No local STT hardware needed — Zello handles speech-to-text server-side.

---

## Installation

### 1. Clone and install Node.js dependencies

```bash
git clone https://github.com/fgutzwiller/ClawPTT.git
cd ClawPTT
npm install
```

### 2. Set up Python environment

Create a dedicated venv with the STT and TTS packages:

```bash
python3 -m venv .venv
.venv/bin/pip install sherpa-onnx numpy
```

### 3. Download a TTS voice model

```bash
mkdir -p ~/.clawptt/tts/models
cd ~/.clawptt/tts/models

# Female US English (recommended default)
curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-high.tar.bz2 | tar xjf -

# Male US English
curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-hfc_male-medium.tar.bz2 | tar xjf -

# British male
curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-alan-medium.tar.bz2 | tar xjf -
```

Browse all voices: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models

### 4. Enable OpenClaw chat completions endpoint

Add to your `openclaw.json`:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
}
```

Restart the gateway after changing config.

### 5. Configure ClawPTT

```bash
cp .env.example .env
```

Edit `.env` with your values. At minimum:

```bash
ZELLO_NETWORK=your-network
ZELLO_BOT_USER=your-bot
ZELLO_BOT_PASS=your-password
ZELLO_BRIDGE_CHANNELS=your-channel

GATEWAY_TOKEN=your-openclaw-gateway-token
OPENCLAW_AGENT=your-agent-id

VENV_PYTHON=.venv/bin/python3
```

### 6. Run

```bash
./run.sh
```

---

## Agent Design for Voice

Voice interaction has fundamentally different constraints than text chat. A dedicated voice agent produces dramatically better results.

### Why a dedicated agent?

| Text agent | Voice agent |
|------------|-------------|
| Can return markdown, lists, tables | Must return plain spoken language |
| Can include URLs, citations | Must be self-contained |
| Can be verbose (user scans) | Must be concise (user listens) |
| Can use slow, thorough tools | Must respond within seconds |
| Can ask for clarification via text | Must handle ambiguity gracefully |

### Agent configuration recommendations

Create a dedicated agent in `openclaw.json` with voice-optimized settings:

```json
{
  "id": "voice",
  "name": "voice",
  "workspace": "~/.openclaw/workspace-voice",
  "model": {
    "primary": "vllm/Qwen/Qwen3-Coder-Next-FP8",
    "fallbacks": [
      "ollama/qwen3:32b",
      "anthropic/claude-sonnet-4-6"
    ]
  }
}
```

### Agent system prompt for voice

In the agent's `AGENT.md` or system configuration, include voice-specific instructions:

```
You are a voice assistant responding via push-to-talk radio.

Rules:
- Keep responses under 30 seconds of speech (roughly 75 words)
- Use natural spoken language, no written conventions
- Never use markdown, bullet points, asterisks, or special formatting
- Spell out abbreviations and acronyms on first use
- Use conversational connectors ("first", "also", "finally")
- Round numbers to meaningful precision ("about 17 degrees", not "16.7°C")
- When listing items, limit to 3-4 most important
- If more detail is needed, offer to elaborate
- End with a clear signal that you're done ("Over", "Standing by", etc.)
```

### Two-tier architecture: fast voice + async deep research

Voice has a hard constraint that text channels don't: **dead air is failure**. A user on Zello, WhatsApp voice, or any PTT system cannot wait 30-60 seconds for a response. But some questions genuinely require deep research (multi-step search, cross-domain analysis, document drafting).

The solution is a two-tier agent architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                   Tier 1: Voice Agent                        │
│                                                             │
│  Fast, lightweight, focused skillset                        │
│  Model: local vLLM (sub-2s inference)                       │
│  Skills: weather, calendar, email triage, search, locations │
│  Target: answer in 1-5 seconds                              │
│                                                             │
│  Can answer directly:         Must escalate:                │
│  "Weather in Barcelona?"      "Analyze the tax implications"│
│  "Where's Jack?"              "Write a board memo"          │
│  "Any SpaceX news?"           "Compare IPO scenarios"       │
│  "What's on my calendar?"     "Send email to Luca"          │
└────────────────────┬────────────────────────────────────────┘
                     │ gate triggers
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   Tier 2: Research Agent                     │
│                                                             │
│  Full skills, deep reasoning, no time constraint            │
│  Model: cloud Opus/Sonnet (frontier reasoning)              │
│  Skills: all (55+), domain agents, write operations         │
│  Runs async — posts results to text channel (Slack, etc.)   │
└─────────────────────────────────────────────────────────────┘
```

### Why this matters for any voice or chat system

This pattern applies regardless of the voice/chat transport:

| Transport | Tier 1 (voice agent) | Tier 2 (research agent) |
|-----------|---------------------|------------------------|
| **Zello PTT** | Speaks response via TTS | Posts to Slack #channel |
| **WhatsApp voice** | Sends voice note or text reply | Sends detailed text message |
| **Discord voice** | Speaks in voice channel | Posts in text channel |
| **Telegram** | Quick text reply | Detailed follow-up message |
| **Phone call** | Speaks response | Sends SMS or email with details |

The voice agent always responds immediately. The research agent always delivers asynchronously to a text-capable channel where the user can read at their own pace.

### Configuration

**Voice agent (Tier 1) — limited skills for speed:**

```json
{
  "id": "voice",
  "name": "voice",
  "workspace": "~/.openclaw/workspace-voice",
  "model": {
    "primary": "vllm/Qwen/Qwen3-Coder-Next-FP8",
    "fallbacks": [
      "anthropic/claude-sonnet-4-6"
    ]
  },
  "skills": [
    "weather",
    "gws-calendar-agenda",
    "gws-gmail-triage",
    "gws-gmail",
    "gws-shared",
    "folk-crm",
    "unifi-network",
    "slack"
  ],
  "subagents": {
    "allowAgents": ["research"]
  }
}
```

Key decisions:
- **Limited `skills` array** — only the tools the voice agent needs for quick lookups. Every skill added increases the prompt size and slows inference. 8-12 skills is the sweet spot.
- **No Ollama in fallbacks** — on GPU systems like DGX Spark, Ollama (GGUF/llama.cpp) is 50-80x slower than vLLM (native CUDA FP8). Skip straight to cloud fallback.
- **Single subagent** — the voice agent only spawns the research agent, never domain specialists directly.

**Research agent (Tier 2) — full skills, no speed constraint:**

```json
{
  "id": "research",
  "name": "research",
  "workspace": "~/.openclaw/workspace-research",
  "model": {
    "primary": "anthropic/claude-opus-4-6",
    "fallbacks": [
      "anthropic/claude-sonnet-4-6",
      "vllm/Qwen/Qwen3-Coder-Next-FP8"
    ]
  }
}
```

No skill restrictions. The research agent has access to everything — web search, document drafting, email sending, calendar writes, domain agents, deep analysis. It takes as long as it needs and posts results to a text channel.

### Gate logic in the voice agent's system prompt

Add this to the voice agent's `SOUL.md` or system prompt:

```
## GATE: What you handle vs what you escalate

HANDLE DIRECTLY (you have the tools, answer in 1-2 sentences):
- Weather, time, date, math
- Calendar: "What's on today?" → gws-calendar-agenda
- Email: "Any important email?" → gws-gmail-triage
- Search: "SpaceX news?" → Perplexity
- Location: "Where's Jack?" → Zello API + reverse geocode
- Network: "Is the internet up?" → UniFi
- Contacts: "Who is Luca?" → Folk CRM

ESCALATE TO RESEARCH AGENT (async, results on text channel):
- Deep analysis: "Analyze...", "Compare...", "Evaluate..."
- Document creation: "Write a memo...", "Draft an email..."
- Write operations: "Send email to...", "Create a calendar event..."
- Multi-domain queries: "What's the portfolio status?"
- Anything requiring 3+ tool calls or 3+ sentences of output

GATE PROTOCOL:
1. "That needs [research-agent]. Want me to route it?"
2. Wait for confirmation ("yes", "go ahead")
3. Spawn research agent asynchronously — do NOT wait for result
4. "Routed. Results will be on [text channel]."

NEVER wait for the research agent inline. Dead air on voice = failure.
The research agent posts directly to the text channel when done.

EMERGENCY (L1/L2 — safety, legal, financial):
- Route immediately without confirmation
- "Routing now. Check [text channel]."
```

### Why limited skills matter for performance

Every skill injected into the voice agent's prompt adds ~200-500 tokens of tool definitions. With 55 skills, that's ~15,000 extra tokens per request. On a local model:

| Skills loaded | Prompt size | Inference time (simple query) |
|--------------|-------------|-------------------------------|
| 8-10 skills | ~6K tokens | ~1.5s |
| 25 skills | ~12K tokens | ~3-5s |
| 55 skills | ~20K tokens | ~5-15s (intermittent timeouts) |

The voice agent should have the minimum skills needed for its direct-answer queries. Everything else goes through the research agent, which has no latency constraint.

### Subagent delegation

The voice agent spawns the research agent with `sessions_spawn`:

```
sessions_spawn(agentId="research", task="[user's question]. Post results to #channel via message tool.", runtime="subagent")
```

The `runtime: "subagent"` flag runs it asynchronously. The voice agent does not await the result — it responds to the user immediately and moves on.

If your research agent is a coordinator (like HALDEMAN in the WATERGATE architecture), it can in turn spawn domain-specialist subagents for legal, financial, portfolio, or operational queries.

---

## Model Recommendations

### Primary model for voice (speed-critical)

The voice loop has a latency budget. Every second the user waits feels unnatural on radio.

| Model | Engine | Latency | Quality | Best for |
|-------|--------|---------|---------|----------|
| **Qwen3-Coder-Next-FP8** | vLLM | ~0.3s direct, ~1.5s via gateway | Very good | Primary voice model |
| **claude-sonnet-4-6** | Anthropic cloud | ~3-5s | Excellent | Cloud fallback for voice |
| **claude-opus-4-6** | Anthropic cloud | ~5-15s | Best | Research agent (Tier 2), too slow for voice |
| **kimi-k2.5** | NVIDIA NIM | ~2-4s | Good | Cloud alternative with large context |
| **qwen3:32b** | Ollama (GGUF) | ~16-26s | Good | **Not recommended for voice** |

**Important: Ollama vs vLLM on GPU systems.** On hardware with native CUDA support (DGX Spark, any NVIDIA GPU), vLLM with FP8 quantization is 50-80x faster than Ollama with GGUF quantization. Ollama uses llama.cpp which doesn't fully leverage GPU tensor cores. Don't use Ollama models in the voice fallback chain — skip straight to a cloud model.

**Recommendation:** `vLLM (local, ~1.5s) → cloud Sonnet (~4s)`. Two-step fallback. No Ollama in the voice path.

### Latency budget breakdown

```
Target: < 10 seconds from PTT release to voice response start

Zello transcription delivery:      ~0s   (arrives with on_stream_stop)
LLM (local vLLM):                  ~1-2s (depends on response length)
TTS (sherpa-onnx):                 ~1-2s (depends on text length)
Opus encoding + transmission:      ~0.5s
──────────────────────────────────────────
Total:                              ~3-5s typical
```

With a cloud LLM, add 2-8 seconds. With tool calls (search), add 2-5 seconds per tool.

---

## Search and Tool Configuration

### Primary search endpoint: Perplexity

For voice, search must be fast AND return synthesized answers (not raw web snippets). Perplexity is the best fit.

**Why Perplexity over Brave Search for voice:**

| | Perplexity | Brave Search |
|-|------------|-------------|
| Response type | Synthesized answer | Raw page snippets |
| Accuracy | High (AI-summarized) | Depends on indexed pages |
| Latency | ~2-4s | ~1-2s |
| Voice suitability | Ready to speak | Needs LLM post-processing |

Configure Perplexity as a plugin in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "perplexity": {
        "enabled": true,
        "config": {
          "webSearch": {
            "apiKey": "${PERPLEXITY_API_KEY}"
          }
        }
      }
    }
  }
}
```

### Tool execution settings for voice agents

Voice agents should favor speed over thoroughness for routine queries. Configure the agent to:

1. **Prefer Perplexity** for real-time data (weather, news, sports, stocks)
2. **Use Brave Search** as fallback when Perplexity is unavailable
3. **Limit tool depth** — avoid multi-step research chains in the voice path

In the agent's system prompt:

```
When the user asks a factual question:
- Use Perplexity search for a quick, synthesized answer
- Do not chain multiple searches — give the best answer from one query
- If the answer requires deep research, offer to research and follow up
```

---

## Gate Settings and Execution Policy

### Exec policy for voice agents

Voice agents cannot block waiting for interactive approval — there's no text input on radio. Set `ask: "off"` and control access structurally via the `skills` array instead:

```json
{
  "id": "voice",
  "skills": ["weather", "gws-calendar-agenda", "gws-gmail-triage", "gws-gmail", "gws-shared", "folk-crm", "unifi-network", "slack"],
  "tools": {
    "exec": {
      "security": "full",
      "ask": "off"
    }
  }
}
```

The voice agent can only use the skills listed. Write operations (email send, calendar create, user delete) are not in the list — the agent physically cannot call them. No runtime approval needed.

### Gate flow in practice

```
User (on radio): "What's the weather?"
Voice agent: [calls weather tool] → "Twenty degrees, partly cloudy." (3s)

User (on radio): "Write a board memo on the Voliro situation"
Voice agent: "That needs the research agent. Want me to route it?"
User: "Go ahead"
Voice agent: [spawns research agent async] → "Routed. Results on Slack." (4s)
Research agent: [runs 30-60s on Opus, posts to Slack when done]

User (on radio): "Jack fell off his bike"
Voice agent: [L1 emergency — no confirmation needed]
→ "Routing to research agent now. Check Slack." [spawns immediately] (2s)
```

The voice path never blocks. Deep research and write operations always go async to a text channel.

---

## Zello Work REST API

ClawPTT includes a built-in REST API for Zello Work admin and data operations. It runs in-process with the voice bridge — one process, one Zello session, zero extra overhead.

### How it works

When `ZELLO_API_KEY` is set, ClawPTT starts an HTTP server (default port 18790) alongside the voice bridge. Agents call it via standard HTTP — no MCP server, no extra processes.

```
┌─────────────────────────────────────────────────────────────┐
│  ClawPTT (single process)                                   │
│                                                             │
│  bridge.js ─── Voice (text in via WS, TTS + Opus out)      │
│  api.js ────── REST API (HTTP, port 18790)                  │
│  zello.js ──── ZelloAPI class (shared session)              │
└─────────────────────────────────────────────────────────────┘
```

### Endpoints

All endpoints require `Authorization: Bearer <token>` (defaults to `GATEWAY_TOKEN`).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + session status |
| `/users` | GET | List users or get specific user (`?username=X`) |
| `/users` | POST | Create/update user |
| `/users` | DELETE | Delete users |
| `/channels` | GET | List channels or get specific (`?name=X`) |
| `/channels` | POST | Create channel |
| `/channels/members` | POST/DELETE | Add/remove channel members |
| `/contacts` | POST/DELETE | Add/remove user contacts |
| `/roles` | GET/POST/DELETE | Channel roles |
| `/roles/assign` | POST | Assign users to roles |
| `/locations` | GET | GPS locations (`?filter=active` for all online users) |
| `/locations/user` | GET | Per-user location (`?username=X&history=true&format=geojson`) |
| `/history` | GET | Message history (`?sender=X&via_channel=Y&type=voice&max=10`) |
| `/media` | GET | Media download URL (`?media_key=X`) |
| `/session/refresh` | POST | Refresh Zello API session |

### Configuration

Add to your `.env`:

```bash
ZELLO_API_KEY=your-api-key           # from Zello admin console → Settings → API
ZELLO_ADMIN_USER=admin               # falls back to ZELLO_BOT_USER
ZELLO_ADMIN_PASS=admin-password      # falls back to ZELLO_BOT_PASS
CLAWPTT_API_PORT=18790               # default
CLAWPTT_API_TOKEN=your-token         # default: same as GATEWAY_TOKEN
```

### Use cases

**Location tracking via voice:**

*"Where is the rest of the team?"*

The voice agent calls `GET /locations?filter=active`, reverse-geocodes each GPS position, and responds: *"Field-2 is on Main Street heading north, Dispatch is at the office. Field-3 is offline."*

**Message history:**

*"Were there any voice messages on Dispatch in the last hour?"*

The agent calls `GET /history?via_channel=Dispatch&type=voice&start_ts=<epoch>`, summarizes the results.

**Network administration (via research agent, not voice):**

Write operations like creating users or modifying channels should go through the research/admin agent (Tier 2), not the voice agent. A misheard "delete" on radio can be costly. The voice agent should only use read endpoints.

---

## NemoClaw Integration

NemoClaw adds NVIDIA's security and privacy guardrails on top of OpenClaw. It's relevant for production voice deployments where:

- Voice data (transcriptions) contains sensitive information
- The agent has access to protected systems (HR, finance, medical)
- Regulatory compliance requires audit trails
- Multi-tenant deployments need data isolation

### What NemoClaw adds

| Feature | Without NemoClaw | With NemoClaw |
|---------|-----------------|---------------|
| Inference routing | Direct to model | Policy-gated, privacy-aware |
| Data handling | Trust the model | Enforce PII redaction rules |
| Execution sandbox | OS-level isolation | NVIDIA OpenShell hardened sandbox |
| Audit trail | Application logs | Structured compliance logging |
| Model selection | Agent config | Policy-based routing with guardrails |

### NemoClaw + ClawPTT architecture

```
Zello → ClawPTT → OpenClaw Gateway → NemoClaw Policy Layer → LLM
                                      ↓
                                   OpenShell Runtime
                                   (sandboxed execution)
```

ClawPTT is unaware of NemoClaw — it connects to the same OpenClaw gateway. NemoClaw operates as a layer within OpenClaw, intercepting and gating requests before they reach the model or tools.

### When to add NemoClaw

- **Development / personal use:** Not needed. OpenClaw alone is sufficient.
- **Team deployment:** Consider it if voice agents access shared resources.
- **Enterprise / production:** Recommended for compliance and data control.

Refer to the [NemoClaw documentation](https://docs.nvidia.com/nemoclaw/latest/index.html) for installation.

---

## Production Deployment

### Systemd service

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
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now clawptt
```

### Monitoring

```bash
# Live logs
journalctl --user -u clawptt -f

# Recent errors
journalctl --user -u clawptt --since "1 hour ago" --priority err
```

### Health indicators in logs

| Log line | Meaning |
|----------|---------|
| `STT worker ready` | Whisper model loaded, ready for transcription |
| `Logged in as X on channels: Y` | Zello connected and authenticated |
| `Channel X: N users online` | Channel active |
| `Transcribed from X: "..."` | STT working |
| `OpenClaw (Nms): ...` | Agent responded in N milliseconds |
| `Audio sent: N packets` | TTS and transmission complete |

### Capacity planning

Each active voice conversation uses:
- ~90MB RAM (Node.js process + Opus encoder)
- ~200MB RAM (sherpa-onnx TTS, loaded per request)
- Negligible CPU between conversations
- TTS CPU burst during response generation

ClawPTT handles one conversation at a time per channel. Multiple channels are supported concurrently, but audio processing is sequential. For high-throughput deployments, run multiple ClawPTT instances on different channels.

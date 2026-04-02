<p align="center">
  <img src="../assets/clawtalk-icon-white-clean.png" alt="ClawPTT" width="96">
</p>

# ClawPTT — Installation and Configuration Guide

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Component Demarcation](#component-demarcation)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Agent Design for Voice](#agent-design-for-voice)
- [Model Recommendations](#model-recommendations)
- [Search and Tool Configuration](#search-and-tool-configuration)
- [Gate Settings for Deep Research](#gate-settings-for-deep-research)
- [NemoClaw Integration](#nemoclaw-integration)
- [Production Deployment](#production-deployment)

---

## Architecture Overview

ClawPTT is the voice transport layer in a three-tier stack:

```
┌──────────────────────────────────────────────────────────────┐
│                     Zello Work Network                        │
│              (PTT radio — phones, desktops, radios)           │
└──────────────────────┬───────────────────────────────────────┘
                       │ WebSocket (Opus audio)
┌──────────────────────▼───────────────────────────────────────┐
│                      ClawPTT                                  │
│                                                               │
│   Voice I/O only:                                             │
│   • Opus decode/encode (@discordjs/opus)                      │
│   • Speech-to-text (faster-whisper, persistent worker)        │
│   • Text-to-speech (sherpa-onnx / Piper voices)               │
│   • Text sanitization (markdown → spoken word)                │
│   • DM and channel support                                    │
│                                                               │
│   Does NOT handle: model selection, tools, search, persona    │
└──────────────────────┬───────────────────────────────────────┘
                       │ HTTP (OpenAI-compatible chat/completions)
┌──────────────────────▼───────────────────────────────────────┐
│                    OpenClaw Gateway                            │
│                                                               │
│   Agent orchestration:                                        │
│   • Model routing (primary + fallbacks)                       │
│   • Tool execution (web search, calendars, APIs)              │
│   • Memory and session management                             │
│   • Agent persona and system prompts                          │
│   • Subagent delegation                                       │
│                                                               │
│   Optional: NemoClaw layer for security guardrails            │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│                    LLM Backends                               │
│                                                               │
│   Local:  vLLM, Ollama, LiteLLM                              │
│   Cloud:  Anthropic, OpenAI, NVIDIA NIM, Google               │
│   Hybrid: local primary with cloud fallback                   │
└──────────────────────────────────────────────────────────────┘
```

## Component Demarcation

Understanding what belongs where is critical for a clean deployment.

### ClawPTT is responsible for:

| Concern | Details |
|---------|---------|
| Zello transport | WebSocket connection, authentication, channel management, reconnect |
| Audio codec | Opus decode (inbound) and encode (outbound) at 16kHz mono |
| Speech-to-text | faster-whisper with persistent model worker (no reload per request) |
| Text-to-speech | sherpa-onnx with Piper VITS voices, fully offline |
| Text sanitization | Strips markdown, URLs, emojis, special characters before TTS |
| Audio pacing | Sends Opus frames at correct cadence (60ms intervals) |

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
- **Python 3.10+** with pip
- **ffmpeg** (for PCM/WAV conversion)
- **OpenClaw** >= 2026.3.31 (with `chatCompletions` HTTP endpoint)

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

The bot user (your AI agent) should sit in a **channel**, not just exist as a contact for DMs. Here's why:

**Channels provide shared context.** When the bot is in a channel, everyone on the team hears both the question and the AI response. This creates shared situational awareness — a dispatcher hears what field workers are asking, a supervisor hears what the team needs. On radio, information is ambient by design.

**Channels match PTT radio conventions.** In real-world PTT deployments (security, logistics, field ops, emergency response), communication happens on channels. Users are trained to select a channel and transmit. DMs are an afterthought in radio culture. Putting the AI on a channel means zero behavior change for the team.

**Channels support multi-party interaction.** User A asks a question, the AI responds, User B hears the answer and adds context. This natural radio flow doesn't work in DMs where each conversation is isolated.

**Channels are operationally visible.** An admin or supervisor can monitor the AI channel to audit what's being asked and answered. DM conversations are invisible to the team.

**DMs still work** — ClawPTT handles them correctly (replies go back to the sender). But they're best suited for private queries that shouldn't be broadcast, not as the primary interaction model.

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
| STT (faster-whisper) | CPU only, 2GB RAM | GPU, 4GB RAM |
| TTS (sherpa-onnx) | CPU only, 512MB RAM | CPU is fine |
| Local LLM (optional) | 16GB VRAM | 24GB+ VRAM |

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
.venv/bin/pip install faster-whisper sherpa-onnx numpy
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

### Subagent delegation

For complex queries that need deep research, the voice agent should delegate to a text-based subagent and summarize the result:

```json
{
  "subagents": {
    "allowAgents": ["research-agent"]
  }
}
```

The voice agent asks the research agent for data, then summarizes it in spoken form.

---

## Model Recommendations

### Primary model for voice (speed-critical)

The voice loop has a latency budget. Every second the user waits feels unnatural on radio.

| Model | Latency | Quality | Best for |
|-------|---------|---------|----------|
| **vLLM / Qwen3-Coder-Next-FP8** | ~1-3s | Very good | Primary voice model, fast local inference |
| **Ollama / qwen3:32b** | ~2-4s | Good | Fallback when vLLM is busy |
| **Ollama / qwen2.5:14b** | ~0.5-1s | Adequate | Fastest local option for simple queries |
| **Anthropic / claude-sonnet-4-6** | ~3-5s | Excellent | Cloud fallback, best quality |
| **Anthropic / claude-opus-4-6** | ~5-15s | Best | Too slow for primary voice, use for research |
| **NVIDIA NIM / kimi-k2.5** | ~2-4s | Good | Cloud alternative with large context |

**Recommendation:** Use a fast local model as primary (vLLM with Qwen3-Coder-Next) with a cloud model as fallback. The latency difference between local and cloud is 2-10x.

### Latency budget breakdown

```
Target: < 10 seconds from PTT release to voice response start

STT (faster-whisper base.en):     ~0.5s  (persistent worker, no model load)
LLM (local vLLM):                 ~1-3s  (depends on response length)
TTS (sherpa-onnx):                ~1-2s  (depends on text length)
Audio encoding + transmission:     ~0.5s
─────────────────────────────────────────
Total:                             ~3-6s  typical
```

With a cloud LLM, add 2-8 seconds. With tool calls (search), add 2-5 seconds per tool.

### Whisper model selection

| Model | Size | Speed | Accuracy | Recommended for |
|-------|------|-------|----------|-----------------|
| `base.en` | 74MB | Fastest | Good for clear speech | Default choice |
| `small.en` | 244MB | Fast | Better with accents | Noisy environments |
| `medium.en` | 769MB | Moderate | Very good | Multi-accent teams |
| `large-v3` | 1.5GB | Slow | Best | Offline transcription (not real-time) |

**Recommendation:** Start with `base.en`. Only upgrade if transcription quality is insufficient. The persistent worker eliminates model load time, so the difference is pure inference speed.

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

## Gate Settings for Deep Research

Not all queries should be answered in real-time. Gate settings control when the agent pauses for approval vs. proceeds autonomously.

### Recommended gate strategy for voice

```
┌─────────────────────────────────────────────────────────┐
│                    Query Classification                   │
│                                                           │
│   Simple factual → Autonomous (fast path)                 │
│   "What time is it?" / "Weather in Barcelona?"            │
│                                                           │
│   Complex research → Gate (delegate to subagent)          │
│   "Compare Q1 earnings for NVDA vs AMD"                   │
│                                                           │
│   Dangerous action → Gate (require confirmation)          │
│   "Delete user X" / "Send email to Y"                     │
└─────────────────────────────────────────────────────────┘
```

### OpenClaw exec and tool policy

```json
{
  "tools": {
    "exec": {
      "security": "allowlist",
      "ask": "on-miss"
    }
  }
}
```

- `security: "allowlist"` — only pre-approved commands can execute
- `ask: "on-miss"` — prompt for approval when a tool isn't in the allowlist

For voice agents, you want `ask: "off"` on the voice agent itself (so it doesn't block waiting for text approval that can't come over radio), but gate dangerous operations by not giving the voice agent access to destructive tools:

```json
{
  "id": "voice",
  "tools": {
    "allow": ["web_search", "calendar_read", "weather"],
    "deny": ["calendar_write", "email_send", "user_delete"]
  }
}
```

### Deep research pattern

When a voice query requires extensive research:

1. Voice agent recognizes the query is complex
2. Delegates to a research subagent (which can use Opus-class models, multiple search passes, etc.)
3. Research subagent runs asynchronously
4. Voice agent responds: "Let me look into that. I'll have an answer shortly."
5. When research completes, voice agent summarizes on the next interaction

This keeps the voice path fast while supporting deep research when needed.

---

## Zello Work MCP Server

ClawPTT handles the audio bridge, but your OpenClaw agents also need to **manage** and **query** the Zello network — create users, configure channels, fetch GPS locations, pull message history. This is done through a separate Zello Work MCP server that exposes the full Zello REST API as agent tools.

### Why a separate MCP server?

ClawPTT and the Zello MCP server serve different purposes:

| | ClawPTT | Zello MCP Server |
|-|---------|-----------------|
| Protocol | WebSocket streaming API | REST admin API |
| Purpose | Real-time voice I/O | Network management and data queries |
| Auth | Bot user credentials | Admin credentials + API key |
| Used by | ClawPTT bridge process | Any OpenClaw agent |
| Data | Audio streams | Users, channels, locations, history, roles |

They coexist — ClawPTT uses the streaming API for voice, while agents use the MCP server to manage the network and query data.

### Available tools

The Zello Work MCP server exposes these tools to your agents:

**Session management:**
| Tool | Description |
|------|-------------|
| `zello_login` | Force authenticate with the Zello API |
| `zello_refresh_token` | Invalidate and re-create the session |
| `zello_logout` / `zello_logoff` | End the current API session |

**User management:**
| Tool | Description |
|------|-------------|
| `zello_list_users` | List all users or get details for a specific user |
| `zello_create_user` | Create or update a user (name, password, email, admin, tags) |
| `zello_delete_users` | Delete one or more users |
| `zello_add_contacts` | Add direct contacts to a user |
| `zello_remove_contacts` | Remove direct contacts from a user |

**Channel management:**
| Tool | Description |
|------|-------------|
| `zello_list_channels` | List all channels or get details for a specific one |
| `zello_create_channel` | Create a new channel (group or dynamic, visible or hidden) |
| `zello_delete_channels` | Delete one or more channels |
| `zello_add_users_to_channel` | Add users to a channel |
| `zello_remove_users_from_channel` | Remove users from a channel |

**Roles:**
| Tool | Description |
|------|-------------|
| `zello_list_roles` | List all roles for a channel |
| `zello_save_role` | Create or update a role (listen-only, no-disconnect, allow alerts) |
| `zello_assign_role` | Assign users to a channel role |
| `zello_delete_role` | Delete roles from a channel |

**Location tracking:**
| Tool | Description |
|------|-------------|
| `zello_get_locations` | Get GPS positions of users within a bounding box (lat/lng, speed, heading, battery, signal) |
| `zello_get_user_location` | Get current or historical location for a specific user, optionally as GeoJSON |

**Message history:**
| Tool | Description |
|------|-------------|
| `zello_get_history` | Query message metadata — filter by sender, recipient, channel, media type, time range |
| `zello_get_media` | Get download URL for voice recordings (MP3) or images (JPG) |

### Installation

The MCP server is a standalone Node.js process. Install it alongside ClawPTT:

```bash
mkdir -p /opt/openclaw/mcp-servers/zello-work
cd /opt/openclaw/mcp-servers/zello-work
npm init -y
npm install @modelcontextprotocol/sdk zod
```

Create `run.sh`:

```bash
#!/bin/bash
set -a
source /path/to/your/credentials.env
set +a
exec node /opt/openclaw/mcp-servers/zello-work/index.js
```

The server reads these environment variables:

| Variable | Description |
|----------|-------------|
| `ZELLO_NETWORK` | Your Zello Work network name |
| `ZELLO_API_KEY` | API key from the Zello admin console |
| `ZELLO_ADMIN_USER` | Admin username for REST API auth |
| `ZELLO_ADMIN_PASS` | Admin password |

### Register with OpenClaw

Add the MCP server to `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "zello-work": {
        "command": "/opt/openclaw/mcp-servers/zello-work/run.sh"
      }
    }
  }
}
```

Restart the gateway. All agents will now have access to the Zello tools.

### Use cases

**Location tracking via voice:**

A field worker transmits on the AI channel: *"Where is the rest of the team?"*

The voice agent:
1. Receives the transcription via ClawPTT
2. Calls `zello_get_locations` with `filter: "active"` to get all online users' GPS
3. Summarizes: *"Field-2 is on Main Street heading north, Dispatch is at the office. Field-3 is offline."*

**Network administration via voice:**

*"Add the new hire Sarah to the Operations channel."*

The agent calls `zello_create_user` and `zello_add_users_to_channel`, then confirms: *"Sarah has been added to Operations."*

**Message history via voice:**

*"Were there any voice messages on Dispatch in the last hour?"*

The agent calls `zello_get_history` with time range and channel filter, summarizes the results.

### Recommended agent tool policy

For voice agents, restrict write operations to prevent accidental changes from misheard commands:

```json
{
  "id": "voice",
  "tools": {
    "allow": [
      "zello_list_users",
      "zello_list_channels",
      "zello_get_locations",
      "zello_get_user_location",
      "zello_get_history",
      "zello_get_media",
      "zello_list_roles"
    ]
  }
}
```

Grant write tools (`zello_create_user`, `zello_delete_users`, etc.) only to admin-facing agents, not the voice agent. A misheard "delete" on radio can be costly.

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
- ~30MB RAM (Node.js process + Opus codec)
- ~500MB RAM (faster-whisper worker with base.en model)
- ~200MB RAM (sherpa-onnx TTS, loaded per request)
- Negligible CPU between conversations
- Full STT/TTS CPU/GPU burst during processing

ClawPTT handles one conversation at a time per channel. Multiple channels are supported concurrently, but audio processing is sequential. For high-throughput deployments, run multiple ClawPTT instances on different channels.

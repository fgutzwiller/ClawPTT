#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// PinchPTT — Voice Bridge for OpenClaw
//
// Connects to Zello Work via WebSocket, receives PTT voice streams,
// transcribes them, routes to an LLM (local or cloud), TTS the
// response, and transmits audio back to Zello.
//
// Flow: Zello PTT → Opus → PCM → Whisper STT → LLM
//       → TTS → Opus → Zello PTT
// ═══════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import opus from "@discordjs/opus";
const { OpusEncoder } = opus;
import { spawn } from "child_process";
import { writeFile, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import crypto from "crypto";

// ─── Configuration ─────────────────────────────────────────────────
const ZELLO_NETWORK = process.env.ZELLO_NETWORK;
const ZELLO_BOT_USER = process.env.ZELLO_BOT_USER || process.env.ZELLO_ADMIN_USER;
const ZELLO_BOT_PASS = process.env.ZELLO_BOT_PASS || process.env.ZELLO_ADMIN_PASS;
const ZELLO_CHANNELS = (process.env.ZELLO_BRIDGE_CHANNELS || "").split(",").filter(Boolean);
const ZELLO_WS_URL = `wss://zellowork.io/ws/${ZELLO_NETWORK}`;

// ─── LLM Backend ──────────────────────────────────────────────────
// "openclaw" → route through OpenClaw gateway (uses agent's configured model)
// "local"    → direct OpenAI-compatible LLM call (vLLM/Ollama/etc)
const LLM_BACKEND = process.env.LLM_BACKEND || "openclaw";

// ─── OpenClaw Gateway (for "openclaw" backend) ────────────────────
const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY || "http://127.0.0.1:18789";
const OPENCLAW_TOKEN = process.env.GATEWAY_TOKEN;
const OPENCLAW_AGENT = process.env.OPENCLAW_AGENT || "main";

// ─── Local LLM (for "local" backend) ─────────────────────────────
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "http://127.0.0.1:8888/v1/chat/completions";
const LOCAL_LLM_API_KEY = process.env.LOCAL_LLM_API_KEY || "";
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || "";
const LOCAL_LLM_MAX_TOKENS = parseInt(process.env.LOCAL_LLM_MAX_TOKENS || "512", 10);
const LOCAL_LLM_TEMPERATURE = parseFloat(process.env.LOCAL_LLM_TEMPERATURE || "0.7");

// ─── Agent Persona ────────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT ||
  "You are a concise voice assistant on a Zello PTT radio channel. Keep responses short and spoken-word friendly. No markdown, no bullet points, no special characters. Respond as if speaking on a radio.";

// STT config
const STT_METHOD = process.env.STT_METHOD || "faster-whisper"; // "faster-whisper" or "zello-transcription"
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base.en";

// TTS config — Piper voices via sherpa-onnx Python package
const SHERPA_ONNX_DIR = process.env.SHERPA_ONNX_DIR || `${process.env.HOME}/.pinchptt/tts`;
const TTS_VOICE = process.env.TTS_VOICE || "en_US-lessac-high";
const TTS_VOICE_DIR = `${SHERPA_ONNX_DIR}/models/vits-piper-${TTS_VOICE}`;
const TTS_MODEL = process.env.TTS_MODEL || `${TTS_VOICE_DIR}/${TTS_VOICE}.onnx`;
const TTS_TOKENS = process.env.TTS_TOKENS || `${TTS_VOICE_DIR}/tokens.txt`;
const TTS_DATA_DIR = process.env.TTS_DATA_DIR || `${TTS_VOICE_DIR}/espeak-ng-data`;

// Python binary — set VENV_PYTHON to point to a venv with faster-whisper + sherpa-onnx
const VENV_PYTHON = process.env.VENV_PYTHON || "python3";

// Opus settings for Zello: 16kHz mono, 60ms frames
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 60;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples per 60ms frame

if (!ZELLO_NETWORK || !ZELLO_BOT_USER || !ZELLO_BOT_PASS) {
  console.error("[pinchptt] Missing ZELLO_NETWORK, ZELLO_BOT_USER, or ZELLO_BOT_PASS");
  process.exit(1);
}
if (LLM_BACKEND === "openclaw" && !OPENCLAW_TOKEN) {
  console.error("[pinchptt] Missing GATEWAY_TOKEN (required for openclaw backend)");
  process.exit(1);
}
if (ZELLO_CHANNELS.length === 0) {
  console.error("[pinchptt] No ZELLO_BRIDGE_CHANNELS configured (comma-separated channel names)");
  process.exit(1);
}

// ─── Opus Encoder/Decoder ──────────────────────────────────────────
const opusDecoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
const opusEncoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);

// ─── Persistent STT Worker ─────────────────────────────────────────
let sttWorker = null;
let sttReady = false;
let sttQueue = []; // pending resolve callbacks

function startSTTWorker() {
  const workerScript = new URL("./stt-worker.py", import.meta.url).pathname;
  sttWorker = spawn(VENV_PYTHON, [workerScript], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WHISPER_MODEL },
  });

  let lineBuf = "";
  sttWorker.stdout.on("data", (chunk) => {
    lineBuf += chunk.toString();
    let lines = lineBuf.split("\n");
    lineBuf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line === "READY") {
        sttReady = true;
        console.error("[pinchptt] STT worker ready (model pre-loaded)");
        continue;
      }
      // Resolve the oldest pending request
      if (sttQueue.length > 0) {
        const resolve = sttQueue.shift();
        resolve(line);
      }
    }
  });

  sttWorker.stderr.on("data", (d) => {
    console.error(`[stt] ${d.toString().trim()}`);
  });

  sttWorker.on("close", (code) => {
    console.error(`[pinchptt] STT worker exited (code ${code}), restarting...`);
    sttReady = false;
    // Reject pending requests
    for (const resolve of sttQueue) resolve("");
    sttQueue = [];
    setTimeout(startSTTWorker, 1000);
  });
}

function sttTranscribe(wavPath) {
  return new Promise((resolve) => {
    sttQueue.push(resolve);
    sttWorker.stdin.write(wavPath + "\n");
  });
}

startSTTWorker();

// ─── Active Streams ────────────────────────────────────────────────
// Track incoming voice streams: streamId → { user, channel, packets[], transcription? }
const activeStreams = new Map();

// ─── Zello WebSocket Connection ────────────────────────────────────
let ws = null;
let zelloSeq = 0;
let reconnectTimer = null;
let refreshToken = null;

function nextSeq() {
  return ++zelloSeq;
}

function connectZello() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.error(`[pinchptt] Connecting to ${ZELLO_WS_URL}...`);
  ws = new WebSocket(ZELLO_WS_URL);

  ws.on("open", () => {
    console.error("[pinchptt] WebSocket connected, logging in...");
    const logonCmd = {
      command: "logon",
      seq: nextSeq(),
      username: ZELLO_BOT_USER,
      password: ZELLO_BOT_PASS,
      channels: ZELLO_CHANNELS,
      listen_only: false,
      platform_name: "PinchPTT Voice Bridge",
    };
    if (refreshToken) {
      logonCmd.refresh_token = refreshToken;
    }
    ws.send(JSON.stringify(logonCmd));
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      handleBinaryFrame(data);
    } else {
      handleJsonFrame(data.toString());
    }
  });

  ws.on("close", (code, reason) => {
    console.error(`[pinchptt] WebSocket closed: ${code} ${reason}`);
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error(`[pinchptt] WebSocket error: ${err.message}`);
  });

  ws.on("ping", () => {
    // ws library auto-responds with pong
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = 5000 + Math.random() * 5000;
  console.error(`[pinchptt] Reconnecting in ${Math.round(delay / 1000)}s...`);
  reconnectTimer = setTimeout(connectZello, delay);
}

// ─── JSON Frame Handler ───────────────────────────────────────────
function handleJsonFrame(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // Logon response
  if (msg.seq && msg.success !== undefined) {
    if (msg.success) {
      console.error(`[pinchptt] Logged in as ${ZELLO_BOT_USER} on channels: ${ZELLO_CHANNELS.join(", ")}`);
      if (msg.refresh_token) refreshToken = msg.refresh_token;
    } else {
      console.error(`[pinchptt] Login failed: ${msg.error || "unknown"}`);
      scheduleReconnect();
    }
    return;
  }

  // Log all events for debugging
  if (msg.type || msg.command) {
    console.error(`[pinchptt] Event: ${JSON.stringify(msg)}`);
  }

  const event = msg.command || msg.type;
  switch (event) {
    case "on_stream_start":
      handleStreamStart(msg);
      break;

    case "on_stream_stop":
      handleStreamStop(msg);
      break;

    case "on_transcription":
      handleTranscription(msg);
      break;

    case "on_channel_status":
      console.error(`[pinchptt] Channel ${msg.channel}: ${msg.users_online} users online`);
      break;

    case "on_error":
      console.error(`[pinchptt] Zello error: ${msg.error}`);
      break;
  }
}

// ─── Stream Lifecycle ─────────────────────────────────────────────
function handleStreamStart(msg) {
  // In channels: from=sender, channel=channel name
  // In DMs: from is absent, contactName=sender, channel=bot's own name
  const isDM = !msg.from && msg.contactName;
  const user = msg.from || msg.contactName || msg.user;
  const replyTo = isDM ? user : msg.channel; // DMs reply to sender, channels reply to channel

  // Don't process our own streams
  if (user === ZELLO_BOT_USER) return;

  console.error(`[pinchptt] Stream start: ${user} on ${isDM ? "DM" : msg.channel} (stream ${msg.stream_id})`);
  activeStreams.set(msg.stream_id, {
    user: user,
    channel: replyTo,
    codec: msg.codec,
    codecHeader: msg.codec_header,
    packetDuration: msg.packet_duration,
    packets: [],
    transcription: null,
    startedAt: Date.now(),
  });
}

function handleTranscription(msg) {
  const stream = activeStreams.get(msg.stream_id);
  if (stream) {
    stream.transcription = msg.text;
    console.error(`[pinchptt] Transcription (stream ${msg.stream_id}): "${msg.text}"`);
  }
}

async function handleStreamStop(msg) {
  const stream = activeStreams.get(msg.stream_id);
  if (!stream) return;
  activeStreams.delete(msg.stream_id);

  const durationMs = Date.now() - stream.startedAt;
  console.error(
    `[pinchptt] Stream stop: ${stream.user} on ${stream.channel} — ` +
    `${stream.packets.length} packets, ${Math.round(durationMs / 1000)}s`
  );

  // Skip very short transmissions (< 0.5s, likely key-ups)
  if (durationMs < 500 || stream.packets.length < 3) {
    console.error("[pinchptt] Skipping short transmission");
    return;
  }

  try {
    // Step 1: Get transcription
    let text;
    if (stream.transcription && STT_METHOD === "zello-transcription") {
      text = stream.transcription;
    } else {
      text = await transcribeAudio(stream);
    }

    if (!text || text.trim().length === 0) {
      console.error("[pinchptt] Empty transcription, skipping");
      return;
    }

    console.error(`[pinchptt] Transcribed from ${stream.user}: "${text}"`);

    // Step 2: Send to OpenClaw agent
    const response = await sendToAgent(text, stream.user, stream.channel);
    console.error(`[pinchptt] Agent response (${response.length} chars): "${response.slice(0, 100)}..."`);

    // Step 3: Sanitize and TTS the response
    const cleaned = sanitizeForTTS(response);
    console.error(`[pinchptt] Sanitized (${cleaned.length} chars): "${cleaned.slice(0, 100)}..."`);
    const wavPath = await textToSpeech(cleaned);

    // Step 4: Encode to Opus and send to Zello
    await sendAudioToZello(wavPath, stream.channel);
    await unlink(wavPath).catch(() => {});
  } catch (err) {
    console.error(`[pinchptt] Error processing stream: ${err.message}`);
  }
}

// ─── Text Sanitization for TTS ────────────────────────────────────
function sanitizeForTTS(text) {
  let s = text;

  // Strip markdown formatting
  s = s.replace(/```[\s\S]*?```/g, "");        // code blocks
  s = s.replace(/`([^`]+)`/g, "$1");            // inline code
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");      // bold
  s = s.replace(/\*([^*]+)\*/g, "$1");           // italic
  s = s.replace(/__([^_]+)__/g, "$1");           // bold underscores
  s = s.replace(/_([^_]+)_/g, "$1");             // italic underscores
  s = s.replace(/~~([^~]+)~~/g, "$1");           // strikethrough
  s = s.replace(/^#{1,6}\s+/gm, "");            // headings
  s = s.replace(/^\s*[-*+]\s+/gm, "");          // list bullets
  s = s.replace(/^\s*\d+\.\s+/gm, "");          // numbered lists
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // links — keep text
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");  // images

  // Strip URLs
  s = s.replace(/https?:\/\/\S+/g, "");

  // Strip emojis and unicode symbols (keep basic punctuation)
  s = s.replace(/[\u{1F000}-\u{1FFFF}]/gu, "");
  s = s.replace(/[\u{2600}-\u{27BF}]/gu, "");
  s = s.replace(/[\u{FE00}-\u{FE0F}]/gu, "");
  s = s.replace(/[\u{200D}]/gu, "");

  // Strip special chars that TTS can't voice
  s = s.replace(/[<>{}|\\^~=]/g, "");
  s = s.replace(/\*+/g, "");
  s = s.replace(/_+/g, " ");

  // Collapse whitespace
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]+/g, " ");
  s = s.trim();

  return s;
}

// ─── Binary Frame Handler ─────────────────────────────────────────
function handleBinaryFrame(buf) {
  if (buf.length < 9) return;

  const type = buf.readUInt8(0);
  if (type !== 0x01) return; // Only handle audio packets

  const streamId = buf.readUInt32BE(1);
  const packetId = buf.readUInt32BE(5);
  const opusData = buf.slice(9);

  const stream = activeStreams.get(streamId);
  if (stream) {
    stream.packets.push({ packetId, data: opusData });
  }
}

// ─── Speech-to-Text ───────────────────────────────────────────────
async function transcribeAudio(stream) {
  // Decode all Opus packets to PCM
  const pcmChunks = [];
  for (const pkt of stream.packets) {
    try {
      const decoded = opusDecoder.decode(pkt.data);
      pcmChunks.push(decoded);
    } catch (err) {
      // Skip corrupted packets
    }
  }

  if (pcmChunks.length === 0) return null;

  // Concatenate PCM (16-bit signed LE, 16kHz mono)
  const totalLen = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const pcm = Buffer.concat(pcmChunks, totalLen);

  // Write as raw PCM, then convert to WAV with ffmpeg
  const id = crypto.randomBytes(4).toString("hex");
  const pcmPath = join(tmpdir(), `zello-bridge-${id}.pcm`);
  const wavPath = join(tmpdir(), `zello-bridge-${id}.wav`);

  await writeFile(pcmPath, pcm);

  // Convert raw PCM to WAV
  await execAsync("ffmpeg", [
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1",
    "-i", pcmPath, "-y", wavPath,
  ]);
  await unlink(pcmPath).catch(() => {});

  // Transcribe with persistent STT worker
  const text = await sttTranscribe(wavPath);
  await unlink(wavPath).catch(() => {});
  return text.trim();
}

// ─── LLM Communication ───────────────────────────────────────────
async function sendToAgent(text, zelloUser, zelloChannel) {
  if (LLM_BACKEND === "local") {
    return await sendToLocalLLM(text);
  }
  return await sendToOpenClaw(text, zelloUser, zelloChannel);
}

async function sendToLocalLLM(text) {
  const t0 = Date.now();
  const body = {
    model: LOCAL_LLM_MODEL,
    messages: [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    max_tokens: LOCAL_LLM_MAX_TOKENS,
    temperature: LOCAL_LLM_TEMPERATURE,
  };

  const res = await fetch(LOCAL_LLM_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOCAL_LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Local LLM error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "(no response)";
  console.error(`[pinchptt] Local LLM (${Date.now() - t0}ms): ${content.slice(0, 100)}`);
  return content;
}

async function sendToOpenClaw(text, zelloUser, zelloChannel) {
  const t0 = Date.now();
  const url = `${OPENCLAW_GATEWAY}/v1/chat/completions`;
  const body = {
    model: `openclaw:${OPENCLAW_AGENT}`,
    messages: [
      { role: "user", content: text },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENCLAW_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenClaw API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "(no response)";
  console.error(`[pinchptt] OpenClaw (${Date.now() - t0}ms): ${content.slice(0, 100)}`);
  return content;
}

// ─── Text-to-Speech ───────────────────────────────────────────────
async function textToSpeech(text) {
  const id = crypto.randomBytes(4).toString("hex");
  const wavPath = join(tmpdir(), `zello-tts-${id}.wav`);

  // Use sherpa-onnx Python package for TTS
  // Write text to file to avoid shell escaping issues
  const textPath = join(tmpdir(), `zello-tts-text-${id}.txt`);
  await writeFile(textPath, text);
  await execAsync(VENV_PYTHON, [
    "-c",
    `
import sherpa_onnx, numpy as np, wave
config = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
            model="${TTS_MODEL}",
            tokens="${TTS_TOKENS}",
            data_dir="${TTS_DATA_DIR}",
        ),
        num_threads=2,
    ),
)
tts = sherpa_onnx.OfflineTts(config)
text = open("${textPath}").read().strip()
audio = tts.generate(text, sid=0, speed=1.0)
with wave.open("${wavPath}", "w") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(audio.sample_rate)
    samples = (np.array(audio.samples) * 32767).astype(np.int16)
    wf.writeframes(samples.tobytes())
print("OK")
`.trim(),
  ]);
  await unlink(textPath).catch(() => {});

  return wavPath;
}

// ─── Send Audio to Zello ──────────────────────────────────────────
async function sendAudioToZello(wavPath, channel) {
  // Convert WAV to 16kHz mono PCM for Opus encoding
  const id = crypto.randomBytes(4).toString("hex");
  const pcmPath = join(tmpdir(), `zello-out-${id}.pcm`);

  await execAsync("ffmpeg", [
    "-i", wavPath,
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1",
    "-y", pcmPath,
  ]);

  const pcmData = await readFile(pcmPath);
  await unlink(pcmPath).catch(() => {});

  // Build codec_header: 16kHz (0x80 0x3E), 1 frame/packet, 60ms
  // base64 of [0x80, 0x3E, 0x01, 0x3C] = "gD4BPA=="
  const codecHeader = "gD4BPA==";

  // Start stream
  const startSeq = nextSeq();
  const startCmd = {
    command: "start_stream",
    seq: startSeq,
    channel,
    type: "audio",
    codec: "opus",
    codec_header: codecHeader,
    packet_duration: FRAME_DURATION_MS,
  };

  const streamId = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("start_stream timeout")), 10000);

    const handler = (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.seq === startSeq) {
          clearTimeout(timeout);
          ws.off("message", handler);
          if (msg.success) {
            resolve(msg.stream_id);
          } else {
            reject(new Error(`start_stream failed: ${msg.error}`));
          }
        }
      } catch {}
    };
    ws.on("message", handler);
    ws.send(JSON.stringify(startCmd));
  });

  console.error(`[pinchptt] Sending audio on stream ${streamId} to ${channel}`);

  // Send Opus frames at the correct cadence
  const bytesPerFrame = FRAME_SIZE * 2; // 16-bit = 2 bytes per sample
  let packetId = 0;

  for (let offset = 0; offset + bytesPerFrame <= pcmData.length; offset += bytesPerFrame) {
    const pcmFrame = pcmData.slice(offset, offset + bytesPerFrame);
    const opusFrame = opusEncoder.encode(pcmFrame);

    // Pack binary: [0x01] [streamId:4B BE] [packetId:4B BE] [opus data]
    const packet = Buffer.alloc(9 + opusFrame.length);
    packet.writeUInt8(0x01, 0);
    packet.writeUInt32BE(streamId, 1);
    packet.writeUInt32BE(packetId, 5);
    opusFrame.copy(packet, 9);

    ws.send(packet);
    packetId++;

    // Pace the packets
    await sleep(FRAME_DURATION_MS);
  }

  // Stop stream
  ws.send(JSON.stringify({
    command: "stop_stream",
    seq: nextSeq(),
    stream_id: streamId,
    channel,
  }));

  console.error(`[pinchptt] Audio sent: ${packetId} packets to ${channel}`);
}

// ─── Utilities ────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      ...opts,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
    proc.on("error", reject);
  });
}

// ─── Graceful Shutdown ────────────────────────────────────────────
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.error("[pinchptt] Shutting down...");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, "bridge shutdown");
  }
  process.exit(0);
}

// ─── Start ────────────────────────────────────────────────────────
console.error("═══════════════════════════════════════════════════");
console.error("  PinchPTT — Voice Bridge for OpenClaw");
console.error(`  Network:  ${ZELLO_NETWORK}`);
console.error(`  Bot user: ${ZELLO_BOT_USER}`);
console.error(`  Channels: ${ZELLO_CHANNELS.join(", ")}`);
const llmLabel = LLM_BACKEND === "local" ? `local (${LOCAL_LLM_MODEL})` : `openclaw (${OPENCLAW_AGENT})`;
console.error(`  LLM:      ${llmLabel}`);
console.error(`  STT:      ${STT_METHOD} (persistent worker)`);
console.error(`  TTS:      ${TTS_VOICE}`);
console.error("═══════════════════════════════════════════════════");

connectZello();

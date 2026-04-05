// ═══════════════════════════════════════════════════════════════════
// ClawPTT — Voice Bridge for OpenClaw
//
// Factory: createBridge(opts) → { start(), stop() }
//
// Inbound:  Zello PTT → Opus → PCM → WAV → faster-whisper → text
//           (or Zello server-side transcription)
// Outbound: LLM text → persistent TTS worker → 16kHz PCM → Opus → Zello
// ═══════════════════════════════════════════════════════════════════

import WebSocket from "ws";
import { spawn } from "child_process";
import { writeFile, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { startAPI } from "./api.js";

// ─── Opus: prefer native, fall back to pure JS ───────────────────
let OpusEncoder;
try {
  const m = await import("@discordjs/opus");
  OpusEncoder = m.default?.OpusEncoder ?? m.OpusEncoder;
} catch {
  const m = await import("opusscript");
  const Script = m.default ?? m;
  const VOIP = Script.Application?.VOIP ?? 2049;
  OpusEncoder = class OpusCompat {
    constructor(rate, ch) {
      this._e = new Script(rate, ch, VOIP);
      this._f = (rate * 60) / 1000;
    }
    encode(buf) { return this._e.encode(buf, this._f); }
    decode(buf) { return this._e.decode(buf); }
  };
}

// ─── Constants ────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 60;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960

// ─── Pure helpers (no instance state) ─────────────────────────────

/** 44-byte WAV header for 16kHz mono 16-bit PCM */
function wavHeader(pcmLen) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcmLen, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);      // chunk size
  h.writeUInt16LE(1, 20);       // PCM format
  h.writeUInt16LE(1, 22);       // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  h.writeUInt16LE(2, 32);       // block align
  h.writeUInt16LE(16, 34);      // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(pcmLen, 40);
  return h;
}

function sanitizeForTTS(text) {
  let s = text;
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");
  s = s.replace(/https?:\/\/\S+/g, "");
  s = s.replace(/[\u{1F000}-\u{1FFFF}]/gu, "");
  s = s.replace(/[\u{2600}-\u{27BF}]/gu, "");
  s = s.replace(/[\u{FE00}-\u{FE0F}]/gu, "");
  s = s.replace(/[\u{200D}]/gu, "");
  s = s.replace(/[<>{}|\\^~=]/g, "");
  s = s.replace(/\*+/g, "");
  s = s.replace(/_+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]+/g, " ");
  return s.trim();
}

/** Truncate to last complete sentence within char limit. Keeps radio tight. */
/** Truncate to last complete sentence within char limit. Returns { text, wasTruncated }. */
function truncateForRadio(text, maxChars = 250) {
  if (text.length <= maxChars) return { text, wasTruncated: false };
  const cut = text.slice(0, maxChars);
  const lastPeriod = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  let truncated;
  if (lastPeriod > maxChars * 0.4) {
    truncated = cut.slice(0, lastPeriod + 1) + " Details on Slack.";
  } else {
    const lastSpace = cut.lastIndexOf(" ");
    truncated = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + ". Details on Slack.";
  }
  return { text: truncated, wasTruncated: true };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════
// createBridge — the main factory
// ═══════════════════════════════════════════════════════════════════

export function createBridge(opts = {}) {
  const z = opts.zello || {};
  const l = opts.llm || {};
  const t = opts.tts || {};
  const h = opts.history || {};
  const s = opts.stt || {};

  // ── Config (options override env vars) ──────────────────────────
  const NETWORK       = z.network    || process.env.ZELLO_NETWORK;
  const BOT_USER      = z.botUser    || process.env.ZELLO_BOT_USER || process.env.ZELLO_ADMIN_USER;
  const BOT_PASS      = z.botPass    || process.env.ZELLO_BOT_PASS || process.env.ZELLO_ADMIN_PASS;
  const ZELLO_CHANNELS = z.channels  || (process.env.ZELLO_BRIDGE_CHANNELS || "").split(",").filter(Boolean);
  const WS_URL        = `wss://zellowork.io/ws/${NETWORK}`;

  const LLM_BACKEND   = l.backend    || process.env.LLM_BACKEND || "openclaw";
  const GW_URL        = l.gateway    || process.env.OPENCLAW_GATEWAY || "http://127.0.0.1:18789";
  const GW_TOKEN      = l.token      || process.env.GATEWAY_TOKEN;
  const GW_AGENT      = l.agent      || process.env.OPENCLAW_AGENT || "main";
  const LLM_URL       = l.url        || process.env.LOCAL_LLM_URL || "http://127.0.0.1:8888/v1/chat/completions";
  const LLM_KEY       = l.apiKey     || process.env.LOCAL_LLM_API_KEY || "";
  const LLM_MODEL     = l.model      || process.env.LOCAL_LLM_MODEL || "";
  const LLM_MAX_TOK   = l.maxTokens  ?? (process.env.LOCAL_LLM_MAX_TOKENS ? parseInt(process.env.LOCAL_LLM_MAX_TOKENS, 10) : 256);
  const LLM_TEMP      = l.temperature ?? (process.env.LOCAL_LLM_TEMPERATURE ? parseFloat(process.env.LOCAL_LLM_TEMPERATURE) : 0.7);
  const VOICE_MAX_TOK = l.voiceMaxTokens ?? (process.env.VOICE_MAX_TOKENS ? parseInt(process.env.VOICE_MAX_TOKENS, 10) : 200);
  const VOICE_MAX_CHARS = l.voiceMaxChars ?? (process.env.VOICE_MAX_CHARS ? parseInt(process.env.VOICE_MAX_CHARS, 10) : 160);

  // Slack integration — transcript + bidirectional messaging
  const SLACK_TOKEN     = opts.slack?.token    || process.env.SLACK_BOT_TOKEN || "";
  const SLACK_APP_TOKEN = opts.slack?.appToken || process.env.SLACK_APP_TOKEN || "";
  const SLACK_CHANNEL   = opts.slack?.channel  || process.env.SLACK_OVERFLOW_CHANNEL || "C0AR2HRLNDS"; // #jo

  const SYSTEM_PROMPT  = opts.systemPrompt || process.env.AGENT_SYSTEM_PROMPT ||
    "You are a concise voice assistant on a Zello PTT radio channel. Keep responses short and spoken-word friendly. No markdown, no bullet points, no special characters. Respond as if speaking on a radio.";

  const STT_METHOD     = s.method       || process.env.STT_METHOD || "faster-whisper";
  const WHISPER_MODEL  = s.whisperModel || process.env.WHISPER_MODEL || "base.en";
  const PYTHON         = t.python       || process.env.VENV_PYTHON || "python3";

  const SHERPA_DIR     = t.sherpaDir || process.env.SHERPA_ONNX_DIR || `${process.env.HOME}/.clawptt/tts`;
  const TTS_VOICE      = t.voice     || process.env.TTS_VOICE || "en_US-lessac-high";
  const VOICE_DIR      = `${SHERPA_DIR}/models/vits-piper-${TTS_VOICE}`;
  const TTS_MODEL      = t.model     || process.env.TTS_MODEL || `${VOICE_DIR}/${TTS_VOICE}.onnx`;
  const TTS_TOKENS     = t.tokens    || process.env.TTS_TOKENS || `${VOICE_DIR}/tokens.txt`;
  const TTS_DATA_DIR   = t.dataDir   || process.env.TTS_DATA_DIR || `${VOICE_DIR}/espeak-ng-data`;

  const HIST_MAX       = h.maxTurns  ?? (process.env.HISTORY_MAX_TURNS ? parseInt(process.env.HISTORY_MAX_TURNS, 10) : 10);
  const HIST_TTL       = h.ttlMs     ?? (process.env.HISTORY_TTL_MS ? parseInt(process.env.HISTORY_TTL_MS, 10) : 300000);

  // ── Validation ──────────────────────────────────────────────────
  if (!NETWORK || !BOT_USER || !BOT_PASS)
    throw new Error("Missing zello network, botUser, or botPass");
  if (LLM_BACKEND === "openclaw" && !GW_TOKEN)
    throw new Error("Missing gateway token (GATEWAY_TOKEN)");
  if (ZELLO_CHANNELS.length === 0)
    throw new Error("No channels configured (ZELLO_BRIDGE_CHANNELS)");

  // ── Instance state ──────────────────────────────────────────────
  const needsLocalSTT = STT_METHOD !== "zello-transcription";
  const opusEncoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  const opusDecoder = needsLocalSTT ? new OpusEncoder(SAMPLE_RATE, CHANNELS) : null;

  let ws = null;
  let zelloSeq = 0;
  let reconnectTimer = null;
  let refreshToken = null;
  let stopped = false;
  const activeStreams = new Map();
  const channelHistory = new Map();

  // STT worker
  let sttProc = null;
  let sttReady = false;
  let sttQueue = [];
  let sttFails = 0;

  // TTS worker
  let ttsProc = null;
  let ttsReady = false;
  let ttsQueue = [];
  let ttsFails = 0;

  const MAX_BACKOFF = 60000;

  // ── Helpers ─────────────────────────────────────────────────────
  function nextSeq() { return ++zelloSeq; }
  function log(msg) { console.error(`[clawptt] ${msg}`); }

  // ── Conversation History ────────────────────────────────────────
  function getHistory(channel) {
    const entry = channelHistory.get(channel);
    if (!entry || Date.now() - entry.lastActivity > HIST_TTL) {
      channelHistory.set(channel, { messages: [], lastActivity: Date.now() });
      return channelHistory.get(channel);
    }
    entry.lastActivity = Date.now();
    return entry;
  }

  function pushHistory(channel, role, content) {
    const entry = getHistory(channel);
    entry.messages.push({ role, content });
    while (entry.messages.length > HIST_MAX * 2) entry.messages.shift();
  }

  // ── Latency Estimator ───────────────────────────────────────────
  const SLOW_PATTERNS = [
    /\bflight/i, /\boverhead/i, /\baircraft/i, /\bplane/i,
    /\bemail/i, /\bgmail/i, /\binbox/i, /\bmail/i,
    /\bcalendar/i, /\bschedule/i, /\bmeeting/i, /\bagenda/i,
    /\bweather/i, /\bforecast/i,
    /\bwhere.?s\b/i, /\blocate/i, /\blocation/i, /\btrack/i,
    /\bsearch/i, /\blook up/i, /\bfind\b/i,
    /\bnews\b/i, /\bstatus of/i,
    /\bslack/i, /\bnotion/i, /\bfolk/i, /\bunifi/i, /\bnetwork/i,
    /\bportfolio/i, /\bproject/i,
  ];
  const FAST_PATTERNS = [
    /\b(hey|hi|hello|yo|thanks|thank you|bye|roger|copy)\b/i,
    /\b(who are you|what are you|how are you)\b/i,
    /\b(what time|what day|what date)\b/i,
    /\b(yes|no|affirm|negative)\b/i,
  ];

  function estimateLatency(text) {
    // Fast patterns take priority — greetings, acks, simple questions
    for (const p of FAST_PATTERNS) {
      if (p.test(text)) return "fast";
    }
    // Slow patterns — anything hitting external APIs
    for (const p of SLOW_PATTERNS) {
      if (p.test(text)) return "slow";
    }
    // Default: let it run without ack — most model-only queries are <3s
    return "fast";
  }

  // ── Persistent STT Worker ──────────────────────────────────────
  function startSTTWorker() {
    if (stopped) return;
    const script = join(__dirname, "stt-worker.py");
    sttProc = spawn(PYTHON, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WHISPER_MODEL },
    });

    sttProc.on("error", (err) => {
      log(`STT worker failed to start: ${err.message}`);
      if (err.code === "ENOENT") log(`Python not found at: ${PYTHON}`);
    });

    let buf = "";
    sttProc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line === "READY") {
          sttReady = true;
          sttFails = 0;
          log("STT worker ready");
          continue;
        }
        if (sttQueue.length > 0) sttQueue.shift()(line);
      }
    });

    sttProc.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg.includes("ModuleNotFoundError") && sttFails === 0)
        log(`STT dependency missing. Install: ${PYTHON} -m pip install faster-whisper`);
      console.error(`[stt] ${msg}`);
    });

    sttProc.on("close", (code) => {
      sttReady = false;
      sttFails++;
      for (const cb of sttQueue) cb("");
      sttQueue = [];
      if (stopped) return;
      const backoff = Math.min(1000 * 2 ** (sttFails - 1), MAX_BACKOFF);
      if (sttFails <= 3) log(`STT worker exited (${code}), restarting in ${backoff / 1000}s`);
      else if (sttFails === 4) log(`STT worker failed ${sttFails}x — check VENV_PYTHON=${PYTHON}`);
      setTimeout(startSTTWorker, backoff);
    });
  }

  function sttTranscribe(wavPath) {
    return new Promise((resolve) => {
      sttQueue.push(resolve);
      sttProc.stdin.write(wavPath + "\n");
    });
  }

  // ── Persistent TTS Worker ──────────────────────────────────────
  function startTTSWorker() {
    if (stopped) return;
    const script = join(__dirname, "tts-worker.py");
    ttsProc = spawn(PYTHON, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TTS_MODEL,
        TTS_TOKENS,
        TTS_DATA_DIR,
        TTS_SAMPLE_RATE: String(SAMPLE_RATE),
      },
    });

    ttsProc.on("error", (err) => {
      log(`TTS worker failed to start: ${err.message}`);
      if (err.code === "ENOENT") log(`Python not found at: ${PYTHON}`);
    });

    let buf = "";
    ttsProc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (line === "READY") {
          ttsReady = true;
          ttsFails = 0;
          log("TTS worker ready (model pre-loaded)");
          continue;
        }
        if (ttsQueue.length > 0) {
          const cb = ttsQueue.shift();
          if (line === "OK") cb(null);
          else cb(new Error(line));
        }
      }
    });

    ttsProc.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg.includes("ModuleNotFoundError") && ttsFails === 0)
        log(`TTS dependency missing. Install: ${PYTHON} -m pip install sherpa-onnx numpy`);
      console.error(`[tts] ${msg}`);
    });

    ttsProc.on("close", (code) => {
      ttsReady = false;
      ttsFails++;
      for (const cb of ttsQueue) cb(new Error("TTS worker exited"));
      ttsQueue = [];
      if (stopped) return;
      const backoff = Math.min(1000 * 2 ** (ttsFails - 1), MAX_BACKOFF);
      if (ttsFails <= 3) log(`TTS worker exited (${code}), restarting in ${backoff / 1000}s`);
      else if (ttsFails === 4) log(`TTS worker failed ${ttsFails}x — check VENV_PYTHON=${PYTHON}`);
      setTimeout(startTTSWorker, backoff);
    });
  }

  function ttsGenerate(text, outPath) {
    return new Promise((resolve, reject) => {
      ttsQueue.push((err) => (err ? reject(err) : resolve()));
      ttsProc.stdin.write(JSON.stringify({ text, out: outPath }) + "\n");
    });
  }

  // ── Zello WebSocket ─────────────────────────────────────────────
  function connectZello() {
    if (stopped) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    log(`Connecting to ${WS_URL}`);
    ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      log("WebSocket connected, logging in");
      const cmd = {
        command: "logon",
        seq: nextSeq(),
        username: BOT_USER,
        password: BOT_PASS,
        channels: ZELLO_CHANNELS,
        listen_only: false,
        platform_name: "ClawPTT Voice Bridge",
      };
      if (refreshToken) cmd.refresh_token = refreshToken;
      ws.send(JSON.stringify(cmd));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) handleBinaryFrame(data);
      else handleJsonFrame(data.toString());
    });

    ws.on("close", (code, reason) => {
      log(`WebSocket closed: ${code} ${reason}`);
      scheduleReconnect();
    });

    ws.on("error", (err) => log(`WebSocket error: ${err.message}`));
  }

  function scheduleReconnect() {
    if (reconnectTimer || stopped) return;
    const delay = 5000 + Math.random() * 5000;
    log(`Reconnecting in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(connectZello, delay);
  }

  // ── JSON Frame Handler ──────────────────────────────────────────
  function handleJsonFrame(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.seq && msg.success !== undefined) {
      if (msg.success) {
        log(`Logged in as ${BOT_USER} on: ${ZELLO_CHANNELS.join(", ")}`);
        if (msg.refresh_token) refreshToken = msg.refresh_token;
      } else {
        log(`Login failed: ${msg.error || "unknown"}`);
        scheduleReconnect();
      }
      return;
    }

    const event = msg.command || msg.type;
    switch (event) {
      case "on_stream_start":   handleStreamStart(msg); break;
      case "on_stream_stop":    handleStreamStop(msg); break;
      case "on_transcription":  handleTranscription(msg); break;
      case "on_channel_status": log(`Channel ${msg.channel}: ${msg.users_online} users`); break;
      case "on_error":          log(`Zello error: ${msg.error}`); break;
    }
  }

  // ── Binary Frame Handler ────────────────────────────────────────
  function handleBinaryFrame(buf) {
    if (!needsLocalSTT || buf.length < 9) return;
    if (buf.readUInt8(0) !== 0x01) return; // audio packets only

    const streamId = buf.readUInt32BE(1);
    const packetId = buf.readUInt32BE(5);
    const stream = activeStreams.get(streamId);
    if (stream) stream.packets.push({ packetId, data: buf.slice(9) });
  }

  // ── Stream Lifecycle ────────────────────────────────────────────
  function handleStreamStart(msg) {
    const isDM = !msg.from && msg.contactName;
    const user = msg.from || msg.contactName || msg.user;
    const replyTo = isDM ? user : msg.channel;
    if (user === BOT_USER) return;

    log(`Stream start: ${user} on ${isDM ? "DM" : msg.channel} (${msg.stream_id})`);
    activeStreams.set(msg.stream_id, {
      user,
      channel: replyTo,
      packets: [],
      transcription: null,
      startedAt: Date.now(),
    });
  }

  function handleTranscription(msg) {
    const stream = activeStreams.get(msg.stream_id);
    if (stream) {
      stream.transcription = msg.text;
      log(`Transcription (${msg.stream_id}): "${msg.text}"`);
    }
  }

  async function handleStreamStop(msg) {
    const stream = activeStreams.get(msg.stream_id);
    if (!stream) return;
    activeStreams.delete(msg.stream_id);

    const dur = Date.now() - stream.startedAt;
    log(`Stream stop: ${stream.user} on ${stream.channel} — ${stream.packets.length} pkts, ${Math.round(dur / 1000)}s`);

    if (dur < 500 || (needsLocalSTT && stream.packets.length < 3)) {
      log("Skipping short transmission");
      return;
    }

    try {
      // 1. Transcribe
      let text;
      if (STT_METHOD === "zello-transcription" && stream.transcription) {
        text = stream.transcription;
      } else if (needsLocalSTT) {
        text = await transcribeAudio(stream);
      } else {
        text = stream.transcription;
      }

      if (!text || !text.trim()) { log("Empty transcription, skipping"); return; }
      log(`From ${stream.user}: "${text}"`);

      // 2. Estimate latency — send ack on radio if slow, then LLM in parallel
      const estimated = estimateLatency(text);
      let ackPromise = null;
      if (estimated === "slow") {
        log(`Slow query detected, sending ack first`);
        ackPromise = textToSpeech("Copy, pulling that now.")
          .then((pcm) => sendAudioToZello(pcm, stream.channel))
          .catch((err) => log(`Ack failed: ${err.message}`));
      }

      // 3. LLM (runs while ack plays if slow)
      const response = await sendToAgent(text, stream.user, stream.channel);
      log(`Agent (${response.length} chars): "${response.slice(0, 100)}"`);

      // Wait for ack to finish before sending the real response
      if (ackPromise) await ackPromise;

      // 4. Truncate for radio + post full transcript to Slack
      const sanitized = sanitizeForTTS(response);
      const { text: cleaned, wasTruncated } = truncateForRadio(sanitized, VOICE_MAX_CHARS);
      if (wasTruncated) log(`Truncated ${sanitized.length} → ${cleaned.length} chars`);
      postTranscript(stream.user, text, response, { truncated: wasTruncated, radioText: cleaned });
      const pcmData = await textToSpeech(cleaned);

      // 5. Opus → Zello
      await sendAudioToZello(pcmData, stream.channel);
    } catch (err) {
      log(`Error processing stream: ${err.message}`);
    }
  }

  // ── Speech-to-Text (local, no ffmpeg) ───────────────────────────
  async function transcribeAudio(stream) {
    const pcmChunks = [];
    for (const pkt of stream.packets) {
      try { pcmChunks.push(opusDecoder.decode(pkt.data)); }
      catch { /* skip corrupted */ }
    }
    if (pcmChunks.length === 0) return null;

    const pcm = Buffer.concat(pcmChunks);
    const wav = Buffer.concat([wavHeader(pcm.length), pcm]);

    const id = crypto.randomBytes(4).toString("hex");
    const wavPath = join(tmpdir(), `clawptt-stt-${id}.wav`);
    await writeFile(wavPath, wav);

    const text = await sttTranscribe(wavPath);
    await unlink(wavPath).catch(() => {});
    return text.trim();
  }

  // ── Slack Transcript ────────────────────────────────────────────
  function postTranscript(user, question, fullResponse, { truncated = false, radioText = "" } = {}) {
    if (!SLACK_TOKEN) return;
    const lines = [`*${user}* on radio:`, `> ${question}`, "", `*JO:*`, fullResponse];
    if (truncated) {
      lines.push("", `_Truncated for radio to:_ "${radioText}"`);
    }
    fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text: lines.join("\n") }),
    }).catch((err) => log(`Slack post failed: ${err.message}`));
  }

  // ── Slack Socket Mode (bidirectional #jo) ───────────────────────
  let slackWs = null;
  let slackUserCache = new Map();

  async function resolveSlackUser(userId) {
    if (slackUserCache.has(userId)) return slackUserCache.get(userId);
    try {
      const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
      });
      const data = await res.json();
      const name = data.user?.profile?.display_name || data.user?.real_name || userId;
      slackUserCache.set(userId, name);
      return name;
    } catch { return userId; }
  }

  async function connectSlack() {
    if (!SLACK_APP_TOKEN || !SLACK_TOKEN || stopped) return;

    try {
      const res = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: { Authorization: `Bearer ${SLACK_APP_TOKEN}` },
      });
      const data = await res.json();
      if (!data.ok) { log(`Slack Socket Mode failed: ${data.error}`); return; }

      slackWs = new WebSocket(data.url);

      slackWs.on("open", () => log("Slack Socket Mode connected to #jo"));

      slackWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());

        // Acknowledge all envelopes immediately
        if (msg.envelope_id) {
          slackWs.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        }

        if (msg.type === "events_api") {
          const event = msg.payload?.event;
          if (event) handleSlackEvent(event);
        }
      });

      slackWs.on("close", () => {
        log("Slack Socket Mode disconnected");
        if (!stopped) setTimeout(connectSlack, 5000);
      });

      slackWs.on("error", (err) => log(`Slack WS error: ${err.message}`));

    } catch (err) {
      log(`Slack connection failed: ${err.message}`);
      if (!stopped) setTimeout(connectSlack, 10000);
    }
  }

  async function handleSlackEvent(event) {
    // Only messages in #jo, from humans, not in threads (avoid reply loops)
    if (event.type !== "message") return;
    if (event.channel !== SLACK_CHANNEL) return;
    if (event.bot_id || event.subtype || !event.user) return;
    if (event.thread_ts) return; // ignore thread replies

    const text = event.text?.trim();
    if (!text) return;

    const userName = await resolveSlackUser(event.user);
    log(`Slack from ${userName}: "${text}"`);

    try {
      // LLM
      const response = await sendToAgent(text, userName, "slack");
      log(`Slack agent (${response.length} chars): "${response.slice(0, 100)}"`);

      // Reply in Slack thread
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: SLACK_CHANNEL,
          text: response,
          thread_ts: event.ts,
        }),
      });

      // Also speak on radio (truncated)
      const sanitized = sanitizeForTTS(response);
      const { text: cleaned } = truncateForRadio(sanitized, VOICE_MAX_CHARS);
      const pcmData = await textToSpeech(cleaned);
      await sendAudioToZello(pcmData, ZELLO_CHANNELS[0]);

    } catch (err) {
      log(`Slack message handling failed: ${err.message}`);
    }
  }

  // ── LLM Communication ──────────────────────────────────────────
  async function sendToAgent(text, user, channel) {
    return LLM_BACKEND === "local"
      ? sendToLocalLLM(text)
      : sendToOpenClaw(text, user, channel);
  }

  async function sendToLocalLLM(text) {
    const t0 = Date.now();
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LLM_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        max_tokens: LLM_MAX_TOK,
        temperature: LLM_TEMP,
      }),
    });
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "(no response)";
    log(`Local LLM (${Date.now() - t0}ms)`);
    return content;
  }

  async function sendToOpenClaw(text, user, channel) {
    const t0 = Date.now();
    const ch = channel || "default";
    pushHistory(ch, "user", text);

    const res = await fetch(`${GW_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GW_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `openclaw:${GW_AGENT}`,
        messages: [...getHistory(ch).messages],
        max_tokens: VOICE_MAX_TOK,
      }),
    });
    if (!res.ok) throw new Error(`OpenClaw error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "(no response)";
    pushHistory(ch, "assistant", content);
    log(`OpenClaw (${Date.now() - t0}ms)`);
    return content;
  }

  // ── Text-to-Speech (persistent worker, no ffmpeg) ──────────────
  async function textToSpeech(text) {
    const id = crypto.randomBytes(4).toString("hex");
    const pcmPath = join(tmpdir(), `clawptt-tts-${id}.pcm`);

    await ttsGenerate(text, pcmPath);
    const pcmData = await readFile(pcmPath);
    await unlink(pcmPath).catch(() => {});
    return pcmData;
  }

  // ── Send Audio to Zello ─────────────────────────────────────────
  async function sendAudioToZello(pcmData, channel) {
    // Codec header: 16kHz, 1 frame/packet, 60ms — base64 of [0x80,0x3E,0x01,0x3C]
    const codecHeader = "gD4BPA==";

    // Pre-encode all Opus frames before starting stream (minimize dead air)
    const bytesPerFrame = FRAME_SIZE * 2;
    const frames = [];
    for (let off = 0; off + bytesPerFrame <= pcmData.length; off += bytesPerFrame) {
      frames.push(opusEncoder.encode(pcmData.slice(off, off + bytesPerFrame)));
    }

    if (frames.length === 0) return;

    // Start stream (with retry for DMs)
    let streamId;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const seq = nextSeq();
      try {
        streamId = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("timeout")), 10000);
          const handler = (data, isBinary) => {
            if (isBinary) return;
            try {
              const m = JSON.parse(data.toString());
              if (m.seq === seq) {
                clearTimeout(timeout);
                ws.off("message", handler);
                m.success ? resolve(m.stream_id) : reject(new Error(m.error || "unknown"));
              }
            } catch {}
          };
          ws.on("message", handler);
          ws.send(JSON.stringify({
            command: "start_stream", seq, channel,
            type: "audio", codec: "opus",
            codec_header: codecHeader,
            packet_duration: FRAME_DURATION_MS,
          }));
        });
        break;
      } catch (err) {
        if (attempt < 6 && (err.message.includes("not ready") || err.message.includes("timeout"))) {
          await sleep(1500 * 1.5 ** (attempt - 1));
        } else {
          throw new Error(`start_stream failed: ${err.message}`);
        }
      }
    }

    // Send pre-encoded frames at correct cadence
    for (let i = 0; i < frames.length; i++) {
      const pkt = Buffer.alloc(9 + frames[i].length);
      pkt.writeUInt8(0x01, 0);
      pkt.writeUInt32BE(streamId, 1);
      pkt.writeUInt32BE(i, 5);
      frames[i].copy(pkt, 9);
      ws.send(pkt);
      await sleep(FRAME_DURATION_MS);
    }

    ws.send(JSON.stringify({
      command: "stop_stream",
      seq: nextSeq(),
      stream_id: streamId,
      channel,
    }));
    log(`Audio sent: ${frames.length} frames to ${channel}`);
  }

  // ── Public API ──────────────────────────────────────────────────
  return {
    async start() {
      stopped = false;

      // Start workers
      if (needsLocalSTT) startSTTWorker();
      startTTSWorker();

      // Connect to Zello + Slack
      connectZello();
      connectSlack();

      // Start REST API if configured
      if (opts.api) {
        await startAPI({
          network: NETWORK,
          apiKey: opts.api.apiKey,
          username: opts.api.adminUser,
          password: opts.api.adminPass,
          port: opts.api.port,
          token: opts.api.token,
        }).catch((err) => log(`API failed to start: ${err.message}`));
      }

      log("Bridge started");
    },

    async stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (sttProc) { sttProc.kill(); sttProc = null; }
      if (ttsProc) { ttsProc.kill(); ttsProc = null; }
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, "bridge shutdown");
      if (slackWs && slackWs.readyState === WebSocket.OPEN) slackWs.close(1000);
      log("Bridge stopped");
    },
  };
}

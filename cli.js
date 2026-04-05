#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// ClawPTT CLI — reads env vars and starts the voice bridge
//
// Usage:
//   npx clawptt          — start the bridge
//   npx clawptt init     — interactive setup wizard
// ═══════════════════════════════════════════════════════════════════

// Subcommand routing
if (process.argv[2] === "init") {
  const { runInit } = await import("./init.js");
  await runInit();
  process.exit(0);
}

import { createBridge } from "./bridge.js";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

// Auto-load .env from current directory (no dependency needed)
try {
  const envFile = readFileSync(join(process.cwd(), ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // No .env file — that's fine, use env vars directly
}

const channels = (process.env.ZELLO_BRIDGE_CHANNELS || "").split(",").filter(Boolean);
const llmBackend = process.env.LLM_BACKEND || "openclaw";

const options = {
  zello: {
    network: process.env.ZELLO_NETWORK,
    botUser: process.env.ZELLO_BOT_USER || process.env.ZELLO_ADMIN_USER,
    botPass: process.env.ZELLO_BOT_PASS || process.env.ZELLO_ADMIN_PASS,
    channels,
  },
  llm: {
    backend: llmBackend,
    gateway: process.env.OPENCLAW_GATEWAY || "http://127.0.0.1:18789",
    token: process.env.GATEWAY_TOKEN,
    agent: process.env.OPENCLAW_AGENT || "main",
    url: process.env.LOCAL_LLM_URL,
    apiKey: process.env.LOCAL_LLM_API_KEY,
    model: process.env.LOCAL_LLM_MODEL,
    maxTokens: process.env.LOCAL_LLM_MAX_TOKENS ? parseInt(process.env.LOCAL_LLM_MAX_TOKENS, 10) : undefined,
    temperature: process.env.LOCAL_LLM_TEMPERATURE ? parseFloat(process.env.LOCAL_LLM_TEMPERATURE) : undefined,
  },
  tts: {
    voice: process.env.TTS_VOICE,
    sherpaDir: process.env.SHERPA_ONNX_DIR,
    model: process.env.TTS_MODEL,
    tokens: process.env.TTS_TOKENS,
    dataDir: process.env.TTS_DATA_DIR,
    python: process.env.VENV_PYTHON,
  },
  history: {
    maxTurns: process.env.HISTORY_MAX_TURNS ? parseInt(process.env.HISTORY_MAX_TURNS, 10) : undefined,
    ttlMs: process.env.HISTORY_TTL_MS ? parseInt(process.env.HISTORY_TTL_MS, 10) : undefined,
  },
  systemPrompt: process.env.AGENT_SYSTEM_PROMPT,
};

if (process.env.ZELLO_API_KEY) {
  options.api = {
    apiKey: process.env.ZELLO_API_KEY,
    adminUser: process.env.ZELLO_ADMIN_USER || process.env.ZELLO_BOT_USER,
    adminPass: process.env.ZELLO_ADMIN_PASS || process.env.ZELLO_BOT_PASS,
    port: process.env.CLAWPTT_API_PORT ? parseInt(process.env.CLAWPTT_API_PORT, 10) : 18790,
    token: process.env.CLAWPTT_API_TOKEN || process.env.GATEWAY_TOKEN,
  };
}

// Banner
const llmLabel = llmBackend === "local"
  ? `local (${process.env.LOCAL_LLM_MODEL || "default"})`
  : `openclaw (${process.env.OPENCLAW_AGENT || "main"})`;

console.error("═══════════════════════════════════════════════════");
console.error("  ClawPTT — Voice Bridge for OpenClaw");
console.error(`  Network:  ${process.env.ZELLO_NETWORK || "(not set)"}`);
console.error(`  Bot user: ${options.zello.botUser || "(not set)"}`);
console.error(`  Channels: ${channels.join(", ") || "(none)"}`);
console.error(`  LLM:      ${llmLabel}`);
console.error(`  STT:      Zello server-side transcription`);
console.error(`  TTS:      ${options.tts.voice || "en_US-lessac-high"}`);
console.error("═══════════════════════════════════════════════════");

// ─── Preflight checks ────────────────────────────────────────────
async function preflight() {
  let ok = true;

  // Check LLM backend
  if (llmBackend === "openclaw") {
    const gateway = options.llm.gateway;
    const token = options.llm.token;
    try {
      const res = await fetch(`${gateway}/v1/models`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        // Gateway is running but HTTP API not enabled (dashboard returned)
        console.error(`[preflight] Gateway reachable but HTTP API returned HTML.`);
        console.error("[preflight] The gateway may need its HTTP/OpenAI API enabled.");
        console.error("[preflight] ClawPTT will attempt to use it at runtime — continuing.");
      } else if (res.ok) {
        const data = await res.json();
        const agents = (data.data || []).map((m) => m.id.replace(/^openclaw\/?/, "")).filter(Boolean);
        const agent = options.llm.agent;
        if (agents.length > 0 && !agents.includes(agent)) {
          console.error(`[preflight] Warning: agent '${agent}' not found. Available: ${agents.join(", ")}`);
        } else {
          console.error(`[preflight] Gateway OK — ${agents.length} agent(s)`);
        }
      } else if (res.status === 401 || res.status === 403) {
        console.error("[preflight] FAIL: gateway rejected token. Check GATEWAY_TOKEN.");
        ok = false;
      } else {
        console.error(`[preflight] Warning: gateway returned ${res.status}`);
      }
    } catch (err) {
      if (err.name === "AbortError" || err.cause?.code === "ECONNREFUSED") {
        console.error(`[preflight] FAIL: cannot reach gateway at ${gateway}`);
        console.error("[preflight] Is openclaw-gateway running?");
        ok = false;
      } else {
        // Gateway is reachable but response wasn't JSON (e.g. HTML dashboard)
        console.error(`[preflight] Gateway reachable but didn't return JSON — HTTP API may not be enabled.`);
        console.error("[preflight] ClawPTT will attempt to use it at runtime — continuing.");
      }
    }
  } else {
    const url = options.llm.url || "http://127.0.0.1:8888/v1/chat/completions";
    const modelsUrl = url.replace(/\/chat\/completions$/, "/models");
    try {
      const res = await fetch(modelsUrl, {
        headers: options.llm.apiKey ? { Authorization: `Bearer ${options.llm.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        console.error("[preflight] LLM endpoint OK");
      } else {
        console.error(`[preflight] Warning: LLM endpoint returned ${res.status}`);
      }
    } catch (err) {
      console.error(`[preflight] FAIL: cannot reach LLM at ${modelsUrl} (${err.message})`);
      ok = false;
    }
  }

  // Check TTS python + sherpa-onnx
  const python = options.tts.python || "python3";
  try {
    execSync(`${python} -c "import sherpa_onnx"`, { stdio: "pipe" });
    console.error("[preflight] TTS (sherpa-onnx) OK");
  } catch {
    console.error(`[preflight] Warning: sherpa-onnx not available via '${python}'. TTS will fail.`);
    console.error("[preflight] Fix: pip install sherpa-onnx numpy, or set VENV_PYTHON");
  }

  // Check ffmpeg
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
    console.error("[preflight] ffmpeg OK");
  } catch {
    console.error("[preflight] FAIL: ffmpeg not found. Audio encoding requires ffmpeg.");
    ok = false;
  }

  if (!ok) {
    console.error("[preflight] Some checks failed. Fix the issues above or run 'npx clawptt init'.");
    process.exit(1);
  }
  console.error("");
}

await preflight();

let bridge;
try {
  bridge = createBridge(options);
} catch (err) {
  console.error(`[clawptt] ${err.message}`);
  process.exit(1);
}

process.on("SIGINT", () => bridge.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => bridge.stop().then(() => process.exit(0)));

bridge.start().catch((err) => {
  console.error(`[clawptt] Fatal: ${err.message}`);
  process.exit(1);
});

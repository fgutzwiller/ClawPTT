// ═══════════════════════════════════════════════════════════════════
// ClawPTT Setup — `npx clawptt init`
//
// Generates a .env config, opens it in $EDITOR, then validates
// the configuration and installs missing dependencies.
// ═══════════════════════════════════════════════════════════════════

import { createInterface } from "readline";
import { writeFile, readFile, access, mkdir } from "fs/promises";
import { execSync, spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

// ─── UI helpers ──────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

const OK = `${GREEN}✓${RESET}`;
const WARN = `${YELLOW}!${RESET}`;
const FAIL = `${RED}✗${RESET}`;
const ARROW = `${CYAN}→${RESET}`;

function log(msg = "") { console.log(msg); }
function status(icon, msg) { console.log(`  ${icon} ${msg}`); }

function exists(path) {
  return access(path).then(() => true).catch(() => false);
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${DIM}(${hint})${RESET} `, (answer) => {
      const a = answer.trim().toLowerCase();
      resolve(a === "" ? defaultYes : a.startsWith("y"));
    });
  });
}

// ─── .env template ───────────────────────────────────────────────

function generateTemplate(existing = {}) {
  const v = (key, fallback = "") => existing[key] || fallback;

  return `# ═══════════════════════════════════════════════════════════════
# ClawPTT Configuration
# Edit the values below, then save and close this file.
# Lines starting with # are comments. Uncomment to enable.
# ═══════════════════════════════════════════════════════════════

# ── Zello Work ────────────────────────────────────────────────
# Your Zello Work network name (from zellowork.com admin)
ZELLO_NETWORK=${v("ZELLO_NETWORK", "your-network")}

# Bot credentials (create a dedicated user for the bridge)
ZELLO_BOT_USER=${v("ZELLO_BOT_USER", "your-bot-user")}
ZELLO_BOT_PASS=${v("ZELLO_BOT_PASS", "your-bot-password")}

# Channel(s) the bot will join (comma-separated)
ZELLO_BRIDGE_CHANNELS=${v("ZELLO_BRIDGE_CHANNELS", "your-channel")}

# ── LLM Backend ──────────────────────────────────────────────
# "openclaw" = OpenClaw gateway (default)
# "local"    = any OpenAI-compatible endpoint (vLLM, Ollama, etc.)
LLM_BACKEND=${v("LLM_BACKEND", "openclaw")}

# OpenClaw gateway settings (when LLM_BACKEND=openclaw)
OPENCLAW_GATEWAY=${v("OPENCLAW_GATEWAY", "http://127.0.0.1:18789")}
GATEWAY_TOKEN=${v("GATEWAY_TOKEN", "your-gateway-token")}
OPENCLAW_AGENT=${v("OPENCLAW_AGENT", "main")}

# Local LLM settings (when LLM_BACKEND=local)
# LOCAL_LLM_URL=http://127.0.0.1:8888/v1/chat/completions
# LOCAL_LLM_API_KEY=
# LOCAL_LLM_MODEL=your-model

# ── Text-to-Speech ───────────────────────────────────────────
# Piper voice model (see: github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)
TTS_VOICE=${v("TTS_VOICE", "en_US-lessac-high")}

# Python with sherpa-onnx installed
VENV_PYTHON=${v("VENV_PYTHON", "python3")}

# ── Zello REST API (optional) ────────────────────────────────
# Uncomment to enable the admin REST API on port 18790
# ZELLO_API_KEY=${v("ZELLO_API_KEY", "your-api-key")}
# ZELLO_ADMIN_USER=${v("ZELLO_ADMIN_USER", "")}
# ZELLO_ADMIN_PASS=${v("ZELLO_ADMIN_PASS", "")}
# CLAWPTT_API_PORT=${v("CLAWPTT_API_PORT", "18790")}
`;
}

// ─── Parse .env ──────────────────────────────────────────────

function parseEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

// ─── Validation & checks ─────────────────────────────────────

async function validate(env, rl) {
  log("");
  log(`${BOLD}── Checking configuration ──${RESET}`);
  log("");

  let issues = 0;

  // Required fields
  const required = [
    ["ZELLO_NETWORK", "Zello network name"],
    ["ZELLO_BOT_USER", "Bot username"],
    ["ZELLO_BOT_PASS", "Bot password"],
    ["ZELLO_BRIDGE_CHANNELS", "Bridge channel(s)"],
  ];

  for (const [key, label] of required) {
    const val = env[key];
    if (!val || val.startsWith("your-")) {
      status(FAIL, `${label} ${DIM}(${key})${RESET} — not configured`);
      issues++;
    } else {
      status(OK, `${label} ${DIM}${key}=${val}${RESET}`);
    }
  }

  // LLM backend
  const backend = env.LLM_BACKEND || "openclaw";
  if (backend === "openclaw") {
    const gateway = env.OPENCLAW_GATEWAY || "http://127.0.0.1:18789";
    const token = env.GATEWAY_TOKEN;

    if (!token || token === "your-gateway-token") {
      status(FAIL, `Gateway token ${DIM}(GATEWAY_TOKEN)${RESET} — not configured`);
      issues++;
    } else {
      // Test gateway connectivity
      try {
        const res = await fetch(`${gateway}/v1/models`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("text/html")) {
          status(WARN, `Gateway ${DIM}${gateway}${RESET} — reachable, HTTP API not enabled`);
          log(`         ${DIM}ClawPTT will try at runtime. Enable the OpenAI HTTP API in openclaw config.${RESET}`);
        } else if (res.ok) {
          const data = await res.json();
          const agents = (data.data || []).map((m) => m.id.replace(/^openclaw\/?/, "")).filter(Boolean);
          const agent = env.OPENCLAW_AGENT || "main";
          if (agents.length > 0 && agents.includes(agent)) {
            status(OK, `Gateway ${DIM}${gateway}${RESET} — ${agents.length} agent(s), using ${BOLD}${agent}${RESET}`);
          } else if (agents.length > 0) {
            status(WARN, `Agent ${BOLD}${agent}${RESET} not found. Available: ${agents.join(", ")}`);
          } else {
            status(OK, `Gateway ${DIM}${gateway}${RESET} — reachable`);
          }
        } else if (res.status === 401 || res.status === 403) {
          status(FAIL, `Gateway ${DIM}${gateway}${RESET} — token rejected`);
          issues++;
        } else {
          status(WARN, `Gateway ${DIM}${gateway}${RESET} — returned ${res.status}`);
        }
      } catch (err) {
        if (err.cause?.code === "ECONNREFUSED") {
          status(FAIL, `Gateway ${DIM}${gateway}${RESET} — connection refused`);
          issues++;
        } else {
          status(WARN, `Gateway ${DIM}${gateway}${RESET} — reachable, non-JSON response`);
        }
      }
    }
  } else if (backend === "local") {
    const url = env.LOCAL_LLM_URL || "http://127.0.0.1:8888/v1/chat/completions";
    try {
      const res = await fetch(url.replace(/\/chat\/completions$/, "/models"), {
        headers: env.LOCAL_LLM_API_KEY ? { Authorization: `Bearer ${env.LOCAL_LLM_API_KEY}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        status(OK, `LLM endpoint ${DIM}${url}${RESET}`);
      } else {
        status(WARN, `LLM endpoint ${DIM}${url}${RESET} — returned ${res.status}`);
      }
    } catch {
      status(FAIL, `LLM endpoint ${DIM}${url}${RESET} — unreachable`);
      issues++;
    }
  }

  log("");
  log(`${BOLD}── Checking dependencies ──${RESET}`);
  log("");

  // Python + sherpa-onnx
  const python = env.VENV_PYTHON || "python3";
  const pyVersion = run(`${python} --version`);
  if (!pyVersion) {
    status(FAIL, `Python ${DIM}(${python})${RESET} — not found`);
    issues++;
  } else {
    status(OK, `${pyVersion}`);

    const hasSherpa = run(`${python} -c "import sherpa_onnx; print('ok')"`);
    if (!hasSherpa) {
      status(WARN, `sherpa-onnx — not installed`);
      if (await confirm(rl, `Install sherpa-onnx and numpy via ${python}?`)) {
        log(`  ${ARROW} Installing...`);
        try {
          execSync(`${python} -m pip install sherpa-onnx numpy`, { stdio: "inherit" });
          status(OK, "sherpa-onnx installed");
        } catch {
          status(FAIL, "Install failed. Run manually: pip install sherpa-onnx numpy");
        }
      }
    } else {
      status(OK, "sherpa-onnx");
    }

    // Voice model
    const voice = env.TTS_VOICE || "en_US-lessac-high";
    const modelDir = join(homedir(), ".clawptt", "tts", "models", `vits-piper-${voice}`);
    const modelFile = join(modelDir, `${voice}.onnx`);
    if (await exists(modelFile)) {
      status(OK, `Voice model ${DIM}${voice}${RESET}`);
    } else {
      status(WARN, `Voice model ${DIM}${voice}${RESET} — not found`);
      if (await confirm(rl, "Download it now?")) {
        const modelsDir = join(homedir(), ".clawptt", "tts", "models");
        await mkdir(modelsDir, { recursive: true });
        log(`  ${ARROW} Downloading...`);
        try {
          execSync(
            `curl -sL https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${voice}.tar.bz2 | tar xjf - -C "${modelsDir}"`,
            { stdio: "inherit" },
          );
          status(OK, "Voice model downloaded");
        } catch {
          status(FAIL, "Download failed. See README for manual install.");
        }
      }
    }
  }

  // ffmpeg
  if (run("ffmpeg -version")) {
    status(OK, "ffmpeg");
  } else {
    status(FAIL, "ffmpeg — not found");
    const platform = process.platform;
    if (platform === "darwin") {
      if (await confirm(rl, "Install ffmpeg via Homebrew?")) {
        log(`  ${ARROW} Installing...`);
        try {
          execSync("brew install ffmpeg", { stdio: "inherit" });
          status(OK, "ffmpeg installed");
        } catch {
          status(FAIL, "Install failed. Run: brew install ffmpeg");
        }
      }
    } else if (platform === "linux") {
      log(`  ${ARROW} Install with: ${BOLD}sudo apt install ffmpeg${RESET}`);
    } else {
      log(`  ${ARROW} Install from: https://ffmpeg.org/download.html`);
    }
    issues++;
  }

  return issues;
}

// ─── Main ────────────────────────────────────────────────────

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const envPath = join(process.cwd(), ".env");

  log("");
  log(`${BOLD}╭─────────────────────────────────────────────────╮${RESET}`);
  log(`${BOLD}│${RESET}  ${CYAN}ClawPTT${RESET} — Setup                               ${BOLD}│${RESET}`);
  log(`${BOLD}│${RESET}  ${DIM}A push to talk interface to OpenClaw${RESET}            ${BOLD}│${RESET}`);
  log(`${BOLD}╰─────────────────────────────────────────────────╯${RESET}`);
  log("");

  // Load existing .env if present
  let existing = {};
  if (await exists(envPath)) {
    try {
      existing = parseEnv(await readFile(envPath, "utf8"));
      status(OK, `Found existing ${DIM}${envPath}${RESET}`);
    } catch {}
  }

  // Generate and write template
  const template = generateTemplate(existing);
  await writeFile(envPath, template);

  // Determine editor
  const editor = process.env.EDITOR || process.env.VISUAL || (run("which nano") ? "nano" : run("which vi") ? "vi" : null);

  if (!editor) {
    log("");
    status(WARN, "No editor found. Edit the config manually:");
    log(`  ${ARROW} ${BOLD}${envPath}${RESET}`);
    log("");
    log(`  Then run ${BOLD}npx clawptt init${RESET} again to validate.`);
    rl.close();
    return;
  }

  log("");
  log(`  Opening ${BOLD}.env${RESET} in ${BOLD}${editor}${RESET}...`);
  log(`  ${DIM}Edit your configuration, then save and close the editor.${RESET}`);
  log("");

  // Open editor
  const result = spawnSync(editor, [envPath], { stdio: "inherit" });
  if (result.status !== 0) {
    status(FAIL, `Editor exited with code ${result.status}`);
    rl.close();
    return;
  }

  // Read back the edited .env
  let edited;
  try {
    edited = await readFile(envPath, "utf8");
  } catch {
    status(FAIL, `Could not read ${envPath}`);
    rl.close();
    return;
  }

  const env = parseEnv(edited);
  const issues = await validate(env, rl);

  log("");
  if (issues === 0) {
    log(`${BOLD}╭─────────────────────────────────────────────────╮${RESET}`);
    log(`${BOLD}│${RESET}  ${GREEN}All checks passed.${RESET}                             ${BOLD}│${RESET}`);
    log(`${BOLD}│${RESET}                                                 ${BOLD}│${RESET}`);
    log(`${BOLD}│${RESET}  Run ${BOLD}npx clawptt${RESET} to start the bridge.           ${BOLD}│${RESET}`);
    log(`${BOLD}╰─────────────────────────────────────────────────╯${RESET}`);
  } else {
    log(`${BOLD}╭─────────────────────────────────────────────────╮${RESET}`);
    log(`${BOLD}│${RESET}  ${YELLOW}${issues} issue(s) found.${RESET}                              ${BOLD}│${RESET}`);
    log(`${BOLD}│${RESET}                                                 ${BOLD}│${RESET}`);
    log(`${BOLD}│${RESET}  Edit ${DIM}.env${RESET} to fix, then run ${BOLD}npx clawptt init${RESET}    ${BOLD}│${RESET}`);
    log(`${BOLD}│${RESET}  again, or just ${BOLD}npx clawptt${RESET} to try anyway.      ${BOLD}│${RESET}`);
    log(`${BOLD}╰─────────────────────────────────────────────────╯${RESET}`);
  }
  log("");

  rl.close();
}

// ═══════════════════════════════════════════════════════════════════
// ClawPTT API — HTTP endpoints for Zello Work admin/data
//
// Runs in-process with bridge.js. Single Zello session shared
// across all callers (agents, scripts, bridge internals).
// ═══════════════════════════════════════════════════════════════════

import { createServer } from "http";
import { ZelloAPI } from "./zello.js";

const API_PORT = parseInt(process.env.CLAWPTT_API_PORT || "18790", 10);
const API_TOKEN = process.env.CLAWPTT_API_TOKEN || process.env.GATEWAY_TOKEN;

let api = null;

export function getAPI() {
  return api;
}

export async function startAPI() {
  api = new ZelloAPI({
    network: process.env.ZELLO_NETWORK,
    apiKey: process.env.ZELLO_API_KEY,
    username: process.env.ZELLO_ADMIN_USER || process.env.ZELLO_BOT_USER,
    password: process.env.ZELLO_ADMIN_PASS || process.env.ZELLO_BOT_PASS,
  });

  await api.login();
  console.error(`[clawptt-api] Zello session ready (${api.network})`);

  const server = createServer(handleRequest);
  server.listen(API_PORT, "127.0.0.1", () => {
    console.error(`[clawptt-api] Listening on 127.0.0.1:${API_PORT}`);
  });

  return api;
}

// ─── Router ──────────────────────────────────────────────────────

const routes = {
  "GET /users":            (q) => api.listUsers(q),
  "POST /users":           (q, b) => api.createUser(b),
  "DELETE /users":         (q, b) => api.deleteUsers(b.usernames),
  "GET /channels":         (q) => api.listChannels(q),
  "POST /channels":        (q, b) => api.createChannel(b.name, b),
  "DELETE /channels":      (q, b) => api.deleteChannels(b.names),
  "POST /channels/members":   (q, b) => api.addUsersToChannel(b.channel, b.usernames),
  "DELETE /channels/members":  (q, b) => api.removeUsersFromChannel(b.channel, b.usernames),
  "POST /contacts":        (q, b) => api.addContacts(b.target_user, b.contacts),
  "DELETE /contacts":       (q, b) => api.removeContacts(b.target_user, b.contacts),
  "GET /roles":            (q) => api.listRoles(q.channel),
  "POST /roles":           (q, b) => api.saveRole(b.channel, b.role_name, b),
  "POST /roles/assign":    (q, b) => api.assignRole(b.channel, b.role_name, b.usernames),
  "DELETE /roles":         (q, b) => api.deleteRoles(b.channel, b.role_names),
  "GET /locations":        (q) => api.getLocations(q),
  "GET /locations/user":   (q) => api.getUserLocation(q.username, q),
  "GET /history":          (q) => api.getHistory(q),
  "GET /media":            (q) => api.getMedia(q.media_key),
  "POST /session/refresh": ()  => api.refreshSession().then((sid) => ({ sid })),
};

async function handleRequest(req, res) {
  // Auth
  if (API_TOKEN) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${API_TOKEN}`) {
      return send(res, 401, { error: "unauthorized" });
    }
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  // Health
  if (path === "/health") {
    return send(res, 200, { ok: true, session: !!api?.sessionId });
  }

  const key = `${method} ${path}`;
  const handler = routes[key];
  if (!handler) {
    return send(res, 404, { error: "not found", path, method });
  }

  try {
    const query = Object.fromEntries(url.searchParams);
    const body = method !== "GET" ? await readBody(req) : {};
    const result = await handler(query, body);
    send(res, 200, result);
  } catch (err) {
    console.error(`[clawptt-api] ${key} error: ${err.message}`);
    send(res, 500, { error: err.message });
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════════
// ClawPTT API — HTTP endpoints for Zello Work admin/data
//
// Runs in-process with bridge.js. Single Zello session shared
// across all callers (agents, scripts, bridge internals).
// ═══════════════════════════════════════════════════════════════════

import { createServer } from "http";
import { ZelloAPI } from "./zello.js";

let api = null;

export function getAPI() {
  return api;
}

/**
 * Start the ClawPTT REST API server.
 *
 * @param {object} opts
 * @param {string} opts.network - Zello Work network name
 * @param {string} opts.apiKey - Zello REST API key
 * @param {string} opts.username - Admin username
 * @param {string} opts.password - Admin password
 * @param {number} [opts.port=18790] - Listen port
 * @param {string} [opts.token] - Bearer token for API auth
 * @returns {Promise<{ api: ZelloAPI, server: import("http").Server }>}
 */
export async function startAPI(opts = {}) {
  const port = opts.port || 18790;
  const authToken = opts.token;

  api = new ZelloAPI({
    network: opts.network,
    apiKey: opts.apiKey,
    username: opts.username,
    password: opts.password,
  });

  await api.login();
  console.error(`[clawptt-api] Zello session ready (${api.network})`);

  // ─── Router ──────────────────────────────────────────────────
  const routes = {
    "GET /users":              (q) => api.listUsers(q),
    "POST /users":             (q, b) => api.createUser(b),
    "DELETE /users":           (q, b) => api.deleteUsers(b.usernames || []),
    "GET /channels":           (q) => api.listChannels(q),
    "POST /channels":          (q, b) => api.createChannel(b.name, b),
    "DELETE /channels":        (q, b) => api.deleteChannels(b.names || []),
    "POST /channels/members":  (q, b) => api.addUsersToChannel(b.channel, b.usernames || []),
    "DELETE /channels/members": (q, b) => api.removeUsersFromChannel(b.channel, b.usernames || []),
    "POST /contacts":          (q, b) => api.addContacts(b.target_user, b.contacts || []),
    "DELETE /contacts":        (q, b) => api.removeContacts(b.target_user, b.contacts || []),
    "GET /roles":              (q) => api.listRoles(q.channel),
    "POST /roles":             (q, b) => api.saveRole(b.channel, b.role_name, b),
    "POST /roles/assign":      (q, b) => api.assignRole(b.channel, b.role_name, b.usernames || []),
    "DELETE /roles":           (q, b) => api.deleteRoles(b.channel, b.role_names || []),
    "GET /locations":          (q) => api.getLocations(q),
    "GET /locations/user":     (q) => api.getUserLocation(q.username, q),
    "GET /history":            (q) => api.getHistory(q),
    "GET /media":              (q) => api.getMedia(q.media_key),
    "POST /session/refresh":   () => api.refreshSession().then((sid) => ({ sid })),
  };

  async function handleRequest(req, res) {
    if (authToken) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${authToken}`) {
        return send(res, 401, { error: "unauthorized" });
      }
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

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

  const server = createServer(handleRequest);
  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      console.error(`[clawptt-api] Listening on 127.0.0.1:${port}`);
      resolve();
    });
  });

  return { api, server };
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

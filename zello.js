// ═══════════════════════════════════════════════════════════════════
// ZelloAPI — Zello Work REST API Client
//
// Standalone client for the Zello Work admin/data REST API.
// Handles session auth, user/channel management, location tracking,
// message history, roles, and media retrieval.
//
// Separate from bridge.js (which handles WebSocket streaming for
// real-time voice). This module is for admin operations and data.
// ═══════════════════════════════════════════════════════════════════

import crypto from "crypto";

export class ZelloAPI {
  /**
   * @param {object} opts
   * @param {string} opts.network   - Zello Work network name
   * @param {string} opts.apiKey    - API key from admin console
   * @param {string} opts.username  - Admin username
   * @param {string} opts.password  - Admin password (plaintext)
   */
  constructor({ network, apiKey, username, password }) {
    this.network = network;
    this.apiKey = apiKey;
    this.username = username;
    this.password = password;
    this.baseUrl = `https://${network}.zellowork.com`;
    this.sessionId = null;
  }

  // ─── Session ───────────────────────────────────────────────────

  async login() {
    const res = await fetch(`${this.baseUrl}/user/gettoken`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from gettoken`);
    const data = await res.json();
    if (data.code !== "200") throw new Error(`gettoken failed: ${data.status}`);

    this.sessionId = data.sid;

    const passHash = crypto.createHash("md5").update(this.password).digest("hex");
    const authHash = crypto
      .createHash("md5")
      .update(passHash + data.token + this.apiKey)
      .digest("hex");

    const loginRes = await fetch(`${this.baseUrl}/user/login?sid=${data.sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `username=${encodeURIComponent(this.username)}&password=${authHash}`,
    });
    if (!loginRes.ok) throw new Error(`HTTP ${loginRes.status} from login`);
    const loginData = await loginRes.json();
    if (loginData.code !== "200") throw new Error(`Login failed: ${loginData.status}`);

    return this.sessionId;
  }

  async logout() {
    if (!this.sessionId) return;
    try {
      await fetch(`${this.baseUrl}/user/logout?sid=${this.sessionId}`);
    } finally {
      this.sessionId = null;
    }
  }

  async refreshSession() {
    await this.logout();
    return this.login();
  }

  // ─── HTTP Primitives ───────────────────────────────────────────

  async _ensureSession() {
    if (!this.sessionId) await this.login();
  }

  async _get(path) {
    await this._ensureSession();
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${this.baseUrl}${path}${sep}sid=${this.sessionId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from GET ${path}`);
    const data = await res.json();

    if (data.code === "301") {
      await this.login();
      return this._get(path);
    }
    return data;
  }

  async _post(path, body) {
    await this._ensureSession();
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${this.baseUrl}${path}${sep}sid=${this.sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from POST ${path}`);
    const data = await res.json();

    if (data.code === "301") {
      await this.login();
      return this._post(path, body);
    }
    return data;
  }

  // ─── Users ─────────────────────────────────────────────────────

  /**
   * List all users, or get a specific user by username.
   * @param {object} [opts]
   * @param {string} [opts.username] - Specific user to fetch
   * @param {number} [opts.max]      - Max results
   * @param {number} [opts.start]    - Pagination offset
   */
  async listUsers(opts = {}) {
    let path = "/user/get";
    if (opts.username) path += `/login/${encodeURIComponent(opts.username)}`;
    if (opts.max) path += `/max/${opts.max}`;
    if (opts.start) path += `/start/${opts.start}`;
    return this._get(path);
  }

  /**
   * Create or update a user.
   * @param {object} opts
   * @param {string} opts.name            - Username (login)
   * @param {string} [opts.password]      - Plaintext password (md5-hashed before sending)
   * @param {string} [opts.full_name]     - Display name
   * @param {string} [opts.email]
   * @param {string} [opts.job]           - Job title
   * @param {boolean} [opts.admin]        - Admin console access
   * @param {boolean} [opts.limited_access] - Restrict 1:1 conversations
   * @param {string} [opts.tags]          - Comma-separated tags
   */
  async createUser(opts) {
    const params = new URLSearchParams();
    params.set("name", opts.name);
    if (opts.password) {
      params.set("password", crypto.createHash("md5").update(opts.password).digest("hex"));
    }
    for (const key of ["full_name", "email", "job", "tags"]) {
      if (opts[key]) params.set(key, opts[key]);
    }
    for (const key of ["admin", "limited_access"]) {
      if (opts[key] !== undefined) params.set(key, String(opts[key]));
    }
    return this._post("/user/save", params.toString());
  }

  /**
   * Delete one or more users.
   * @param {string[]} usernames
   */
  async deleteUsers(usernames) {
    return this._post("/user/delete", _encodeArray("login", usernames));
  }

  /**
   * Add direct contacts to a user.
   * @param {string} targetUser
   * @param {string[]} contacts
   */
  async addContacts(targetUser, contacts) {
    return this._post(
      `/user/addcontactsto/${encodeURIComponent(targetUser)}`,
      _encodeArray("login", contacts)
    );
  }

  /**
   * Remove direct contacts from a user.
   * @param {string} targetUser
   * @param {string[]} contacts
   */
  async removeContacts(targetUser, contacts) {
    return this._post(
      `/user/removecontactsfrom/${encodeURIComponent(targetUser)}`,
      _encodeArray("login", contacts)
    );
  }

  // ─── Channels ──────────────────────────────────────────────────

  /**
   * List all channels, or get a specific one by name.
   * @param {object} [opts]
   * @param {string} [opts.name]   - Specific channel name
   * @param {string} [opts.tags]   - Comma-separated tag filter
   * @param {string} [opts.search] - Partial name match
   * @param {number} [opts.max]
   * @param {number} [opts.start]
   */
  async listChannels(opts = {}) {
    let path = "/channel/get";
    if (opts.name) path += `/name/${encodeURIComponent(opts.name)}`;
    if (opts.tags) path += `/tags/${encodeURIComponent(opts.tags)}`;
    if (opts.search) path += `/search/${encodeURIComponent(opts.search)}`;
    if (opts.max) path += `/max/${opts.max}`;
    if (opts.start) path += `/start/${opts.start}`;
    return this._get(path);
  }

  /**
   * Create a channel.
   * @param {string} name
   * @param {object} [opts]
   * @param {boolean} [opts.shared]    - Group channel (true) or dynamic (false)
   * @param {boolean} [opts.invisible] - Hidden channel
   * @param {string}  [opts.tags]      - Comma-separated tags
   */
  async createChannel(name, opts = {}) {
    let path = `/channel/add/name/${encodeURIComponent(name)}`;
    if (opts.shared) path += "/shared/true";
    if (opts.invisible) path += "/invisible/true";
    if (opts.tags) path += `/tags/${encodeURIComponent(opts.tags)}`;
    return this._get(path);
  }

  /**
   * Delete one or more channels.
   * @param {string[]} names
   */
  async deleteChannels(names) {
    return this._post("/channel/delete", _encodeArray("name", names));
  }

  /**
   * Add users to a channel.
   * @param {string} channel
   * @param {string[]} usernames
   */
  async addUsersToChannel(channel, usernames) {
    return this._post(
      `/user/addto/${encodeURIComponent(channel)}`,
      _encodeArray("login", usernames)
    );
  }

  /**
   * Remove users from a channel.
   * @param {string} channel
   * @param {string[]} usernames
   */
  async removeUsersFromChannel(channel, usernames) {
    return this._post(
      `/user/removefrom/${encodeURIComponent(channel)}`,
      _encodeArray("login", usernames)
    );
  }

  // ─── Roles ─────────────────────────────────────────────────────

  /**
   * List all roles for a channel.
   * @param {string} channel
   */
  async listRoles(channel) {
    return this._get(`/channel/roleslist/name/${encodeURIComponent(channel)}`);
  }

  /**
   * Create or update a channel role.
   * @param {string} channel
   * @param {string} roleName
   * @param {object} [settings]
   * @param {boolean} [settings.listen_only]
   * @param {boolean} [settings.no_disconnect]
   * @param {boolean} [settings.allow_alerts]
   * @param {string[]} [settings.to] - Roles this role can talk to (empty = all)
   */
  async saveRole(channel, roleName, settings = {}) {
    const body = `settings=${encodeURIComponent(JSON.stringify(settings))}`;
    return this._post(
      `/channel/saverole/channel/${encodeURIComponent(channel)}/name/${encodeURIComponent(roleName)}`,
      body
    );
  }

  /**
   * Assign users to a channel role.
   * @param {string} channel
   * @param {string} roleName - Empty string to reset assignments
   * @param {string[]} usernames
   */
  async assignRole(channel, roleName, usernames) {
    return this._post(
      `/channel/addtorole/channel/${encodeURIComponent(channel)}/name/${encodeURIComponent(roleName)}/`,
      _encodeArray("login", usernames)
    );
  }

  /**
   * Delete roles from a channel.
   * @param {string} channel
   * @param {string[]} roleNames
   */
  async deleteRoles(channel, roleNames) {
    return this._post(
      `/channel/deleterole/channel/${encodeURIComponent(channel)}/`,
      _encodeArray("roles", roleNames)
    );
  }

  // ─── Locations ─────────────────────────────────────────────────

  /**
   * Get GPS locations of users within a bounding box.
   * @param {object} [opts]
   * @param {number} [opts.northeast_lat]
   * @param {number} [opts.northeast_lng]
   * @param {number} [opts.southwest_lat]
   * @param {number} [opts.southwest_lng]
   * @param {string} [opts.name]   - Filter by username/display name
   * @param {string} [opts.filter] - "active" | "none"
   * @param {number} [opts.max]
   */
  async getLocations(opts = {}) {
    const qs = [];
    if (opts.northeast_lat !== undefined) {
      qs.push(`northeast[]=${opts.northeast_lat}&northeast[]=${opts.northeast_lng}`);
      qs.push(`southwest[]=${opts.southwest_lat}&southwest[]=${opts.southwest_lng}`);
    }
    if (opts.name) qs.push(`name=${encodeURIComponent(opts.name)}`);
    if (opts.filter) qs.push(`filter=${opts.filter}`);
    if (opts.max) qs.push(`max=${opts.max}`);
    const query = qs.length ? `?${qs.join("&")}` : "";
    return this._get(`/location/get${query}`);
  }

  /**
   * Get current or historical location for a user.
   * @param {string} username
   * @param {object} [opts]
   * @param {boolean} [opts.history]  - Include track data
   * @param {number}  [opts.start_ts] - History start (epoch)
   * @param {number}  [opts.end_ts]   - History end (epoch)
   * @param {string}  [opts.format]   - "geojson" for GeoJSON output
   */
  async getUserLocation(username, opts = {}) {
    let path = `/location/getuser/${encodeURIComponent(username)}`;
    if (opts.history) path += "/history";
    const qs = [];
    if (opts.start_ts) qs.push(`start_ts=${opts.start_ts}`);
    if (opts.end_ts) qs.push(`end_ts=${opts.end_ts}`);
    if (opts.format) qs.push(`format=${opts.format}`);
    if (qs.length) path += `?${qs.join("&")}`;
    return this._get(path);
  }

  // ─── History & Media ───────────────────────────────────────────

  /**
   * Query message history metadata.
   * @param {object} [opts]
   * @param {string}  [opts.sender]      - Filter by sender
   * @param {string}  [opts.recipient]   - Filter by recipient
   * @param {string}  [opts.via_channel] - Filter by channel
   * @param {boolean} [opts.is_channel]  - true=channel only, false=DM only
   * @param {string}  [opts.type]        - "voice" | "image" | "call_alert"
   * @param {string}  [opts.text]        - Search call alert text
   * @param {number}  [opts.start_ts]    - Epoch start
   * @param {number}  [opts.end_ts]      - Epoch end
   * @param {number}  [opts.max]         - Max results (default 100)
   * @param {number}  [opts.start]       - Pagination offset
   * @param {string}  [opts.sort]        - Sort field
   * @param {string}  [opts.sort_order]  - "asc" | "desc"
   */
  async getHistory(opts = {}) {
    const params = new URLSearchParams();
    const fields = [
      "sender", "recipient", "via_channel", "is_channel", "type",
      "text", "start_ts", "end_ts", "max", "start", "sort", "sort_order",
    ];
    for (const f of fields) {
      if (opts[f] !== undefined && opts[f] !== null) {
        params.set(f, String(opts[f]));
      }
    }
    return this._post("/history/getmetadata", params.toString());
  }

  /**
   * Get download URL for a media item (voice MP3 or image JPG).
   * @param {string} mediaKey - From getHistory response
   */
  async getMedia(mediaKey) {
    return this._get(`/history/getmedia/key/${encodeURIComponent(mediaKey)}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function _encodeArray(prefix, items) {
  return items.map((v) => `${prefix}[]=${encodeURIComponent(v)}`).join("&");
}

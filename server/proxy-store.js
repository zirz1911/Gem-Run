import {decryptSecret, encryptSecret} from "./crypto.js";

const activeStatuses = ["queued", "submitted", "running"];
const runColumns = new Set(["workflow_id", "workflow_name", "profile_mode", "profile_id", "created_profile_id", "proxy_id", "cleanup_requested", "status", "remote_run_id", "error_message", "cleanup_status", "batch_id", "batch_index", "batch_total", "started_at", "finished_at"]);

function now() { return new Date().toISOString(); }

function normalizeTimestamp(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("Timestamp must be an ISO string");
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Timestamp must be an ISO string");
  return timestamp.toISOString();
}

function validHost(host) {
  return host.length <= 253 && host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function parseProxy(rawProxy) {
  if (typeof rawProxy !== "string") throw new Error("Proxy must be a string");
  const value = rawProxy.trim();
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const match = normalized.match(/^([a-z][a-z0-9+.-]*):\/\/([^/:\s]+):(\d+)(?::([^:\s]+):([^:\s]+))?$/i);
  if (!match) throw new Error("Proxy must include host, port, and complete credentials");
  const [, scheme, host, portText, username, password] = match;
  if (!validHost(host)) throw new Error("Proxy host is invalid");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Proxy port must be between 1 and 65535");
  return {scheme: scheme.toLowerCase(), host: host.toLowerCase(), port, username: username ?? null, password: password ?? null};
}

function proxyCredentials(row, key) {
  if (!row.password_ciphertext) return {username: null, password: null};
  return JSON.parse(decryptSecret({iv: row.iv, auth_tag: row.auth_tag, ciphertext: row.password_ciphertext}, key));
}

function fullProxy(row, key) {
  return {...row, ...proxyCredentials(row, key), enabled: Boolean(row.enabled)};
}

function maskedProxy(row) {
  return {id: row.id, label: row.label, scheme: row.scheme, host: row.host, port: row.port, enabled: Boolean(row.enabled), last_used_at: row.last_used_at};
}

function runRecord(row) {
  return row ? {...row, cleanup_requested: Boolean(row.cleanup_requested)} : null;
}

export class ProxyStore {
  constructor(db, key) {
    this.db = db;
    this.key = key;
  }

  create(input) {
    const proxy = parseProxy(input.raw_proxy);
    const label = String(input.label || "").trim();
    if (!label) throw new Error("Proxy label is required");
    const encrypted = proxy.username === null ? null : encryptSecret(JSON.stringify({username: proxy.username, password: proxy.password}), this.key);
    const timestamp = now();
    const result = this.db.prepare(`INSERT INTO proxies (label, scheme, host, port, password_ciphertext, iv, auth_tag, enabled, created_at, updated_at)
      VALUES (@label, @scheme, @host, @port, @password_ciphertext, @iv, @auth_tag, @enabled, @created_at, @updated_at)`).run({
      ...proxy, label, password_ciphertext: encrypted?.ciphertext ?? null, iv: encrypted?.iv ?? null, auth_tag: encrypted?.auth_tag ?? null,
      enabled: input.enabled === false ? 0 : 1, created_at: timestamp, updated_at: timestamp
    });
    return this.get(result.lastInsertRowid);
  }

  list() { return this.db.prepare("SELECT id, label, scheme, host, port, enabled, last_used_at FROM proxies ORDER BY id").all().map(maskedProxy); }

  get(id) {
    const row = this.db.prepare("SELECT * FROM proxies WHERE id = ?").get(id);
    return row ? fullProxy(row, this.key) : null;
  }

  setEnabled(id, enabled) {
    return this.db.prepare("UPDATE proxies SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), id).changes > 0;
  }

  setLabel(id, label) {
    const value = String(label || "").trim();
    if (!value) throw new Error("Proxy label is required");
    return this.db.prepare("UPDATE proxies SET label = ?, updated_at = ? WHERE id = ?").run(value, now(), id).changes > 0;
  }

  replaceCredentials(id, rawProxy) {
    const proxy = parseProxy(rawProxy);
    const encrypted = proxy.username === null ? null : encryptSecret(JSON.stringify({username: proxy.username, password: proxy.password}), this.key);
    const result = this.db.prepare(`UPDATE proxies SET scheme = @scheme, host = @host, port = @port, password_ciphertext = @password_ciphertext,
      iv = @iv, auth_tag = @auth_tag, updated_at = @updated_at WHERE id = @id`).run({
      ...proxy, id, password_ciphertext: encrypted?.ciphertext ?? null, iv: encrypted?.iv ?? null, auth_tag: encrypted?.auth_tag ?? null, updated_at: now()
    });
    return result.changes > 0 ? this.get(id) : null;
  }

  remove(id) { return this.db.prepare("DELETE FROM proxies WHERE id = ?").run(id).changes > 0; }

  pickRandomEnabled(excludedIds = []) {
    const pick = this.db.transaction(() => {
      const excluded = [...new Set(excludedIds.map((id) => Number(id)).filter(Number.isInteger))];
      const placeholders = excluded.map(() => "?").join(", ");
      const row = this.db.prepare(`SELECT * FROM proxies WHERE enabled = 1${placeholders ? ` AND id NOT IN (${placeholders})` : ""} ORDER BY RANDOM() LIMIT 1`).get(...excluded);
      if (!row) return null;
      const timestamp = now();
      this.db.prepare("UPDATE proxies SET last_used_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, row.id);
      return this.db.prepare("SELECT * FROM proxies WHERE id = ?").get(row.id);
    });
    const row = pick();
    return row ? fullProxy(row, this.key) : null;
  }
}

export class RunStore {
  constructor(db) { this.db = db; }

  create(input) {
    const timestamp = now();
    const values = {
      workflow_id: input.workflow_id, workflow_name: input.workflow_name ?? null, profile_mode: input.profile_mode,
      profile_id: input.profile_id ?? null, created_profile_id: input.created_profile_id ?? null, proxy_id: input.proxy_id ?? null,
      cleanup_requested: input.cleanup_requested ? 1 : 0, status: input.status, remote_run_id: input.remote_run_id ?? null,
      error_message: input.error_message ?? null, cleanup_status: input.cleanup_status, batch_id: input.batch_id ?? null,
      batch_index: input.batch_index ?? null, batch_total: input.batch_total ?? null, created_at: timestamp,
      started_at: normalizeTimestamp(input.started_at), finished_at: normalizeTimestamp(input.finished_at)
    };
    const result = this.db.prepare(`INSERT INTO runs (${Object.keys(values).join(", ")}) VALUES (${Object.keys(values).map((key) => `@${key}`).join(", ")})`).run(values);
    return this.get(result.lastInsertRowid);
  }

  get(id) { return runRecord(this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id)); }

  listRecent(limit) {
    const count = Math.max(1, Math.floor(Number(limit) || 1));
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?").all(count).map(runRecord);
  }

  update(id, patch) {
    const entries = Object.entries(patch).filter(([key]) => runColumns.has(key));
    if (!entries.length) return this.get(id);
    const values = Object.fromEntries(entries.map(([key, value]) => [key,
      key === "cleanup_requested" ? Number(Boolean(value)) : ["started_at", "finished_at"].includes(key) ? normalizeTimestamp(value) : value
    ]));
    values.id = id;
    const statement = entries.map(([key]) => `${key} = @${key}`).join(", ");
    this.db.prepare(`UPDATE runs SET ${statement} WHERE id = @id`).run(values);
    return this.get(id);
  }

  findActive() {
    return runRecord(this.db.prepare(`SELECT * FROM runs WHERE status IN (${activeStatuses.map(() => "?").join(", ")}) ORDER BY created_at LIMIT 1`).get(...activeStatuses));
  }

  findRecoverable() {
    return runRecord(this.db.prepare(`SELECT * FROM runs WHERE status IN (${activeStatuses.map(() => "?").join(", ")})
      OR (cleanup_status = 'pending' AND cleanup_requested = 1 AND created_profile_id IS NOT NULL) ORDER BY created_at LIMIT 1`).get(...activeStatuses));
  }
}

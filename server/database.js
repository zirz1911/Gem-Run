import Database from "better-sqlite3";

export function openDatabase(filename) {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      scheme TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username_ciphertext TEXT,
      password_ciphertext TEXT,
      iv TEXT,
      auth_tag TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT,
      profile_mode TEXT NOT NULL,
      profile_id TEXT,
      created_profile_id TEXT,
      proxy_id INTEGER,
      cleanup_requested INTEGER NOT NULL,
      status TEXT NOT NULL,
      remote_run_id TEXT,
      error_message TEXT,
      cleanup_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  return db;
}

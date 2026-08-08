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
      close_browser INTEGER NOT NULL DEFAULT 0,
      delete_profile INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      remote_run_id TEXT,
      error_message TEXT,
      cleanup_status TEXT NOT NULL,
      batch_id TEXT,
      batch_index INTEGER,
      batch_total INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      schedule_id INTEGER,
      schedule_name TEXT,
      configured_profile_count INTEGER,
      profile_count_mode TEXT,
      actual_profile_count INTEGER,
      schedule_execution_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      name TEXT PRIMARY KEY,
      value_ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      timezone TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      run_date TEXT,
      run_time TEXT NOT NULL,
      weekdays TEXT NOT NULL DEFAULT '[]',
      payload_ciphertext TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      next_run_at TEXT,
      dispatch_state TEXT NOT NULL DEFAULT 'idle',
      claimed_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(runs)").all().map(({name}) => name));
  for (const [name, definition] of [["batch_id", "TEXT"], ["batch_index", "INTEGER"], ["batch_total", "INTEGER"], ["close_browser", "INTEGER NOT NULL DEFAULT 0"], ["delete_profile", "INTEGER NOT NULL DEFAULT 0"], ["source", "TEXT NOT NULL DEFAULT 'manual'"], ["schedule_id", "INTEGER"], ["schedule_name", "TEXT"], ["configured_profile_count", "INTEGER"], ["profile_count_mode", "TEXT"], ["actual_profile_count", "INTEGER"], ["schedule_execution_id", "TEXT"]]) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
      if (name === "close_browser" || name === "delete_profile") db.exec(`UPDATE runs SET ${name} = cleanup_requested`);
    }
  }
  return db;
}

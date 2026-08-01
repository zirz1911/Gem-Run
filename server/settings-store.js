import {decryptSecret, encryptSecret} from "./crypto.js";

const settingNames = new Set(["cloud_device_id", "cloud_soft_id", "cloud_token"]);

function now() { return new Date().toISOString(); }

export class SettingsStore {
  constructor(db, key) { this.db = db; this.key = key; }

  getAll() {
    return Object.fromEntries(this.db.prepare("SELECT name, value_ciphertext, iv, auth_tag FROM settings").all().map((row) => [
      row.name, decryptSecret({ciphertext: row.value_ciphertext, iv: row.iv, auth_tag: row.auth_tag}, this.key)
    ]));
  }

  setMany(values) {
    const entries = Object.entries(values).filter(([name, value]) => settingNames.has(name) && typeof value === "string");
    const save = this.db.transaction(() => {
      for (const [name, value] of entries) {
        const encrypted = encryptSecret(value.trim(), this.key);
        this.db.prepare(`INSERT INTO settings (name, value_ciphertext, iv, auth_tag, updated_at)
          VALUES (@name, @value_ciphertext, @iv, @auth_tag, @updated_at)
          ON CONFLICT(name) DO UPDATE SET value_ciphertext = excluded.value_ciphertext, iv = excluded.iv,
            auth_tag = excluded.auth_tag, updated_at = excluded.updated_at`).run({
          name, value_ciphertext: encrypted.ciphertext, iv: encrypted.iv, auth_tag: encrypted.auth_tag, updated_at: now()
        });
      }
    });
    save();
    return this.getAll();
  }
}

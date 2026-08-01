import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {openDatabase} from "../server/database.js";
import {SettingsStore} from "../server/settings-store.js";

test("settings are encrypted and can be reloaded", () => {
  const directory = mkdtempSync(join(tmpdir(), "gem-run-settings-"));
  const filename = join(directory, "gem-run.sqlite");
  const key = Buffer.alloc(32, 8);
  try {
    const db = openDatabase(filename);
    const store = new SettingsStore(db, key);
    store.setMany({cloud_token: "cloud-secret", ignored: "not saved"});
    assert.deepEqual(store.getAll(), {cloud_token: "cloud-secret"});
    db.close();
    assert.equal(readFileSync(filename).includes(Buffer.from("cloud-secret")), false);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

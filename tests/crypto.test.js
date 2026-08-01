import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {loadOrCreateEncryptionKey} from "../server/crypto.js";

test("encryption key is generated once and reused from disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "gem-run-key-"));
  const filename = join(directory, ".key");
  try {
    const first = loadOrCreateEncryptionKey("", filename);
    const second = loadOrCreateEncryptionKey("", filename);
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    assert.equal(readFileSync(filename, "utf8").trim().length > 0, true);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {decryptSecret, encryptSecret} from "../server/crypto.js";
import {openDatabase} from "../server/database.js";
import {parseProxy, ProxyStore, RunStore} from "../server/proxy-store.js";

const key = Buffer.alloc(32, 7);

function makeStores(t) {
  const directory = mkdtempSync(join(tmpdir(), "gem-run-"));
  const filename = join(directory, "gem-run.sqlite");
  const db = openDatabase(filename);
  t.after(() => {
    db.close();
    rmSync(directory, {recursive: true, force: true});
  });
  return {filename, proxyStore: new ProxyStore(db, key), runStore: new RunStore(db)};
}

test("proxy credentials round-trip without storing plaintext", () => {
  const proxy = parseProxy("http://147.15.196.136:30955:CC:TOOD");
  const encrypted = encryptSecret(proxy.password, key);
  assert.equal(decryptSecret(encrypted, key), "TOOD");
  assert.equal(encrypted.ciphertext.includes("TOOD"), false);
});

test("parseProxy normalizes supported proxy forms and rejects malformed values", () => {
  assert.deepEqual(parseProxy("proxy.example:8080"), {
    scheme: "http", host: "proxy.example", port: 8080, username: null, password: null
  });
  assert.deepEqual(parseProxy("HTTP://Proxy.EXAMPLE:8080"), {
    scheme: "http", host: "proxy.example", port: 8080, username: null, password: null
  });
  assert.deepEqual(parseProxy("socks5://proxy.example:1080:alice:secret"), {
    scheme: "socks5", host: "proxy.example", port: 1080, username: "alice", password: "secret"
  });
  for (const rawProxy of ["http://:8080", "http://-host:8080", "http://host:70000", "http://host:8000:alice"]) {
    assert.throws(() => parseProxy(rawProxy));
  }
});

test("openDatabase creates proxy and run tables", (t) => {
  const {filename} = makeStores(t);
  assert.equal(readFileSync(filename).subarray(0, 16).toString(), "SQLite format 3\u0000");
});

test("ProxyStore persists encrypted credentials and exposes only masked fields", (t) => {
  const {filename, proxyStore} = makeStores(t);
  const created = proxyStore.create({label: "Primary", raw_proxy: "http://proxy.example:8080:alice:secret", enabled: true});

  assert.deepEqual(proxyStore.list(), [{
    id: created.id, label: "Primary", scheme: "http", host: "proxy.example", port: 8080, enabled: true, last_used_at: null
  }]);
  assert.equal(proxyStore.get(created.id).username, "alice");
  assert.equal(proxyStore.get(created.id).password, "secret");
  assert.equal(readFileSync(filename).includes(Buffer.from("alice")), false);
  assert.equal(readFileSync(filename).includes(Buffer.from("secret")), false);

  proxyStore.setEnabled(created.id, false);
  assert.equal(proxyStore.list()[0].enabled, false);
  assert.equal(proxyStore.setLabel(created.id, "Renamed"), true);
  assert.equal(proxyStore.list()[0].label, "Renamed");
  proxyStore.replaceCredentials(created.id, "socks5://other.example:1080:bob:changed");
  const replaced = proxyStore.get(created.id);
  assert.equal(replaced.scheme, "socks5");
  assert.equal(replaced.host, "other.example");
  assert.equal(replaced.port, 1080);
  assert.equal(replaced.username, "bob");
  assert.equal(replaced.password, "changed");
  assert.equal(proxyStore.remove(created.id), true);
  assert.equal(proxyStore.get(created.id), null);
});

test("ProxyStore picks and marks an enabled proxy", (t) => {
  const {proxyStore} = makeStores(t);
  const disabled = proxyStore.create({label: "Disabled", raw_proxy: "http://one.example:8000", enabled: false});
  const enabled = proxyStore.create({label: "Enabled", raw_proxy: "http://two.example:8000:user:password", enabled: true});

  const picked = proxyStore.pickRandomEnabled();
  assert.equal(picked.id, enabled.id);
  assert.equal(picked.username, "user");
  assert.notEqual(proxyStore.list()[1].last_used_at, null);
  assert.equal(proxyStore.setEnabled(disabled.id, true), true);
});

test("RunStore creates, updates, finds active, and retains proxy references", (t) => {
  const {proxyStore, runStore} = makeStores(t);
  const proxy = proxyStore.create({label: "Primary", raw_proxy: "http://proxy.example:8080", enabled: true});
  const run = runStore.create({
    workflow_id: "workflow-1", workflow_name: "Workflow", profile_mode: "new", proxy_id: proxy.id,
    cleanup_requested: true, status: "queued", cleanup_status: "pending"
  });

  assert.equal(runStore.findActive().id, run.id);
  const updated = runStore.update(run.id, {status: "success", remote_run_id: "remote-1", finished_at: "2026-08-01T00:00:00.000Z"});
  assert.equal(updated.status, "success");
  assert.equal(runStore.findActive(), null);
  assert.equal(runStore.listRecent(1)[0].remote_run_id, "remote-1");
  proxyStore.remove(proxy.id);
  assert.equal(runStore.get(run.id).proxy_id, proxy.id);
});

test("RunStore accepts ISO timestamps and rejects non-ISO timestamps", (t) => {
  const {runStore} = makeStores(t);
  const input = {workflow_id: "workflow-1", profile_mode: "existing", cleanup_requested: false, status: "queued", cleanup_status: "not_requested"};

  assert.throws(() => runStore.create({...input, started_at: "soon"}), /ISO/);
  const run = runStore.create({...input, started_at: "2026-08-01T00:00:00.000Z"});
  assert.equal(run.started_at, "2026-08-01T00:00:00.000Z");
  assert.throws(() => runStore.update(run.id, {finished_at: "later"}), /ISO/);
  assert.equal(runStore.get(run.id).finished_at, null);
  assert.equal(runStore.update(run.id, {finished_at: "2026-08-01T01:00:00.000Z"}).finished_at, "2026-08-01T01:00:00.000Z");
});

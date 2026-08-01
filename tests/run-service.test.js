import assert from "node:assert/strict";
import test from "node:test";
import {RunService} from "../server/run-service.js";
import {normalizeRemoteStatus} from "../server/status.js";

function makeContext({remoteStatus = "success", hangStatus = false, deleteError, deleteErrors, runTimeoutSeconds = 30} = {}) {
  const records = new Map();
  let nextId = 1;
  const calls = [];
  const client = {
    calls,
    async createProfile(details) { calls.push({name: "createProfile", details}); return {data: {id: 99}}; },
    async executeCloud(details) { calls.push({name: "executeCloud", details}); return {data: {id: "remote-1", status: "submitted"}}; },
    async checkScriptStatus() { calls.push({name: "checkScriptStatus"}); return hangStatus ? new Promise(() => {}) : {data: {status: remoteStatus}}; },
    async closeProfile(profileId) { calls.push({name: "closeProfile", profileId}); },
    async deleteProfile(profileId) { calls.push({name: "deleteProfile", profileId}); const error = deleteErrors?.shift() ?? deleteError; if (error) throw error; }
  };
  const store = {
    create(input) { const run = {id: `run-${nextId++}`, ...input}; records.set(run.id, run); return {...run}; },
    get(id) { const run = records.get(String(id)); return run && {...run}; },
    updates: [],
    update(id, patch) { this.updates.push({...patch}); const run = {...records.get(String(id)), ...patch}; records.set(String(id), run); return {...run}; },
    findActive() { return [...records.values()].find((run) => ["queued", "submitted", "running"].includes(run.status)) ?? null; }
  };
  const proxyStore = {picked: 0, pickRandomEnabled() { this.picked += 1; return {id: 7, scheme: "http", host: "proxy.example", port: 8000, username: "alice", password: "secret"}; }};
  let tick = 0;
  const service = new RunService({
    gemloginClient: client, proxyStore, runStore: store,
    clock: () => new Date(tick * 1000), sleep: (seconds) => {
      let timer;
      const wait = new Promise((resolve) => { timer = setImmediate(() => { tick += seconds / 1000; resolve(); }); });
      wait.cancel = () => clearImmediate(timer);
      return wait;
    }, runTimeoutSeconds
  });
  return {client, proxyStore, store, service, drain: () => service.drain()};
}

test("normalizes supported remote status shapes", () => {
  assert.equal(normalizeRemoteStatus({data: {status: "success"}}), "success");
  assert.equal(normalizeRemoteStatus({status: "running"}), "running");
  assert.equal(normalizeRemoteStatus({data: {status: "unknown"}}), "submitted");
});

test("existing profile never calls create or delete", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
  await ctx.drain();
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["executeCloud", "checkScriptStatus"]);
  assert.equal(ctx.store.get("run-1").cleanup_status, "not_requested");
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "success", "done"]);
});

test("new profile selects a proxy, creates, executes, and deletes on success", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "random", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.proxyStore.picked, 1);
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["createProfile", "executeCloud", "checkScriptStatus", "closeProfile", "deleteProfile"]);
  assert.equal(ctx.store.get("run-1").status, "done");
});

test("new profile deletes after workflow failure", async () => {
  const ctx = makeContext({remoteStatus: "failed"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").status, "done");
  assert.equal(ctx.store.get("run-1").error_message, "remote workflow failed");
  assert.equal(ctx.client.calls.at(-1).name, "deleteProfile");
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "failed", "done"]);
});

test("new profile deletes after timeout", async () => {
  const ctx = makeContext({remoteStatus: "running", runTimeoutSeconds: 0});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "workflow timed out");
  assert.equal(ctx.client.calls.at(-1).name, "deleteProfile");
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "timeout", "done"]);
});

test("a hung status request reaches its deadline and cleans the created profile", {timeout: 100}, async () => {
  const ctx = makeContext({hangStatus: true, runTimeoutSeconds: 1});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "workflow timed out");
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["createProfile", "executeCloud", "checkScriptStatus", "closeProfile", "deleteProfile"]);
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "timeout", "done"]);
});

test("cleanup failure preserves the original run result and retries deletion once", async () => {
  const ctx = makeContext({remoteStatus: "failed", deleteError: new Error("delete failed")});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "remote workflow failed");
  assert.equal(ctx.store.get("run-1").cleanup_status, "failed");
  assert.equal(ctx.client.calls.filter((call) => call.name === "deleteProfile").length, 2);
});

test("a successful deletion retry completes cleanup", async () => {
  const ctx = makeContext({deleteErrors: [new Error("temporary delete failure")]});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").cleanup_status, "done");
  assert.equal(ctx.client.calls.filter((call) => call.name === "deleteProfile").length, 2);
});

test("second active run is rejected", async () => {
  const ctx = makeContext({remoteStatus: "running"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
  await assert.rejects(() => ctx.service.start({workflow_id: "wf-2", profile_mode: "existing", profile_id: 64, cleanup_requested: false}), /active run/);
});

test("validates profile mode and never stores a manual proxy", async () => {
  const ctx = makeContext();
  await assert.rejects(() => ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", cleanup_requested: false}), /profile_id/);
  await assert.rejects(() => ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: true}), /cleanup/);
  await assert.rejects(() => ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "manual", raw_proxy: "bad", cleanup_requested: false}), /Proxy/);
  assert.equal(ctx.store.findActive(), null);
});

test("recovers an active run and cleans its recorded new profile", async () => {
  const ctx = makeContext();
  ctx.store.create({workflow_id: "wf-1", profile_mode: "new", created_profile_id: 99, cleanup_requested: true, status: "running", cleanup_status: "pending"});
  await ctx.service.recover();
  assert.equal(ctx.store.get("run-1").status, "failed");
  assert.equal(ctx.store.get("run-1").error_message, "run interrupted by restart");
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["closeProfile", "deleteProfile"]);
});

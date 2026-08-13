import assert from "node:assert/strict";
import test from "node:test";
import {RunService} from "../server/run-service.js";
import {normalizeRemoteStatus} from "../server/status.js";

function makeContext({remoteStatus = "success", remotePayload, runningPolls = 0, statusSequences = {}, hangStatus = false, hangCreate = false, hangSubmit = false, executeError, deleteError, deleteErrors, runTimeoutSeconds = 30, executionDelay = 0, realTime = false, gemloginExecutionMode = "cloud"} = {}) {
  const records = new Map();
  let nextId = 1;
  let nextProfileId = 98;
  let activeExecutions = 0;
  let maxActiveExecutions = 0;
  const statusChecks = new Map();
  const calls = [];
  const client = {
    calls,
    async createProfile(details, options = {}) { calls.push({name: "createProfile", details, signal: options.signal}); return hangCreate ? new Promise(() => {}) : {data: {id: ++nextProfileId}}; },
    async startProfile(profileId, options = {}) { calls.push({name: "startProfile", profileId, signal: options.signal}); },
    async refreshProfileList(options = {}) { calls.push({name: "refreshProfileList", signal: options.signal}); },
    async executeLocal(details, options = {}) {
      calls.push({name: "executeLocal", details, signal: options.signal});
      if (hangSubmit) return new Promise((resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
      return {success: true, id: "wf-1"};
    },
    async executeCloud(details, options = {}) {
      calls.push({name: "executeCloud", details, signal: options.signal});
      if (executeError) throw executeError;
      if (hangSubmit) return new Promise((resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {once: true}));
      if (executionDelay) { activeExecutions += 1; maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions); await new Promise((resolve) => setTimeout(resolve, executionDelay)); activeExecutions -= 1; }
      return {data: {id: "remote-1", status: "submitted"}};
    },
    async checkScriptStatus(_workflowId, profileId) {
      calls.push({name: "checkScriptStatus", profileId: String(profileId)});
      if (hangStatus) return new Promise(() => {});
      const key = String(profileId);
      const checks = statusChecks.get(key) ?? 0;
      statusChecks.set(key, checks + 1);
      const sequence = statusSequences[key];
      if (sequence?.length) return sequence[Math.min(checks, sequence.length - 1)];
      return checks < runningPolls ? {data: {status: "running"}} : (remotePayload ?? {data: {status: remoteStatus}});
    },
    async closeProfile(profileId) { calls.push({name: "closeProfile", profileId}); },
    async deleteProfile(profileId) { calls.push({name: "deleteProfile", profileId}); const error = deleteErrors?.shift() ?? deleteError; if (error) throw error; }
  };
  const store = {
    create(input) { const run = {id: `run-${nextId++}`, ...input}; records.set(run.id, run); return {...run}; },
    get(id) { const run = records.get(String(id)); return run && {...run}; },
    updates: [],
    update(id, patch) { this.updates.push({...patch}); const run = {...records.get(String(id)), ...patch}; records.set(String(id), run); return {...run}; },
    findActive() { return [...records.values()].find((run) => ["queued", "submitted", "running", "cancelling"].includes(run.status)) ?? null; },
    findRecoverable() { return [...records.values()].find((run) => ["queued", "submitted", "running", "cancelling"].includes(run.status) || (run.cleanup_status === "pending" && run.created_profile_id)) ?? null; },
    listBatch(batchId) { return [...records.values()].filter((run) => run.batch_id === batchId).map((run) => ({...run})); }
  };
  const proxyStore = {picked: 0, pickRandomEnabled() { this.picked += 1; return {id: 7, scheme: "http", host: "proxy.example", port: 8000, username: "alice", password: "secret"}; }};
  let tick = 0;
  const realSleep = (milliseconds) => {
    let timer;
    const wait = new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); });
    wait.cancel = () => clearTimeout(timer);
    return wait;
  };
  const service = new RunService({
    gemloginClient: client, proxyStore, runStore: store,
    clock: realTime ? () => new Date() : () => new Date(tick * 1000), sleep: realTime ? realSleep : (seconds) => {
      let timer;
      const wait = new Promise((resolve) => { timer = setImmediate(() => { tick += seconds / 1000; resolve(); }); });
      wait.cancel = () => clearImmediate(timer);
      return wait;
    }, runTimeoutSeconds, gemloginExecutionMode
  });
  return {client, proxyStore, store, service, drain: () => service.drain(), get maxActiveExecutions() { return maxActiveExecutions; }};
}

test("normalizes supported remote status shapes", () => {
  assert.equal(normalizeRemoteStatus({data: {status: "success"}}), "success");
  assert.equal(normalizeRemoteStatus({status: "running"}), "running");
  assert.equal(normalizeRemoteStatus({data: {status: "unknown"}}), "submitted");
  assert.equal(normalizeRemoteStatus({is_running: true, message: "Script is running"}), "running");
  assert.equal(normalizeRemoteStatus({is_running: false, message: "Script is not running"}), "not_running");
  assert.equal(normalizeRemoteStatus({is_running: false, message: "Script failed"}), "failed");
});

test("existing profile never calls create or delete", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
  await ctx.drain();
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["executeCloud", "checkScriptStatus"]);
  assert.equal(ctx.store.get("run-1").cleanup_status, "not_requested");
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "success", "done"]);
});

test("existing profile batch runs every selected profile", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  const batch = await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_ids: [63, 64]});
  await ctx.drain();
  assert.equal(batch.runs.length, 2);
  assert.deepEqual(ctx.client.calls.filter(({name}) => name === "executeCloud").map(({details}) => details.profileId), ["63", "64"]);
  assert.deepEqual([1, 2].map((id) => ctx.store.get(`run-${id}`).status), ["done", "done"]);
});

test("queued batch runs get a full timeout after their worker starts", async () => {
  const ctx = makeContext({runningPolls: 1, runTimeoutSeconds: 3});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_ids: [61, 62, 63, 64]});
  await ctx.drain();
  assert.deepEqual([1, 2, 3, 4].map((id) => ctx.store.get(`run-${id}`).error_message), [null, null, null, null]);
});

test("slow Local workflow keeps its worker beyond the startup window", async () => {
  const notRunning = {is_running: false, message: "Script is not running"};
  const running = {is_running: true, message: "Script is running"};
  const ctx = makeContext({
    gemloginExecutionMode: "local",
    runTimeoutSeconds: 30,
    statusSequences: {
      61: [...Array(9).fill(notRunning), running, notRunning],
      62: [running, notRunning]
    }
  });

  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_ids: [61, 62], execution_mode: "parallel", max_concurrency: 1});
  await ctx.drain();

  const first = ctx.store.get("run-1");
  const second = ctx.store.get("run-2");
  assert.equal(first.error_message, null);
  assert.equal(second.error_message, null);
  assert.ok(new Date(second.started_at) - new Date(first.started_at) >= 20_000);
});

test("Local workflow that never starts waits for the run deadline", async () => {
  const ctx = makeContext({
    gemloginExecutionMode: "local",
    remotePayload: {is_running: false, message: "Script is not running"},
    runTimeoutSeconds: 20
  });

  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 61});
  await ctx.drain();

  assert.equal(ctx.store.get("run-1").error_message, "workflow timed out");
});

test("local execution mode submits existing and new profiles through Local API", async () => {
  const existing = makeContext({gemloginExecutionMode: "local"});
  await existing.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, parameter: {keyword_file: "keywords.txt"}});
  await existing.drain();
  assert.deepEqual(existing.client.calls.map(({name}) => name), ["executeLocal", "checkScriptStatus"]);

  const created = makeContext({gemloginExecutionMode: "local"});
  await created.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", parameter: {target_site: "example.com"}, cleanup_requested: true});
  await created.drain();
  assert.deepEqual(created.client.calls.map(({name}) => name), ["createProfile", "startProfile", "refreshProfileList", "executeLocal", "checkScriptStatus", "closeProfile", "deleteProfile", "refreshProfileList"]);
});

test("existing profile can close its browser without cleanup", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, close_browser: true, delete_profile: false});
  await ctx.drain();
  assert.equal(ctx.client.calls.find((call) => call.name === "executeCloud").details.closeBrowser, true);
  assert.equal(ctx.client.calls.some((call) => ["closeProfile", "deleteProfile"].includes(call.name)), false);
});

test("new profile separates browser close from profile deletion", async () => {
  const closeOnly = makeContext({remoteStatus: "success"});
  await closeOnly.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", close_browser: true, delete_profile: false});
  await closeOnly.drain();
  assert.equal(closeOnly.client.calls.find((call) => call.name === "executeCloud").details.closeBrowser, true);
  assert.equal(closeOnly.client.calls.some((call) => call.name === "deleteProfile"), false);

  const deleteOnly = makeContext({remoteStatus: "success"});
  await deleteOnly.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", close_browser: false, delete_profile: true});
  await deleteOnly.drain();
  assert.equal(deleteOnly.client.calls.find((call) => call.name === "executeCloud").details.closeBrowser, true);
  assert.equal(deleteOnly.client.calls.filter((call) => call.name === "deleteProfile").length, 1);
});

test("new profile uses a fixed macOS fingerprint and Thailand location", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "random", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.proxyStore.picked, 1);
  assert.deepEqual(ctx.client.calls.find((call) => call.name === "createProfile").details, {
    profile_name: "Temp",
    group_id: "1",
    raw_proxy: "http://proxy.example:8000:alice:secret",
    os: {type: "macOS", version: "macos13"},
    country: "Thailand"
  });
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["createProfile", "startProfile", "refreshProfileList", "executeCloud", "checkScriptStatus", "closeProfile", "deleteProfile", "refreshProfileList"]);
  assert.equal(ctx.store.get("run-1").status, "done");
});

test("new profile batch creates separate profiles and respects parallel concurrency", async () => {
  const ctx = makeContext({executionDelay: 10, realTime: true});
  const batch = await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Batch", group_id: "1", proxy_mode: "none", cleanup_requested: true, repeat_count: 3, execution_mode: "parallel", max_concurrency: 2});
  await ctx.drain();
  assert.equal(batch.runs.length, 3);
  assert.equal(ctx.maxActiveExecutions, 2);
  assert.deepEqual(ctx.client.calls.filter((call) => call.name === "createProfile").map((call) => call.details.profile_name), ["Batch-01", "Batch-02", "Batch-03"]);
  assert.deepEqual([1, 2, 3].map((id) => ctx.store.get(`run-${id}`).status), ["done", "done", "done"]);
  assert.equal(ctx.client.calls.filter((call) => call.name === "deleteProfile").length, 3);
});

test("batch settings are only valid for new profiles", async () => {
  const ctx = makeContext();
  await assert.rejects(() => ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false, repeat_count: 2}), /repeat_count/);
  await assert.rejects(() => ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Batch", group_id: "1", proxy_mode: "none", repeat_count: 2, execution_mode: "parallel", max_concurrency: 0}), /max_concurrency/);
});

test("new profile batches accept 500 rounds and reject 501", () => {
  const ctx = makeContext();
  assert.doesNotThrow(() => ctx.service.validate({workflow_id: "wf-1", profile_mode: "new", profile_name: "Batch", group_id: "1", proxy_mode: "none", repeat_count: 500}));
  assert.throws(() => ctx.service.validate({workflow_id: "wf-1", profile_mode: "new", profile_name: "Batch", group_id: "1", proxy_mode: "none", repeat_count: 501}), /repeat_count/);
});

test("manual batch concurrency accepts 500 and cannot exceed the batch size", () => {
  const ctx = makeContext();
  const newBatch = {workflow_id: "wf-1", profile_mode: "new", profile_name: "Batch", group_id: "1", proxy_mode: "none", execution_mode: "parallel"};
  assert.doesNotThrow(() => ctx.service.validate({...newBatch, repeat_count: 500, max_concurrency: 500}));
  assert.throws(() => ctx.service.validate({...newBatch, repeat_count: 500, max_concurrency: 501}), /max_concurrency/);
  assert.throws(() => ctx.service.validate({...newBatch, repeat_count: 3, max_concurrency: 4}), /profile count/);
  assert.doesNotThrow(() => ctx.service.validate({workflow_id: "wf-1", profile_mode: "existing", profile_ids: [1, 2, 3], execution_mode: "parallel", max_concurrency: 3}));
});

test("does not treat an unstarted workflow as success", async () => {
  const ctx = makeContext({remotePayload: {is_running: false, message: "Script is not running"}, runTimeoutSeconds: 20});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "workflow did not start");
});

test("new profile deletes after workflow failure", async () => {
  const ctx = makeContext({remoteStatus: "failed"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").status, "done");
  assert.equal(ctx.store.get("run-1").error_message, "remote workflow failed");
  assert.equal(ctx.client.calls.filter((call) => call.name === "deleteProfile").at(-1).name, "deleteProfile");
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "failed", "done"]);
});

test("stores the GemLogin rejection message", async () => {
  const ctx = makeContext({executeError: new Error("GemLogin request failed: Invalid type for parameter: keyword_file")});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none"});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "GemLogin request failed: Invalid type for parameter: keyword_file");
});

test("new profile deletes after timeout", async () => {
  const ctx = makeContext({remoteStatus: "running", runTimeoutSeconds: 0.001});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "workflow timed out");
  assert.equal(ctx.client.calls.filter((call) => call.name === "deleteProfile").at(-1).name, "deleteProfile");
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "running", "timeout", "done"]);
});

test("a hung status request reaches its deadline and cleans the created profile", {timeout: 100}, async () => {
  const ctx = makeContext({hangStatus: true, runTimeoutSeconds: 1});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "workflow timed out");
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["createProfile", "startProfile", "refreshProfileList", "executeCloud", "checkScriptStatus", "closeProfile", "deleteProfile", "refreshProfileList"]);
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["submitted", "timeout", "done"]);
});

test("a hung profile creation is aborted at the absolute deadline", {timeout: 100}, async () => {
  const ctx = makeContext({hangCreate: true, runTimeoutSeconds: 1});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "workflow timed out");
  assert.equal(ctx.client.calls[0].signal.aborted, true);
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["timeout", "done"]);
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

test("cancel aborts an active task and finishes it as cancelled", async () => {
  const ctx = makeContext({hangSubmit: true, realTime: true});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63});
  await new Promise(setImmediate);
  const cancelled = ctx.service.cancel("run-1");
  assert.equal(cancelled.status, "cancelling");
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").status, "done");
  assert.equal(ctx.store.get("run-1").error_message, "run cancelled");
  assert.equal(ctx.client.calls[0].signal.aborted, true);
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
  assert.equal(ctx.store.get("run-1").status, "done");
  assert.equal(ctx.store.get("run-1").error_message, "run interrupted by restart");
  assert.deepEqual(ctx.store.updates.filter(({status}) => status).map(({status}) => status), ["failed", "done"]);
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["closeProfile", "deleteProfile", "refreshProfileList"]);
});

test("recovers a terminal run whose temporary-profile cleanup is still pending", async () => {
  const ctx = makeContext();
  ctx.store.create({workflow_id: "wf-1", profile_mode: "new", created_profile_id: 99, cleanup_requested: true, status: "success", cleanup_status: "pending"});
  await ctx.service.recover();
  assert.equal(ctx.store.get("run-1").status, "done");
  assert.equal(ctx.store.get("run-1").cleanup_status, "done");
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["closeProfile", "deleteProfile", "refreshProfileList"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {createApp} from "../server/app.js";
import {randomBytes} from "node:crypto";
import {openDatabase} from "../server/database.js";
import {ScheduleStore} from "../server/schedule-store.js";

function makeApp({client = {}, proxyStore = {}, runStore = {}, runService = {}, settingsStore = null, scheduleStore = null, scheduler = null} = {}) {
  return createApp({
    config: {}, gemloginClient: {
      status: async () => ({token: "cloud-secret"}),
      listProfiles: async () => ({data: [{id: 63, name: "Profile", proxy: "http://alice:secret@proxy.example:8000", browser: "Chrome", status: "ready", token: "cloud-secret"}]}),
      listGroups: async () => ({data: [{id: 7, name: "Group", token: "cloud-secret"}]}),
      listWorkflows: async () => ({data: [{id: "wf-1", name: "Workflow", parameters: [{name: "api_token", default: "workflow-secret"}, {name: "limit", default: 2}], token: "cloud-secret"}]}),
      startProfile: async () => ({data: {debugger_address: "127.0.0.1:9222", name: "Chrome", version: "123", token: "cloud-secret"}}),
      ...client
    },
    proxyStore: {
      list: () => [{id: 1, label: "Primary", scheme: "http", host: "proxy.example", port: 8080, enabled: true, last_used_at: null, username: "alice", password: "secret"}],
      create: () => ({id: 2}), get: () => null, setEnabled: () => false, replaceCredentials: () => null, remove: () => false,
      ...proxyStore
    },
    runStore: {listRecent: () => [], get: () => null, ...runStore}, settingsStore,
    runService: {start: async (input) => ({id: 1, ...input, status: "queued"}), validate: () => {}, get: () => null, ...runService}, scheduleStore, scheduler
  });
}

test("settings save only returns configured flags", async () => {
  const values = {};
  const client = {cloudDeviceId: "", cloudSoftId: "", cloudToken: "", configureCloud(next) { Object.assign(this, next); }};
  const settingsStore = {setMany(next) { Object.assign(values, next); return values; }};
  const app = makeApp({client, settingsStore});
  const response = await request(app, "/api/settings", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({device_id: "device", soft_id: "1", token: "cloud-secret"})});
  assert.deepEqual(response, {status: 200, body: {cloud: {device_id: true, soft_id: true, token: true}}});
  assert.equal(JSON.stringify(response.body).includes("cloud-secret"), false);
  assert.deepEqual(values, {cloud_device_id: "device", cloud_soft_id: "1", cloud_token: "cloud-secret"});
});

async function request(app, path, options) {
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    return {status: response.status, body: await response.json()};
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("proxy routes return only masked proxy fields", async () => {
  const {status, body} = await request(makeApp(), "/api/proxies");
  assert.equal(status, 200);
  assert.deepEqual(body, [{id: 1, label: "Primary", scheme: "http", host: "proxy.example", port: 8080, enabled: true, last_used_at: null}]);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("proxy creation rejects invalid input with a static error", async () => {
  const {status, body} = await request(makeApp({proxyStore: {create: () => { throw new Error("Proxy host is invalid"); }}}), "/api/proxies", {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({label: "Primary", raw_proxy: "bad"})
  });
  assert.equal(status, 400);
  assert.deepEqual(body, {error: "Invalid proxy request"});
});

test("proxy update returns a masked row and missing proxies return 404", async () => {
  const proxy = {id: 1, label: "Renamed", scheme: "http", host: "proxy.example", port: 8080, enabled: false, last_used_at: null, password: "secret"};
  const app = makeApp({proxyStore: {
    list: () => [proxy], get: (id) => Number(id) === 1 ? proxy : null,
    setLabel: () => true, setEnabled: () => true
  }});
  const updated = await request(app, "/api/proxies/1", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({label: "Renamed", enabled: false})});
  assert.deepEqual(updated, {status: 200, body: {id: 1, label: "Renamed", scheme: "http", host: "proxy.example", port: 8080, enabled: false, last_used_at: null}});
  const missing = await request(app, "/api/proxies/99", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({enabled: true})});
  assert.deepEqual(missing, {status: 404, body: {error: "Proxy not found"}});
});

test("run route returns 202 and forwards only allowed fields", async () => {
  const received = {value: null};
  const runService = {async start(input) { received.value = input; return {id: 1, ...input, status: "queued"}; }, get: () => null};
  const {status, body} = await request(makeApp({runService}), "/api/runs", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false, ignored: "drop"})
  });
  assert.equal(status, 202);
  assert.deepEqual(received.value, {workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
  assert.deepEqual(body, {id: 1, workflow_id: "wf-1", workflow_name: null, profile_mode: "existing", profile_id: 63, created_profile_id: null, proxy_id: null, cleanup_requested: false, close_browser: false, delete_profile: false, status: "queued", error_message: null, cleanup_status: null, created_at: null, started_at: null, finished_at: null});
});

test("batch run route forwards repeat and concurrency settings", async () => {
  const received = {value: null};
  const runService = {async start(input) { received.value = input; return {batch_id: "batch-1", runs: []}; }, get: () => null};
  const {status, body} = await request(makeApp({runService}), "/api/runs", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({workflow_id: "wf-1", profile_mode: "new", profile_name: "Batch", group_id: "1", proxy_mode: "none", repeat_count: 3, execution_mode: "parallel", max_concurrency: 2})
  });
  assert.equal(status, 202);
  assert.deepEqual(received.value, {workflow_id: "wf-1", profile_mode: "new", profile_name: "Batch", group_id: "1", proxy_mode: "none", repeat_count: 3, execution_mode: "parallel", max_concurrency: 2});
  assert.deepEqual(body, {batch_id: "batch-1", runs: []});
});

test("run route forwards close and delete options", async () => {
  const received = {value: null};
  const runService = {async start(input) { received.value = input; return {id: 1, ...input, status: "queued"}; }, get: () => null};
  const {status} = await request(makeApp({runService}), "/api/runs", {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", close_browser: true, delete_profile: false})
  });
  assert.equal(status, 202);
  assert.equal(received.value.close_browser, true);
  assert.equal(received.value.delete_profile, false);
});

test("cancel route forwards the run id", async () => {
  const runService = {cancel: async (id) => ({id, workflow_id: "wf-1", profile_mode: "existing", status: "cancelling"}), get: () => null};
  const {status, body} = await request(makeApp({runService}), "/api/runs/1/cancel", {method: "POST"});
  assert.equal(status, 202);
  assert.equal(body.id, "1");
  assert.equal(body.status, "cancelling");
});

test("workflow route masks sensitive defaults and drops upstream fields", async () => {
  const {status, body} = await request(makeApp(), "/api/gemlogin/workflows");
  assert.equal(status, 200);
  assert.deepEqual(body, [{id: "wf-1", name: "Workflow", parameters: [{name: "api_token", default: "***"}, {name: "limit", default: 2}]}]);
  assert.equal(JSON.stringify(body).includes("workflow-secret"), false);
});

test("workflow route exposes GemLogin defaultValue fields", async () => {
  const {body} = await request(makeApp({client: {listWorkflows: async () => ({data: [{id: "wf-2", parameters: [{name: "path", defaultValue: "/tmp/input.txt"}, {name: "limit", defaultValue: 2}]}]})}}), "/api/gemlogin/workflows");
  assert.deepEqual(body[0].parameters, [{name: "path", default: "/tmp/input.txt"}, {name: "limit", default: 2}]);
});

test("workflow route masks auth, key, bearer, header, and config defaults", async () => {
  const {body} = await request(makeApp({client: {listWorkflows: async () => ({data: [{id: "wf-2", parameters: [
    {name: "auth", default: "auth-secret"}, {name: "access_key", default: "access-secret"},
    {name: "private_key", default: "private-secret"}, {name: "bearer", default: "bearer-secret"},
    {name: "headers", default: "header-secret"}, {name: "config", default: "config-secret"},
    {name: "retries", default: 3}
  ]}]})}}), "/api/gemlogin/workflows");
  assert.deepEqual(body[0].parameters.map(({name, default: value}) => [name, value]), [
    ["auth", "***"], ["access_key", "***"], ["private_key", "***"], ["bearer", "***"], ["headers", "***"], ["config", "***"], ["retries", 3]
  ]);
});

test("profile start returns only the CDP address and browser metadata", async () => {
  const {status, body} = await request(makeApp(), "/api/gemlogin/profiles/63/start", {method: "POST"});
  assert.equal(status, 200);
  assert.deepEqual(body, {cdp_address: "127.0.0.1:9222", browser: {name: "Chrome", version: "123"}});
  assert.equal(JSON.stringify(body).includes("cloud-secret"), false);
});

test("GemLogin failures are unavailable and active runs conflict", async () => {
  const unavailable = await request(makeApp({client: {listProfiles: async () => { throw new Error("upstream secret"); }}}), "/api/gemlogin/profiles");
  assert.deepEqual(unavailable, {status: 503, body: {error: "GemLogin unavailable", code: "gemlogin_unavailable"}});
  const conflict = await request(makeApp({runService: {start: async () => { throw new Error("an active run already exists"); }, get: () => null}}), "/api/runs", {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false})
  });
  assert.deepEqual(conflict, {status: 409, body: {error: "An active run already exists"}});
});

test("schedule routes create, toggle, and expose per-schedule history without payload secrets", async () => {
  const db = openDatabase(":memory:");
  const scheduleStore = new ScheduleStore(db, randomBytes(32), () => new Date("2026-08-08T00:00:00Z"));
  const runStore = {listRecent: () => [], get: () => null, listBySchedule: () => [{id: 9, workflow_id: "wf-1", profile_mode: "new", status: "done", source: "schedule", schedule_id: 1, actual_profile_count: 3, cleanup_status: "done"}]};
  const app = makeApp({scheduleStore, runStore});
  const created = await request(app, "/api/schedules", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: "Morning", timezone: "Asia/Bangkok", type: "daily", time: "09:30", run: {workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", profile_count: 5, profile_count_mode: "random", max_concurrency: 3, delete_profile: true, close_browser: true, parameter: {token: "secret"}}})});
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes("secret"), false);
  assert.deepEqual(scheduleStore.getWithPayload(1).run, {workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", profile_count: 5, profile_count_mode: "random", max_concurrency: 3, execution_mode: "parallel", repeat_count: 5, delete_profile: true, close_browser: true, parameter: {token: "secret"}});
  const invalidConcurrency = await request(app, "/api/schedules", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: "Invalid", timezone: "Asia/Bangkok", type: "daily", time: "09:30", run: {workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", profile_count: 2, max_concurrency: 3}})});
  assert.equal(invalidConcurrency.status, 400);
  const disabled = await request(app, "/api/schedules/1/disable", {method: "POST"});
  assert.equal(disabled.body.enabled, false);
  const history = await request(app, "/api/schedules/1/runs");
  assert.equal(history.body[0].actual_profile_count, 3);
});

import assert from "node:assert/strict";
import test from "node:test";
import {GemLoginClient} from "../server/gemlogin-client.js";

const jsonResponse = (body, status = 200, statusText = "OK") => new Response(JSON.stringify(body), {
  status,
  statusText,
  headers: {"content-type": "application/json"}
});

function makeClient(response = {success: true}) {
  const calls = [];
  return {
    calls,
    client: new GemLoginClient({
      baseUrl: "http://local.example/",
      cloudBase: "https://cloud.example/",
      cloudDeviceId: "device",
      cloudSoftId: "1",
      cloudToken: "secret",
      fetchImpl: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(response);
      }
    })
  };
}

test("local methods use the documented methods, paths, and encoded IDs", async () => {
  const {client, calls} = makeClient();

  await client.status();
  await client.listProfiles();
  await client.getProfile("a/b");
  await client.listGroups();
  await client.listWorkflows();
  await client.createProfile({name: "Temp"});
  await client.executeLocal({profileId: "a/b", workflowId: "workflow/a", parameter: {}, closeBrowser: false});
  await client.startProfile("a/b");
  await client.closeProfile("a/b");
  await client.deleteProfile("a/b");
  await client.checkProfileStatus("a/b");
  await client.checkScriptStatus("script/a", "profile/b");

  assert.deepEqual(calls.map(({url, options}) => [url, options.method, options.body]), [
    ["http://local.example/api/status", "GET", undefined],
    ["http://local.example/api/profiles", "GET", undefined],
    ["http://local.example/api/profile/a%2Fb", "GET", undefined],
    ["http://local.example/api/groups", "GET", undefined],
    ["http://local.example/api/scripts", "GET", undefined],
    ["http://local.example/api/profiles/create", "POST", '{"name":"Temp"}'],
    ["http://local.example/api/scripts/execute/workflow%2Fa", "POST", '{"profileId":["a/b"],"parameters":{},"closeBrowser":false}'],
    ["http://local.example/api/profiles/start/a%2Fb", "GET", undefined],
    ["http://local.example/api/profiles/close/a%2Fb", "GET", undefined],
    ["http://local.example/api/profiles/delete/a%2Fb", "GET", undefined],
    ["http://local.example/api/profiles/check-status/a%2Fb", "POST", undefined],
    ["http://local.example/api/scripts/check-status/script%2Fa", "POST", '{"profileId":"profile/b"}']
  ]);
});

test("optional abort signals are forwarded without changing existing method calls", async () => {
  const {client, calls} = makeClient();
  const signal = new AbortController().signal;
  await client.createProfile({name: "Temp"}, {signal});
  await client.executeCloud({profileId: 63, workflowId: "wf-1", parameter: {}, closeBrowser: false}, {signal});
  await client.checkScriptStatus("wf-1", 63, {signal});
  await client.closeProfile(63, {signal});
  await client.deleteProfile(63, {signal});
  assert.equal(calls.every(({options}) => options.signal === signal), true);
});

test("executeCloud sends the GemLogin webhook shape without returning its token", async () => {
  const {client, calls} = makeClient({success: true, run_id: "remote-1", token: "secret"});

  const result = await client.executeCloud({profileId: 63, workflowId: "wf-1", parameter: {}, closeBrowser: true});
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, "https://cloud.example/api/v2/execscript");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(body.profile_id, ["63"]);
  assert.equal(body.workflow_id, "wf-1");
  assert.equal(body.close_browser, true);
  assert.equal(body.token, "secret");
  assert.equal("parameters" in body, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("executeCloud rejects a cloud response whose nested result failed", async () => {
  const {client} = makeClient({success: true, message: "Execute successfully", data: JSON.stringify({success: false, message: "Script not found"})});
  await assert.rejects(client.executeCloud({profileId: 63, workflowId: "missing", parameter: {}, closeBrowser: false}), /Script not found/);
});

test("profiles and workflow defaults are returned without credentials", async () => {
  const responses = [
    {data: [{id: "1", proxy: "http://alice:password@proxy.example:8000", username: "alice", password: "password"}]},
    {data: [{id: "wf-1", parameters: [{name: "api_token", default: "workflow-secret"}, {name: "limit", default: 2}]}]}
  ];
  const safeClient = new GemLoginClient({
    baseUrl: "http://local.example",
    fetchImpl: async () => jsonResponse(responses.shift())
  });

  const profiles = await safeClient.listProfiles();
  const workflows = await safeClient.listWorkflows();
  const serialized = JSON.stringify({profiles, workflows});
  assert.equal(serialized.includes('"password":"password"'), false);
  assert.equal(serialized.includes("alice"), false);
  assert.equal(serialized.includes("workflow-secret"), false);
  assert.equal(workflows.data[0].parameters[1].default, 2);
});

test("listProfiles masks colon-delimited proxy credentials", async () => {
  const client = new GemLoginClient({
    baseUrl: "http://local.example",
    fetchImpl: async () => jsonResponse({data: [{proxy: "http://proxy.example:8000:alice:password"}]})
  });

  const profiles = await client.listProfiles();
  assert.equal(profiles.data[0].proxy, "http://proxy.example:8000:***:***");
});

test("listProfiles follows GemLogin pages beyond the first 50 profiles", async () => {
  const calls = [];
  const client = new GemLoginClient({
    baseUrl: "http://local.example",
    fetchImpl: async (url) => {
      calls.push(url);
      const page = new URL(url).searchParams.get("page");
      return jsonResponse({data: page === "2" ? [{id: "70"}] : Array.from({length: 50}, (_, index) => ({id: String(index + 1)}))});
    }
  });
  const profiles = await client.listProfiles();
  assert.equal(profiles.data.length, 51);
  assert.equal(profiles.data.at(-1).id, "70");
  assert.deepEqual(calls, ["http://local.example/api/profiles", "http://local.example/api/profiles?page=2"]);
});

test("refreshProfileList clicks GemLogin's real profile refresh control", async () => {
  const messages = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = {}; }
    addEventListener(name, listener) {
      this.listeners[name] = listener;
      if (name === "open") queueMicrotask(listener);
    }
    send(message) {
      messages.push(JSON.parse(message));
      queueMicrotask(() => this.listeners.message({data: JSON.stringify({id: 1, result: {result: {value: true}}})}));
    }
    close() {}
  }
  const client = new GemLoginClient({
    baseUrl: "http://local.example",
    cdpBase: "http://host.example:9223",
    fetchImpl: async (url) => url.endsWith("/json/list")
      ? jsonResponse([{type: "page", url: "http://localhost:1010/#/profiles", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc"}])
      : jsonResponse({success: true}),
    webSocketImpl: FakeWebSocket
  });

  await client.refreshProfileList();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, "Runtime.evaluate");
  assert.match(messages[0].params.expression, /Refresh profile list button not found/);
  assert.match(messages[0].params.expression, /querySelectorAll\('button,\[role="button"\]'\)/);
  assert.doesNotMatch(messages[0].params.expression, /reload/);
  assert.match(messages[0].params.expression, /setTimeout\(r,2000\)/);
});

test("refreshProfileList navigates to profiles when GemLogin is on another page", async () => {
  const messages = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = {}; }
    addEventListener(name, listener) {
      this.listeners[name] = listener;
      if (name === "open") queueMicrotask(listener);
    }
    send(message) {
      messages.push(JSON.parse(message));
      queueMicrotask(() => this.listeners.message({data: JSON.stringify({id: 1, result: {result: {value: true}}})}));
    }
    close() {}
  }
  const client = new GemLoginClient({
    baseUrl: "http://local.example",
    cdpBase: "http://host.example:9223",
    fetchImpl: async (url) => url.endsWith("/json/list")
      ? jsonResponse([{type: "page", url: "http://localhost:1010/#/settings", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc"}])
      : jsonResponse({success: true}),
    webSocketImpl: FakeWebSocket
  });

  await client.refreshProfileList();
  assert.match(messages[0].params.expression, /location\.hash/);
  assert.match(messages[0].params.expression, /#\/profiles/);
});

test("configured cloud tokens are redacted from arbitrary response fields", async () => {
  const {client} = makeClient({success: true, upstream_context: {opaque_value: "secret"}});

  const result = await client.executeCloud({profileId: 63, workflowId: "wf-1", parameter: {}, closeBrowser: true});
  assert.equal(result.upstream_context.opaque_value, "***");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("failed requests report a sanitized HTTP error", async () => {
  const client = new GemLoginClient({
    baseUrl: "http://local.example",
    cloudToken: "secret",
    fetchImpl: async () => jsonResponse({message: "secret"}, 401, "token secret rejected")
  });

  await assert.rejects(client.status(), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});

test("successful HTTP responses still reject GemLogin errors", async () => {
  const {client} = makeClient({success: false, message: "Invalid type for parameter: keyword_file"});
  await assert.rejects(client.executeLocal({profileId: 63, workflowId: "wf-1", parameter: {}, closeBrowser: false}), /Invalid type for parameter/);
});

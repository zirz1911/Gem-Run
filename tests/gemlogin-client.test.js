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
    ["http://local.example/api/profiles/start/a%2Fb", "GET", undefined],
    ["http://local.example/api/profiles/close/a%2Fb", "GET", undefined],
    ["http://local.example/api/profiles/delete/a%2Fb", "GET", undefined],
    ["http://local.example/api/profiles/check-status/a%2Fb", "POST", undefined],
    ["http://local.example/api/scripts/check-status/script%2Fa", "POST", '{"profileId":"profile/b"}']
  ]);
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

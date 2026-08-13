import assert from "node:assert/strict";
import test from "node:test";
import {createApp} from "../server/app.js";
import {loadConfig} from "../server/config.js";

const config = loadConfig({});
const app = createApp({config, gemloginClient: null, db: null, runService: null});

test("health reports the app and GemLogin status", async () => {
  const server = app.listen(0);
  const {port} = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).app, "ok");
  await new Promise((resolve) => server.close(resolve));
});

test("health reports configured GemLogin availability without forwarding its response", async () => {
  const app = createApp({
    config,
    gemloginClient: {status: async () => ({version: "1.0"})},
    db: null,
    runService: null
  });
  const server = app.listen(0);
  try {
    const {port} = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.deepEqual(await response.json(), {app: "ok", gemlogin: "available", execution_mode: "cloud"});
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("health exposes Local execution mode without credentials", async () => {
  const app = createApp({
    config: loadConfig({GEMLOGIN_EXECUTION_MODE: "local"}),
    gemloginClient: {status: async () => ({success: true, token: "must-not-leak"})},
    db: null,
    runService: null
  });
  const server = app.listen(0);
  try {
    const {port} = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.deepEqual(await response.json(), {app: "ok", gemlogin: "available", execution_mode: "local"});
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("run-start errors use a static response", async () => {
  const app = createApp({
    config, gemloginClient: null, db: null,
    runService: {start: async () => { throw new Error("proxy://alice:secret@host"); }, get: () => null}
  });
  const server = app.listen(0);
  const {port} = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {error: "Unable to start run"});
  await new Promise((resolve) => server.close(resolve));
});

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

test("health uses the configured GemLogin client", async () => {
  const app = createApp({
    config,
    gemloginClient: {status: async () => ({version: "1.0"})},
    db: null,
    runService: null
  });
  const server = app.listen(0);
  const {port} = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.deepEqual((await response.json()).gemlogin, {version: "1.0"});
  await new Promise((resolve) => server.close(resolve));
});

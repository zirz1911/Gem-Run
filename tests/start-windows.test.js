import {test} from "node:test";
import assert from "node:assert/strict";
import {decideGemLoginStartup, gemLoginArguments, waitUntil} from "../scripts/ensure-gemlogin-windows.mjs";

test("Windows supervisor reuses GemLogin only when API and CDP are ready", () => {
  assert.equal(decideGemLoginStartup({apiReady: true, cdpReady: true, gemLoginRunning: true, status: {activeBrowsers: 0}}), "reuse");
  assert.throws(
    () => decideGemLoginStartup({apiReady: false, cdpReady: true, gemLoginRunning: true, status: null}),
    /local API is unavailable/
  );
});

test("Windows supervisor starts GemLogin when no instance is running", () => {
  assert.equal(decideGemLoginStartup({apiReady: false, cdpReady: false, gemLoginRunning: false, status: null}), "start");
});

test("Windows supervisor refuses to restart without trustworthy browser status", () => {
  assert.throws(
    () => decideGemLoginStartup({apiReady: false, cdpReady: false, gemLoginRunning: true, status: null}),
    /status is unavailable/
  );
  assert.throws(
    () => decideGemLoginStartup({apiReady: true, cdpReady: false, gemLoginRunning: true, status: {}}),
    /activeBrowsers is unavailable/
  );
});

test("Windows supervisor protects active browsers and restarts only an idle instance", () => {
  assert.throws(
    () => decideGemLoginStartup({apiReady: true, cdpReady: false, gemLoginRunning: true, status: {activeBrowsers: 2}}),
    /2 active browsers/
  );
  assert.equal(decideGemLoginStartup({apiReady: true, cdpReady: false, gemLoginRunning: true, status: {activeBrowsers: 0}}), "restart");
});

test("Windows supervisor builds one validated CDP startup argument", () => {
  assert.deepEqual(gemLoginArguments(9222), ["--remote-debugging-port=9222"]);
  for (const port of [0, 65536, "not-a-port"]) {
    assert.throws(() => gemLoginArguments(port), /valid TCP port/);
  }
});

test("Windows supervisor waits for a process to finish after termination", async () => {
  let checks = 0;
  await waitUntil(async () => ++checks === 3, {timeoutMs: 100, intervalMs: 1, timeoutMessage: "process still running"});
  assert.equal(checks, 3);
});

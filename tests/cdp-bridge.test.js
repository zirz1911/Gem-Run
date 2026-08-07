import assert from "node:assert/strict";
import test from "node:test";
import {makeUpstreamHeaders} from "../scripts/gemlogin-cdp-bridge.mjs";

test("CDP bridge keeps Electron's local Host header when connecting through Docker", () => {
  assert.deepEqual(makeUpstreamHeaders({connection: "Upgrade"}, "127.0.0.1", 9222), {
    connection: "Upgrade",
    host: "127.0.0.1:9222"
  });
});

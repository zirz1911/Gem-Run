import assert from "node:assert/strict";
import test from "node:test";
import {loadConfig} from "../server/config.js";

test("rejects invalid run timeout configuration", () => {
  for (const value of ["0", "-1", "NaN", "Infinity", ""]) {
    assert.throws(() => loadConfig({RUN_TIMEOUT_SECONDS: value}), /RUN_TIMEOUT_SECONDS must be a finite positive number/);
  }
  assert.equal(loadConfig({RUN_TIMEOUT_SECONDS: "2.5"}).runTimeoutSeconds, 2.5);
  assert.equal(loadConfig({GEMLOGIN_CDP_BASE: "http://host:9223"}).gemloginCdpBase, "http://host:9223");
});

import {readFileSync} from "node:fs";
import {test} from "node:test";
import assert from "node:assert/strict";

const launcher = readFileSync(new URL("../start-windows.cmd", import.meta.url), "utf8");

test("Windows launcher starts GemLogin with an overridable CDP endpoint", () => {
  assert.match(launcher, /if not defined GEMLOGIN_EXE set "GEMLOGIN_EXE=%LOCALAPPDATA%\\Programs\\gemlogin\\gemlogin\.exe"/i);
  assert.match(launcher, /if not defined GEMLOGIN_CDP_PORT set "GEMLOGIN_CDP_PORT=9222"/i);
  assert.match(launcher, /if not defined GEMLOGIN_CDP_BASE set "GEMLOGIN_CDP_BASE=http:\/\/127\.0\.0\.1:%GEMLOGIN_CDP_PORT%"/i);
  assert.match(launcher, /--remote-debugging-port=%GEMLOGIN_CDP_PORT%/i);
});

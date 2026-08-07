# Windows GemLogin CDP Launcher Implementation Plan

**Goal:** Ensure the Windows Gem-Run launcher starts GemLogin with its renderer CDP endpoint available before Gem-Run starts.

**Architecture:** Keep the fix entirely in Gem-Run. `start-windows.cmd` will use the standard GemLogin install path (with an override), derive the CDP URL from an overridable port, reuse an already-ready CDP endpoint, and otherwise start GemLogin with `--remote-debugging-port` and wait for readiness. A Node regression test will protect these launcher contracts because the command file is not portable to the Node test runner.

**Constraints:** Do not edit GemLogin files; preserve existing-profile behavior; do not add dependencies; keep secrets out of diagnostics; do not commit or push.

### Task 1: Add the failing launcher contract test

**Files:**
- Create: `tests/start-windows.test.js`

- [ ] Assert that the launcher defines an overridable GemLogin executable path, CDP port/base, and passes the CDP flag when starting GemLogin.
- [ ] Run the focused test and confirm it fails against the current launcher.

### Task 2: Implement portable CDP startup

**Files:**
- Modify: `start-windows.cmd`

- [ ] Add defaults for `GEMLOGIN_EXE`, `GEMLOGIN_CDP_PORT`, and `GEMLOGIN_CDP_BASE`.
- [ ] Reuse an already-listening CDP endpoint.
- [ ] If GemLogin is running without CDP, fail with a clear restart message rather than killing the user's process.
- [ ] Otherwise start GemLogin with `--remote-debugging-port` and wait for the endpoint before starting Gem-Run.
- [ ] Run the focused test and confirm it passes.

### Task 3: Verify

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Manually verify the launcher/CDP behavior on Windows without editing GemLogin files.

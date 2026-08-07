# Windows GemLogin Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `start-windows.cmd` leave a visible GemLogin instance running with local API and renderer CDP ready before Gem-Run starts.

**Architecture:** Keep environment defaults in `start-windows.cmd` and delegate process supervision to a focused Node.js script. Its pure startup decision function is tested cross-platform; Windows process inspection and shutdown use PowerShell only at the OS boundary. The supervisor preserves a healthy instance, protects active browser sessions, safely restarts an idle instance that lacks CDP, starts GemLogin visibly, and condition-polls both readiness endpoints.

**Tech Stack:** Node.js ESM and built-in test runner, Windows CMD, Windows PowerShell 5+ process boundary.

## Global Constraints

- Do not edit GemLogin installation files, profiles, database, or configuration.
- Do not stop GemLogin when `/api/status` reports active browsers or cannot be read.
- Do not add dependencies or change existing-profile execution behavior.
- Keep executable paths, API base, CDP base, and CDP port overridable.
- Do not log credentials, cookies, proxy data, profile fields, or response bodies.
- Do not commit or push until the Windows smoke test passes and the user explicitly requests it.

---

### Task 1: Add failing startup-decision tests

**Files:**
- Modify: `tests/start-windows.test.js`
- Create: `scripts/ensure-gemlogin-windows.mjs`

**Interfaces:**
- Consumes: the future `decideGemLoginStartup(state)` and `gemLoginArguments(port)` exports.
- Produces: cross-platform behavior tests for reuse, start, restart, refusal, and CDP argument validation.

- [ ] **Step 1: Replace the source-text test with behavior tests before creating the supervisor**

Import `decideGemLoginStartup` and `gemLoginArguments`. Assert literal outcomes: healthy API/CDP returns `reuse`; no process returns `start`; an unreadable/malformed status refuses restart; positive `activeBrowsers` refuses restart; zero active browsers returns `restart`; port `9222` yields exactly `--remote-debugging-port=9222` and invalid ports throw.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/start-windows.test.js`

Expected: FAIL because `scripts/ensure-gemlogin-windows.mjs` does not exist.

### Task 2: Implement the Node.js supervisor

**Files:**
- Create: `scripts/ensure-gemlogin-windows.mjs`
- Modify: `start-windows.cmd`

**Interfaces:**
- Consumes `GEMLOGIN_EXE`, `GEMLOGIN_BASE`, `GEMLOGIN_CDP_BASE`, and integer `GEMLOGIN_CDP_PORT` from the environment.
- Exports `decideGemLoginStartup(state)`, `gemLoginArguments(port)`, and `ensureGemLogin(options)`.
- Produces exit code `0` only when both `${GEMLOGIN_BASE}/api/status` and `${GEMLOGIN_CDP_BASE}/json/version` are ready; nonzero otherwise.

- [ ] **Step 1: Implement the tested decision functions**

Implement only the branches and validation required by the tests, then add endpoint and bounded-wait helpers that inspect HTTP status without printing response bodies.

- [ ] **Step 2: Protect active sessions**

When GemLogin is running without CDP, read `/api/status`. Refuse restart if the request fails, `activeBrowsers` is absent, or its numeric value is greater than zero.

- [ ] **Step 3: Restart only idle GemLogin processes**

List `gemlogin.exe` PIDs and command lines through PowerShell. Identify the main process by the absence of `--type=`, call `CloseMainWindow()`, wait for exit, then force-stop only remaining captured PIDs after the API confirmed zero active browsers.

- [ ] **Step 4: Start GemLogin visibly and wait for readiness**

Use detached Node `spawn(GemLoginExe, gemLoginArguments(port), {windowsHide:false})`. Poll both API and CDP endpoints until the bounded deadline.

- [ ] **Step 5: Simplify the CMD launcher**

Retain environment defaults, run `node scripts/ensure-gemlogin-windows.mjs`, stop on a nonzero exit, and run `npm start` only after readiness succeeds.

- [ ] **Step 6: Verify GREEN**

Run: `node --test tests/start-windows.test.js`

Expected: PASS.

### Task 3: Verify behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: final launcher behavior.
- Produces: user-facing Windows startup instructions and runtime evidence.

- [ ] **Step 1: Update Windows instructions**

Document that `start-windows.cmd` opens and leaves GemLogin visible, restarts only an idle no-CDP instance, and refuses to interrupt active profiles.

- [ ] **Step 2: Run automated verification**

Run `npm test`, `npm run check`, and `git diff --check`.

- [ ] **Step 3: Run Windows smoke checks**

Verify: healthy CDP keeps the same main PID; idle no-CDP GemLogin restarts with the CDP flag; the main process has a visible window; API and CDP return HTTP 200; a cleanup-enabled `Test Gem Run` new-profile workflow ends without an error and cleanup is `done`.

- [ ] **Step 4: Leave changes uncommitted**

Report files changed and exact smoke/test results. Do not commit or push.

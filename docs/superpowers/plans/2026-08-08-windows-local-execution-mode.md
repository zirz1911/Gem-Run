# Windows Local Execution Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every Windows-native workflow submission through GemLogin Local API while preserving Cloud webhook submission for Mac Docker.

**Architecture:** Add one validated `GEMLOGIN_EXECUTION_MODE` runtime setting and inject it into `RunService`. Supported launchers set their modes explicitly: Windows CMD defaults to `local`, while Compose uses `cloud`; `RunService` selects exactly one client submission method and leaves polling and cleanup unchanged.

**Tech Stack:** Node.js 24, Node test runner, Express, PowerShell/CMD launcher, Docker Compose

## Global Constraints

- Do not modify Mac code, configuration, database, Docker volume, or runtime during Windows verification.
- Do not copy secrets from Mac to Windows.
- Windows native must use Local API for both existing and new profiles.
- Mac Docker must continue using Cloud webhook for both existing and new profiles.
- Do not fall back between endpoints after a failed submission.
- Preserve temporary-profile cleanup after success, failure, cancellation, and timeout.
- Make no database schema or stored-run format change.

---

### Task 1: Validate and declare the runtime execution mode

**Files:**
- Modify: `tests/config.test.js`
- Modify: `tests/start-windows.test.js`
- Modify: `server/config.js`
- Modify: `start-windows.cmd`
- Modify: `compose.yaml`

**Interfaces:**
- Consumes: `loadConfig(env)` and the two supported launcher files.
- Produces: `config.gemloginExecutionMode` with value `"local"` or `"cloud"`.

- [ ] **Step 1: Write failing configuration and launcher tests**

Add these assertions to `tests/config.test.js`:

```js
assert.equal(loadConfig({}).gemloginExecutionMode, "cloud");
assert.equal(loadConfig({GEMLOGIN_EXECUTION_MODE: "local"}).gemloginExecutionMode, "local");
assert.equal(loadConfig({GEMLOGIN_EXECUTION_MODE: "cloud"}).gemloginExecutionMode, "cloud");
assert.throws(() => loadConfig({GEMLOGIN_EXECUTION_MODE: "auto"}), /GEMLOGIN_EXECUTION_MODE must be local or cloud/);
```

Add a test to `tests/start-windows.test.js` that reads `start-windows.cmd` and `compose.yaml`, then asserts:

```js
assert.match(windowsLauncher, /if not defined GEMLOGIN_EXECUTION_MODE set "GEMLOGIN_EXECUTION_MODE=local"/);
assert.match(compose, /GEMLOGIN_EXECUTION_MODE:\s*cloud/);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/config.test.js tests/start-windows.test.js`

Expected: FAIL because `gemloginExecutionMode` is absent and neither launcher declares the mode.

- [ ] **Step 3: Implement minimal configuration and launcher support**

In `server/config.js`, validate before returning:

```js
const gemloginExecutionMode = env.GEMLOGIN_EXECUTION_MODE || "cloud";
if (!["local", "cloud"].includes(gemloginExecutionMode)) {
  throw new Error("GEMLOGIN_EXECUTION_MODE must be local or cloud");
}
```

Return `gemloginExecutionMode` from `loadConfig`.

In `start-windows.cmd`, add this default beside the existing GemLogin defaults:

```cmd
if not defined GEMLOGIN_EXECUTION_MODE set "GEMLOGIN_EXECUTION_MODE=local"
```

In the `gem-run` service environment in `compose.yaml`, add:

```yaml
GEMLOGIN_EXECUTION_MODE: cloud
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test tests/config.test.js tests/start-windows.test.js`

Expected: all focused tests pass.

- [ ] **Step 5: Commit the runtime-mode contract**

```powershell
git add tests/config.test.js tests/start-windows.test.js server/config.js start-windows.cmd compose.yaml
git commit -m "feat: configure workflow execution mode"
```

---

### Task 2: Route workflow submissions through the configured client

**Files:**
- Modify: `tests/run-service.test.js`
- Modify: `server/run-service.js`
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `config.gemloginExecutionMode` from Task 1 and existing `GemLoginClient.executeLocal(details, options)` / `executeCloud(details, options)` methods.
- Produces: `new RunService({... , gemloginExecutionMode})` with endpoint selection applied to manual and scheduled runs.

- [ ] **Step 1: Write failing Local-mode routing tests**

Extend `makeContext` in `tests/run-service.test.js` to accept `gemloginExecutionMode = "cloud"` and pass it to `RunService`. Add one test that starts an existing-profile run and a new-profile run using separate Local-mode contexts:

```js
test("local execution mode submits existing and new profiles through Local API", async () => {
  const existing = makeContext({gemloginExecutionMode: "local"});
  await existing.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, parameter: {keyword_file: "keywords.txt"}});
  await existing.drain();
  assert.deepEqual(existing.client.calls.map(({name}) => name), ["executeLocal", "checkScriptStatus"]);

  const created = makeContext({gemloginExecutionMode: "local"});
  await created.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", parameter: {target_site: "example.com"}, cleanup_requested: true});
  await created.drain();
  assert.deepEqual(created.client.calls.map(({name}) => name), ["createProfile", "startProfile", "refreshProfileList", "executeLocal", "checkScriptStatus", "closeProfile", "deleteProfile", "refreshProfileList"]);
});
```

Keep the existing Cloud-mode assertions unchanged to protect Mac Docker behavior.

- [ ] **Step 2: Run the routing test and verify RED**

Run: `node --test --test-name-pattern="local execution mode" tests/run-service.test.js`

Expected: FAIL because `RunService` always calls `executeCloud`.

- [ ] **Step 3: Implement minimal endpoint selection**

Accept `gemloginExecutionMode = "cloud"` in the `RunService` constructor and retain it on the instance. Replace the hard-coded Cloud submission in `execute` with:

```js
const executeWorkflow = this.gemloginExecutionMode === "local"
  ? this.gemloginClient.executeLocal.bind(this.gemloginClient)
  : this.gemloginClient.executeCloud.bind(this.gemloginClient);
const submitted = await this.runWithDeadline(deadline, (signal) => executeWorkflow({
  profileId: currentProfileId,
  workflowId: run.workflow_id,
  parameter: input.parameter ?? {},
  closeBrowser: closeBrowserRequested(run) || (run.profile_mode === "new" && deleteProfileRequested(run))
}, {signal}), runId);
```

In `server/index.js`, pass:

```js
gemloginExecutionMode: config.gemloginExecutionMode
```

- [ ] **Step 4: Run focused and full routing tests and verify GREEN**

Run: `node --test tests/run-service.test.js tests/config.test.js tests/start-windows.test.js`

Expected: Local-mode tests pass and existing Cloud-mode tests remain green.

- [ ] **Step 5: Commit endpoint routing**

```powershell
git add tests/run-service.test.js server/run-service.js server/index.js
git commit -m "fix: use Local API for Windows workflow runs"
```

---

### Task 3: Document and verify the isolated behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the supported launcher behavior from Tasks 1 and 2.
- Produces: operator instructions stating which endpoint each runtime uses and how to override it explicitly.

- [ ] **Step 1: Update runtime documentation**

Add to the Windows section that `start-windows.cmd` defaults to Local execution for existing and new profiles. Add to the Docker section that Compose explicitly uses Cloud execution and still requires Cloud settings. Document only the accepted override values:

```powershell
$env:GEMLOGIN_EXECUTION_MODE = "local" # or "cloud"
```

- [ ] **Step 2: Run complete automated verification**

Run:

```powershell
npm test
npm run check
git diff --check
```

Expected: 0 test failures, syntax check exit 0, and no whitespace errors.

- [ ] **Step 3: Restart only the Windows native server with the launcher mode**

Stop the diagnostic Node server without stopping GemLogin, then start `start-windows.cmd`. Verify process configuration without printing environment values and check:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3200/api/health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3200/api/gemlogin/status
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3200/api/gemlogin/workflows
```

Expected: all endpoints return HTTP 200 and `[SEO] Google Search 1.0.1` is present.

- [ ] **Step 4: Verify a Windows Local workflow run and cleanup**

Submit `[SEO] Google Search 1.0.1` with its current Windows workflow ID and parameter defaults through Gem-Run. Use a new temporary profile with cleanup enabled, poll the run to `done`, and compare sanitized profile IDs before and after.

Expected: no HTTP 400 Cloud error, terminal workflow result is recorded, cleanup is `done`, and the created profile ID is absent afterward. If the workflow itself reports a non-transport failure, preserve that result and verify Local submission plus cleanup rather than masking it.

- [ ] **Step 5: Verify Schedule uses the same Local execution mode**

Run the existing scheduler regression test and inspect `server/index.js` to confirm the scheduler receives the same `RunService` instance:

```powershell
node --test --test-name-pattern="scheduler pauses for Manual runs" tests/schedule.test.js
```

Do not create or delete a persistent diagnostic Schedule unless the existing Windows Schedule can be triggered without altering its definition.

- [ ] **Step 6: Review repository state and commit documentation**

```powershell
git status --short --branch
git diff --check
git add README.md
git commit -m "docs: explain runtime workflow execution modes"
```

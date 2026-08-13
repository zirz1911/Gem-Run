# Local Existing Batch Browser Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Windows Local Existing Profile Group/All batches from accumulating browser windows beyond their worker concurrency by forcing and awaiting profile closure before slot reuse.

**Architecture:** `RunService` remains the enforcement boundary: it recognizes Local existing batches, persists effective closure, and performs bounded close cleanup after any attempted dispatch. The health endpoint exposes only the non-sensitive execution mode so the shared dashboard can display the forced setting without changing Cloud behavior.

**Tech Stack:** Node.js 22+, Express, browser JavaScript, `node:test`, SQLite via `better-sqlite3`

## Global Constraints

- Enforce closure only for GemLogin execution mode `local`, profile mode `existing`, and requests containing more than one profile.
- Local one-profile, New Profile, and Cloud execution behavior remain unchanged.
- Do not add retries or alter timeout/concurrency values.
- Do not log parameter values, tokens, proxies, or secrets.
- Do not delete profiles, workflows, databases, or secrets during verification.

---

### Task 1: Enforce Local Existing Batch Closure in the Worker Lifecycle

**Files:**
- Modify: `tests/run-service.test.js`
- Modify: `server/run-service.js`

**Interfaces:**
- Consumes: `RunService.start(input)`, `GemLoginClient.executeLocal(details, options)`, and `GemLoginClient.closeProfile(profileId, options)`.
- Produces: Local existing batch runs with persisted `close_browser=true`; `RunService.finish(runId, status, errorMessage, deadline, closeExistingProfile)` waits for bounded existing-profile closure when `closeExistingProfile` is true.

- [ ] **Step 1: Write failing tests for forced closure and worker ordering**

Extend the fake client so `closeProfile` can optionally wait on a supplied promise, then add a concurrency-1 test with two existing profiles:

```js
test("Local existing batch closes a profile before reusing its worker", async () => {
  const ctx = makeContext({gemloginExecutionMode: "local"});
  await ctx.service.start({
    workflow_id: "wf-1", profile_mode: "existing", profile_ids: [61, 62],
    execution_mode: "parallel", max_concurrency: 1, close_browser: false
  });
  await ctx.drain();

  assert.deepEqual(
    ctx.client.calls.filter(({name}) => ["executeLocal", "closeProfile"].includes(name))
      .map(({name, details, profileId}) => [name, String(details?.profileId ?? profileId)]),
    [["executeLocal", "61"], ["closeProfile", "61"], ["executeLocal", "62"], ["closeProfile", "62"]]
  );
  assert.equal(ctx.client.calls.find(({name}) => name === "executeLocal").details.closeBrowser, true);
  assert.equal(ctx.store.get("run-1").close_browser, true);
  assert.equal(ctx.store.get("run-1").cleanup_status, "done");
});
```

Add focused cases proving failed and timed-out dispatched runs call `closeProfile`, and a cancellation test where profile 61 reaches `executeLocal` but queued profile 62 is cancelled before dispatch; only profile 61 may be closed.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern "Local existing batch|dispatched Local existing|queued Local existing" tests/run-service.test.js
```

Expected: FAIL because Local batches currently retain `close_browser=false` and never call `closeProfile` for existing profiles.

- [ ] **Step 3: Implement the minimal server enforcement**

In `start()`, derive the effective policy before creating run rows:

```js
const forceLocalExistingBatchClose = this.gemloginExecutionMode === "local"
  && input.profile_mode === "existing" && profileIds.length > 1;
```

Persist `close_browser` as true when that policy applies. In `execute()`, initialize `let closeExistingProfile = false`; immediately before attempting Local dispatch for a forced batch, set it to true and update `cleanup_status` to `pending`. Pass that flag to every `finish()` call, including the catch path.

Extend `finish()` so its cleanup deadline is `Math.max(deadline, now) + cleanupTimeout`. When the flag is true, call:

```js
await this.runWithDeadline(
  cleanupDeadline,
  (signal) => this.gemloginClient.closeProfile(run.profile_id, {signal}),
  run.id,
  true
);
```

Record `cleanup_status="done"` after a successful close and `cleanup_status="failed"` after a rejected or timed-out close without overwriting the workflow status/error. If Local dispatch was never attempted, retain the existing cleanup path and do not close the existing profile.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test --test-name-pattern "Local existing batch|dispatched Local existing|queued Local existing|existing profile never|existing profile can close|does not treat an unstarted" tests/run-service.test.js
```

Expected: all selected tests PASS, including unchanged Cloud and one-profile behavior.

- [ ] **Step 5: Commit the worker lifecycle change**

```powershell
git add -- server/run-service.js tests/run-service.test.js
git commit -m "fix(runs): close local batch profiles before slot reuse"
```

---

### Task 2: Show the Forced Local Batch Policy in the Dashboard

**Files:**
- Modify: `tests/app.test.js`
- Modify: `tests/ui-contract.test.js`
- Modify: `server/app.js`
- Modify: `server/routes.js`
- Modify: `public/index.html`
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `config.gemloginExecutionMode` from `loadConfig()` and `GET /api/health`.
- Produces: health JSON field `execution_mode: "local" | "cloud"`; exported `browserCloseForced(executionMode, profileMode, existingSelection): boolean` for dashboard policy and contract testing.

- [ ] **Step 1: Write failing health and UI policy tests**

Update the configured health assertion:

```js
assert.deepEqual(await response.json(), {
  app: "ok", gemlogin: "available", execution_mode: "cloud"
});
```

Add UI helper assertions:

```js
assert.equal(browserCloseForced("local", "existing", "group"), true);
assert.equal(browserCloseForced("local", "existing", "all"), true);
assert.equal(browserCloseForced("local", "existing", "profile"), false);
assert.equal(browserCloseForced("cloud", "existing", "group"), false);
assert.equal(browserCloseForced("local", "new", "profile"), false);
```

Require a stable `id="close-browser-field"` in `public/index.html` for the forced-control state.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test tests/app.test.js tests/ui-contract.test.js
```

Expected: FAIL because health omits execution mode, the helper is absent, and the checkbox label has no stable ID.

- [ ] **Step 3: Implement the health field and dashboard policy**

Pass `config` from `createApp()` to `createRoutes()`. Return the configured mode in both available and unavailable health responses without returning any credential:

```js
const executionMode = config?.gemloginExecutionMode ?? "cloud";
response.json({app: "ok", gemlogin: "available", execution_mode: executionMode});
```

Add and use the UI helper:

```js
export function browserCloseForced(executionMode, selectedProfileMode, existingSelection) {
  return executionMode === "local"
    && selectedProfileMode === "existing" && existingSelection !== "profile";
}
```

Store `health.execution_mode` in dashboard state. In `syncRunForm()`, check and disable `close_browser` when the helper is true, and re-enable it otherwise. In submit serialization, set `close_browser` true when forced even though disabled controls are omitted by `FormData`. Add `id="close-browser-field"` to the existing checkbox label.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/app.test.js tests/ui-contract.test.js
```

Expected: all health and UI contract tests PASS.

- [ ] **Step 5: Commit the dashboard change**

```powershell
git add -- server/app.js server/routes.js public/index.html public/app.js tests/app.test.js tests/ui-contract.test.js
git commit -m "fix(ui): show forced browser close for local batches"
```

---

### Task 3: Full Verification and Windows Runtime Check

**Files:**
- Modify only if a test exposes a defect in Task 1 or Task 2.

**Interfaces:**
- Consumes: the completed server and dashboard changes from Tasks 1 and 2.
- Produces: automated and runtime evidence that the open-browser count respects Local batch concurrency without changing Cloud behavior.

- [ ] **Step 1: Run the complete automated verification**

```powershell
npm test
npm run check
git diff --check
```

Expected: all tests PASS, syntax check exits 0, and diff check prints no errors.

- [ ] **Step 2: Verify the Windows launcher and health mode**

Start with `start-windows.cmd`, then run:

```powershell
Invoke-RestMethod http://127.0.0.1:3200/api/health
Invoke-RestMethod http://127.0.0.1:1010/api/status
```

Expected: Gem-Run reports `execution_mode=local`; GemLogin responds successfully. Do not print response fields containing secrets.

- [ ] **Step 3: Verify Local Existing Group with concurrency 1**

Run a small safe Existing Profile group with concurrency 1. Confirm the dashboard forces Close browser, each workflow starts and reaches its terminal status, its browser closes, and only then does the next profile open.

- [ ] **Step 4: Verify the user's actual concurrency**

Run a representative Existing Profile group using the user's configured concurrency. Record only batch size, concurrency, maximum GemLogin `activeBrowsers`, workflow success/failure counts, and cleanup status counts. Expected: open browsers do not accumulate above concurrency during normal runs; no parameter/proxy/token values are recorded.

- [ ] **Step 5: Review repository state before any push**

```powershell
git status --short --branch
git log --oneline -4
git diff origin/main...HEAD --check
```

Expected: only the planned commits are ahead of `origin/main`. Push only after Windows runtime verification passes or the user explicitly directs an earlier push.

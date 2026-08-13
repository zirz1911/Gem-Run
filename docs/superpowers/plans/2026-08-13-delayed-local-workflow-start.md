# Delayed Local Workflow Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent slow-starting GemLogin Local workflows from releasing a parallel worker before the workflow starts, without charging queued runs against their execution timeout.

**Architecture:** Restore per-worker timeout initialization from `c9cb461`. Keep the existing startup deadline for Cloud mode, but let Local mode poll `not_running` until the normal run deadline so the worker remains assigned to the same profile.

**Tech Stack:** Node.js 22+, ES modules, built-in `node:test`.

## Global Constraints

- Do not change GemLogin request schemas, UI concurrency selection, or Cloud transport.
- Parallel 5 must continue to mean at most five active workers.
- Do not add retries or arbitrary new timeouts.
- Do not commit or push until automated verification and affected Windows runtime verification pass.

---

### Task 1: Preserve Worker Slots for Slow Local Starts

**Files:**
- Modify: `tests/run-service.test.js`
- Modify: `server/run-service.js`

**Interfaces:**
- Consumes: `RunService.start(input)` and `gemloginExecutionMode` values `local` or `cloud`.
- Produces: Local `not_running` polling bounded by the run deadline; Cloud retains the 15-second startup deadline.

- [ ] **Step 1: Restore and extend the test harness**

Add per-profile status sequences and execution event recording to `makeContext()` so tests can model a delayed Local start and prove the next profile is not executed early.

- [ ] **Step 2: Write failing regression tests**

Add tests which assert:

```js
assert.equal(secondExecuteObservedBeforeFirstCompletes, false);
assert.equal(ctx.store.get("run-1").error_message, null);
assert.equal(ctx.store.get("run-2").error_message, null);
```

Also restore the queue-timeout regression and keep a Cloud assertion for `workflow did not start`.

- [ ] **Step 3: Run tests to verify RED**

Run:

```powershell
node --test --test-name-pattern="queued batch|slow Local workflow|does not treat" tests/run-service.test.js
```

Expected: queue-timeout and slow-Local tests fail against `b85b1a5`; the Cloud startup test passes.

- [ ] **Step 4: Implement the minimal production change**

In `RunService`:

```js
// start(): queued runs do not have started_at
started_at: null

// execute(): start the clock when the worker takes the run
let run = this.runStore.update(runId, {started_at: timestamp(this.clock)});

// execute(): only Cloud mode applies the early startup failure
if (this.gemloginExecutionMode !== "local" && status === "not_running" && now >= startupDeadline) {
  return this.finish(runId, "failed", "workflow did not start", deadline);
}
```

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```powershell
node --test --test-name-pattern="queued batch|slow Local workflow|does not treat" tests/run-service.test.js
```

Expected: all selected tests pass.

- [ ] **Step 6: Run full verification**

Run:

```powershell
npm test
npm run check
git diff --check
```

Expected: zero test failures, syntax check exit 0, and no whitespace errors.

- [ ] **Step 7: Verify on affected Windows runtime**

Run Existing Group with Parallel 5. Confirm no more than five profiles execute simultaneously, a slow-starting workflow retains its slot beyond 15 seconds, queued profiles do not consume their run timeout, and the next profile starts only after the current slot completes or reaches the configured run deadline.

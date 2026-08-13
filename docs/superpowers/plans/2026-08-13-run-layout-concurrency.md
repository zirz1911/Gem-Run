# Run Layout and Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Balance the Run Workflow form and support up to 500 concurrent profiles for manual and scheduled batches.

**Architecture:** Recompose the existing HTML into full-width form rows and move the existing execution controls into one shared batch section. Keep profile selection in the browser, pass existing batch execution settings through the current route, and enforce one 500-profile concurrency boundary in the existing service and schedule validators.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js, Express, `node:test`

## Global Constraints

- No new dependency or component abstraction.
- Existing single-profile requests keep their current shape.
- Existing Group and All batches support Sequential and Parallel execution.
- Manual and scheduled concurrency is 1 through 500 and cannot exceed the batch size.
- Existing profile choices stay three columns when space allows and stack below 680px.

---

### Task 1: Concurrency Validation

**Files:**
- Modify: `tests/run-service.test.js`
- Modify: `tests/routes.test.js`
- Modify: `server/run-service.js`
- Modify: `server/routes.js`

**Interfaces:**
- Consumes: `RunService.validate(input)` and `POST /api/schedules`.
- Produces: manual and schedule validation accepting `max_concurrency <= 500` while rejecting values above 500 or above the requested batch size.

- [ ] **Step 1: Write failing service tests**

Add literal boundary assertions:

```js
assert.doesNotThrow(() => ctx.service.validate({...newBatch, repeat_count: 500, execution_mode: "parallel", max_concurrency: 500}));
assert.throws(() => ctx.service.validate({...newBatch, repeat_count: 500, execution_mode: "parallel", max_concurrency: 501}), /max_concurrency/);
assert.throws(() => ctx.service.validate({...newBatch, repeat_count: 3, execution_mode: "parallel", max_concurrency: 4}), /profile count/);
assert.doesNotThrow(() => ctx.service.validate({workflow_id: "wf-1", profile_mode: "existing", profile_ids: [1, 2, 3], execution_mode: "parallel", max_concurrency: 3}));
```

- [ ] **Step 2: Write a failing schedule route test**

Submit a schedule with `profile_count: 12` and `max_concurrency: 11`; expect HTTP 201. Submit `max_concurrency: 501`; expect HTTP 400.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/run-service.test.js tests/routes.test.js`

Expected: failures mention the current 10-profile limit and missing manual batch-size rejection.

- [ ] **Step 4: Implement the boundaries**

In `RunService.validate`, validate `max_concurrency` from 1 through 500 and compare it with the new-profile `repeat_count` or existing `profile_ids.length`. In `validScheduledRun`, raise the upper limit to 500 while retaining its existing `maxConcurrency > count` rejection. Update the static invalid-request messages to match.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/run-service.test.js tests/routes.test.js`

Expected: all focused tests pass.

### Task 2: Shared Batch Controls and Balanced Layout

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/ui-contract.test.js`

**Interfaces:**
- Consumes: `selectExistingProfileIds(profiles, selection, profileId, groupId)` and the existing run payload.
- Produces: `batchSize(profileMode, profiles, selection, profileId, groupId, repeatCount): number`, shared `execution_mode`/`max_concurrency` controls, and existing batch payload settings.

- [ ] **Step 1: Write a failing batch-size test**

```js
assert.equal(batchSize("new", profiles, "profile", "", "", 500), 500);
assert.equal(batchSize("existing", profiles, "group", "", "7", 1), 2);
assert.equal(batchSize("existing", profiles, "all", "", "", 1), 3);
```

- [ ] **Step 2: Run the UI test and verify RED**

Run: `node --test tests/ui-contract.test.js`

Expected: `batchSize is not a function`.

- [ ] **Step 3: Implement shared form behavior**

Export `batchSize` from `public/app.js`. Show shared batch controls for every new-profile run and for Existing Group/All. Set the concurrency input maximum to `Math.min(500, batchSize(...))`, set a native validity error when concurrency exceeds the batch size, and include `execution_mode` plus `max_concurrency` in existing Group/All payloads.

- [ ] **Step 4: Recompose the markup and CSS**

Place Workflow and Existing Profiles in separate full-width rows. Move the current Run mode fieldset and Maximum concurrent profiles field outside `#new-profile` into `#batch-options`. Keep Existing choices three columns above 680px, stack below 680px, and change both manual and schedule concurrency inputs to `max="500"`.

- [ ] **Step 5: Run the UI test and verify GREEN**

Run: `node --test tests/ui-contract.test.js`

Expected: all UI tests pass.

### Task 3: Full Verification and Visual Review

**Files:**
- Verify: all modified files

**Interfaces:**
- Consumes: the complete implementation.
- Produces: tested and visually reviewed desktop/mobile behavior.

- [ ] **Step 1: Run automated verification**

Run: `git diff --check && npm test && npm run check`

Expected: 0 failures and exit code 0.

- [ ] **Step 2: Render and inspect**

Start the local app, inspect the Run Workflow panel at desktop and mobile widths, and confirm normal-height selects, equal Existing Profile cards, shared batch-control visibility, readable labels, and no horizontal overflow.

- [ ] **Step 3: Commit the implementation**

```bash
git add public/index.html public/app.js public/styles.css server/run-service.js server/routes.js tests/ui-contract.test.js tests/run-service.test.js tests/routes.test.js docs/superpowers/plans/2026-08-13-run-layout-concurrency.md
git commit -m "feat: expand profile batch concurrency"
```

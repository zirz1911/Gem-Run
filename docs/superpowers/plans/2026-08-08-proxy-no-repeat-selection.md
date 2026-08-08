# Proxy No-Repeat Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent random proxy selection from reusing a proxy before every currently enabled proxy has had a turn, including across separate runs.

**Architecture:** Keep the existing `last_used_at` field as the lightweight usage cursor. Change the store selection query to prefer never-used enabled proxies, then the least-recently-used enabled proxies, with `RANDOM()` only breaking ties. Keep the existing `excludedIds` filter so one repeat batch remains strictly unique; no schema migration or new global state is needed.

**Tech Stack:** Node.js ESM, better-sqlite3, SQLite transactions, `node:test`.

## Global Constraints

- Preserve encrypted proxy credentials and masked API/UI output.
- Keep the existing `pickRandomEnabled(excludedIds = [])` interface so `RunService` batch assignment remains compatible.
- Do not change manual or no-proxy modes.
- If enabled proxies are fewer than a requested batch size, keep rejecting with `not enough enabled proxies for batch`.
- Do not promise cross-process fairness; the current app uses one local SQLite-backed run service and already serializes active runs.

### Task 1: Lock down no-repeat selection behavior with store tests

**Files:**
- Modify: `tests/proxy-store.test.js` near the existing random-selection tests
- Read: `server/proxy-store.js` to match the current store API

**Interfaces:**
- Consumes: `ProxyStore.create`, `ProxyStore.pickRandomEnabled`, `ProxyStore.list`
- Produces: regression coverage proving selection order is least-recently-used across runs and unique within a batch

- [x] **Step 1: Add a test for never-used proxies taking priority**

Create three enabled proxies, pick one, then pick again. Assert the second pick is one of the two proxies whose `last_used_at` is still `null`, regardless of whether the first pick was random.

- [x] **Step 2: Add a test for a full cycle before reuse**

Create three enabled proxies. Call `pickRandomEnabled()` three times and assert all three IDs are distinct. Call it a fourth time and assert the ID belongs to the original three, proving reuse begins only after the pool is exhausted.

- [x] **Step 3: Preserve excluded-ID behavior in the regression test**

Call `pickRandomEnabled([first.id])` after creating two enabled proxies and assert the result is not the excluded ID. Keep the existing test and extend it only if needed.

- [x] **Step 4: Run the focused tests and verify they fail before implementation**

Run: `node --test tests/proxy-store.test.js`

Expected: the new no-repeat test fails because the current query uses `ORDER BY RANDOM()` without considering `last_used_at`; existing tests continue to pass.

### Task 2: Implement least-recently-used random selection

**Files:**
- Modify: `server/proxy-store.js:101-114`

**Interfaces:**
- Consumes: `pickRandomEnabled(excludedIds = [])`
- Produces: one enabled proxy, selected from never-used rows first and then oldest `last_used_at`, with the timestamp update in the existing transaction

- [x] **Step 1: Replace the selection ordering only**

Keep the existing enabled filter, normalized `excludedIds`, transaction, timestamp update, credential decryption, and return shape. Change only the `ORDER BY` to:

```sql
ORDER BY
  CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END,
  last_used_at ASC,
  RANDOM()
LIMIT 1
```

This makes all never-used rows eligible before previously used rows; among previously used rows, the oldest usage wins; `RANDOM()` still gives variation when timestamps tie.

- [x] **Step 2: Run the focused tests and verify they pass**

Run: `node --test tests/proxy-store.test.js`

Expected: PASS, including the no-repeat cycle tests and the existing encrypted-credential and exclusion tests.

### Task 3: Verify RunService integration and user-visible contract

**Files:**
- Modify: `tests/run-service.test.js` only if a missing integration assertion is identified
- Modify: `README.md` or the relevant design document only if current random-pool wording implies replacement on every run rather than no-repeat rotation

**Interfaces:**
- Consumes: `RunService.assignProxies`, `ProxyStore.pickRandomEnabled`
- Produces: verified behavior for single runs, repeat batches, insufficient pools, and unchanged proxy modes

- [x] **Step 1: Run the random/batch integration tests**

Run: `npm test -- --test-name-pattern='proxy|batch|random'`

Expected: PASS; repeat batches still assign distinct proxy IDs and still reject when the enabled pool is too small.

- [x] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: PASS with no changes to route, UI, manual proxy, or cleanup behavior.

- [x] **Step 3: Review the diff for scope and semantics**

Run: `git diff -- server/proxy-store.js tests/proxy-store.test.js README.md docs/superpowers/plans/2026-08-08-proxy-no-repeat-selection.md`

Confirm the diff contains no credential logging, schema rewrite, unrelated refactor, or change to the public method signature.

## Verification Scenarios

| Scenario | Expected result |
|---|---|
| One enabled proxy, repeated runs | Same proxy is reused because no alternative exists |
| Three enabled proxies, three random runs | All three IDs are used once before any reuse |
| Three enabled proxies, repeat batch of three | Three distinct IDs are assigned up front |
| Repeat batch larger than enabled pool | Start is rejected with `not enough enabled proxies for batch` |
| Disable a proxy | It is excluded immediately from future selection |
| Re-enable a proxy | It participates according to its existing `last_used_at` |
| Manual or no proxy mode | Behavior unchanged |

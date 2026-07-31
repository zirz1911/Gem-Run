# Gem-Run Local Workflow Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-container, localhost-only GemLogin workflow runner that can use an existing profile or create a temporary profile with a saved/random proxy, execute through the GemLogin cloud webhook, and clean up temporary profiles after success, failure, or timeout.

**Architecture:** A Node.js/Express backend serves a small static UI and owns all GemLogin calls and secrets. It talks to the GemLogin local API through `host.docker.internal:1010`, sends workflow executions to `https://app.gemlogin.io/api/v2/execscript`, and persists encrypted proxy entries plus run history in SQLite on a Docker volume.

**Tech Stack:** Node.js 22, Express, built-in `fetch`, built-in `node:test`, built-in `crypto` AES-256-GCM, SQLite via `better-sqlite3`, plain HTML/CSS/JavaScript, Docker Compose.

## Global Constraints

- The first release is one Node.js/Express application packaged as one Docker container.
- The UI binds to `127.0.0.1:3200` by default.
- GemLogin local API base is `http://host.docker.internal:1010` inside Docker.
- Cloud credentials come only from environment variables or Docker secrets; never from browser requests.
- Existing profiles are never deleted by a run.
- Temporary profiles are deleted after success, failure, or timeout only when cleanup was requested.
- Never log or return tokens, passwords, cookies, or raw proxy values.
- Keep the MVP at one active run per container; reject a second run with HTTP 409.
- Use `docker compose up -d --build` as the documented installation path.
- Do not add authentication while the app is localhost-only; require it before any non-loopback bind is documented.

---

## Task 1: Bootstrap the Node/Docker project

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `server/config.js`
- Create: `server/app.js`
- Create: `server/index.js`
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/styles.css`
- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `tests/app.test.js`

**Interfaces:**
- `server/config.js` exports `loadConfig(env)` with `gemloginBase`, `cloudBase`, `cloudDeviceId`, `cloudSoftId`, `cloudToken`, `proxyEncryptionKey`, `runTimeoutSeconds`, and `port`.
- `server/app.js` exports `createApp({config, gemloginClient, db, runService})`.
- `server/index.js` loads config, opens SQLite, creates dependencies, serves `public/`, and listens on `0.0.0.0:3200` inside the container.

- [ ] **Step 1: Write the config and health test**

```js
test("health reports the app and GemLogin status", async () => {
  const server = app.listen(0);
  const {port} = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).app, "ok");
  await new Promise((resolve) => server.close(resolve));
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/app.test.js`

Expected: FAIL because the app, config, and test harness do not exist.

- [ ] **Step 3: Add the minimal Express app and static shell**

Use `express.json({limit: "100kb"})`, `express.static("public")`, `GET /api/health`, and `GET /` serving `public/index.html`. Do not put any GemLogin credential into the HTML or JavaScript.

- [ ] **Step 4: Add package scripts and Docker files**

`package.json` must provide:

```json
{
  "type": "module",
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test",
    "check": "node --check server/index.js"
  }
}
```

Install the runtime dependencies with `npm install express better-sqlite3`.

Use `node:22-bookworm-slim`, install with `npm ci`, expose `3200`, and run as a non-root user. `compose.yaml` must publish only `127.0.0.1:3200:3200`, mount `gem-run-data:/app/data`, set `GEMLOGIN_BASE=http://host.docker.internal:1010`, and add `host.docker.internal:host-gateway` for Linux.

- [ ] **Step 5: Run the focused test and local checks**

Run: `node --test tests/app.test.js && npm run check && docker compose config`

Expected: PASS, valid JavaScript, and valid Compose configuration.

- [ ] **Step 6: Commit the bootstrap**

```bash
git add package.json package-lock.json server public Dockerfile compose.yaml .env.example .gitignore tests/app.test.js
git commit -m "chore: bootstrap gem-run docker app"
```

## Task 2: Add the GemLogin API client

**Files:**
- Create: `server/gemlogin-client.js`
- Modify: `server/config.js`
- Modify: `server/app.js`
- Modify: `tests/app.test.js`
- Create: `tests/gemlogin-client.test.js`

**Interfaces:**
- `new GemLoginClient({baseUrl, cloudBase, cloudDeviceId, cloudSoftId, cloudToken, fetchImpl})`.
- Local methods: `status()`, `listProfiles()`, `getProfile(profileId)`, `listGroups()`, `listWorkflows()`, `createProfile(details)`, `startProfile(profileId)`, `closeProfile(profileId)`, `deleteProfile(profileId)`, `checkProfileStatus(profileId)`, `checkScriptStatus(scriptId, profileId)`.
- Cloud method: `executeCloud({profileId, workflowId, parameter, closeBrowser})`.
- Every method throws an error containing HTTP status and a sanitized message, never request bodies or credentials.

- [ ] **Step 1: Write request-shape tests with a fake fetch**

```js
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {"content-type": "application/json"}
});

test("executeCloud sends the GemLogin webhook shape", async () => {
  const calls = [];
  const client = new GemLoginClient({
    cloudBase: "https://cloud.example",
    cloudDeviceId: "device",
    cloudSoftId: "1",
    cloudToken: "secret",
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return jsonResponse({success: true, run_id: "remote-1"});
    }
  });

  await client.executeCloud({profileId: 63, workflowId: "wf-1", parameter: {}, closeBrowser: true});
  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, "https://cloud.example/api/v2/execscript");
  assert.deepEqual(body.profile_id, ["63"]);
  assert.equal(body.workflow_id, "wf-1");
  assert.equal(body.close_browser, true);
  assert.equal(body.token, "secret");
});
```

- [ ] **Step 2: Run the client tests to verify they fail**

Run: `node --test tests/gemlogin-client.test.js`

Expected: FAIL because `GemLoginClient` is not defined.

- [ ] **Step 3: Implement one request helper and the local/cloud methods**

Use `fetchImpl` for testability, `encodeURIComponent` for path IDs, `JSON.stringify` for POST bodies, and `response.json()` only after checking `response.ok`. Implement the documented local endpoints exactly, including the GemLogin delete endpoint's `GET` method and the cloud body's singular `parameter` field.

- [ ] **Step 4: Sanitize exposed data**

Return workflow parameter schemas with likely-secret default values masked. Return profiles with proxy credentials masked. Never include cloud token in thrown errors or serialized response objects.

- [ ] **Step 5: Run all client tests**

Run: `node --test tests/gemlogin-client.test.js tests/app.test.js`

Expected: PASS, including request method, URL, query, body, and masking assertions.

- [ ] **Step 6: Commit the client**

```bash
git add server/gemlogin-client.js server/config.js server/app.js tests/gemlogin-client.test.js tests/app.test.js
git commit -m "feat: add GemLogin local and cloud clients"
```

## Task 3: Add SQLite persistence, proxy validation, and encryption

**Files:**
- Create: `server/database.js`
- Create: `server/proxy-store.js`
- Create: `server/crypto.js`
- Create: `tests/proxy-store.test.js`
- Modify: `server/index.js`

**Interfaces:**
- `openDatabase(filename)` creates the `proxies` and `runs` tables and returns a database handle.
- `encryptSecret(value, key)` and `decryptSecret(record, key)` use AES-256-GCM with a 32-byte key.
- `parseProxy(rawProxy)` accepts `scheme://host:port` and `scheme://host:port:username:password`, returning normalized components.
- `ProxyStore` methods: `create(input)`, `list()`, `get(id)`, `setEnabled(id, enabled)`, `replaceCredentials(id, rawProxy)`, `remove(id)`, `pickRandomEnabled()`.
- `RunStore` methods: `create(input)`, `get(id)`, `listRecent(limit)`, `update(id, patch)`, `findActive()`.

- [ ] **Step 1: Write validation and encryption tests**

```js
const key = Buffer.alloc(32, 7);

test("proxy credentials round-trip without storing plaintext", () => {
  const proxy = parseProxy("http://147.15.196.136:30955:CC:TOOD");
  const encrypted = encryptSecret(proxy.password, key);
  assert.equal(decryptSecret(encrypted, key), "TOOD");
  assert.equal(encrypted.ciphertext.includes("TOOD"), false);
});

test("invalid proxy port is rejected", () => {
  assert.throws(() => parseProxy("http://host:70000"), /port/);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test tests/proxy-store.test.js`

Expected: FAIL because storage and crypto modules do not exist.

- [ ] **Step 3: Create the SQLite schema**

Create the fields defined by the spec. Use foreign keys only where they do not prevent retaining a run record after a local proxy is removed. Store timestamps as ISO strings and booleans as integers.

- [ ] **Step 4: Implement AES-256-GCM and proxy parsing**

Require `PROXY_ENCRYPTION_KEY` to decode to exactly 32 bytes. Store `iv`, `auth_tag`, and ciphertext as base64. Support the documented GemLogin proxy format and reject missing scheme, invalid host, invalid port, or incomplete credentials.

- [ ] **Step 5: Implement stores with masked list output**

`list()` returns label, scheme, host, port, enabled, and last-used time. It never returns decrypted username/password. `pickRandomEnabled()` selects one enabled row and updates `last_used_at` in the same operation.

- [ ] **Step 6: Run persistence tests and verify the database file**

Run: `node --test tests/proxy-store.test.js`

Expected: PASS, including database creation, CRUD, random selection, encryption, and no-plaintext assertions.

- [ ] **Step 7: Commit persistence**

```bash
git add server/database.js server/proxy-store.js server/crypto.js server/index.js tests/proxy-store.test.js
git commit -m "feat: add encrypted proxy and run storage"
```

## Task 4: Implement run orchestration and cleanup

**Files:**
- Create: `server/run-service.js`
- Create: `server/status.js`
- Create: `tests/run-service.test.js`
- Modify: `server/gemlogin-client.js`
- Modify: `server/app.js`

**Interfaces:**
- `RunService.start(input)` validates the request, rejects when `findActive()` returns a run, creates a `queued` record, starts background execution, and returns the stored run.
- `RunService.get(runId)` returns a sanitized run.
- `normalizeRemoteStatus(payload)` returns `submitted`, `running`, `success`, `failed`, or `timeout`.
- `RunService` accepts injected `gemloginClient`, `proxyStore`, `runStore`, `clock`, and `sleep` dependencies for deterministic tests.

- [ ] **Step 1: Write the branching and cleanup tests**

Define a `makeContext()` test helper that returns a fake client with a `calls` array, a fake proxy store with `picked`, a fake run store, a `RunService`, and a `drain()` promise that waits for the background run to reach a terminal state. Cover these cases with concrete assertions:

```js
test("existing profile never calls create or delete", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
  await ctx.drain();
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["executeCloud", "checkScriptStatus"]);
  assert.equal(ctx.store.get("run-1").cleanup_status, "not_requested");
});

test("new profile selects a proxy, creates, executes, and deletes on success", async () => {
  const ctx = makeContext({remoteStatus: "success"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "random", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.proxyStore.picked, 1);
  assert.deepEqual(ctx.client.calls.map((call) => call.name), ["createProfile", "executeCloud", "checkScriptStatus", "closeProfile", "deleteProfile"]);
  assert.equal(ctx.store.get("run-1").status, "done");
});

test("new profile deletes after workflow failure", async () => {
  const ctx = makeContext({remoteStatus: "failed"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").status, "done");
  assert.equal(ctx.store.get("run-1").error_message, "remote workflow failed");
  assert.equal(ctx.client.calls.at(-1).name, "deleteProfile");
});

test("new profile deletes after timeout", async () => {
  const ctx = makeContext({remoteStatus: "running", runTimeoutSeconds: 0});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "workflow timed out");
  assert.equal(ctx.client.calls.at(-1).name, "deleteProfile");
});

test("cleanup failure preserves the original run result", async () => {
  const ctx = makeContext({remoteStatus: "failed", deleteError: new Error("delete failed")});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "1", proxy_mode: "none", cleanup_requested: true});
  await ctx.drain();
  assert.equal(ctx.store.get("run-1").error_message, "remote workflow failed");
  assert.equal(ctx.store.get("run-1").cleanup_status, "failed");
});

test("second active run is rejected", async () => {
  const ctx = makeContext({remoteStatus: "running"});
  await ctx.service.start({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
  await assert.rejects(() => ctx.service.start({workflow_id: "wf-2", profile_mode: "existing", profile_id: 64, cleanup_requested: false}), /active run/);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test tests/run-service.test.js`

Expected: FAIL because `RunService` and status normalization do not exist.

- [ ] **Step 3: Implement input validation and run creation**

Require `workflow_id`. Require `profile_id` for existing mode. Require profile name and group for new mode. Allow proxy modes `none`, `manual`, and `random`. Reject `cleanup_requested=true` for existing mode. Persist `queued` before making any GemLogin call.

- [ ] **Step 4: Implement new-profile creation and cloud submission**

For random mode call `pickRandomEnabled()`. For manual mode validate the one-time raw proxy and do not store it unless the user explicitly adds it to the proxy pool. Call `/api/profiles/create`, persist `created_profile_id` immediately, then call `executeCloud` with `close_browser` equal to `cleanup_requested` for new profiles.

- [ ] **Step 5: Implement status polling and timeout**

Poll the normalized remote response and the supported local script-status fallback at a fixed 2-second interval until terminal state or `RUN_TIMEOUT_SECONDS`. Do not log response bodies. Persist every state transition before performing the next action.

- [ ] **Step 6: Implement cleanup and recovery**

When cleanup is requested and `created_profile_id` exists, close the profile before deleting it, then retry deletion once. If profile creation succeeded but webhook submission or polling fails, run the same cleanup path. If the process restarts with an active run, mark it `failed` on startup and attempt cleanup for its recorded created profile.

- [ ] **Step 7: Run orchestration tests**

Run: `node --test tests/run-service.test.js`

Expected: PASS for all branches, ordering, state transitions, timeout, and cleanup behavior.

- [ ] **Step 8: Commit orchestration**

```bash
git add server/run-service.js server/status.js server/gemlogin-client.js server/app.js tests/run-service.test.js
git commit -m "feat: orchestrate workflow runs and cleanup"
```

## Task 5: Add the internal HTTP API

**Files:**
- Create: `server/routes.js`
- Modify: `server/app.js`
- Modify: `server/index.js`
- Create: `tests/routes.test.js`

**Interfaces:**
- `createRoutes({gemloginClient, proxyStore, runStore, runService})` returns an Express router.
- Read routes: `/api/health`, `/api/gemlogin/status`, `/api/gemlogin/profiles`, `/api/gemlogin/groups`, `/api/gemlogin/workflows`, `/api/proxies`, `/api/runs`, `/api/runs/:id`.
- Write routes: `/api/proxies`, `/api/proxies/:id`, `/api/gemlogin/profiles/:id/start`, `/api/runs`.

- [ ] **Step 1: Write route tests for safe response shapes**

Test that `GET /api/proxies` masks credentials, `POST /api/proxies` validates input, `POST /api/runs` passes the exact validated input to `RunService`, and `GET /api/gemlogin/workflows` masks sensitive defaults.

```js
test("run route returns 202 and forwards only allowed fields", async () => {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false, ignored: "drop"})
  });
  assert.equal(response.status, 202);
  assert.deepEqual(runService.received, {workflow_id: "wf-1", profile_mode: "existing", profile_id: 63, cleanup_requested: false});
});
```

- [ ] **Step 2: Run route tests to verify they fail**

Run: `node --test tests/routes.test.js`

Expected: FAIL because `server/routes.js` is not defined.

- [ ] **Step 3: Implement read routes**

Return only the fields required by the UI. Include profile groups for new-profile creation. Convert GemLogin upstream failures to `{error, code}` without forwarding token-bearing payloads. Return HTTP 503 for unavailable GemLogin and HTTP 404 for missing local run/proxy IDs.

- [ ] **Step 4: Implement proxy routes**

`POST /api/proxies` accepts `{label, raw_proxy, enabled}` and returns the masked row. `PATCH` accepts `{label, enabled, raw_proxy?}`. `DELETE` removes only the local proxy record. Never pass proxy credentials through a GET response.

- [ ] **Step 5: Implement run routes**

`POST /api/runs` accepts the spec-defined run input and returns HTTP 202 with the run record. Return HTTP 409 when another run is active, HTTP 400 for validation errors, and HTTP 500 only for unexpected internal failures. `GET /api/runs/:id` returns live state.

`POST /api/gemlogin/profiles/:id/start` calls the local GemLogin start endpoint and returns only the CDP address and sanitized browser metadata.

- [ ] **Step 6: Run route tests**

Run: `node --test tests/routes.test.js tests/run-service.test.js`

Expected: PASS with no secret values in any response assertion.

- [ ] **Step 7: Commit the API**

```bash
git add server/routes.js server/app.js server/index.js tests/routes.test.js
git commit -m "feat: expose local Gem-Run API"
```

## Task 6: Build the plain web UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/ui-contract.test.js`

**Interfaces:**
- The UI calls only `/api/*` endpoints.
- The UI never writes GemLogin cloud credentials to DOM attributes, localStorage, sessionStorage, or query strings.
- `public/app.js` exposes no raw proxy value after a successful save.

- [ ] **Step 1: Write the UI contract test**

Assert the HTML includes Run Workflow, Profiles, Proxy Pool, and Run History sections, and assert the JavaScript contains no cloud credential environment variable names.

- [ ] **Step 2: Run the UI contract test to verify it fails**

Run: `node --test tests/ui-contract.test.js`

Expected: FAIL because the Gem-Run dashboard markup does not exist.

- [ ] **Step 3: Build the Run Workflow panel**

Load workflows, groups, and profiles on page load. Toggle existing/new profile fields. Show proxy mode controls. Show cleanup only for new profiles. Render workflow parameters from the returned schema without rendering sensitive defaults.

- [ ] **Step 4: Build Proxy Pool and Run History panels**

Add, edit, enable/disable, and delete proxy rows. Render only masked proxy summaries. Poll `GET /api/runs/:id` every 2 seconds for the active run, then refresh history when it reaches a terminal state.

- [ ] **Step 5: Add accessible states and errors**

Use real labels, keyboard-focusable controls, `aria-live` status text, disabled submit state, confirmation before local proxy deletion, and visible errors that do not include raw upstream bodies.

- [ ] **Step 6: Run UI tests and manual static check**

Run: `node --test tests/ui-contract.test.js tests/routes.test.js`; then open `public/index.html` through the Express server and verify all four panels render without a console error.

- [ ] **Step 7: Commit the UI**

```bash
git add public tests/ui-contract.test.js
git commit -m "feat: add Gem-Run dashboard"
```

## Task 7: Finish Docker packaging and end-to-end verification

**Files:**
- Modify: `Dockerfile`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Modify: `.gitignore`
- Create: `tests/docker-smoke.sh`
- Modify: `README.md`

**Interfaces:**
- `docker compose up -d --build` starts the app.
- `GET http://127.0.0.1:3200/api/health` reports app status and GemLogin reachability.
- The named volume preserves SQLite data across container recreation.

- [ ] **Step 1: Write the Docker smoke script**

```sh
#!/bin/sh
set -eu
response=$(curl -sSf http://127.0.0.1:3200/api/health)
node -e 'if (JSON.parse(process.argv[1]).app !== "ok") process.exit(1)' "$response"
```

- [ ] **Step 2: Run the smoke script to verify the container path fails**

Run: `sh tests/docker-smoke.sh`

Expected: FAIL until the image is built and started.

- [ ] **Step 3: Harden the image and Compose configuration**

Run the process as a non-root user, keep the data directory writable, use the named volume, set the localhost-only port mapping, include the Linux host gateway, and add a Node-based healthcheck that requests `/api/health`.

- [ ] **Step 4: Add the installation README**

Document Docker prerequisites, `.env` creation, generating a 32-byte encryption key, GemLogin running on the host, `docker compose up -d --build`, health verification, and the fact that exposing the port beyond localhost requires authentication work that is not included.

- [ ] **Step 5: Run the complete verification**

Run:

```bash
npm test
npm run check
docker compose config
docker compose up -d --build
sh tests/docker-smoke.sh
docker compose down
```

Expected: all Node tests pass, Compose validates, the container serves the dashboard, health responds, and the named volume remains after shutdown.

- [ ] **Step 6: Commit packaging**

```bash
git add Dockerfile compose.yaml .env.example .gitignore README.md tests/docker-smoke.sh
git commit -m "chore: package Gem-Run for Docker"
```

## Final review checklist

- [ ] `git status --short` shows no untracked secrets or generated database files.
- [ ] `npm test` passes without network access by using fake GemLogin clients.
- [ ] The live smoke check confirms the container can reach the host GemLogin API when GemLogin is running.
- [ ] Existing-profile runs never call the delete endpoint.
- [ ] New-profile runs clean up on success, failure, and timeout when requested.
- [ ] Raw proxy credentials and cloud credentials are absent from UI storage, API responses, logs, and commits.

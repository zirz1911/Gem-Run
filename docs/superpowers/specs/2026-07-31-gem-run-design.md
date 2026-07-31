# Gem-Run Local Workflow Runner Design

## Goal

Build a self-hosted Docker web app that runs GemLogin workflows from the same machine where GemLogin is installed. A user can run a workflow against an existing profile or create a temporary profile with a manually selected or randomly selected proxy, then optionally delete that newly created profile after any terminal outcome.

## Scope

The first release includes:

- One local Node.js/Express application packaged as one Docker container.
- A browser UI bound to `127.0.0.1`.
- GemLogin local REST API integration through `host.docker.internal:1010`.
- GemLogin cloud webhook integration through `POST /api/v2/execscript`.
- Existing-profile and new-profile run modes.
- A local encrypted proxy pool with random selection.
- Run history, status polling, cleanup, and cleanup error reporting.
- SQLite persistence in a Docker volume.

The first release does not include public hosting, user accounts, roles, multi-machine coordination, or a second worker service.

## Architecture

```text
Browser at http://127.0.0.1:3200
        |
        v
Gem-Run Node/Express container
   |                    |
   |                    +--> GemLogin cloud webhook
   |
   +--> http://host.docker.internal:1010
        GemLogin local API
```

The browser calls only Gem-Run's own API. The backend owns all GemLogin credentials, decrypts proxy values only when needed, calls GemLogin, persists run state, and performs cleanup.

The app accepts one active run per container in the MVP. This is a deliberate ceiling: `ponytail: one active run, add a persistent queue when concurrent runs are required.`

## GemLogin integration

The backend uses these local endpoints:

| Purpose | Method | Endpoint |
|---|---:|---|
| Health | GET | `/api/status` |
| List profiles | GET | `/api/profiles` |
| Profile detail | GET | `/api/profile/{id}` |
| Create profile | POST | `/api/profiles/create` |
| Start profile | GET | `/api/profiles/start/{id}` |
| Close profile | GET | `/api/profiles/close/{id}` |
| Delete profile | GET | `/api/profiles/delete/{id}` |
| Profile status | POST | `/api/profiles/check-status/{id}` |
| List groups | GET | `/api/groups` |
| List workflows | GET | `/api/scripts` |

Workflow execution uses the cloud webhook:

```text
POST https://app.gemlogin.io/api/v2/execscript
```

The backend builds the request with `token`, `device_id`, `profile_id[]`, `workflow_id`, `parameter`, `soft_id`, and `close_browser`. Values come from environment variables or the run request; the token is never accepted from the browser.

The execution adapter stores non-secret response metadata. When the response exposes a remote run identifier or terminal status, the backend polls the supported status path. If the cloud response does not expose a status path, the backend falls back to the local profile/script status endpoint. A run that does not reach a terminal state before the configured timeout becomes `timeout`.

## Run lifecycle

```text
queued
  -> creating_profile       (new profile only)
  -> submitted
  -> running
  -> success | failed | timeout
  -> cleaning_up            (new profile + cleanup requested)
  -> done | cleanup_failed
```

Existing profiles never enter cleanup and are never deleted by a run.

For a new profile:

1. Validate the workflow, profile fields, and proxy selection.
2. Select a proxy from the active pool when `proxy_mode=random`.
3. Create the profile through `/api/profiles/create` and persist its returned ID immediately.
4. Submit the cloud webhook with the created profile ID.
5. Poll until `success`, `failed`, or timeout.
6. If cleanup is enabled, set `close_browser: true` for the run, wait for the run to finish, then delete the created profile.
7. If profile creation succeeds but submission fails, delete the created profile when cleanup is enabled.
8. Retry cleanup once. If deletion still fails, mark `cleanup_failed` and retain the error without hiding the original run result.

Cleanup applies to all terminal outcomes because a failed or timed-out temporary profile is still unwanted state.

## Data model

SQLite lives at `/app/data/gem-run.sqlite` in a Docker volume.

### `proxies`

- `id`
- `label`
- `scheme`
- `host`
- `port`
- `username_ciphertext` nullable
- `password_ciphertext` nullable
- `iv`
- `auth_tag`
- `enabled`
- `last_used_at` nullable
- `created_at`
- `updated_at`

The canonical proxy string is reconstructed only in backend memory for the profile-create request. The API never returns the username, password, or full raw proxy string.

### `runs`

- `id`
- `workflow_id`
- `workflow_name` snapshot
- `profile_mode` (`existing` or `new`)
- `profile_id` nullable
- `created_profile_id` nullable
- `proxy_id` nullable
- `cleanup_requested`
- `status`
- `remote_run_id` nullable
- `error_message` nullable
- `cleanup_status` (`not_requested`, `pending`, `done`, `failed`)
- `created_at`
- `started_at` nullable
- `finished_at` nullable

Workflows and profiles remain GemLogin-owned data and are fetched live rather than duplicated in SQLite.

## Internal web API

### Read endpoints

- `GET /api/health` — Gem-Run health plus GemLogin connectivity.
- `GET /api/gemlogin/status` — sanitized GemLogin status.
- `GET /api/gemlogin/profiles` — profiles with proxy credentials masked.
- `GET /api/gemlogin/workflows` — installed workflow IDs, names, and parameter schemas with sensitive defaults masked.
- `GET /api/proxies` — local proxy labels, host/port summary, enabled state, and last-used time.
- `GET /api/runs` — recent runs without secrets.
- `GET /api/runs/{id}` — one run with status and cleanup result.

### Write endpoints

- `POST /api/proxies` — validate and encrypt a proxy entry.
- `PATCH /api/proxies/{id}` — change label or enabled state; changing credentials replaces the encrypted fields.
- `DELETE /api/proxies/{id}` — remove a local proxy entry; it does not modify any GemLogin profile.
- `POST /api/runs` — validate and start one run.

The run request accepts either an existing profile ID or new-profile details, plus `proxy_mode` (`none`, `manual`, or `random`), an optional proxy ID, workflow parameters, and `cleanup_requested`.

The backend rejects a cleanup request for an existing profile rather than silently ignoring it.

## UI

### Run Workflow

- Workflow selector populated from GemLogin.
- Existing/new profile switch.
- Existing profile selector populated from GemLogin.
- New profile fields: name and group.
- Proxy mode: none, choose saved proxy, or random active proxy.
- Workflow parameter inputs from the workflow schema.
- Cleanup checkbox visible only for new profiles.
- Submit button disabled while another run is active.

### Profiles

- List profiles from GemLogin.
- Show running state and masked proxy summary.
- Start a profile when requested.
- No delete button in the existing-profile UI path.

### Proxy Pool

- Add proxy with label and proxy URL fields.
- Enable/disable entries.
- Delete local proxy entries with confirmation.
- Never show saved credentials after the initial save.

### Run History

- Show status, workflow, profile mode, profile ID, timestamps, and cleanup result.
- Show actionable error text without tokens, passwords, cookies, or raw proxy values.

## Docker and configuration

The container exposes port `3200`, published only as `127.0.0.1:3200:3200`.

Required configuration:

- `GEMLOGIN_BASE=http://host.docker.internal:1010`
- `GEMLOGIN_CLOUD_BASE=https://app.gemlogin.io`
- `GEMLOGIN_CLOUD_DEVICE_ID`
- `GEMLOGIN_CLOUD_SOFT_ID`
- `GEMLOGIN_CLOUD_TOKEN`
- `PROXY_ENCRYPTION_KEY`
- `RUN_TIMEOUT_SECONDS`

The compose file mounts a named volume at `/app/data`. The `.env.example` contains variable names and empty values only. The real `.env` is ignored by Git. On Linux, Compose adds `host.docker.internal:host-gateway`; on macOS and Windows, Docker Desktop provides the host alias.

## Security and error handling

- Bind the UI to localhost by default.
- Never accept cloud credentials from browser requests.
- Never log request bodies for create-profile, proxy, or webhook calls.
- Mask proxy and profile credential fields in all API responses.
- Encrypt saved proxy credentials with `PROXY_ENCRYPTION_KEY`.
- Validate proxy scheme, host, port, and optional credentials before storage.
- Set request timeouts for local API and cloud webhook calls.
- Preserve both the original run error and any cleanup error.
- Treat GemLogin unavailable, invalid workflow, invalid profile, rejected proxy, webhook rejection, status timeout, and cleanup failure as distinct user-visible errors.

## Verification

The implementation is complete when:

1. `docker compose up -d --build` starts the app and `http://localhost:3200` loads.
2. The health view reports GemLogin connectivity through `host.docker.internal:1010`.
3. Existing-profile mode submits the selected profile and never calls delete.
4. New-profile mode can use a saved proxy or select one randomly.
5. Cleanup deletes only the profile created by the current run on success, failure, or timeout.
6. A failed cleanup is visible in Run History.
7. No token, password, cookie, or raw proxy appears in browser storage, API responses, logs, or Git.
8. Tests cover proxy encryption/validation, run branching, status transitions, and cleanup behavior with mocked GemLogin responses.

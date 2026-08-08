# Gem-Run

Gem-Run is a local dashboard for running GemLogin workflows. It can run in Docker or directly on Windows, and can run an existing profile or create one or more temporary profiles with no proxy, a manually entered proxy, or randomly selected proxies from the saved proxy pool.

## Requirements

- GemLogin installed on the same machine
- GemLogin Local API available at port `1010`
- Node.js 22+ for native Windows runs and tests outside Docker
- Docker Desktop with Docker Compose for the Docker setup

The dashboard is bound to `127.0.0.1:3200` by default. It is intentionally local-only because this release has no user authentication.

## Windows (CMD or PowerShell)

1. Install Node.js 22+ and run `npm install` in the Gem-Run folder.
2. Run `start-windows.cmd` from CMD or PowerShell:

```powershell
.\start-windows.cmd
```

3. Open <http://127.0.0.1:3200>.

The Windows launcher opens GemLogin visibly with CDP enabled and leaves it running. If GemLogin is already ready, the launcher reuses it. If it is running without CDP and has no active profile browsers, the launcher restarts it automatically. It refuses to interrupt GemLogin when active browsers exist or status cannot be verified.

`start-windows.cmd` defaults to **Local** workflow execution for both existing and new profiles. To explicitly select the runtime endpoint, set one of the accepted values before starting:

```powershell
$env:GEMLOGIN_EXECUTION_MODE = "local" # or "cloud"
```

The default executable is `%LOCALAPPDATA%\Programs\gemlogin\gemlogin.exe`; the local API is `127.0.0.1:1010` and CDP is `127.0.0.1:9222`. Override values before starting when another Windows account, installation path, or port is used:

```powershell
$env:GEMLOGIN_EXE = "D:\Apps\GemLogin\gemlogin.exe"
$env:GEMLOGIN_BASE = "http://127.0.0.1:1010"
$env:GEMLOGIN_CDP_PORT = "9222"
$env:GEMLOGIN_CDP_BASE = "http://127.0.0.1:9222"
.\start-windows.cmd
```

Stop the dashboard with `Ctrl+C`.

## Quick start

1. Start GemLogin and make sure its Local API is available.
2. Configure the local environment file. `.env` is ignored by Git and must never be committed.

```dotenv
GEMLOGIN_BASE=http://host.docker.internal:1010
GEMLOGIN_CLOUD_BASE=https://app.gemlogin.io
GEMLOGIN_CLOUD_DEVICE_ID=
GEMLOGIN_CLOUD_SOFT_ID=1
GEMLOGIN_CLOUD_TOKEN=
PROXY_ENCRYPTION_KEY=
RUN_TIMEOUT_SECONDS=300
```

3. Build and start Gem-Run:

```sh
docker compose up -d --build
```

4. Open <http://127.0.0.1:3200>.
5. Open **Settings** and save the GemLogin Cloud values.

Docker Compose explicitly uses **Cloud** workflow execution for both existing and new profiles. It still requires the GemLogin Cloud settings above.

Check the installation:

```sh
curl -sSf http://127.0.0.1:3200/api/health
sh tests/docker-smoke.sh
```

## GemLogin profile refresh bridge

GemLogin's REST API creates and deletes profiles in its database, but its Electron profile list keeps an in-memory store. New profiles and deleted profiles are not visible to the workflow runner until GemLogin's **Refresh profile list** action is triggered.

For new-profile runs, Gem-Run triggers that action automatically through the GemLogin renderer using Chrome DevTools Protocol (CDP). GemLogin must be started with a DevTools port. Docker runs the included bridge automatically; no host Node.js process is required.

Start GemLogin with:

```text
--remote-debugging-port=9222
```

Then start Docker. Compose starts the bridge and waits until GemLogin's CDP endpoint is reachable:

```sh
docker compose up -d --build
docker compose ps
```

The bridge has no authentication and is only reachable inside the Docker network. Do not add a public port mapping for it.

## Using the dashboard

### Scheduled profiles

Use **Scheduled Profiles** to select a workflow and configure an automatic new-profile batch. Set the maximum number of profiles and choose **Fixed** or **Random**; Random selects a number from 1 through the maximum on each execution. Choose whether temporary profiles are deleted and whether browsers are closed after the workflow.

Schedules have persistent **Active** and **Deactive** controls and per-schedule run history. A Manual run pauses schedule dispatch without changing the schedule's Active/Deactive state. After the Manual run finishes, due Active schedules resume automatically. Schedule data and encrypted payloads live in the `gem-run-data` volume.

The scheduler polls every 15 seconds by default. Change `SCHEDULE_POLL_INTERVAL_SECONDS` in `.env` if needed.

### Existing profile

Select an existing profile and a workflow, then run it. The existing-profile path uses the configured GemLogin cloud webhook.

### New profile

Select **New profile**, enter a name and group, then choose the number of profiles/rounds and:

- **None**: no proxy
- **Manual**: one proxy value
- **Random**: one enabled proxy from the saved proxy pool

For more than one round, names receive a suffix such as `Paji-01`, `Paji-02`. Choose **One by one** for sequential execution or **Parallel** with a maximum concurrency. Start with a concurrency of `2`; each round has its own profile, workflow status, and cleanup result. Random proxy mode reserves a different enabled proxy for each round and fails before creating profiles if the pool is too small.

The run sequence is:

```text
create profile -> open profile -> refresh GemLogin list -> execute workflow -> poll status
```

### Batch run lifecycle

Each new-profile round follows the same lifecycle independently:

```text
create -> open -> refresh -> execute -> poll -> close/delete (if cleanup is enabled)
```

Enable cleanup to close and delete the temporary profile after the workflow finishes. Gem-Run also refreshes the GemLogin profile list after deletion, so the deleted profile disappears without a manual refresh.

Parallel rounds share one serialized GemLogin profile-list refresh so the Electron UI does not receive competing refresh commands. Gem-Run still allows only one active batch at a time.

### Proxy formats

The proxy editor accepts one value per line. Blank lines are ignored, and `http://` is optional.

```text
147.15.196.136:30955:CC:TOOD
http://147.15.196.136:30956:CC:TOOD
```

Proxy credentials are encrypted in the local SQLite database and masked in API responses and the UI.

## Data and lifecycle

- SQLite data is stored in the `gem-run-data` Docker volume.
- `docker compose down` keeps the volume.
- `docker compose down -v` deletes local Gem-Run data and should only be used intentionally.
- `.env`, database files, proxy encryption keys, and session data must stay local.

Stop the container:

```sh
docker compose down
```

## Development

Run the test suite and syntax checks:

```sh
npm test
npm run check
git diff --check
```

The project uses Node's built-in test runner, Express, and better-sqlite3. No external database or cloud service is required for the local dashboard.

## API overview

Gem-Run exposes its local dashboard API on port `3200`:

- `GET /api/health` — service and GemLogin health
- `GET /api/gemlogin/profiles` — profiles from GemLogin
- `GET /api/gemlogin/groups` — profile groups from GemLogin
- `GET /api/gemlogin/workflows` — workflows from GemLogin
- `GET /api/proxies` — saved proxy pool
- `POST /api/proxies` — add a proxy
- `POST /api/runs` — queue a workflow run
- `GET /api/runs` — run history
- `GET /api/settings` — configured setting flags
- `PATCH /api/settings` — save encrypted cloud settings

GemLogin remains the source of truth for profiles and workflows. Gem-Run stores only its run history, proxy pool, and encrypted local settings.

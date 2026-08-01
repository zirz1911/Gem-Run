# Gem-Run

Gem-Run runs GemLogin workflows from the same machine that runs GemLogin. The dashboard is deliberately published only on `127.0.0.1:3200`.

## Run with Docker

Prerequisites: Docker with Docker Compose, and GemLogin running on the host with its local API available on port `1010`.

Start the app; it generates the local encryption key inside the named Docker volume on first run:

```sh
docker compose up -d --build
```

Open `http://127.0.0.1:3200`, open **Settings**, and enter the GemLogin cloud values. They are encrypted in the local database and are never returned to the browser.

Start the app and verify it:

```sh
curl -sSf http://127.0.0.1:3200/api/health
sh tests/docker-smoke.sh
docker compose down
```

The `gem-run-data` named volume retains the SQLite database when containers are recreated; `docker compose down` does not remove it. Use `docker compose down -v` only when intentionally deleting local Gem-Run data.

## Security boundary

No authentication is included because this release is restricted to localhost. Do not change the `127.0.0.1:3200:3200` mapping to a non-loopback address until authentication and its associated security review are implemented.

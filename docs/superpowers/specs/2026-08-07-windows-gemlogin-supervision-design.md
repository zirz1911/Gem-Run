# Windows GemLogin Supervision Design

## Goal

Starting Gem-Run on Windows also leaves a visible GemLogin window running with its renderer CDP endpoint enabled, including when GemLogin was previously opened without the required CDP flag.

## Startup behavior

The Windows launcher delegates GemLogin readiness to a Node.js supervisor owned by Gem-Run. The supervisor uses PowerShell only to inspect and close exact Windows process IDs. It uses the configured local API and CDP endpoints and follows this order:

1. If the CDP `/json/version` endpoint is healthy, keep the existing GemLogin process unchanged.
2. If GemLogin is running without CDP, read `/api/status`.
3. If `activeBrowsers` is greater than zero, stop with a clear message and do not close GemLogin.
4. If `activeBrowsers` is zero, close the existing GemLogin process, waiting for it to exit before continuing.
5. Start the configured GemLogin executable visibly with `--remote-debugging-port=<port>`.
6. Wait until both the local API and CDP endpoints are healthy, then start Gem-Run.

GemLogin runs independently of the Gem-Run console and remains open if Gem-Run exits. The helper never edits GemLogin binaries, configuration, profile data, or installation files.

## Portability

Defaults match the standard Windows installation:

- `GEMLOGIN_EXE=%LOCALAPPDATA%\Programs\gemlogin\gemlogin.exe`
- `GEMLOGIN_BASE=http://127.0.0.1:1010`
- `GEMLOGIN_CDP_PORT=9222`
- `GEMLOGIN_CDP_BASE=http://127.0.0.1:9222`

Every value remains overridable through environment variables so another Windows account or installation path can use the same launcher.

## Safety and errors

- Never restart GemLogin while its API reports active browser profiles.
- If GemLogin status cannot be read, do not terminate the process.
- Target only `gemlogin.exe` processes; do not stop profile browser processes.
- Attempt a normal window close first. Force-stop remaining GemLogin renderer processes only after the API confirmed `activeBrowsers=0`.
- Fail before starting Gem-Run when the executable is missing or API/CDP readiness times out.
- Error messages state the exact corrective action without exposing tokens, cookies, proxy credentials, or profile fields.

## Testing

- Add cross-platform unit tests for the startup decision branches and CDP argument validation.
- Exercise real Windows process startup, shutdown, visibility, and readiness behavior in the Windows smoke test.
- Run `npm test` and `npm run check`.
- On Windows, verify these scenarios:
  - GemLogin already running with CDP: no restart.
  - GemLogin absent: visible startup with CDP.
  - GemLogin running without CDP and no active browsers: automatic restart with CDP.
  - A new-profile `Test Gem Run` execution succeeds and profile refresh is visible.

No commit or push is performed for this change until the Windows smoke test passes and the user explicitly requests it.

# Windows Local Execution Mode Design

**Date:** 2026-08-08

## Problem

Gem-Run previously submitted new-profile workflows through GemLogin's Local API. Commit `6831907` changed every workflow submission to the GemLogin Cloud webhook. Mac Docker has the required Cloud configuration and continues to work, but Windows native has no Cloud device ID, soft ID, or token, so the webhook rejects submissions with HTTP 400.

Windows native must use the Local API for both existing and newly created profiles. Mac Docker must retain its current Cloud webhook behavior.

## Execution Mode

Add one explicit runtime setting named `GEMLOGIN_EXECUTION_MODE` with exactly two accepted values:

- `local`: submit every workflow through `GemLoginClient.executeLocal()`.
- `cloud`: submit every workflow through `GemLoginClient.executeCloud()`.

The application configuration defaults to `cloud` to preserve existing Docker and Mac behavior for callers that do not set the new variable. Invalid values fail configuration loading with a static, non-secret error.

`start-windows.cmd` sets `GEMLOGIN_EXECUTION_MODE=local` only when the caller has not already supplied a value. `compose.yaml` sets the container value to `cloud` explicitly. This makes the supported launch paths self-describing without using an implicit operating-system check or credential-dependent fallback.

## Data Flow

`server/config.js` validates and exposes the execution mode. `server/index.js` passes it to `RunService`. `RunService` selects one client method for workflow submission:

- Local mode sends `profileId`, `workflowId`, `parameter`, and `closeBrowser` to `executeLocal()`. The client preserves GemLogin's Local API request shape: `profileId` as an array, `parameters` as an object, and `closeBrowser` as a boolean.
- Cloud mode sends the same logical inputs to `executeCloud()`, which preserves the existing Cloud webhook request shape and credentials.

Profile creation, profile startup, CDP refresh, status polling, cancellation, deadlines, and cleanup remain unchanged. Both manual and scheduled runs use the same configured `RunService`, so Windows Schedule executions also use Local API.

## Error Handling and Safety

Gem-Run does not fall back from Cloud to Local after a failed submission. Automatic fallback could submit the same workflow twice when the first request reaches GemLogin but its response is lost. A configured mode therefore selects exactly one endpoint per run.

HTTP errors remain sanitized. No Cloud values are copied, logged, or added to Windows. Temporary-profile cleanup continues after submission failure, workflow failure, cancellation, and timeout.

## Compatibility

- Windows native launched with `start-windows.cmd`: Local API for existing and new profiles.
- Mac Docker launched with Compose: Cloud webhook for existing and new profiles.
- Direct `npm start` without `GEMLOGIN_EXECUTION_MODE`: Cloud mode for backward compatibility.
- Callers may explicitly override the launcher default before starting Windows when diagnosing another supported configuration.

No database migration or stored-run format change is required.

## Testing

Automated regression coverage will prove:

1. Configuration accepts `local` and `cloud`, defaults to `cloud`, and rejects any other value.
2. Local mode routes both existing-profile and new-profile workflow submissions only to `executeLocal()`.
3. Cloud mode routes both profile modes only to `executeCloud()`.
4. `start-windows.cmd` supplies the Local mode default without overriding an existing value.
5. Compose explicitly supplies Cloud mode.
6. Existing failure, timeout, cancellation, and cleanup tests remain green.

Windows runtime verification will run the `[SEO] Google Search 1.0.1` workflow manually in Local mode, verify its parameter schema reaches GemLogin unchanged, and confirm temporary-profile cleanup. If the reported failure originated from Schedule execution, an equivalent Schedule run will also be verified without deleting existing schedules or profiles.

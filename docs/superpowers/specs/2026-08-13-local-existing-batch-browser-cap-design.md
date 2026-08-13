# Local Existing Batch Browser Cap Design

## Problem

On Windows, Gem-Run uses GemLogin Local execution. `max_concurrency` currently limits the number of workers waiting for workflows, but an Existing Profile batch can leave completed browsers open when `close_browser` is false. The next queued profiles then start correctly within the worker limit while the total number of open browser windows keeps growing.

Runtime evidence from the affected machine showed:

- A batch with `close_browser=true` had a maximum of 5 overlapping workers when configured for 5.
- The latest batch had `close_browser=false`, a maximum of 10 overlapping workers, and 31 successful runs before cancellation. Its worker concurrency was correct, but completed browsers were retained.

## Scope

Enforce browser closure only when all of these conditions are true:

- GemLogin execution mode is `local`.
- Profile mode is `existing`.
- The request contains more than one profile, meaning Group or All selection.

Local runs for one existing profile remain user-controlled. New Profile behavior remains unchanged. Cloud execution remains unchanged so Mac/Docker behavior is preserved.

## Server Behavior

The server is the source of truth. For a Local Existing Profile batch it will persist `close_browser=true` for every run and send `closeBrowser: true` to GemLogin regardless of the submitted checkbox value.

A worker continues to own its concurrency slot through browser closure. Once a Local execute attempt has begun, every terminal path—success, remote failure, timeout, cancellation, or submit failure—will make one bounded `closeProfile(profile_id)` call before `execute()` returns and the worker can take the next queued profile.

The close call uses the existing cleanup timeout. A close failure must not overwrite the workflow result, but it is exposed as `cleanup_status=failed`; a successful close is recorded as `cleanup_status=done`.

Queued runs cancelled before Local execute is attempted must not call `closeProfile`, because Gem-Run did not open those profiles. Their cleanup status stays `not_requested`.

## Dashboard Behavior

`GET /api/health` will expose the non-sensitive configured execution mode. When the dashboard is in Local mode and Existing Profile Group/All is selected, the Close browser checkbox is checked and disabled to show that closure is mandatory. It becomes user-controlled again for One Profile and non-Local modes.

This UI behavior is advisory; the server still enforces the rule for API clients and stale browser tabs.

## Error Handling

- Workflow status and error reporting retain their current meaning.
- Browser-close failure is reported through cleanup status and does not turn a successful workflow into a failed workflow.
- Browser closure is deadline-bounded so an unavailable GemLogin close endpoint cannot block a batch forever.
- No retry or concurrency change is introduced.

## Regression Tests

Automated tests will prove that:

1. Local Existing Profile batches override `close_browser=false`, submit with `closeBrowser=true`, and close each dispatched profile.
2. With concurrency 1, the second profile is not submitted until the first profile's close call completes.
3. Failed, timed-out, and cancelled dispatched runs still attempt browser closure.
4. Queued runs cancelled before dispatch do not close an untouched existing profile.
5. Local one-profile and Cloud batch behavior remain unchanged.
6. The dashboard displays forced closure only for Local Existing Group/All.

## Acceptance Criteria

- On Windows Local Existing Group/All, the number of browsers opened by the active batch does not accumulate beyond its worker concurrency during normal operation.
- A queued profile is not dispatched until the prior profile assigned to that worker has completed its bounded close step.
- Windows manual verification passes for concurrency 1 and the user's actual concurrency.
- `npm test`, `npm run check`, and `git diff --check` pass.

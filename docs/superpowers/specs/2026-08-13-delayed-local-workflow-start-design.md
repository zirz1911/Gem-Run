# Delayed Local Workflow Start Design

## Goal

Keep a parallel worker assigned to its current profile while a GemLogin Local workflow is slow to start, while excluding queue wait time from that profile's run timeout.

## Behavior

- A queued run has no `started_at` timestamp and consumes no run timeout.
- When a worker takes the run, it records `started_at` and creates that run's deadline.
- After Local execute succeeds, `not_running` is treated as pending until the run deadline. The fixed 15-second startup failure does not apply to Local mode.
- The worker does not take another profile until the current workflow reports running then stops, reports a terminal result, is cancelled, or reaches the run deadline.
- Cloud mode keeps its existing 15-second startup behavior.
- Requested parallelism remains unchanged; Parallel 5 means no more than five active workers.

## Tests

- A queued run gets its full timeout after a worker takes it.
- A Local workflow that remains `not_running` past 15 seconds and then runs completes without releasing its worker early.
- A Local workflow that never starts still times out at the normal run deadline.
- Cloud mode continues to fail an unstarted workflow at the existing startup deadline.

## Scope

Only `RunService` timing and its regression tests change. Request payloads, GemLogin API schemas, UI concurrency selection, and Cloud transport remain unchanged.

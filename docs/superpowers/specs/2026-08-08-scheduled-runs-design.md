# Scheduled Runs Design

## Behavior

Gem-Run stores schedules in SQLite and executes them from the existing Node process. A schedule is Active by default and can be made Deactive without cancelling a workflow already in progress.

While a Manual run is active, the scheduler does not claim or start any schedule. Due schedules remain pending. After the Manual run reaches `done`, the next scheduler tick resumes and starts the oldest due Active schedule.

## Profile batch settings

Scheduled runs use new profiles and store the following configuration in an encrypted payload:

- Workflow and workflow parameters
- Profile name, group, and proxy mode
- Maximum `profile_count` from 1 to 100
- `profile_count_mode`: `fixed` or `random`
- `delete_profile` and `close_browser`

For `random`, each scheduled execution selects an integer from `1..profile_count`. The actual count is passed to the existing `RunService` as `repeat_count` and recorded in run history.

Deleting a temporary profile always closes its browser first. `close_browser` controls browser closure when the profile is retained.

## History and API

Each run row stores `schedule_id`, source, batch metadata, configured count, count mode, and actual count. `GET /api/schedules/:id/runs` returns sanitized history; encrypted payloads and secrets are never returned.

The schedule API supports list, create, update, Active/Deactive, run-now, per-schedule history, and delete. Run-now requires the schedule to be Active and still respects the one-active-run ceiling.

## Restart policy

One-time schedules remain due until they execute or are Deactive. Recurring schedules advance to the next future occurrence and do not replay every missed occurrence after downtime. Docker uses `restart: unless-stopped`; Windows users can launch `start-windows.cmd` through Task Scheduler.

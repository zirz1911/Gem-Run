# Schedule Concurrency and Layout

## Reusable Pattern

For scheduled batches, model the total requested work separately from the maximum simultaneous work. Persist the total as profile_count, persist the worker limit as max_concurrency, derive parallel mode when the limit is greater than one, and let the worker pool process the final remainder naturally.

## Failure Mode / Trigger

Two UI failures appear when variable-height content is placed inside a control group: action buttons stretch to the height of history, and helper text inside one form field makes paired inputs look vertically misaligned. These issues are especially visible when history contains several entries.

## Concrete Future Rule

Keep history and actions as separate layout regions. Give paired controls an explicit shared input height, and enforce max_concurrency <= profile_count in both the browser and the server. Add a visual contract or screenshot check whenever a change is specifically about alignment or scrolling.

## Concepts / Tags

#gem-run #schedule #concurrency #batch-processing #ui-layout #scrolling #validation

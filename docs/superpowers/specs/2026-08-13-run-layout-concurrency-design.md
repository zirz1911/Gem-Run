# Run Layout and Concurrency Design

## Goal

Make the Run Workflow form visually balanced and let capable machines run more than ten profiles concurrently.

## Layout

- Place Workflow on a full-width row.
- Place Existing Profiles on the next full-width row.
- Keep One profile, Group, and All profiles as three equal-width choices on desktop and stack them on mobile.
- Keep the selected profile/group field directly below those choices.
- Use one shared Run mode and Maximum concurrent profiles section for both new-profile and existing-profile batches.
- Hide shared batch controls for a single existing profile.

## Behavior

- Existing Group and All selections support Sequential and Parallel execution.
- Parallel mode exposes Maximum concurrent profiles.
- Manual new-profile, existing-profile, and scheduled-profile concurrency allow values from 1 through 500.
- Concurrency cannot exceed the selected profile count or new-profile round count.
- Existing single-profile runs preserve their current request shape and behavior.

## Implementation

- Recompose the existing HTML; do not add a component or dependency.
- Reuse the current `execution_mode` and `max_concurrency` controls outside the new-profile-only container.
- Extend form synchronization to calculate the active batch size and update native input validity and limits.
- Include execution settings when submitting an existing Group or All batch.
- Raise backend manual and schedule validation limits from 10 to 500 and reject concurrency above the batch size.

## Responsive and Accessibility

- Keep three Existing Profiles choices in one row when the full-width panel has room.
- Stack choices and form fields below 680px.
- Preserve semantic fieldsets, legends, labels, native required validation, keyboard controls, and visible focus styles.

## Verification

- Regression tests cover manual limits at 500/501, concurrency above batch size, existing batch concurrency forwarding, and scheduled concurrency limits.
- Run the full Node test suite and syntax check.
- Render the dashboard at desktop and mobile widths and inspect alignment, visibility, and field sizing.

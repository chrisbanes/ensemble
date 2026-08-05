# Run GitHub Project

## Repository

- Host: `github.com`
- Repository: `chrisbanes/ensemble`
- Default branch: `main`
- Base branch: `main`

## Project

- Owner: `chrisbanes`
- Number: `6`
- URL: `https://github.com/users/chrisbanes/projects/6`
- Node ID: `PVT_kwHOAAN4ns4BatgH`
- Filter: `none`
- Execution approver logins: `chrisbanes`

## Status

- Field name: `Status`
- Field ID: `PVTSSF_lAHOAAN4ns4BatgHzhVjFtY`
- Backlog name: `Backlog`
- Backlog option ID: `f75ad846`
- Planning name: `Planning`
- Planning option ID: `cc2b7773`
- Ready to implement name: `Ready to implement`
- Ready to implement option ID: `0732c167`
- In progress name: `In progress`
- In progress option ID: `47fc9ee4`
- Done name: `Done`
- Done option ID: `98236657`

## Triage

- Needs-triage label: `needs-triage`

## Work Roles

- Epic label: `epic`
- Epic label ID: `LA_kwDORzdwYM8AAAACuWX7NA`
- Auto-close epic label: `auto-close-epic`
- Auto-close epic label ID: `LA_kwDORzdwYM8AAAACu3F6Tg`
- Human-work label: `ready-for-human`
- Human-work label ID: `LA_kwDORzdwYM8AAAACuAxOsQ`

Epics are not auto-closed by default. Applying `auto-close-epic` delegates
closure authority to `.github/workflows/auto-close-epics.yml`. When an issue
closes, that workflow walks its same-repository native parent chain and closes
an open parent only when the parent also has `epic`, has at least one native
sub-issue, every native sub-issue is closed, and no native blocker remains open.
Missing metadata fails closed. The workflow then continues up the chain so
opted-in nested epics can complete in one serialized run. Cross-repository
parents are logged and left open because the repository workflow token does not
have authority outside this repository.

Do not apply `auto-close-epic` to coordination issues with completion gates that
are not fully represented by native sub-issues and blockers.

## Priority

- Field name: `Priority`
- Field ID: `PVTSSF_lAHOAAN4ns4BatgHzhVjFxQ`
- Options in descending order:
  1. `P0`: `79628723`
  2. `P1`: `0a877460`
  3. `P2`: `da944a9c`

## Merge Policy

- Method: `squash`
- Issue closure: `closing-keyword`
- Required reviews: `none`
- Required checks: `Check, Test, Clippy, Format`; `Frontend Test and Build`;
  `Tauri PR (Linux)`; `Tauri PR (Mac)`
- Done automation: `set-status`
- Automation description: Enabled Project workflows `Item closed` and
  `Pull request merged`; verified that merged-and-closed issue #182 moved from
  `In progress` to `Done` through `github-project-automation` and remained
  unarchived. Repository workflow `Auto-close epics` closes explicitly opted-in
  epic issues after their native sub-issues and blockers complete; `Item closed`
  then projects the epic to `Done`.

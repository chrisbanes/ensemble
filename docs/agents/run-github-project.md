# Run GitHub Project

Verify this Project metadata and the merge requirements against live GitHub state
before execution. The TypeScript implementation runs the `check` job in
`.github/workflows/ci.yml`; required checks must still be verified from the target
branch's live protection rules and rulesets.

The [standalone delivery issues](https://github.com/chrisbanes/ensemble/issues/649) own current
scope, sequencing and slice completion criteria; native dependencies govern dispatch.
Do not maintain a parallel repo delivery plan. A stale ready label on a historical
T01–T12 ticket does not authorize implementing the retired BB path: reconcile its
live scope and capability dependencies with the delivery issues before dispatch.

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

## Status

- Field name: `Status`
- Field ID: `PVTSSF_lAHOAAN4ns4BatgHzhVjFtY`
- Backlog name: `Backlog`
- Backlog option ID: `f75ad846`
- Todo name: `Todo`
- Todo option ID: `cc2b7773`
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
- Human-work label: `ready-for-human`
- Human-work label ID: `LA_kwDORzdwYM8AAAACuAxOsQ`

## Priority

- Field name: `Priority`
- Field ID: `PVTSSF_lAHOAAN4ns4BatgHzhVjFxQ`
- Options in descending order:
  1. `P0`: `79628723`
  2. `P1`: `0a877460`
  3. `P2`: `da944a9c`
  4. `P3`: `23871b8a`

## Merge Policy

- Method: `squash`
- Issue closure: `closing-keyword`
- Required reviews: `none`
- Required checks: Resolve from the target branch's live protection rules and
  rulesets before execution; do not assume an empty set while new CI is pending.
- Done automation: `set-status`
- Automation description: Project workflows `Item closed` and `Pull request merged`
  are enabled; a merged-and-closed issue moves from `In progress` to `Done`
  through `github-project-automation` and remains unarchived.

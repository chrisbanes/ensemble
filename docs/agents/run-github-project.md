# Run GitHub Project

Project metadata is retained from the previous implementation. Verify it and merge
requirements against live GitHub state before execution. The TypeScript implementation runs the `check` job in `.github/workflows/ci.yml`;
required checks must still be verified from the target branch's live protection
rules and rulesets.

The [standalone delivery issues](https://github.com/chrisbanes/ensemble/issues/649) own current
scope, sequencing and slice completion criteria; native dependencies govern dispatch.
They supersede the BB delivery architecture. Do not maintain a parallel repo delivery plan.
Before dispatching a historical T01–T12 ticket, reconcile its live scope and
capability dependencies with S01–S08. A stale ready label does not authorize
implementing the retired BB path. This note does not change remote Project state.

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

## Agent Setup

- Routing: `typesafe`
- Default planner profile: `workhorse-owner`
- Default ticket profile: `fast-worker`
- TypeSafe judgment model: `jev-1.13.0`

| Profile | Capability | Best suited to | Runtime role | Execution model | Reasoning |
| --- | --- | --- | --- | --- | --- |
| `frontier-owner` | `default-owner` | Ambiguous, architectural, or high-risk ownership | `default` | `gpt-6-astra` | `high` |
| `workhorse-owner` | `default-owner` | Ordinary substantive planning and implementation | `default` | `gpt-6-sol` | `high` |
| `fast-worker` | `default-owner` | Bounded implementation after an approved plan | `worker` | `gpt-6-luna` | `max` |
| `evidence-investigator` | `read-only-evidence` | Repeated non-CI failure investigation | `investigator` | `gpt-6-sol` | `high` |
| `codebase-explorer` | `read-only-discovery` | Targeted repository discovery | `explorer` | `gpt-6-luna` | `high` |
| `exceptional-investigator` | `exceptional-investigator` | Qualifying unresolved technical questions | `investigator` | `gpt-6-sol` | `high` |

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
- Automation description: Enabled Project workflows `Item closed` and
  `Pull request merged`; verified that merged-and-closed issue #182 moved from
  `In progress` to `Done` through `github-project-automation` and remained
  unarchived.

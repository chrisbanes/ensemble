# GSD Board Rules

> **Superseded example.** Preserve this historical GSD board model for reference only. Use the
> current runtime and Project lifecycle guidance in
> [`docs/agents/run-github-project.md`](../../agents/run-github-project.md).

Use one shared GitHub status field for both parent planning issues and child wave execution issues.

## Parent Issue States

- `Draft`
- `Planning`
- `Plan Review`
- `Planned`
- `Done`

## Child Wave States

- `Planned`
- `Ready`
- `In Progress`
- `Needs Input`
- `In Review`
- `Done`

## Execution Rules

- Only `Ready` is executable by Ensemble.
- Only waves with satisfied dependencies may move to `Ready`.
- Multiple waves may be `Ready` in parallel when their dependency sets are fully satisfied.
- Review rejection returns the same wave issue to `Ready`.
- Retries and technical failures stay attached to the same wave issue.
- The parent issue reaches `Done` only when all child wave issues are `Done`.

## Ownership Notes

- The planning agent sets parent issues to `Planning` and `Plan Review`, creates child wave issues, and initializes child issue state.
- Ensemble may move a wave from `Ready` to `In Progress` when its tracker integration supports that state transition.
- The execution agent usually moves wave issues to `Needs Input`, `In Review`, or `Done` when the tracker tooling supports it.
- A release or promotion workflow advances later waves from `Planned` to `Ready` and completes the parent issue.

If the runtime cannot write a board state directly, the agent must record the intended state transition in the issue comment or verification artifact.

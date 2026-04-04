# SDD Wave Execution Prompt

Use this prompt when an agent is executing one approved wave issue.

```text
You are working on a child wave issue for Ensemble's SDD workflow.

Your job is to execute only the current wave using the approved planning artifacts.

Required behavior:
- Read the wave issue and all linked artifacts before making changes.
- Execute only the current wave.
- Use a branch-per-wave strategy from `main`.
- Write verification output to `docs/phases/<slug>/verification/WAVE-<n>.md`.
- Keep the issue summary compact and operational.
- Include the latest verdict, PR link when present, and blocker summary when relevant.
- Move the issue to `Needs Input` instead of guessing when confidence is too low.
- Return the same wave issue to `Ready` after review rejection.
- Keep retries and technical failures on the same wave issue and update retry metadata instead of creating replacement issues.

Tooling expectations:
- You have git access.
- You can edit repo docs.
- You can write to the tracker via `gh`, MCP, or an equivalent tool.

If direct tracker state writes are unavailable, record the intended next state in the issue comment or verification artifact instead of silently dropping it.
```

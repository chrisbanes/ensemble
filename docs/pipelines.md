# Pipeline Guide

A pipeline is a directed acyclic graph (DAG) of steps that Ensemble runs for each issue. Each step invokes a named agent, collects a verdict, and decides what happens next.

## Steps and agents

Each step references an agent defined in `config.yaml`:

```yaml
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid

steps:
  - name: build
    agent: builder
```

The `templates/` directory is relative to your configuration directory. See [Configuration Reference](configuration.md) for details on config directory resolution.

When a step runs, Ensemble:
1. Renders the agent's prompt template with the issue context
2. Launches the agent in the issue's workspace directory
3. Waits for the agent to finish
4. Collects a verdict (approve or reject)

## Sequential and parallel steps

**Sequential (default):** Steps run one after another in list order. Each step implicitly depends on the one before it.

```yaml
steps:
  - name: build      # runs first
    agent: builder
  - name: test       # runs after build
    agent: tester
  - name: review     # runs after test
    agent: reviewer
```

**Parallel:** Use `depends` to create branches. Steps with the same dependencies run in parallel.

```yaml
steps:
  - name: build
    agent: builder
    depends: []           # root step — no dependencies
  - name: lint
    agent: linter
    depends: []           # also a root step — runs parallel to build
  - name: review
    agent: reviewer
    depends:
      - build             # waits for both build and lint
      - lint
```

This creates:

```
build ──┐
        ├──> review
lint  ──┘
```

The `depends` field overrides the default sequential behavior:
- Omit `depends` → depends on the previous step in the list
- `depends: []` → no dependencies (root step, starts immediately)
- `depends: [step1, step2]` → waits for the named steps

## Tracker state transitions

Steps can optionally write a tracker state when they start:

```yaml
steps:
  - name: build
    agent: builder
    tracker_state: Building
  - name: review
    agent: reviewer
    tracker_state: In Review
```

When the full pipeline completes, Ensemble writes `on_success` or `on_failure` to the tracker.

A typical lifecycle looks like:

```
Todo → Building → In Review → Done
                            → Failed
```

## Verdicts

After an agent finishes, Ensemble resolves verdicts with this strict precedence:

1. **Runtime verdict (primary)** — if the runtime reports a parseable structured verdict, Ensemble uses it.
2. **File fallback** — only when no runtime verdict is available, Ensemble checks `.ensemble/verdict.json`:

```json
{
  "verdict": "approve"
}
```

or:

```json
{
  "verdict": "reject",
  "summary": "Tests are failing — 3 test cases need fixes"
}
```

3. **Default approve** — if neither source provides a verdict, the step is treated as approved.

If both runtime and file verdicts exist, runtime verdict takes precedence and file verdict is ignored.

By default, Ensemble appends fallback verdict instructions to rendered prompts (`agent.inject_verdict_fallback_instructions: true`, alias `agent.inject_verdict_instructions`), so users do not need to manually add `.ensemble/verdict.json` instructions in their templates.

**Approve** means the step passed. The pipeline moves to the next step (or completes).

**Reject** means the step failed. The `summary` field explains why. Ensemble transitions the issue to `on_failure` state, or retries if cycles remain.

## Retries and cycles

When a step rejects or an agent errors out, Ensemble can retry the entire pipeline. The `max_cycles` setting controls how many times:

```yaml
max_cycles: 3  # default
```

- Cycle 1: Initial run
- Cycle 2: First retry (if cycle 1 failed)
- Cycle 3: Second retry (if cycle 2 failed)
- After cycle 3: Issue moves to `on_failure` state

Retries use exponential backoff: 10s, 20s, 40s, ... capped at `agent.max_retry_backoff_ms` (default 5 minutes).

The workspace persists across retries, so agents can see previous work and build on it. The `attempt` variable is available in prompt templates for retry-aware prompts.

## Example: build + review pipeline

A common pattern: one agent implements, another reviews.

```yaml
agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid
  reviewer:
    executor: claude-code
    model: claude-opus-4-6
    prompt_template: templates/review.liquid

steps:
  - name: implement
    agent: builder
    tracker_state: In Progress
  - name: review
    agent: reviewer
    tracker_state: In Review

on_success: Done
on_failure: Needs Rework
max_cycles: 3
```

What happens:

1. Ensemble polls the tracker and finds an issue in "Todo" state
2. Creates a workspace directory for the issue
3. Runs the `implement` step — builder agent gets the issue context, writes code
4. Builder approves → runs the `review` step — reviewer agent checks the work
5. Reviewer approves → issue moves to "Done"
6. If reviewer rejects → issue moves to "Needs Rework", retries from step 1 on next cycle

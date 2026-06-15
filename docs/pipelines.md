# Pipeline Guide

A pipeline is a directed acyclic graph (DAG) of steps that Ensemble runs for each issue. Each step invokes a named agent, collects a result, and decides what happens next.

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
4. Collects a result (`succeeded`, `failed`, or `concern`)

## Clarification request style (batched by default)

Ensemble now injects interaction-policy guidance into prompts by default. Agents are expected to:

- Prefer batching related clarifying questions into one interaction request (soft preference).
- Ask one-by-one only when urgency or sequential discovery requires it.
- For each question include:
  - the question
  - why it matters
  - the default assumption if unanswered

You can customize or disable this with `agent.interaction_policy_*` settings in `config.yaml`.

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

## Results

After an agent finishes its visible working turn, Ensemble runs a hidden extraction turn in the same
runtime session. The extraction turn produces the step's structured result. Extraction messages are
not shown in the timeline.

Every successful agent step must produce:

```json
{
  "result": "succeeded",
  "summary": "optional human-readable summary",
  "output": {
    "optional": "structured data for downstream steps"
  }
}
```

Failed and concern results require a non-empty `summary`:

```json
{
  "result": "failed",
  "summary": "Tests are failing - 3 test cases need fixes"
}
```

or:

```json
{
  "result": "concern",
  "summary": "Naming is inconsistent, but the implementation is usable"
}
```

If extraction produces invalid JSON or violates the result contract, Ensemble runs one hidden repair
turn. If repair also fails, the worker fails and the orchestrator applies the configured retry or
failure behavior.

Verdict files and default-success fallback are not part of the runtime result contract.

**Succeeded** means the step passed. The pipeline moves to the next step or completes.

**Concern** means the step raised a non-blocking concern. The step is treated as passed, and downstream steps can inspect the summary and output.

**Failed** means the step failed. The `summary` field explains why. Ensemble applies the step's `on_failure` behavior.

## Retries and cycles

When a step fails or an agent errors out, Ensemble can retry. The `max_cycles` setting controls how many times:

```yaml
max_cycles: 3  # default
```

- Cycle 1: Initial run
- Cycle 2: First retry (if cycle 1 failed)
- Cycle 3: Second retry (if cycle 2 failed)
- After cycle 3: Issue moves to `on_failure` state

Retries use exponential backoff: 10s, 20s, 40s, ... capped at `agent.max_retry_backoff_ms` (default 5 minutes).

The workspace persists across retries, so agents can see previous work and build on it. The `attempt` variable is available in prompt templates for retry-aware prompts.

By default, step failures use whole-issue retry behavior: Ensemble removes the current `PipelineRun`, queues a retry, and starts again from the first step on the next cycle.

## Step-level retry

Each step can choose what happens when it returns `failed`:

```yaml
steps:
  - name: implement
    agent: builder
    on_failure: retry_step
  - name: review
    agent: reviewer
    on_failure: fixup
    fixup_agent: fixer
  - name: release
    agent: releaser
    on_failure: halt
```

`on_failure` values:

- `retry_issue` (default): retry the whole issue from the first step.
- `retry_step`: preserve passed upstream steps and retry the failed step plus downstream dependents.
- `fixup`: inject a synthetic fixup step before retrying the failed step. This requires `fixup_agent`.
- `halt`: stop automatic retry and keep the issue claimed while it waits for manual intervention.

Manual step retry is also available from the API:

```http
POST /api/v1/{identifier}/retry?step=review
```

Without `step`, the retry endpoint keeps its whole-issue behavior: it releases the retry claim so the next poll can pick the issue up fresh.

## Step transcripts

Each run step writes a drill-down transcript to:

```text
.ensemble/runs/{run_id}/steps/{step_name}/transcript.jsonl
```

Use the timeline to understand step state transitions. Use the step transcript when you need the
agent conversation details: assistant output, exposed reasoning, tool activity, permission events,
and turn completion records.

While a step is running, newly persisted transcript records are streamed over the issue WebSocket as
`transcript_record` messages. The live stream is best-effort; the step conversation API remains the
source of truth for reconnect replay and historical inspection.

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
4. Builder succeeds -> runs the `review` step; reviewer agent checks the work
5. Reviewer succeeds -> issue moves to "Done"
6. If reviewer fails -> the configured `on_failure` behavior decides whether to retry the issue, retry from `review`, run a fixup agent, or halt

## Synthesis steps

Synthesis steps merge or adjudicate outputs from parallel branches. Set `kind: synthesis` on a step to
mark it as a synthesis step. Synthesis steps must declare `depends` explicitly. Ensemble passes only
final dependency outputs into the prompt context; intermediate tool calls and hidden reasoning are not
injected.

```yaml
steps:
  - name: implement
    agent: implementer
  - name: review-a
    agent: reviewer
    depends: [implement]
  - name: review-b
    agent: reviewer
    depends: [implement]
  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [review-a, review-b]
```

## Accessing dependency outputs

Downstream steps can access outputs from their direct dependencies via the `dependency_outputs` and
`steps` template variables.

A synthesizer prompt can iterate over `dependency_outputs`:

```liquid
{% for review in dependency_outputs %}
## {{ review.step }}
{{ review.summary }}
Risk: {{ review.output.risk }}
{% endfor %}
```

Or access a specific step by name via the `steps` map:

```liquid
Review A risk: {{ steps["review-a"].output.risk }}
Review B risk: {{ steps["review-b"].output.risk }}
```

Steps can produce structured `output` data alongside their result. Set the `output` field in
the extracted runtime `StepOutput`:

```json
{
  "result": "succeeded",
  "summary": "Looks good, low risk",
  "output": {
    "risk": "low",
    "findings": ["minor style nit on line 42"]
  }
}
```

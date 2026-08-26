# Pipeline Guide

A pipeline is a directed acyclic graph (DAG) of steps that Ensemble runs for each issue. It is the CI contract for autonomous coding agents: each step invokes a named agent in an isolated workspace, collects a structured result, and lets pipeline policy decide what happens next.

For the first release, sequential list-order pipelines are the supported path. Dependency syntax
can describe a DAG, but Ensemble does not promise guaranteed parallel execution. Finalization after
a successful pipeline is recoverable and may create a pull request; a human owns review and merge.

## Named pipeline selection and recovery

A configuration can replace the legacy top-level pipeline with named `pipelines`,
`scheduler.lanes`, and `workflow_selection` rules. The selector matches normalized issue state,
labels, and blockers without assigning built-in meanings such as planning or delivery to them.
The matching rule chooses both the executable pipeline and the live-worker capacity lane.

For fresh work, Ensemble evaluates and orders the candidate snapshot, then refreshes the selected
issue by stable ID immediately before the existing claim operation. The refreshed issue must still
match the same rule, pipeline, and lane and the lane must still have capacity. If any of those
conditions changed, Ensemble does not claim or dispatch it during that tick.

The selected rule, pipeline, and lane are journaled with the run's ownership lease and workspace
branch identity. Retries, interaction resumes, finalization, and restart recovery use that frozen
identity rather than selecting again. If the named rule, pipeline, or lane is missing or points at
a different combination after configuration changes, recovery fails closed for operator action.
This preserves the orchestrator's single lifecycle authority described by ADR-0012 while keeping
development-method vocabulary outside the runtime core as required by ADR-0014.

## Scheduler leases and bounded execution

Selected lanes have a unique positive `precedence`, optional live-agent `capacity`, and may be
`idle_only`. Lower precedence runs first; idle-only fresh work waits until recovered and eligible
non-idle work has had an admission opportunity. Omitted lane capacity adds no further cap beyond
the global and per-issue worker limits.

Steps may request configured named resource units and may select a direct dependency's validated
string-array output with a JSON Pointer as their affected-path declaration. Paths use the strict
`repository:path` form, are repository-relative slash paths, and conflict only when equal or when
one is a component ancestor of another in the same repository. Every live dispatch reserves worker,
lane, resources, and paths atomically; its effective lease is journaled before `StepRunning` and is
cleared when a stale running step is restored to pending after restart.

`scheduler.recovery.max_attempts` bounds automatic retry recovery. Once exhausted, Ensemble keeps
the claim, workspace, run state, and completed steps as a parked run, releases live-agent leases,
and reports the generic `runtime.scheduler.recovery_exhausted` operator-attention item. Parking
does not add tracker or dashboard mutation authority.

`ensemble run --once [--deadline-ms N]` drives the same scheduler without starting the daemon
watcher and emits one JSON result. It returns `success` after two fresh empty snapshots,
`waiting_for_human` only when open interactions are the sole residual, and `partial_drain` on the
configured/overridden deadline with a deterministic residual summary. Non-success results exit
nonzero.

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
4. Collects a structured `StepOutput` result (`succeeded`, `failed`, or `concern`)

## Artifact snapshot producers

A step may declare `output_schema` and `artifact_snapshot` in configuration. The schema is read
at configuration activation, restricted to Draft 2020-12, and frozen into the live pipeline
snapshot. All result variants then require a present, schema-valid `output`; the existing hidden
extraction repair turn is the only repair opportunity.

After validation and before a producer becomes passed, Ensemble waits for concurrently running
siblings of that issue to finish, then records a content-free Artifact snapshot identity for each
selected repository. It covers the run, cycle, producer, attempt,
validated-output digest, repository HEAD/index/tracked state, and non-ignored untracked relative
paths with content-free per-path digests. A direct dependent may list those producer names in
`artifact_inputs`. Immutable consumers must select disjoint repositories across those producer
snapshots. With
`artifact_access: immutable`, Ensemble compares the producer observations immediately before the
consumer starts; a mismatch drains sibling workers and leaves the issue halted for manual
intervention rather than retrying automatically. A `step_launched` journal commitment opens the
runtime gate; it authorizes launch, rather than proving the child executed instructions. ACPX
receives read approval for such a consumer
unless its configured mode is `deny_all`; direct ACP cannot offer an equivalent runtime guarantee.

### Tracker-event authorization

An `authorization` declaration binds dispatch to a direct Artifact producer and a
tracker-normalized opaque field/value/actor event. Ensemble selects the latest qualifying event
by timestamp and immutable event identity, persists it with the exact Artifact identity and output
digest, and re-reads both before launch. Missing, changed, unsupported, or legacy Artifact evidence
keeps the protected step pending. `wait_for_event` writes nothing; `automatic_transition` reuses
the protected step's configured tracker state. Its pending intent is journaled before the remote
write, and dispatch stays closed until the applied acknowledgement is durable; recovery observes an
already-applied remote state without repeating the write. No tracker or development-method
vocabulary enters the pipeline contract.

Authorization is valid only for dispatched agent or synthesis steps. It is rejected on synchronous
`gate` steps, which evaluate durable assessment evidence directly rather than opening a dispatch
boundary.

The durable violation records a sorted, bounded list of repository-relative changed paths plus an
omitted-path count, never contents or absolute paths. Source contents, absolute paths, ignored
files, workspace copies, and automatic cleanup are deliberately out of scope.
Tracked Gitlinks and untracked embedded Git repositories use their nested repository's ignore
rules when the host can bind Git observation to an already opened directory; hosts without that
descriptor-bound facility fail closed rather than observe a mutable external path. Self-contained
Git metadata contributes `info/exclude`. Standard tracked Gitfiles are never followed: worktree
`.gitignore` rules apply, while metadata-local excludes outside the opened worktree are deliberately
not observed and therefore remain part of the captured identity. The identity is journaled,
appears beside direct dependency output and completed history, and is restored rather than
recaptured after restart.

## Assessment gates

A `kind: gate` step is a deterministic non-agent step. It names immutable sibling assessment
steps and one ordinary `synthesis` adjudication step. Every assessment source must consume the
same single immutable Artifact producer, and the synthesis step must directly depend on every
source. The gate can run only after those completed outputs are available; it never starts an
agent, reserves a scheduler slot, prepares a workspace, or reads transcripts.

```yaml
- name: security
  agent: reviewer
  depends: [build]
  artifact_inputs: [build]
  artifact_access: immutable
- name: adjudicate
  kind: synthesis
  agent: reviewer
  depends: [security]
- name: quality-gate
  kind: gate
  depends: [adjudicate]
  gate:
    assessment_steps: [security]
    adjudication_step: adjudicate
```

Assessment output is `{"assessment":{"findings":[...]}}`. Each finding has a source-local
non-empty `id` and `summary`, a `blocking` or `non_blocking` severity, and a non-empty object
`evidence`. The synthesis output is `{"adjudication":{"dispositions":[...]}}`; it must contain
exactly one evidence-backed `upheld`, `dismissed`, or `unresolved` disposition for every
`source_step`/`finding_id` pair. Missing, duplicate, unknown, incomplete, or malformed evidence
fails closed. Upheld blocking findings fail; non-blocking upheld findings are retained as durable
evidence; unresolved findings create one durable accept/reject approval request. Accept resumes
only downstream steps and reject fails the gate. Gate failure permits whole-issue retry or halt,
never gate-local retry or fixup.

For a complete fixture-backed operator composition, including plan, code, and test-review routes,
prompt guidance, trust boundaries, and recovery, see [Adversarial reviews](adversarial-reviews.md).

## Static route steps

A `kind: route` step is an agentless, fixed-DAG branch selector. It reads a non-empty JSON Pointer
from one direct producer. Activation proves that pointer is a required `string` enum in the
producer's resolved Draft 2020-12 output schema; route cases must exactly exhaust that enum and
partition every direct successor exactly once.

```yaml
- name: compare
  agent: comparator
  output_schema: { path: schemas/comparison.json }
- name: choose_review_path
  kind: route
  depends: [compare]
  on_failure: halt
  route:
    source: { step: compare, pointer: /decision }
    cases:
      agreement: [accept_agreement]
      disagreement: [escalate]
- name: accept_agreement
  agent: agreement_handler
  depends: [choose_review_path]
- name: escalate
  agent: adjudicator
  depends: [choose_review_path]
```

The selected branch remains eligible. Direct non-selected entries, and descendants whose settled
dependencies are all skipped, become terminal `Skipped` with the route provenance; they produce no
output, attempt, transcript, artifact, or dependency-output entry. A shared join waits for every
dependency to settle and runs when at least one passed. A run containing only `Passed` and `Skipped`
terminal steps succeeds.

The selected case and a source-output digest are stored in the run snapshot, so restart and a
downstream retry retain the choice. Resetting the source resets its descendants and removes affected
route decisions. Missing or unmatched route evidence fails the route closed and halts; routes do
not support automatic retry, fixup, defaults, coercion, predicates, dynamic nodes, or loops.

## Durable post-output actions

Ordinary agent and synthesis steps may have ordered generic actions sourced from their own
schema-validated output. A producer is `AwaitingActions` until every declared effect has a durable
receipt, so dependents, routes, approval, terminal state changes, and finalization cannot proceed
early. A pending action is retried from its saved output after restart; it does not rerun the
producer, consume worker capacity, change `max_cycles`, or select a new Pipeline.

The public effects are marker-reconciled tracker comments and durable operator-attention upserts.
Actions are invalid on routes and gates. Route-excluded `Skipped` steps have no output, action,
receipt, artifact, attempt, or transcript. Retrying a producer clears its own and dependent action
receipts. Completed history exposes only bounded applied-action evidence (identity, source digest,
kind, and receipt); it never includes resolved comment bodies or attention presentation. Retrying
a producer clears its own and dependent action state together with their outputs.

The checked-in [outcome-routing example](outcome-routing.md) shows this composition with Artifact
and authorization wiring while keeping its policy labels out of the runtime.

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

**Parallel syntax (not a supported first-release guarantee):** Use `depends` to describe branches.
Do not rely on it for guaranteed parallel execution in the sequential MVP.

```yaml
steps:
  - name: build
    agent: builder
    depends: []           # root step — no dependencies
  - name: lint
    agent: linter
    depends: []           # another root; parallel dispatch is deferred beyond the MVP
  - name: review
    agent: reviewer
    depends:
      - build             # syntax for a future multi-branch pipeline
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

## Step Outputs

After an agent finishes its visible working turn, Ensemble runs a hidden extraction turn in the same
runtime session. The extraction turn produces the step's structured `StepOutput`. Extraction messages
are not shown in the timeline.

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

## Acceptance requirements

Acceptance requirements provide deterministic checks around repository finalization:

```yaml
acceptance:
  commands:
    - name: tests
      run: cargo test --workspace
      timeout_ms: 900000
    - name: formatting
      run: cargo fmt --all -- --check
      timeout_ms: 120000
  required_files:
    - name: release-notes
      repo: ensemble
      path: docs/release-notes.md
  required_handoff_sections:
    - name: implementation-handoff
      step: implement
      sections: [summary, testing]
  required_pull_requests:
    - name: ensemble-pr
      repo: ensemble
```

Ensemble runs these sequentially in declaration order as `/bin/sh -lc` in the issue workspace,
inheriting the orchestrator environment unchanged. It runs the complete list even if an earlier
command fails, times out, or cannot launch. Commands are not DAG steps, do not run through an agent,
and cannot be parallelized or given acceptance-specific retries. Ensemble next checks required files
in owned worktrees, then required top-level sections in persisted step output objects. It runs the
complete pre-final sequence even after a failure.

Required files use exact repository-relative paths. The target must be a regular file whose resolved
path stays inside the configured worktree. Required handoff sections treat missing, null, blank
strings, empty objects, and empty arrays as absent; boolean `false` and numeric `0` are present.

After finalization retains a pull-request identity, Ensemble evaluates required pull requests in
declaration order. These checks project only the stored delivery phase, branch and SHA identity,
pull-request number, and URL. They never push, create, or discover remote state.

Each newly written durable result is a version-2 envelope with `name`, `status`, `summary`, `timing`,
and tagged `evidence`. Evidence kind is `command`, `file`, `handoff`, or `pull_request`. Command
evidence has optional `exit_code` plus `stdout` and `stderr`; each stream stores a lossy-UTF-8
rendering of only the final 32,768 raw bytes, total observed bytes, and a `truncated` flag. The runner
drains both streams concurrently and terminates and reaps the command process group on timeout.
Other evidence variants contain typed observations and configured relative identifiers, never
command strings or absolute repository paths. Unversioned legacy flat command results remain
readable with unknown timing; unsupported explicit versions fail closed and new writes are v2.

Every newly executed result also records tagged timing:

```json
{
  "kind": "observed",
  "started_at": "2026-08-04T09:00:00Z",
  "completed_at": "2026-08-04T09:00:01Z",
  "duration_ms": 1234
}
```

The boundaries use UTC wall-clock timestamps, while `duration_ms` uses a monotonic clock. Legacy
results without a `timing` field deserialize as `{"kind":"unknown"}`; Ensemble preserves their
evidence without inventing timestamps.

Phase start and every completed result are journaled before Ensemble advances. A new run freezes a
non-secret resolved plan and semantic config digest. Results must be a declaration-order prefix of
commands, files, and handoffs; restart resumes the first missing check from frozen descriptors.
Digest drift before an unfinished command retains the run instead of executing changed command
configuration. Legacy snapshots without a plan use historical command-only recovery and do not gain
new rules. Ordered attempts are preserved in JSONL history, SQLite history, and pending terminal
reconciliation records.

If an append outcome is ambiguous, Ensemble keeps the active owner and retries only the journal
visibility check on later poll ticks. An exactly visible result advances without executing the
command again; confirmed absence releases the owner so only that undurable command can be
redispatched.

Any non-passing result dominates a succeeded or concern step output and prevents finalization. It
uses whole-issue retry regardless of per-step `on_failure`: a new cycle reruns the full pipeline and
the full acceptance list while retaining prior attempts. Exhausting `max_cycles` records every
attempt and moves the issue to `on_failure`.

Pull-request results are an ordered suffix after the pre-final prefix. Startup resumes an incomplete
suffix batch without remote calls. A failed batch blocks only affected delivery repositories and
retains their exact delivery and pull-request identity. An explicit finalize retry appends a full
new suffix batch; a passing retry returns the delivery to `waiting`, while failure remains blocked.
This path does not consume pipeline cycles or use `max_cycles`.

`delivery_states` is a separate delivery-owned, non-terminal projection policy. Once durable
delivery evidence is available, Ensemble selects one fact in fixed order: closed without merge,
requested changes, failed checks, all-repository merge, all-repository approval, then waiting.
`merged: on_success` enters the existing durable terminal-success transition; closed without merge
keeps the delivery claimed and upserts operator attention until recovery observes a different fact.
The journal records `pending`, then `in_flight` before a configured tracker write, and `applied`
only after an exact tracker read. Omitted mappings leave the tracker unchanged; ambiguous or
unexpected reconciliation retains delivery without another branch, pull request, terminal
transition, or agent dispatch.

An optional pipeline `delivery_repair` policy may freeze actionable feedback for the retained
pull-request head. The observation must be fresh, match the durable SHA, and contain a terminal
failed check, a non-empty change-request body, or an unresolved non-outdated inline thread.
Pending checks and general pull-request conversation do not form repair instructions. A frozen
snapshot is immutable: later observations cannot replace it while the delivery retains repair
state. Ensemble journals the repair launch intent, including the consumed cumulative repair budget,
before reserving capacity or launching the repair agent. The budget belongs to the retained delivery
owner rather than one feedback snapshot, so it remains consumed after a successful repair, an
interaction resume, and restart. Once exhausted, later actionable feedback creates a durable
operator handoff instead of another automatic repair launch.

Automatic repair additionally requires `mergeable` pull-request evidence. Actionable feedback on a
`conflicting` or `unknown` pull request creates the same durable operator handoff without reserving
repair capacity. If a journaled launch cannot locate a retained worktree directory, Ensemble
records that diagnostic, removes the in-memory launch grant, and hands the retained delivery to an
operator rather than retrying indefinitely.

The repair worker retains the scheduler capacity identity frozen with delivery: the selected workflow
lane when one was selected, otherwise the original issue state. Lane admission still resolves that
frozen lane against the live configuration and its current capacity. A missing frozen identity or a
lane removed by reload fails closed to the same operator question; repairs never borrow a synthetic
delivery-state bucket. The question offers `Retry delivery repair` only while budget remains, which
retains the frozen feedback, journals a new launch intent, and creates a distinct durable interaction
identity for that retry cycle, or `Handle manually`, which suppresses
automatic refreezing only for that repository, pull request, and exact head while retaining the
delivery owner and continuing read-only observation. A different actionable head for that same pull
request is eligible only when it follows a manually suppressed exact prior head for the same
repository and pull request. Ensemble retains the durable delivery SHA and records the observed
divergence; the new observed head belongs only to the next frozen repair attempt and guarded-push
lease. Other divergent heads remain blocked. The successor is evaluated against the same cumulative
budget without clearing other repositories' manual suppressions. Invalid or missing choices leave
the owner waiting for an explicit decision.

After a successful repair worker changes its local head, Ensemble journals `push_in_flight` before
one guarded push that requires the retained remote head and the current local head to match the
frozen identities. The Git mutation applies an exact ref lease for that observed remote head, so a
concurrent branch advance is rejected rather than overwritten. A normal response and an ambiguous
response both enter same-pull-request reconciliation; a restart with a journaled dispatch or push
in flight never replays the uncertain effect. It either hands dispatch ambiguity to an operator or
reads the exact retained pull request and accepts only the expected post-worker head. Missing
post-worker head, retained worktree or repository identity, identity mismatch, closed or divergent pull requests,
incomplete observations, and guarded-push rejection retain the workspace, claim, and pull-request
identity with one durable operator interaction.

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
The queued retry's `attempt` is the next pipeline cycle to dispatch. Scheduler work such as fetching
tracker candidates, waiting for agent capacity, or entering shutdown quiescence can defer that same
queued entry, but does not consume another pipeline cycle or release its claim.

When an automated failure reaches `max_cycles`, Ensemble durably records the configured
`on_failure` transition before attempting the tracker write. The issue remains claimed with its
pipeline snapshot and completion history until terminal reconciliation succeeds. A restart restores
that pending transition instead of rerunning the pipeline or silently dropping the exhausted retry.

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

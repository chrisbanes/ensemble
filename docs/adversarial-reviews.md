# Adversarial reviews with generic pipeline primitives

An adversarial review is a composition of ordinary Ensemble Steps, not a review
mode. It lets independent evaluators judge one captured subject, then makes an
ordinary synthesis Step account for every finding before a deterministic gate
decides the result.

The checked-in [complete configuration](examples/adversarial-reviews/config.yaml)
and reusable [Assessment schema](examples/adversarial-reviews/schemas/assessment.schema.json),
[adjudication schema](examples/adversarial-reviews/schemas/adjudication.schema.json), and
[sample outputs](examples/adversarial-reviews/outputs/) are the supported starting point.
`adversarial_review_examples` loads those exact assets with the production configuration
loader and validates their schemas and gate outcome.

## The composition

An **Artifact snapshot** is the immutable identity produced after a Step's
schema-valid output, for the repositories named by `artifact_snapshot`. It is
not a request for evaluators to inspect a live, changing Workspace. An
**Assessment** is a structured judgment about that snapshot; successful
evaluator completion only proves the evaluator Step completed, not that the
artifact is acceptable. An **Interaction request** is the durable human
question or approval that blocks a Run until it is resolved.

The example composes this path:

```text
produce Artifact snapshot
        |
 architecture Assessment + verification Assessment (immutable consumers)
        |                         |
        +----------- synthesis ---+
                       |
              deterministic adversarial-gate
```

`architecture` and `verification` each directly depend on `produce`, select its
same one Artifact snapshot with `artifact_inputs: [produce]`, and declare
`artifact_access: immutable`. They may run independently when the scheduler can
admit them. `synthesis` is an ordinary agent Step: it has both evaluator
outputs as direct dependencies and emits the complete adjudication. The final
`kind: gate` Step launches no agent. It evaluates the named Assessment outputs
and their one synthesis output, so reviewer agreement or a reviewer summary
cannot itself pass the pipeline.

Each finding ID is stable only within its source Step. An Assessment records a
non-empty ID, `blocking` or `non_blocking` severity, summary, and structured
evidence. The synthesis output contains exactly one evidence-backed
disposition for every `(source_step, finding_id)` pair: `upheld`, `dismissed`,
or `unresolved`. Unique findings and disagreements remain in the evidence;
synthesis does not deduplicate them by consensus.

## Worked routes

Use the same public configuration shape for each route; only the producer
prompt, evaluator lenses, and evidence contract change.

| Review | Producer snapshots | Independent evaluator lenses | Required evidence |
| --- | --- | --- | --- |
| Plan | The proposed plan and declared design material through the selected repositories | architecture and ownership; delivery and operational risks | cited requirement or decision, affected boundary, and a concrete contradiction or omission |
| Code | The selected source and test state after the implementation output validates | behavior and security; maintainability and API | repository-relative location, observed behavior or path, and a reproducer, test, or direct contract reference |
| Tests | The selected implementation and test state | specification coverage; failure-mode and regression coverage | covered or missing criterion, test identifier or path, and failure or reproduction evidence |

Keep evidence bounded and structured. Do not put source contents, absolute
paths, raw transcripts, or hidden reasoning in an Assessment. A finding is not
valid merely because two evaluators agree; every claim must be evidence-backed,
and synthesis must preserve a unique finding even when another evaluator says
the opposite.

### Prompt rules

Give every evaluator the immutable Artifact identity and its assigned lens.
Ask it to finish its own work with a schema-valid Step output containing an
Assessment, including evidence for each claim. Tell it explicitly that success
means it completed the evaluation, not that the Artifact passed. Give synthesis
all direct evaluator outputs and require one exact, evidence-backed disposition
per finding. Neither prompt may treat agreement as proof, request a vote, or
invent conditional routing.

## Gate and recovery operations

The gate—not evaluator prose—has three deterministic outcomes:

- An upheld `blocking` finding fails the gate. The configured whole-issue
  retry or halt policy applies; a gate has no local retry or fixup.
- Only dismissed or non-blocking upheld findings pass. Non-blocking findings
  remain normalized gate evidence.
- Any `unresolved` finding creates one durable accept/reject Interaction
  request. Accept resumes only downstream Steps; reject ends the Run through
  its failure path.

Repair one malformed evaluator output with the single schema-aware repair turn,
then retry that evaluator against the unchanged snapshot only when normal Step
retry policy permits it. After a rejected gate, regenerate and retry the whole issue;
do not relabel the old snapshot as accepted. The Artifact identity, completed
outputs, and interaction state are journaled, so restart restores them rather
than recapturing a moving Workspace. Use the normal deterministic acceptance
commands after the gate passes; external CI remains an independent acceptance
authority and should validate the same change before delivery.

## Trust and mutation boundaries

This is a trusted-critic pattern. Sibling evaluators reuse the issue-owned
Workspace, while core before-and-after Git-observable verification is the
authority for the selected source state. Adapter restrictions on known mutation
capabilities are defense in depth; ignored build outputs remain writable. This
does not observe every write, contain a hostile agent, or create an OS security
sandbox.

Mutation testing is a separately configured tool. It owns its disposable
environment and restoration; this pipeline does not promise controlled-mutation
lifecycle, perfect restoration, or restart recovery for mutation tooling.

## What this does not add

Basic parallel synthesis is simply several direct dependency outputs summarized
by an ordinary synthesis Step. Fixed-round cross-examination is a separately
configured, bounded sequence of such Steps. This guide adds neither a
review-specific Step kind nor a critic entity, provider or model rule, voting
or quorum scheme, fixed review methodology, dynamic convergence, or conditional
routing. Dynamic convergence is unsupported: configure a finite DAG and let
the deterministic gate and durable human authority decide the outcome.

For the concise primitive semantics, see the [Pipeline Guide](pipelines.md).
The architectural boundary is recorded in [ADR-0017](adr/0017-evaluate-immutable-artifact-snapshots-with-generic-pipeline-primitives.md).

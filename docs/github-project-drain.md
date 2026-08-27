# GitHub Project reference configuration

[`examples/github-project-drain/`](examples/github-project-drain/) is a copyable reference for
running an issue-driven GitHub Project with generic Ensemble configuration contracts. Copy the
whole directory into a private configuration directory and adapt its
[`config.yaml`](examples/github-project-drain/config.yaml), prompts, schemas, and
[`tools/apply-triage-patch.sh`](examples/github-project-drain/tools/apply-triage-patch.sh)
together. It is not a built-in `github_project_drain` runtime mode.

## What to replace

Replace the repository, Project number, state and label predicates, priority order, Project field
display names, actor identities, branch policy, agents, paths, scheduler capacities, and deadlines.
The `tracker.github.status_field` value is the readable Project field name used for normalization.
`authorization.event.field` is different: it must be the opaque immutable Project status-field
node ID discovered for your Project (the reference placeholder is `PVTSSF_example_status`).
Activation or dispatch fails closed when that event field is missing, unavailable from the adapter,
or does not match fresh status-event evidence.

The reference uses selected named `pipelines`, `scheduler.lanes`, and `workflow_selection` rules.
The names `planning`, `delivery`, `triage`, `epic-closure`, and `human-attention` are ordinary
configuration keys; their state and label meanings stay in this directory. Delivery alone requires
the `ready-for-agent` label, and rules that must respect native dependencies use
`require_unblocked: true`.

## Planning and delivery

The default planning handoff is human-authorized. `draft-plan` snapshots an Artifact and publishes
a marker-bound plan comment, then routes `revision` to an immutable `wait_for_event` publication
acknowledgement or `operator_required` to marker-bound operator attention. The acknowledgement
retains the same Run until an allowlisted actor supplies a qualifying post-Artifact status event.
To make that policy automatic, explicitly change the protected step to `automatic_transition`,
give it a `tracker_state`, and authorize the entry transition; it is not a default.

Delivery snapshots implementation output, obtains independent immutable review and verification
assessments, then uses a deterministic gate and normal repository finalization. The example
declares a bounded delivery-repair policy and a merge-queue policy. Change the repository's
`finalize.merge` to `manual`, `auto` with an allowed method, or `merge_queue` according to the
repository's live policy. No label or assignee is merge eligibility: finalization reads the
repository's own merge policy and current pull-request facts.

Repository finalization is configured per repository, not per selected pipeline. Keep planning,
triage, and human-attention agents non-mutating; if a private copy needs different publication
policy per pipeline, use separate repository configurations or stop at the delivery boundary
instead of treating this reference as a new runtime mode.

Tune lane capacities, the `repository` resource, recovery budget, and `one_shot.deadline_ms` for
your operating limits. These are policy inputs, not promises of agent capacity.

## Triage, epics, and attention

Triage is deliberately draft then authorize then apply. The drafter emits the strict
[`triage-patch.schema.json`](examples/github-project-drain/schemas/triage-patch.schema.json) and
the configuration publishes only its bounded summary and snapshots its Artifact.
`apply-triage-patch` immutably consumes that direct Artifact only after a fresh allowlisted
`Triage approved` post-Artifact status event. It has no `approval` field: approval is a post-step
decision primitive, retained here only for the genuine epic-close acknowledgement. Its prompt
renders the producer's exact compact `dependency_outputs[0].output_json`, directs the applier to
materialize that value unchanged, then invokes the bundled helper with the exact repository,
Project number, status-field name, issue number, and authorized workspace patch.

The helper is a privileged, example-local boundary. It requires `gh`, `jq`, authenticated GitHub
access, and a Project-visible issue. Install the copied helper at a trusted absolute path that the
agent runtime can execute, then replace the placeholder path in `prompts/triage-apply.md`; agent
working directories are issue workspaces, not the configuration directory. It validates schema
version and exact shape, checks an
expected post-approval issue/Project/status/labels snapshot against an authoritative reread,
requires every field, option, item, and label target to resolve exactly once for the entire patch
before the first write, and
permits only the configured `set_status`, `add_label`, and `remove_label` values. Malformed,
stale, ambiguous, unavailable, or out-of-policy patches fail before any mutation; it neither
interprets prose nor accepts arbitrary GraphQL input.

The unblocked epic rule routes a schema enum either to an approval-protected closure
acknowledgement or to a marker-bound comment plus durable operator-attention item. The reference
defaults closure to an approval checkpoint. Removing that checkpoint is an explicit automatic
policy choice. The human-attention rule similarly records opaque durable attention; it does not
implement, publish, or create a special runtime role.

## Required capabilities and fail-closed boundaries

This reference needs generic Project field discovery and normalization, selected-rule native
blocker data, authenticated exclusive ownership, marker-bound comments, immutable status-event
evidence, durable attention history, and repository finalization/merge-policy reads. It also needs
the helper prerequisites above. Unsupported event evidence, ambiguous Project membership, missing
permissions, absent durable history, or a helper preflight mismatch stops the relevant path.
Triage and human-attention lanes are intentionally `idle_only`, while `Triage approved`,
`Awaiting review`, and `Awaiting merge` stay active so held and delivery-projection records can
reconcile. None falls back to a built-in drain mode.

For the generic configuration vocabulary, see the [Configuration Reference](configuration.md)
and [Pipeline Guide](pipelines.md).

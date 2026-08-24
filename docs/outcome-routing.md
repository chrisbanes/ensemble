# Outcome routing example

[`examples/outcome-routing/config.yaml`](examples/outcome-routing/config.yaml) composes a
schema-validated producer, generic durable actions, and one static enum route. It deliberately
keeps `revised_artifact` and `operator_required` in reference assets rather than runtime types.

The producer snapshots an Artifact and reports one of the two schema values. The selected branch,
and only the selected branch, resolves and applies its declared actions: `revised_artifact` emits
the publication comment after configured authorization, while `operator_required` emits the
marker-bound comment and attention upsert. The `revised_artifact` branch waits for configured
tracker-event authorization while retaining the same Run, Workspace, Artifact, and claim. The
unselected branch is `Skipped` and has no action state.

If external policy later wants another attempt, it selects a new whole Run after a fresh tracker
snapshot. The example does not loop, reinterpret a route choice, or create a runtime mode.

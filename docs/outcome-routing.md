# Outcome routing example

[`examples/outcome-routing/config.yaml`](examples/outcome-routing/config.yaml) composes a
schema-validated producer, generic durable actions, and one static enum route. It deliberately
keeps `revised_artifact` and `operator_required` in reference assets rather than runtime types.

The producer snapshots an Artifact and reports one of the two schema values. Before either route
branch becomes eligible, its marker-bound comment and attention upsert receive durable receipts.
The `revised_artifact` branch waits for configured tracker-event authorization while retaining the
same Run, Workspace, Artifact, and claim. The other branch is ordinary configured work. The
unselected branch is `Skipped` and has no action state.

If external policy later wants another attempt, it selects a new whole Run after a fresh tracker
snapshot. The example does not loop, reinterpret a route choice, or create a runtime mode.

---
status: accepted
---

# Start a fresh implementation

Ensemble will implement ADR-0020 from a minimal scaffold in the existing repository,
retaining Git history. Pipeline assumptions currently span agent execution,
results, recovery, approvals, and publication; replacing that model incrementally
would carry those assumptions into the new design or require maintaining two
execution models. The previous implementation and interview notes are preserved on
`cb/pipeline-implementation` at `272adb7`, and new work starts on
`cb/agent-coordination`.

Existing configuration and persisted runs have no compatibility requirement.
Existing runs must finish or be explicitly retired before an operational cutover.
Reuse code selectively when concrete needs justify it. Retain the Apache-2.0
license and existing Rust toolchain policy; introduce runtime dependencies and
plugin interfaces as working integrations establish their requirements.

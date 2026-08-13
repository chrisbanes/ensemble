---
status: accepted
---

# Evaluate immutable artifact snapshots with generic pipeline primitives

Ensemble will support adversarial evaluation through generic pipeline primitives rather than a review-specific step kind or development method. A producing step exposes an explicit artifact snapshot, evaluating steps bind to that immutable identity, and the core verifies the declared material before and after each evaluation while runtime adapters restrict known mutation capabilities where possible; this preserves issue-level workspace reuse without creating a worktree per evaluator.

Step completion and artifact assessment remain separate facts. When a step declares an output schema, every result must provide schema-valid output after at most one schema-aware repair turn. A producer captures its Artifact snapshot only after that validation and before it becomes passed; the captured identity is journaled and survives restart. Consumer access, sibling assessments, dispositions, and gates remain later work.

This design assumes trusted critics rather than hostile agent containment. Controlled mutation execution remains outside the runtime lifecycle until usage justifies exclusive ownership, journaling, restoration, and restart-recovery semantics; existing mutation tools may run through separately configured commands or their own disposable environments.

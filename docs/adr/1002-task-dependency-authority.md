---
status: accepted
partially_superseded_by: ADR-1004
---

# Treat task dependencies as a separate execution gate

BB ownership and integration choices below are superseded by
[ADR-1004](1004-standalone-service.md). Other product policies remain in force.
The following text records the earlier decision.

Task dependencies gate Ensemble-managed execution independently of readiness
or assignment waits. Ensemble owns edges from local tasks, while imported GitHub
issues use GitHub's native issue relationships, including blockers outside the
selected source or Ensemble project. This preserves one authority for each edge
and avoids turning readiness labels into dependency state or duplicating GitHub
relationships. Only the operator may mutate local edges; a scoped agent task
edit cannot lift its own blocker. Observing an external blocker grants no
execution access to its repository. BB's direct manual Send-now override remains outside Ensemble's
enforcement boundary and must be disclosed.

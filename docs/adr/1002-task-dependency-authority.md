---
status: accepted
---

# Treat task dependencies as a separate execution gate

Task dependencies gate Ensemble-managed execution independently of readiness
or assignment waits. Ensemble owns edges from local tasks, while imported GitHub
issues use GitHub's native issue relationships, including blockers outside the
selected source or Ensemble project. This preserves one authority for each edge
and avoids turning readiness labels into dependency state or duplicating GitHub
relationships; observing an external blocker grants no execution access to its
repository. BB's direct manual Send-now override remains outside Ensemble's
enforcement boundary and must be disclosed.

---
status: accepted
---

# Keep lifecycle authority in the orchestrator loop

The orchestrator loop owns issue lifecycle transitions and its in-memory state is authoritative while the process runs; refresh, retry, resume, and cancellation surfaces signal that runtime instead of implementing parallel lifecycle logic in API or UI handlers. External I/O happens outside long-held state locks and results are committed only after ownership is revalidated, preventing host divergence, stale commits, and reentrant deadlocks.

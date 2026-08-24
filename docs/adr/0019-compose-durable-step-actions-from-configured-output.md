---
status: accepted
---

# Compose durable step actions from configured output

Steps may emit bounded configured effects after their structured output has passed its declared
schema. The runtime resolves each action from that immutable output, checkpoints intent before the
external effect, and checkpoints a receipt before releasing dependent work.

This keeps the Pipeline a static DAG. Actions do not select pipelines, add nodes, interpret tracker
states, change claims, or own finalization. A failed effect retains the existing Run, Workspace,
and claim for normal retained-run recovery; it never reruns the producer merely to recreate an
effect. Marker reconciliation makes tracker comments safe across an ambiguous post-write crash,
while operator attention uses the existing stable identity and fresh-evidence contract.

The boundary deliberately leaves policy names in configuration and reference assets. The core only
knows bounded action shapes, durable ordering, receipts, and adapter capability.

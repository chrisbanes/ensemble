---
status: accepted
---

# Use embedded SQLite for queryable run history

Completed run summaries and timeline events use an embedded SQLite database at
`{workspace}/.ensemble/history.db`, with durability pragmas and query-oriented tables. Completed
run summaries are also appended to legacy JSONL history so summary APIs can fall back when the
database cannot initialize.

Timeline events have a different durability contract: `run_events` is their sole durable source.
The runtime writes them asynchronously through the history store, and timeline API and step-detail
reads use that same table. Ensemble does not dual-write, fall back to, or migrate historical
per-run timeline JSONL.

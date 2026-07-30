---
status: accepted
---

# Use embedded SQLite for queryable run history

Completed run summaries use an embedded SQLite database under the workspace state root, with durability pragmas and query-oriented tables. Each summary is also appended to legacy JSONL history so the API can fall back when the database cannot initialize, providing local queryable storage without making observability a startup dependency.

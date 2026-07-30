---
status: accepted
---

# Keep trackers as runtime adapters

GitHub, Notion, and local TODO sources implement one tracker-independent `IssueTracker` contract and normalize work into the same Issue model. Tracker reads and optional writes project external state, while the orchestrator remains the authority for dispatch, retry, interaction, and completion so tracker capabilities do not leak into pipeline semantics.

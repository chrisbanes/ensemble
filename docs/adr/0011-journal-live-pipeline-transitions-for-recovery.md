---
status: accepted
---

# Journal live pipeline transitions for recovery

Every recoverable pipeline transition appends a versioned per-issue record containing the resolved pipeline snapshot under the configuration state directory. This journal is separate from completed history because its purpose is to rehydrate halted, interacting, approving, or retrying runs after restart and to mark released runs as no longer live.

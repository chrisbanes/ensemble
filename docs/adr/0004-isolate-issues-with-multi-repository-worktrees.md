---
status: accepted
---

# Isolate issues with multi-repository worktrees

Each issue owns a workspace containing one Git worktree per configured repository, placed under the workspace root rather than inside source repositories. Worktrees are prepared as an all-or-nothing set and reused across steps and retries, which preserves agent collaboration while isolating concurrent issues and keeping managed files out of user checkouts.

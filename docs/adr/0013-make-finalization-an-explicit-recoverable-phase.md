---
status: accepted
---

# Make finalization an explicit recoverable phase

Repository publication is a first-class phase after pipeline success, configured per repository as none, push, or push-and-PR with an optional approval gate. Pending approval or failure retains the claim, workspace, artifacts, and retry path, and an issue becomes complete only after required finalization succeeds rather than trusting an agent to publish implicitly.

---
status: accepted
---

# Serve a React operator interface from Ensemble

On 1 October 2026 Chris selected React with Vite for the reviewed operator UI,
instead of extending the existing server-rendered forms with bespoke browser
state handling. The UI must preserve drafts, history disclosure, reading position
and selections while service state changes. Shared React components will implement
the Pen design system, using Radix primitives selectively for complex controls.

Ensemble serves the production browser build and same-origin authenticated APIs
from its existing service. Preserve session, origin and CSRF protection, runtime
validation, command idempotency, revision checks and server-owned action policy.
Browser state never establishes execution, persistence or external-write success.
This decision adds a frontend build and an API presentation boundary; it does not
replace the coordination core or require a separate production frontend service.

The chosen libraries do not establish accessibility or runtime qualification.
Validate the integrated UI against the specification and acceptance criteria.
Delivery scope and child-issue sequencing remain in GitHub issue #736. This records
the selected architecture, not implementation completion or dispatch approval.

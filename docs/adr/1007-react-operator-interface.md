---
status: accepted
---

# Serve a React operator interface from Ensemble

On 1 October 2026 Chris selected React with Vite for the reviewed operator UI,
instead of extending the existing server-rendered forms with bespoke browser
state handling. The UI must preserve drafts, history disclosure, reading position
and selections while service state changes. Locally owned shadcn/ui source
components supply the shared foundation; Radix primitives remain selective for
composed controls such as the mobile navigation sheet.

Ensemble serves the production browser build and same-origin authenticated APIs
from its existing service. Preserve session, origin and CSRF protection, runtime
validation, command idempotency, revision checks and server-owned action policy.
Browser state never establishes execution, persistence or external-write success.
This decision adds a frontend build and an API presentation boundary; it does not
replace the coordination core or require a separate production frontend service.

UI08 #765 implements the Dark / Neutral / Default token set with self-hosted
Inter and JetBrains Mono, owned Button/Input/Textarea/NativeSelect/Badge/Alert/
Card/Sheet source, and Tailwind v4 build integration. The same validated bundle
stylesheet styles retained production HTML through the existing document
wrapper; it does not hydrate those pages or change their forms. The web-disabled
diagnostic HTML and public denied/not-found fragments retain their existing
functional/minimal presentation. Detailed implementation and evidence are in
the [UI08 foundation contract](../design/ui08-foundation.md) and
[UI08 foundation evidence](../evidence/ui08-foundation.md).

The chosen libraries do not establish accessibility or runtime qualification.
Validate the integrated UI against the specification and acceptance criteria.
Delivery scope and child-issue sequencing remain in GitHub issue #736. This records
the selected architecture, not implementation completion or dispatch approval.

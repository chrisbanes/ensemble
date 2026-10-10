---
status: accepted
---

# Serve a React operator interface from Ensemble

Use React with Vite for the reviewed operator UI, instead of extending the existing
server-rendered forms with bespoke browser state handling. The UI must preserve drafts, history disclosure, reading position
and selections while service state changes. Locally owned shadcn/ui source
components supply the shared foundation; Radix primitives remain selective for
composed controls such as the mobile navigation sheet.

Ensemble serves the production browser build and same-origin authenticated APIs
from its existing service. Preserve session, origin and CSRF protection, runtime
validation, command idempotency, revision checks and server-owned action policy.
Browser state never establishes execution, persistence or external-write success.
This decision adds a frontend build and an API presentation boundary; it does not
replace the coordination core or require a separate production frontend service.

The foundation uses the Dark / Neutral / Default token set with self-hosted Geist
and Geist Mono, owned Button/Input/Textarea/NativeSelect/Badge/Alert/Card/Sheet
source, and Tailwind v4 build integration. The same validated bundle stylesheet
styles retained server-rendered HTML through the existing document wrapper without
hydrating those pages or changing their forms. See the
[foundation contract](../design/ui08-foundation.md) and
[foundation evidence](../evidence/ui08-foundation.md).

The chosen libraries do not establish accessibility or runtime qualification.
Validate the integrated UI against the specification and acceptance criteria.
Delivery scope and sequencing live in GitHub issue
[#736](https://github.com/chrisbanes/ensemble/issues/736).

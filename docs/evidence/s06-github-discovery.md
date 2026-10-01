# S06 GitHub discovery evidence

GitHub discovery is implemented for selected repository issues, searches and
Projects. It uses a configured credential reference to read GitHub.com; it does
not write to GitHub. An issue is one Ensemble task across matching selections.
Discovery does not grant repository workspace access. Imported task provisioning
requires an exact operator-linked repository identity, path and ref.

The service retains complete versus incomplete selection and native dependency
observations separately. Incomplete reads keep existing memberships but hold
new admission. Open blockers outside the selected backlog are references, not
new tasks or repository grants. Local edges to withdrawn imported tasks remain
blocked until an identity-verified closed observation. On restart, prior
provider-derived clearance becomes unknown before the first scheduler wake.
Changed issue text, lost readiness and withdrawal hold new work; an already
admitted turn may finish. Operator review uses the current task version and
observed text digest. The existing routing and delegation admission paths are
used rather than a source-specific owner. For a task held before it has an
assignment, the task-scoped hold in the operator UI is the attention record;
there is no assignment inbox recipient yet. Existing lead and active assignment
recipients receive idempotent source-hold notices.

## Deterministic checks

The real-SQLite/fake-reader suites are `github-source-config`,
`github-source-reader`, `github-reconciliation`, `github-dependencies` and
`github-service`. They cover preview/version activation, pagination and
partial errors, identity and cross-project placement, retained blocker
references, initial and repeated unknown states, active-turn and stale-routing
holds, operator review receipts, timer/explicit refresh and stop. The
authenticated HTTP and Chromium source-view fixture checks HTML escaping,
local-task visibility, credential exclusion, login, Origin and CSRF guards.
These checks do not qualify current provider permissions or fixture content.
With Node.js 24.21.0 and npm 12.2.0, `npm ci` completed with zero reported
vulnerabilities and `npm run check` passed type checking, lint, formatting,
build and all 318 tests on 1 October 2026. Biome reported four pre-existing
warnings in unrelated S05/standalone code and a schema-version information
message; it reported no lint or format errors. The focused HTTP/Chromium test
was run with loopback access after the filesystem sandbox denied a local listen.

## Required live check: unproved

`test/s06/live-github-source.mjs` is a read-only harness. It has **not** been
run because no designated prepared repository/Project and exact fixture
manifest/credential reference have been provided. It exits before any provider
request if `ENSEMBLE_S06_FIXTURE_MANIFEST` is absent. Do not substitute a
production backlog or create remote fixture data without a separate grant.

After a fixture is provided, build the service and invoke
`ENSEMBLE_S06_FIXTURE_MANIFEST=/absolute/path/to/manifest.json node test/s06/live-github-source.mjs`
with the credential available only to that process. The manifest contains
`version: 1`, `repository: { fullName, id }`, `projectNodeId`, `searchQuery`,
optional `projectFilter`, `credentialRef: "env:NAME"`, a configured `readiness`
rule, and `issues` with exact `nodeId`, `number`, `state`, `memberships`,
`blockers: [{ nodeId, state }]` and `expectedAdmission: "eligible" | "blocked"`.
The harness checks complete read-only selections, membership and blocker
identity, imports them into disposable local SQLite with a fake runtime,
compares admission and operator views, and asserts zero provider writes. It
reports observed identities and time without printing the credential. A
missing or changed expected case fails rather than being manufactured.

External GitHub writes and completion reconciliation belong to S07; this
report does not claim A24, A26 or operational release qualification.

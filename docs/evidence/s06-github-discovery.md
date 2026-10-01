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
The canonical task lead also receives a notice while its assignment is held.
A source-hold safety notice does not prevent a valid already-running assignment
from recording its result; other undelivered inbox events still do. Imported
tasks cannot author outgoing local dependency edges. Placement recalculates
readiness using the chosen project's rule in the placement transaction.
Linked repository verification is asynchronous and rechecks configuration and
task identity before committing or provisioning, so a stale verification cannot
restore an invalidated grant.

## Deterministic checks

The real-SQLite/fake-reader suites are `github-source-config`,
`github-source-reader`, `github-reconciliation`, `github-dependencies`,
`github-sync-race` and `github-service`. They cover preview/version activation, pagination and
partial errors, identity and cross-project placement, retained blocker
references, initial and repeated unknown states, active-turn and stale-routing
holds, operator review receipts, timer/explicit refresh and stop. Audit-repair
fixtures cover delayed selection/blocker/status observations across
reconfiguration, differing placement-readiness rules, active result reporting
with independent inbox guards, held-lead notices, outgoing-edge authority,
and asynchronous Git identity verification with stale version/credential and
provisioning grants. The
authenticated HTTP and Chromium source-view fixture checks HTML escaping,
local-task visibility, credential exclusion, login, Origin and CSRF guards.
These checks do not qualify current provider permissions or fixture content.
With Node.js 24.21.0 and npm 12.2.0, `npm ci` completed with zero reported
vulnerabilities and `npm run check` passed type checking, lint, formatting,
build and all 323 tests on 1 October 2026. Biome reported four pre-existing
warnings in unrelated S05/standalone code and a schema-version information
message; it reported no lint or format errors. The focused HTTP/Chromium test
was run with loopback access after the filesystem sandbox denied a local listen.

## Required live check: passed

On 1 October 2026 Chris authorised creation of a private synthetic fixture
repository and Project, and use of the existing `gh` credential only in process
memory behind the harness's provider-write guard. This explicitly amends the
planned least-privilege credential prerequisite for this qualification run.
The credential has broader write scopes; this evidence does not establish
token-level read-only permissions. No token was printed or written to disk.

`test/s06/live-github-source.mjs` passed at
`2026-10-01T14:49:23.935Z`, against implementation
`cb43790e0f909777bf4e73de7992227d3d661255`, using Node.js 24.21.0.
The prepared identities and expected cases are retained in
[`test/s06/fixture-manifest.json`](../../test/s06/fixture-manifest.json):

- Repository: [chrisbanes/ensemble-s06-fixture](https://github.com/chrisbanes/ensemble-s06-fixture),
  node `R_kgDOU3TyZQ`.
- Project: [Ensemble S06 qualification, #11](https://github.com/users/chrisbanes/projects/11),
  node `PVT_kwHOAAN4ns4BlV3Y`; private, with four issue memberships.
- Search: `repo:chrisbanes/ensemble-s06-fixture label:s06-ready`.
- Project filter: `label:s06-selected`; readiness requires `s06-ready`.

| Issue | Prepared case | Expected and observed admission |
| --- | --- | --- |
| #1 | Ready, no native blockers; repository/search/Project overlap | Eligible |
| #2 | Ready, blocked by open #5 | Blocked |
| #3 | Ready, blocked by closed #6 | Eligible |
| #4 | Selected, missing readiness label | Blocked |
| #5 | Open blocker, outside filtered search and Project | Blocked |
| #6 | Closed blocker, outside filtered search and Project | Blocked |

All three provider selections completed. The harness verified expected issue
identities, memberships, native dependency reads and current issue states,
then refreshed the service into disposable local SQLite with a fake runtime.
Admission and rendered operator project/task views matched every expected case.
The repository selection includes #5 and #6; this live run does not demonstrate
a blocker outside every configured selection. Deterministic outside-selection,
pagination, outage, reopening and mid-work cases retain the coverage above.

The guarded qualification recorded `providerWrites: 0`. Fixture setup separately
created six issues, two labels, four Project memberships and two native edges,
and closed #6; those were authorised setup writes, not read-only harness effects.
The repository and Project remain available for repeatable checks. The temporary
service database was removed; no model calls, repository execution grants,
production backlog import, deployment or cutover occurred.

To repeat, build the service, provide `ENSEMBLE_S06_GITHUB_TOKEN` only to the
qualification process, and invoke
`ENSEMBLE_S06_FIXTURE_MANIFEST="$PWD/test/s06/fixture-manifest.json" node test/s06/live-github-source.mjs`.
The manifest contains references and expected cases, not a credential.
A missing manifest or credential fails before provider requests; a missing or
changed expected case fails rather than being manufactured.

Validation in this checkout used pinned Node.js 24.21.0/npm 12.2.0.
`npm ci` reported zero vulnerabilities. The initial test stage failed because
the filesystem sandbox denied loopback listeners. Final `npm run check` with
loopback access passed type checking, lint, formatting, build and all 323 tests.
The four existing lint warnings and schema information message remain.

External GitHub writes and completion reconciliation belong to S07; this
report does not claim A24, A26 or operational release qualification.

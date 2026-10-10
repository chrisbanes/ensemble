# S04a command and view boundary

`StandaloneService.domain()` exposes `DomainStore` only after the standalone
directory owner is acquired and the SQLite migrations have completed. The domain
tables share `standalone.sqlite`; there is no second service database or runtime
process. `DomainStore.migrate()` uses its own `domain_schema` version and runs
under the directory owner. The legacy core tables share the same database.

## Command receipts

`DomainCommands.execute(command)` is the async command boundary. `DomainStore.execute`
is its synchronous SQLite implementation. Every command has a UUID key, actor,
scope, and validated payload. Command receipts are keyed by scope and UUID;
matching retries replay the stored result before checking an obsolete expected
version. Changed payloads conflict. Concurrent calls through one `DomainCommands`
instance share the original promise. A SQLite `BEGIN IMMEDIATE` transaction makes
the receipt and state change atomic across service restarts. Callers must keep a
command key stable for a logical retry.

## Authority and configuration

Operator-only commands create and configure projects, tasks, and profiles; change
project routing settings; apply current instruction/profile revisions to an
assignment; and edit local dependencies. Assignment creation may come from a
scoped agent, but its task and project identities must match and its profile must
be the project lead or an operator-configured permitted candidate. A nested
assignment must remain on its requester's task; an explicit lead allocation may
omit the requester. Local tasks start unready, projects start paused, and neither
routing opt-in nor an assignment record grants execution admission. Profile
revocation is checked against current profile state even when an assignment
retains older revision snapshots. A draft project may have no lead, but it cannot
admit work until its configured lead profile exists and is active; the
existing-project form can set or replace it.

## Admission eligibility

`admission(taskId)` returns a structured eligibility result with project pause,
active project lead, task readiness/state, imported-blocker state, and unfinished
local dependencies. `assignmentAdmission(assignmentId)` adds current profile
revocation and assignment hold state. These are read-side inputs to the
scheduler; the scheduler also checks its own writer, runtime, capacity, and
permission holds at effective admission. Imported-blocker `unknown` is persisted
and holds execution after restart. Live GitHub blocker observations come from the
source integration.

## Routing operations

`recordRouting` persists one operation per project/task work version. The
identity, candidate/profile revisions, guidance revision, model/question,
judgment, disposition, assignment identity, and result destination remain
readable after restart. Same-payload retries replay; competing operation IDs or
changed payloads conflict. An `assigned` disposition requires assignment details;
`recordRouting` checks current task, guidance, candidate, opt-in and admission
state for every new disposition. A delayed fallback after a task, routing or hold
change is refused rather than recorded as actionable; a matching retry of an
already committed operation still replays its receipt. An assigned disposition
creates the pending assignment in the same transaction as the operation. A stale
or held decision creates neither record. `recordRouting` does not call TypeSafe or
consume model responses. Downstream routing rechecks admission before launch.
A routing operation is not an execution intent. When routing is disabled, an
explicit lead allocation can still use the scoped `assignment.create` command
without a routing operation.

## Operator forms

`LocalOperatorUi` supplies project, task, profile and routing forms plus HTML read
views over the same commands. The authenticated `LocalOperatorHttp` mounts on
`127.0.0.1` only; the `operator` CLI mode starts it while the standalone runtime
is active. Its web allowlist does not expose assignment, dependency or
imported-blocker commands; runtime and coordination controls are separate
extension routes ([S04c](s04c-operator-ui.md), [S04d](s04d-operator-integration.md)).
Each rendered form carries a command key, and create forms also carry their
record ID. Reposting the same form payload replays one receipt after a lost
redirect; a changed payload with that key conflicts. A fresh form gets a new key.
The read view reports credential availability, never a credential value or
environment-variable reference. Configuration accepts only `env:NAME`
references. Private remote access qualification is separate from the form
interface.

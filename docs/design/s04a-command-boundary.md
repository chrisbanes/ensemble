# S04a command and view boundary

`StandaloneService.domain()` exposes `DomainStore` only after the standalone
directory owner is acquired and the SQLite migrations have completed. The S04a
tables share `standalone.sqlite`; no second service database or runtime process is
introduced. `DomainStore.migrate()` uses its own `domain_schema` version and runs
under the S02 directory owner. The legacy core tables remain available during
the transition to the scheduler and workspace slices.

`DomainCommands.execute(command)` is the async command boundary. `DomainStore.execute`
is its synchronous SQLite implementation. Every command has a UUID key, actor,
scope, and validated payload. Command receipts are keyed by scope and UUID;
matching retries replay the stored result before checking an obsolete expected
version. Changed payloads conflict. Concurrent calls through one `DomainCommands`
instance share the original promise. A SQLite `BEGIN IMMEDIATE` transaction makes
the receipt and state change atomic across service restarts. Callers must keep a
command key stable for a logical retry.

Operator-only commands create and configure projects, tasks, and profiles; change
project routing settings; apply current instruction/profile revisions to an
assignment; and edit local dependencies. Assignment creation may come from a
scoped agent, but its task and project identities must match and its profile must
be the project lead or an operator-configured permitted candidate. Local tasks
start unready, projects start paused, and neither routing opt-in nor an assignment
record grants execution admission. Profile revocation is checked against current
profile state even when an assignment retains older revision snapshots.

For #691, `admission(taskId)` returns a structured eligibility result with
project pause, task readiness/state, imported-blocker state, and unfinished local
dependencies. `assignmentAdmission(assignmentId)` adds current profile revocation
and assignment hold state. These are read-side inputs to the later scheduler;
the scheduler must also check its own writer, runtime, capacity, and permission
holds at effective admission. Imported-blocker `unknown` is persisted and holds
execution after restart. Live GitHub blocker observations belong to S06.

For #693, `recordRouting` persists one operation per project/task work version.
The identity, candidate/profile revisions, guidance revision, model/question,
judgment, disposition, assignment identity, and result destination remain
readable after restart. Same-payload retries replay; competing operation IDs or
changed payloads conflict. An `assigned` disposition requires assignment details;
`recordRouting` checks current task, guidance, candidate and admission state and
creates the pending assignment in the same transaction as the operation. A stale
or held decision creates neither record. This slice does not call TypeSafe or
consume model responses. Downstream routing rechecks admission before launch.
A routing operation is not an execution intent.

For #703, `LocalOperatorUi` supplies project, task, profile, assignment, routing,
and dependency forms plus HTML read views over the same commands. `LocalOperatorHttp`
mounts these locally on `127.0.0.1` only; the `operator` CLI mode starts it while
the standalone runtime is active. Its read view reports credential availability,
never a credential value or environment-variable reference. The credential
configuration accepts only `env:NAME` references; the later authenticated
operator foundation owns remote access and login. The loopback interface is an
integration surface, not the finished operator UI.

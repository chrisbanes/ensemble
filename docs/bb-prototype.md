# BB delegation prototype

## Decision and scope

Run Ensemble’s host-independent core inside a BB plugin. Use Taskboard's project-scoped board,
task details, and conversation context as design references. There is no Taskboard
dependency or fork. The product architecture is recorded in ADR-1001 and the host boundary in ADR-1003.

This experiment tests the smallest storage/execution boundary: create a local task,
delegate one worker, persist its result, and recover the assignment after a restart.
An existing operator-selected BB conversation acts as the coordinator. Project lead
creation, nested delegation, multiple profiles, result notifications, and the task
panel are later slices. The prototype allows only one assignment per task.

## Ownership

| Ensemble | BB |
| --- | --- |
| Task and project identity, title, host bindings | Host project and repository configuration |
| Assignment brief, instruction snapshot, state, result | Conversation, provider process, transcript |
| Reconciliation of launch intent | Workspace provisioning and execution lifecycle |
| Future source memberships and handoffs | Plugin settings, database handle, and UI host |

The core owns its schema and receives a SQLite connection. The BB adapter supplies
BB’s SQLite handle; standalone tests use Node’s SQLite driver against temporary
files. `src/server.ts` is the manifest entry and re-exports the BB adapter.
`EnsembleService` owns caller authorization and commands; `Coordinator` owns
launch/reconciliation through the small `WorkerHost` spawn/find contract.

## Prototype tools

Configure these plugin settings through BB before starting the experiment:

- `project`: one disposable BB project.
- `coordinatorThread`: an existing thread in that project.
- `provider` and `model`: an installed provider and a supported model.
- `instructions`: the operator's worker instructions.

Start or resume the coordinator's provider session so BB resolves the new tools.
The coordinator can call:

- `ensemble_create_task({id, title})`: supply a UUID; identical retries reuse it.
- `ensemble_delegate({id, taskId, brief})`: supply a separate assignment UUID;
  identical retries preserve the original assignment and launch intent.
- `ensemble_assignments({})`: reconcile uncertain launches and read durable results.

The worker calls `ensemble_report({assignmentId, result})`. Only the stored worker
thread in the stored project may report. Identical repeated results are accepted;
a changed result is rejected. Completion means a result was recorded, not that a
task is verified, a PR is merged, or an external issue is closed.

Workers use BB's project-default environment and `accept-edits` permission mode.
These settings do not provide Ensemble's planned project-level security boundary.
Use a disposable project. The plugin has no workspace cleanup or publication code.
The operator controls the coordinator ID and worker configuration; agent tools
cannot change them. Changing the selected project or coordinator immediately revokes the previous
coordinator’s management access. An already assigned worker may still report its
result. Assignments retain their captured instructions; versioned execution
profiles and explicit instruction updates remain future work.

## Recovery

The assignment moves from `pending` to `launching` in SQLite before calling BB.
The BB thread is created with the assignment ID in this plugin's metadata. After a
confirmed response, the assignment stores its thread ID and becomes `running`.

If the response is lost, startup or an explicit assignment read scans BB threads
for a matching project, plugin, and assignment ID. One match reconnects the
assignment. Multiple matches require operator investigation. No matches leave the
launch unresolved: the original request could still finish, or its thread could
be archived, deleted, or have changed metadata. No automatic retry occurs.

The plugin does not claim exactly-once execution. BB plugin metadata is mutable;
reconciliation assumes a trusted experimental BB instance. It is not authority
for repository access or protection against a malicious agent rewriting metadata.
After reconnection, the existing thread continues through BB; the plugin does not
start a replacement agent. Missing conversations need manual investigation.

Results remain readable after restart. Automatic delivery to a sleeping owner is
not implemented: that requires a durable delivery record and proven BB message
idempotency. For this experiment the operator asks the coordinator to read results.

## Schema and portability

New projects have Ensemble UUIDs distinct from BB project IDs. Task and assignment
records use those IDs; separate project and conversation bindings retain host
references. The four BB tools keep their existing JSON shape, including BB
`projectId` and `threadId` fields.

On initialization, a transactional schema migration retains original task and
assignment IDs, states, results, and BB references. Legacy project IDs are retained
as historical Ensemble IDs with explicit host bindings; newly created projects
receive independent IDs. Historical instructions that were never stored stay
null; uncertain launches remain uncertain and cannot automatically spawn again.
The schema version and host installation identity survive restart. Opening a newer
schema or selecting another host kind fails. This is a one-host installation,
not a facility for moving unfinished work between hosts.

## Validation

`npm run check` covers type compatibility with the pinned published SDK and:

1. SQLite close/reopen preserving a local task, assignment, worker, and result.
2. A lost spawn response followed by restart reconnecting to the existing worker.
3. Concurrent launch attempts producing one host call.
4. Zero or multiple reconciliation matches refusing automatic replacement work.
5. Cross-project delegation and results from foreign threads being rejected.
6. Plugin tool registration, input validation, actor checks, and reload reconciliation
   through a fake public BB API.

These include automated tests with a fake execution host. Additional core tests
cover caller policy, distinct IDs, conflicting bindings, instruction snapshots,
preflight failures, migration rollback and legacy uncertain-launch recovery.
A dependency test rejects direct/transitive BB or adapter imports, including
exports and literal dynamic imports. A subprocess runs copied compiled core
modules with only Zod installed, exercises restart/recovery, and verifies BB
cannot resolve.

`npm run test:bb-integration` exercises the pinned real BB host and fixture API.
`npm run test:bb-prototype` installs the production adapter into an isolated BB
instance and exercises its four tools with a scripted provider, durable results,
foreign-report rejection, restart, and replay without another worker. These
suites use disposable data and repositories and leave the installed Haze
prototype untouched. They do not provide authenticated-provider release evidence.
The startup queue and delayed writer-release capability gaps remain recorded in
[BB capabilities](bb-capabilities.md).

### Extraction evidence — 25 September 2026

The standalone core tests, T1–T5 aggregate, and production adapter smoke passed
on Node 24.21.0, npm 12.1.0, BB 0.43.4 and SDK package 0.5.27 on macOS arm64.
The production smoke verified the actual BB plugin loader and SQLite driver,
one completed assignment, foreign-report rejection, stable core and host IDs
after restart, and replay without another conversation. Cleanup confirmed all
owned processes exited, both ports closed, and the disposable root was removed.

### Live installation evidence — 24 September 2026

Installed from `path:/Users/chris/dev/ensemble` into the local BB 0.43.4 instance.
BB required `bb.branding` in the manifest and reported its bundled SDK as 0.5.9.
Added branding, pinned the dependency to SDK 0.5.9, verified type checking and all
five tests, and reloaded. A fresh `bb plugin list --json` reports Ensemble enabled
and running, with all four agent tools and its settings registered. The startup
reconciliation service completes and is then shown as stopped by design.

Haze was subsequently configured with a coordinator and Codex worker settings.
The user reported successful delegation. This is feasibility evidence, not an
automated acceptance run. The remaining live checks are durable result delivery,
restart with the same worker/result, and loss of the spawn response after creation.
Preserve this installed experiment while the specification and design are reviewed;
run future integration tests in an isolated BB instance.

## Inspected references

- [BB plugin API](https://github.com/get-bb/bb/blob/fdd3de3b19b97e6cd1ef7300cbb54711431249d3/packages/plugin-sdk/src/backend-contract.ts)
- [BB Tasks delegation](https://github.com/get-bb/bb/blob/fdd3de3b19b97e6cd1ef7300cbb54711431249d3/plugins/tasks/delegate/index.ts)
- [Taskboard](https://github.com/MateoCerquetella/bb-plugins/tree/821855b07d68d9be4f9fd767b977c4c419b8acb4/plugins/taskboard)

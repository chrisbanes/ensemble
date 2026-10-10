# UI02 foundation contract

The React operator is served at `/app`; `/` and all existing operator forms remain available. One production operator listener serves the built bundle and same-origin `/api/operator` boundary. The boundary delegates durable writes to existing domain and coordination commands. Receipts prove recorded outcomes only. `observedAt` means server capture, never successful provider sync.

## Retained-control inventory

Each semicolon-separated control is individually retained at the listed destination. No removal is authorized until a replacement has equivalent behavior, keyboard/browser evidence and approved parity review (UI07 #745). JSON readiness says whether a curated JSON adapter exists. [UI06 configuration and recovery](ui06-configuration.md) records the individual control dispositions.

| Existing destination | Command/action | Controls/read destinations | React surface or retained destination | JSON readiness |
| --- | --- | --- | --- | --- |
| / | project.create | create project; name; lead | Settings | no |
| / | profile.create | create profile; name; instructions; capabilities | Settings | no |
| /project/:id | project.configure | name; lead; instructions; pause | Settings | no |
| /profile/:id | profile.configure | name; instructions; capabilities; revoke | Settings | no |
| /project/:id | routing.configure | enable; guidance; candidates; set/clear credential reference | Settings | no |
| /project/:id | github.configure | selections; readiness; repositories; set/clear credential reference | Settings | no |
| /project/:id | github.preview | preview selections; activation via preview receipt | Settings | no |
| /project/:id | github.refresh | refresh observation | Settings | no |
| /project/:id | github.place | conflicting placement | Settings | no |
| /project/:id | delivery.configure | completion mode; scoped grants; required checks; set/clear credential reference | Retained exact editor; Settings links it | no |
| /coordination/task/:id | delivery.read | issue observation; Project field observations; PR identity/head/state; provider feedback; external action states; local task state; delivery holds | Retained coordination task page | no |
| /coordination/task/:id | /coordination/control/delivery/settle | Accept handback; Settle outcome as closed; task/delivery/policy revisions; repository/PR/node/head guard | Retained coordination task page | no |
| /coordination/task/:id | /coordination/control/delivery/refresh | refresh delivery observations | Retained coordination task page | yes |
| /project/:id | task.create | draft; create and start; project-page task form | Task composer (`/app/tasks/new`) | yes |
| /task/:id | task.configure | local title; outcome; readiness | Retained task page | yes |
| /task/:id | source.review | source identity; body; status; Project fields; native blockers; review; hold resolution | Retained task page | no |
| /runtime | /runtime/control/capacity | global capacity; project override; remove override | Settings (Runtime) | no |
| /runtime/task/:id | /runtime/control/dependency/add | local dependency add | Retained Runtime task page | yes |
| /runtime/task/:id | /runtime/control/dependency/remove | local dependency remove | Retained Runtime task page | yes |
| /runtime/task/:id | /runtime/control/instruction-apply | apply project instructions and profile revisions | Retained Runtime task page | yes |
| /runtime/task/:id | /runtime/control/stop | stop request and observation | Retained Runtime task page | no |
| /runtime/task/:id | /runtime/control/resume | explicit resume | Retained Runtime task page | no |
| /runtime/assignment/:id | read | generation; holds; advanced recovery evidence | Assignment recovery | read subset |
| /coordination/task/:id | /coordination/control/message | message recipient; exact version; durable message | Task workspace; retained coordination task page | yes |
| /coordination/task/:id | /coordination/control/result/recipient | unresolved results; destination reconciliation | Retained coordination task page | yes |
| /coordination/assignment/:id | read | retained captured history; omissions; results | Retained coordination assignment page | yes |
| /coordination/task/:id | /coordination/control/question/answer | plain question and exact revision answer | Inbox and request view; retained coordination task page | yes |
| /coordination/task/:id | /coordination/control/approval/decision | retained exact material; approve; deny | Inbox and request view; retained coordination task page | yes |
| /login | /login | password sign-in | Sign-in | yes |
| all authenticated views | /logout | sign-out | Account menu | yes |
| all views | navigation | delivered overview/project List/Board/composer; retained task/profile/assignment/Runtime/Coordination destinations | App shell and retained destinations | curated reads |
| /assignment/:id | read | captured instructions/profile revision and result destination | Retained assignment page | curated subset |

The delivery rows cover the existing delivery controls: the exact policy/authority editor is retained, and the task delivery facts, guarded handback settlement and observation refresh live in the coordination task page. Only observation refresh has a JSON command; policy editing and settlement have no JSON delivery adapter. Settlement records an operator decision; refresh requests provider observations. Neither action alone completes the local task.

Advanced authenticated recovery routes have no rendered form or React control. The host operator supplies the reviewed evidence and exact command material under the existing Origin, session and CSRF checks; model tools have no adoption authority.

| Advanced route | Owner and disposition |
| --- | --- |
| `/runtime/control/pre-turn/adopt` | historical pre-turn evidence adoption; exact held generation, operator attestation and immutable command receipt. Witness acknowledgement appears on the shared task/assignment runtime history and assignment recovery view. |
| `/runtime/control/pre-turn/recover` | exact witness-bound recovery; independently verified termination and settled effects/workspace reconcile ownership without dispatch. Existing runtime history records the receipt and retained holds. |
| `/runtime/control/no-turn/adopt` | distinct historical no-turn-submission evidence adoption; reviewed complete invocation ledger and exact known-null-predecessor generation. Shared task/assignment runtime history and assignment recovery view acknowledge the witness while retaining possible idle-thread creation. |
| `/runtime/control/no-turn/recover` | exact no-turn witness-bound recovery; verified process termination and settled effects/workspace reconcile ownership without dispatch. Separate conversation replacement and NEW message remain required; no model tool authority or new forms in the curated operator UI. |
| `/runtime/control/conversation-replace` | explicit recovery counterpart; assignment/conversation revision checks and immutable keyed result prevent duplicate increments. Fresh operator message remains separately required for continuation. |

Programmatic support (no new HTTP exposure):

| Command | Destination | Disposition |
| --- | --- | --- |
| `assignment.create` | Task composer; retained assignment page | Optional initial assignment in atomic `task.create`; standalone assignment creation remains programmatic |
| `assignment.apply` | Retained assignment page | Durable adapter and retained `/runtime/control/instruction-apply` |
| `dependency.add` | Retained Runtime task page | Durable adapter and retained `/runtime/control/dependency/add` |
| `dependency.remove` | Retained Runtime task page | Durable adapter and retained `/runtime/control/dependency/remove` |
| `imported-blockers.set` | Explicitly unsupported operator exposure | Existing programmatic case only; no HTTP or JSON endpoint |

`LocalOperatorUi.submit` cases that are not current HTTP controls: `assignment.create`, `assignment.apply`, `dependency.add`, `dependency.remove`, `imported-blockers.set`. The latter remains unexposed. `github.activate` is applied from the existing preview flow and has no arbitrary JSON adapter.

## Transport and safe projection

Foundation reads: `/api/operator/session`, `/workspace`, `/projects/:projectId`, `/tasks/:taskId`, `/assignments/:assignmentId/history`. The task list, composer options, inbox, search, configuration, runtime settings, source observations and recovery reads follow the same rules ([UI03](ui03-tasks.md), [UI06](ui06-configuration.md)). Authenticated writes: `/commands`; auth writes: `/login`, `/logout`. Every DTO is strict and runtime validated; no actor, credentials, raw payload, diagnostic/recovery/process rows or workspace paths cross the boundary. JSON is bounded to 64 KiB; approval material to 8 KiB. Existing Host, exact Origin, sessions, cookie attributes, expiry and CSRF remain authoritative. There is no CORS or forwarded-header trust.

Active request selection crosses configured assignment revisions before falling back to the current version. Execution generation remains the selected actual request's work/version/instruction/profile snapshots; configured revisions describe the next turn. Unresolved results supply their own positive destination revision and permitted same-task recipient, with null when unavailable. Existing reconciliation policy validates writes again.

Unsafe approval material becomes unavailable and deny-only; altered/redacted material is never approvable. A denial may omit material: the adapter supplies only the immutable retained JSON for that same task and interaction, privately, while preserving the submitted revision, action and target. This reconstruction does not depend on current display redaction, so a matching saved-key replay remains stable after privacy context changes. Client-supplied material is never replaced; approvals still require exposed exact material, and unavailable action or target cannot be substituted. Legacy interactions without retained JSON keep material omitted. Existing policy checks remain authoritative.

Provider timestamps are stored observations; unavailable successful sync/history is explicit. Native structured input is unavailable until qualified; the operator interface neither enables it nor resumes the paused X01-X08 work.

## Client

The React client supplies login, session lifecycle, project navigation and shared controls. [UI03](ui03-tasks.md) describes the attention overview, project and cross-project List/Board views and the local composer. Task cards open the task workspace at `/app/tasks/:id`, which links the retained `/task/:id`, Runtime and Coordination destinations. The Inbox links the retained `/coordination` controls. First load, stale refresh, invalid responses, session expiry and command outcome unknown remain distinct. Lost write responses retain the exact key and payload for deliberate reconciliation. No credential/API persistence or automatic write replay.

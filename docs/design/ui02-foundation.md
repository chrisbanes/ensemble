# UI02 foundation contract

The React shell is staged at `/app`; `/` and all existing operator forms remain available. One production operator listener serves the built bundle and same-origin `/api/operator` boundary. The boundary delegates durable writes to existing domain and coordination commands. Receipts prove recorded outcomes only. `observedAt` means server capture, never successful provider sync.

## Retained-control inventory

Each semicolon-separated control is individually retained at the listed destination. No removal is authorized until its named child has replacement behavior, keyboard/browser evidence and UI07 #745 parity approval. JSON readiness describes this foundation, not replacement forms.

| Existing destination | Command/action | Controls/read destinations | Replacement owner | JSON readiness |
| --- | --- | --- | --- | --- |
| / | project.create | create project; name; lead | UI06 #744 | no |
| / | profile.create | create profile; name; instructions; capabilities | UI06 #744 | no |
| /project/:id | project.configure | name; lead; instructions; pause | UI06 #744 | no |
| /profile/:id | profile.configure | name; instructions; capabilities; revoke | UI06 #744 | no |
| /project/:id | routing.configure | enable; guidance; candidates; set/clear credential reference | UI06 #744 | no |
| /project/:id | github.configure | selections; readiness; repositories; set/clear credential reference | UI06 #744 | no |
| /project/:id | github.preview | preview selections; activation via preview receipt | UI06 #744 | no |
| /project/:id | github.refresh | refresh observation | UI06 #744 | no |
| /project/:id | github.place | conflicting placement | UI06 #744 | no |
| /project/:id | delivery.configure | completion mode; scoped grants; required checks; set/clear credential reference | UI06 #744 retained exact policy/authority editor | no |
| /project/:id | task.create | draft; create and start; retained alongside delivered `/app/tasks/new` composer | UI03 #741 delivered | yes |
| /task/:id | task.configure | local title; outcome; readiness | UI04 #742 | yes |
| /task/:id | source.review | source identity; body; status; Project fields; native blockers; review; hold resolution | UI04 #742 | no |
| /runtime | /runtime/control/capacity | global capacity; project override; remove override | UI06 #744 | no |
| /runtime/task/:id | /runtime/control/dependency/add | local dependency add | UI04 #742 | yes |
| /runtime/task/:id | /runtime/control/dependency/remove | local dependency remove | UI04 #742 | yes |
| /runtime/task/:id | /runtime/control/instruction-apply | apply project instructions and profile revisions | UI04 #742 | yes |
| /runtime/task/:id | /runtime/control/stop | stop request and observation | UI04 #742 | no |
| /runtime/task/:id | /runtime/control/resume | explicit resume | UI04 #742 | no |
| /runtime/assignment/:id | read | generation; holds; advanced recovery evidence | UI06 #744 | read subset |
| /coordination/task/:id | /coordination/control/message | message recipient; exact version; durable message | UI04 #742 | yes |
| /coordination/task/:id | /coordination/control/result/recipient | unresolved results; destination reconciliation | UI04 #742 | yes |
| /coordination/task/:id | read | separate issue/Project, PR and task facts; delivery holds; action outcomes; provider feedback | UI04 #742 retained detail | no |
| /coordination/task/:id | /coordination/control/delivery/settle | Accept handback; Settle outcome as closed; exact task/delivery/policy revisions and PR identity/head | UI04 #742 retained detail | no |
| /coordination/task/:id | /coordination/control/delivery/refresh | Refresh delivery observations | UI04 #742 retained detail | no |
| /coordination/assignment/:id | read | retained captured history; omissions; results | UI04 #742 | yes |
| /coordination/task/:id | /coordination/control/question/answer | plain question and exact revision answer | UI05 #743 | yes |
| /coordination/task/:id | /coordination/control/approval/decision | retained exact material; approve; deny | UI05 #743 | yes |
| /login | /login | password sign-in | UI02 #740 | yes |
| all authenticated views | /logout | sign-out | UI02 #740 | yes |
| all views | navigation | delivered overview/project List/Board/composer; retained task/profile/assignment/Runtime/Coordination destinations | UI03 #741 delivered / UI04 #742 | curated reads |
| `/assignment/:id` | read | captured instructions/profile revision and result destination | UI04 #742 | curated subset |

The delivery rows record the existing S07a controls and the ownership in the [reviewed UI06 revision 2 plan](https://github.com/chrisbanes/ensemble/issues/744#issuecomment-5948676415): UI06 retains the exact policy/authority editor, while UI04 owns the task delivery facts, guarded handback settlement and observation refresh. These controls have no JSON delivery adapter in this foundation. Settlement records an operator decision; refresh requests provider observations. Neither action alone completes the local task.

Programmatic support (no new HTTP exposure):

| Command | Replacement owner/destination | Disposition |
| --- | --- | --- |
| `assignment.create` | UI03 #741 task composer with UI04 #742 assignment detail | Delivered as optional initial assignment in atomic `task.create`; standalone assignment creation remains programmatic |
| `assignment.apply` | UI04 #742 assignment detail | Durable adapter and retained `/runtime/control/instruction-apply` |
| `dependency.add` | UI04 #742 task dependency controls | Durable adapter and retained `/runtime/control/dependency/add` |
| `dependency.remove` | UI04 #742 task dependency controls | Durable adapter and retained `/runtime/control/dependency/remove` |
| `imported-blockers.set` | Explicitly unsupported operator exposure | Existing programmatic case only; no HTTP or JSON endpoint |

`LocalOperatorUi.submit` cases that are not current HTTP controls: `assignment.create`, `assignment.apply`, `dependency.add`, `dependency.remove`, `imported-blockers.set`. The latter remains unexposed. `github.activate` is applied from the existing preview flow and has no arbitrary JSON adapter.

## Transport and safe projection

Reads: `/api/operator/session`, `/workspace`, `/projects/:projectId`, `/tasks/:taskId`, `/assignments/:assignmentId/history`. Authenticated writes: `/commands`; auth writes: `/login`, `/logout`. Every DTO is strict and runtime validated; no actor, credentials, raw payload, diagnostic/recovery/process rows or workspace paths cross the boundary. JSON is bounded to 64 KiB; approval material to 8 KiB. Existing Host, exact Origin, sessions, cookie attributes, expiry and CSRF remain authoritative. There is no CORS or forwarded-header trust.

Active request selection crosses configured assignment revisions before falling back to the current version. Execution generation remains the selected actual request's work/version/instruction/profile snapshots; configured revisions describe the next turn. Unresolved results supply their own positive destination revision and permitted same-task recipient, with null when unavailable. Existing reconciliation policy validates writes again.

Unsafe approval material becomes unavailable and deny-only; altered/redacted material is never approvable. A denial may omit material: the adapter supplies only the immutable retained JSON for that same task and interaction, privately, while preserving the submitted revision, action and target. This reconstruction does not depend on current display redaction, so a matching saved-key replay remains stable after privacy context changes. Client-supplied material is never replaced; approvals still require exposed exact material, and unavailable action or target cannot be substituted. Legacy interactions without retained JSON keep material omitted. Existing policy checks remain authoritative.

Provider timestamps are stored observations; unavailable successful sync/history is explicit. Native structured input belongs to UI01/UI05 after qualification. UI02 neither enables native availability nor resumes deferred X work.

## Client and staged access

UI02 supplied login, session lifecycle, project navigation and shared controls. [UI03](ui03-tasks.md) now delivers attention overview, project/cross-project List/Board and local composer. Inbox/settings retain clearly labelled links to existing controls; task cards retain `/task/:id`, including Runtime/Coordination destinations. First load, stale refresh, invalid responses, session expiry and command outcome unknown remain distinct. Lost write responses retain the exact key and payload for deliberate reconciliation. No credential/API persistence or automatic write replay.

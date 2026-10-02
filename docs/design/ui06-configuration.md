# UI06 configuration and recovery contract

UI06 completes the reviewed setup, configuration and recovery surfaces in the React operator served by the existing listener. Existing authenticated HTML editors stay reachable. UI07 owns final visual/usability parity and removal approval; this delivery does not qualify release, cutover, real provider access, native structured input or paused X01-X08.

## Configuration and receipt behavior

Settings is `/app/settings`. Profile and paused-project creation are separate recorded steps; optional project instructions are saved later through project configuration. Creation starts no execution. Project/profile edits omit unchanged optional private input; an explicit empty instruction replacement clears it. Routing guidance/candidates and source selections/readiness/repositories are complete explicit replacements. Search queries, Project filters and repository paths are write-only replacement input; exact current-value or partial edits remain at `/project/:id` and `/profile/:id`. Credential references support omission to preserve, null to clear, or a valid environment reference to set. Credential values are server-only. Only the GitHub command input makes its reference optional; persisted configuration remains required/nullable. Omitted input is literally omitted before canonical hashing; existing explicit hashes remain compatible.

The browser fixes a key, create identity, submitted revisions and validated bytes for each operation. An unknown result freezes that concrete form/resource across same-session internal navigation; explicit reconciliation sends the original key and payload. A subsequent rejection/conflict cannot erase prior uncertainty. Matching original receipts stay recorded independently of fresh observations. Later configuration reads cannot replace a receipt or alter a dirty/frozen submission. Editable conflicts require explicit review/adoption of the loaded revision before a new operation. Recorded operations remain separate from latest resource observations.

Private draft state lives only in authenticated application memory. Expiry/logout purges it and suppresses delayed completions. Reload or session end discards private drafts: no cross-session browser draft recovery is claimed. There is no configuration localStorage/sessionStorage, private URL field, automatic replay, browser credential resolution or current-state receipt reconstruction. Current/retained instructions, declared credential refs/values and repository/workspace/control paths are excluded from curated JSON, including labels and receipts. Exact private editors retain existing authentication.

Project/profile/routing/source writes retain existing policy and expected versions. Repository verification errors return fixed repositories inline input errors before mutation; diagnostics are discarded. Commit, notification, wakeup and invalid projection failures stay outcome-unknown. Capacity keeps its existing keyed command with no configuration version/CAS; lowering limits holds new admission without terminating active work.

## Source observations and execution recovery

Preview maps the public `github.preview` input to existing `github.activate` authority. A server-only complete command scope/actor/type/key/selection/version/hash lookup replays the original activation before provider access. Fresh preview requires current configuration and a complete version-matched read. Activation does not prove task import or successful sync. `/api/operator/source-refresh` is a guarded POST requesting installation-wide observations, with complete/partial/never/unavailable state separate from attempts and available successful timestamps. It creates no domain receipt and accepts no arbitrary provider/project URL.

Runtime Settings shows configured/effective caps and actual usage. Recovery at `/app/assignments/:id/recovery` separates captured/configured/current-next revisions from the actual selected admitted generation. All verified task-scoped recovery rows contribute independent Stop, task, writer, capacity and uncertainty holds before the newest 20 evidence rows are selected in persisted insertion order. Omitted count is explicit; older holds and the supported next step remain visible. Foreign or unverified unbound rows are excluded; a selected request without binding can appear only by its exact verified request/assignment identity. Unknown observation kinds remain unknown. Raw process/thread/turn/path/reason data stays out of this projection.

Advanced original recovery/Apply, task Stop/Resume/dependencies, captured history, task/source review and messages/results/questions/approvals remain linked to their exact retained destinations. Recovery is read-only: identities, receipts, acknowledgement and elapsed time do not establish termination or authorize ownership release. Resume clears operator Stop independently of other holds. Phone layouts explain current state and link the desktop-first advanced evidence.

## Individual control dispositions

Every semicolon-separated foundation inventory control appears individually below. Original routes/forms remain supported; these concrete dispositions were reviewed in #744. A replacement does not authorize removing its retained control.

| Command/action | Control/read operation | Retained destination | Reachable replacement or retained destination | Disposition |
| --- | --- | --- | --- | --- |
| project.create | create project | / | /app/settings/projects/new | Implemented replacement; original control retained. |
| project.create | name | / | /app/settings/projects/new | Implemented replacement; original control retained. |
| project.create | lead | / | /app/settings/projects/new | Implemented replacement; original control retained. |
| profile.create | create profile | / | /app/settings/profiles/new | Implemented replacement; original control retained. |
| profile.create | name | / | /app/settings/profiles/new | Implemented replacement; original control retained. |
| profile.create | instructions | / | /app/settings/profiles/new | Implemented replacement; original control retained. |
| profile.create | capabilities | / | /app/settings/profiles/new | Implemented replacement; original control retained. |
| project.configure | name | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. |
| project.configure | lead | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. |
| project.configure | instructions | /project/:id | /app/projects/:id/settings | Explicit write-only replacement in React; exact current private values and partial edits remain in retained editor. |
| project.configure | pause | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. |
| profile.configure | name | /profile/:id | /app/profiles/:id/settings | Implemented replacement; original control retained. |
| profile.configure | instructions | /profile/:id | /app/profiles/:id/settings | Explicit write-only replacement in React; exact current private values and partial edits remain in retained editor. |
| profile.configure | capabilities | /profile/:id | /app/profiles/:id/settings | Explicit write-only replacement in React; exact current private values and partial edits remain in retained editor. |
| profile.configure | revoke | /profile/:id | /app/profiles/:id/settings | Implemented replacement; original control retained. |
| routing.configure | enable | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| routing.configure | guidance | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| routing.configure | candidates | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| routing.configure | set/clear credential reference | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| github.configure | selections | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| github.configure | readiness | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| github.configure | repositories | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| github.configure | set/clear credential reference | /project/:id | /app/projects/:id/settings | Explicit complete replacement in React; exact private guidance, queries, filters and paths and partial edits remain in retained editor. |
| github.preview | preview selections | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. |
| github.preview | activation via preview receipt | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. |
| github.refresh | refresh observation | /project/:id | /app/projects/:id/settings | Installation-wide observation request; no domain receipt or successful-sync claim. |
| github.place | conflicting placement | /project/:id | /app/projects/:id/settings | Implemented replacement; original control retained. |
| task.create | draft | /project/:id | /app/tasks/new | Implemented replacement; original control retained. |
| task.create | create and start | /project/:id | /app/tasks/new | Implemented replacement; original control retained. |
| task.create | retained alongside delivered `/app/tasks/new` composer | /project/:id | /app/tasks/new | Implemented replacement; original control retained. |
| task.configure | local title | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| task.configure | outcome | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| task.configure | readiness | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| source.review | source identity | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| source.review | body | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| source.review | status | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| source.review | Project fields | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| source.review | native blockers | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| source.review | review | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| source.review | hold resolution | /task/:id | /task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /runtime/control/capacity | global capacity | /runtime | /app/settings/runtime | Implemented replacement; original control retained. |
| /runtime/control/capacity | project override | /runtime | /app/settings/runtime | Implemented replacement; original control retained. |
| /runtime/control/capacity | remove override | /runtime | /app/settings/runtime | Implemented replacement; original control retained. |
| /runtime/control/dependency/add | local dependency add | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /runtime/control/dependency/remove | local dependency remove | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /runtime/control/instruction-apply | apply project instructions and profile revisions | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /runtime/control/stop | stop request and observation | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /runtime/control/resume | explicit resume | /runtime/task/:id | /runtime/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| read | generation | /runtime/assignment/:id | /app/assignments/:id/recovery | Read-only curated evidence; exact advanced evidence and existing Apply remain retained. No ownership release or proof controls. |
| read | holds | /runtime/assignment/:id | /app/assignments/:id/recovery | Read-only curated evidence; exact advanced evidence and existing Apply remain retained. No ownership release or proof controls. |
| read | advanced recovery evidence | /runtime/assignment/:id | /app/assignments/:id/recovery | Read-only curated evidence; exact advanced evidence and existing Apply remain retained. No ownership release or proof controls. |
| /coordination/control/message | message recipient | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/message | exact version | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/message | durable message | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/result/recipient | unresolved results | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/result/recipient | destination reconciliation | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| read | retained captured history | /coordination/assignment/:id | /coordination/assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| read | omissions | /coordination/assignment/:id | /coordination/assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| read | results | /coordination/assignment/:id | /coordination/assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/question/answer | plain question and exact revision answer | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/approval/decision | retained exact material | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/approval/decision | approve | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /coordination/control/approval/decision | deny | /coordination/task/:id | /coordination/task/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /login | password sign-in | /login | /login | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| /logout | sign-out | /app | /app | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| navigation | delivered overview/project List/Board/composer | /app | /app | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| navigation | retained task/profile/assignment/Runtime/Coordination destinations | /app | /app | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |
| read | captured instructions/profile revision and result destination | /assignment/:id | /assignment/:id | Retained at this exact destination; UI04/UI05 detail and Inbox remain separate delivery scope. |

Programmatic dispositions: `assignment.create` remains programmatic as a standalone operation; delivered `/app/tasks/new` supports optional initial assignment atomically with task creation. `assignment.apply`, `dependency.add` and `dependency.remove` retain their exact runtime controls and existing JSON adapters. `imported-blockers.set` has no HTTP/JSON exposure. Arbitrary `github.activate`, recovery-resolution/proof submission and force unlock remain unsupported. No routing/plugin/development-stage framework is added.

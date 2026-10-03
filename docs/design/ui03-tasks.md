# UI03 task views and composer

Delivery UI03 #741 adds the `/app` attention preview, `/app/tasks` and `/app/projects/:id` List/Board views, and `/app/tasks/new`. One complete aggregate feeds both presentations and their shared URL filters. Rows and cards open the existing `/task/:id`; Inbox links `/coordination`. Project controls, local task configuration, Runtime and Coordination remain operational. UI04 #742, UI05 #743 and UI06 #744 retain their replacement responsibilities; UI07 and parent #736 acceptance remain separate.

The 3 October 2026 [operator UX refinement](../SPEC.md#operator-interface-and-human-requests)
adds requirements for evidence-backed next actors, separate attention and work
state, and progressive composer disclosure. The [reviewed design handoff](../../design/DESIGN.md#approved-refinement-brief--3-october-2026)
records the completed Pen revision and its static review. The delivery record below and existing evidence
do not establish implementation or qualification of those refinements. The board
mapping and command/admission contracts remain unchanged.

## Creation and admission

`task.create` accepts optional unique same-project `blockerTaskIds` (maximum 128) and `initialAssignment: {assignmentId, profileId}`. Its one outer transaction reuses private dependency and assignment policy before committing the original receipt and waking admission. Invalid profile/project/edge policy rolls the entire creation back. An explicit permitted active assignee bypasses routing; admission still enforces project configuration, pause, capacity, dependency, Stop and ownership holds. Assignment result accountability remains with the retained task lead.

Omitted optional fields remain omitted in canonical payload hashes. Explicit `[]` is a different command payload. Matching retries replay the original receipt before current version/profile policy, including after restart or a post-commit wakeup failure. Only domain policy failures from a rolled-back command are definite rejections; notification failures after commit, including typed policy errors from coordination wakeup, remain unknown until exact receipt reconciliation. A receipt establishes a saved draft (`ready=false`) or Ready task (`ready=true`), never execution. The receipt view reads actual execution and exposes Refresh execution; an unsuccessful read does not invalidate confirmed creation.

The composer accepts a title, substantial desired outcome, optional context, up to 32 HTTP(S) reference links, a permitted assignee and existing same-project dependencies. Fixed labelled sections append context and passive links to the existing outcome, within its 16,000-character bound. References trigger no fetch and confer no repository access. Imported tasks use source-owned read-only title/outcome/readiness in the retained detail; the composer creates local tasks only.

## Curated read contracts

Authenticated `GET /api/operator/task-list?limit=100&cursor=<task UUID>` supplies strict pages of at most 100 curated task summaries. Unknown/duplicate parameters, invalid limits/cursors and unknown cursor identities fail the read. The producer reads at most 10,001 ordered task/project identities and rejects catalogs above 10,000. SHA-256 over ordered identity pairs detects membership changes between pages. This is not an immutable observation snapshot: execution and provider observations can span time.

The client rejects malformed pages, changed fingerprints, duplicate/nonadvancing identity or cursor, overflow and a continued 100th page. Only a complete aggregate replaces prior data; failed refresh retains the previous aggregate with an explicit stale message. Cancellation prevents obsolete reads from publishing. Project, state, source, readiness, search and List/Board mode survive URL navigation, Back/Forward and reload. Navigation issues no domain command.

`GET /api/operator/projects/:id/composer-options` projects the current safe project lead, active permitted profiles, existing same-project dependency candidates, capacity observations and routing mode. Project switching clears selections and aborts obsolete options. The server validates policy again at submission, so a revoked choice fails atomically while input remains editable.

New projections reuse global retained-revision and task-specific private exclusions, including the existing 128-revision lookup budget. Unavailable privacy context omits prose while retaining safe identities/status. Task lead uses the retained same-task/project binding and its captured profile revision/name; only an absent binding falls back to the current configured project lead. Renaming/reconfiguring a project does not change that task identity or result recipient.

## Attention and Board

Attention derives from open questions/approvals, unresolved result destinations, current-version rejected completion, actual unresolved execution uncertainty, and current-version lead review without an assignment. Current intervention labels appear on the same shared Overview/List/Board/project cards, including terminal cards; uncertainty is deduplicated when multiple current facts describe it. Historical fallback alone is not urgent. A normal Stop observation belongs in Work; actual underlying uncertainty or a current action request remains attention even when execution displays Stopping. Dependency, capacity and project-pause waits are progress.

Column priority is Stopping, Uncertain, Running/Starting, Done, Cancelled, Paused, Draft, Waiting, Ready. Ready-but-blocked stays Ready and appears in Waiting with its reason. Selected and queued are explicit observations. Source status never determines grouping. Terminal cards retain domain/readiness, current intervention and execution facts while omitting inapplicable prospective admission/capacity reasons. Capacity observations use each project’s effective override (above or below the default), shared by catalog cards and composer options. Task-read freshness uses one plain observation range. Named keyboard controls and Previous/Next column controls expose every column on narrow screens; no drag mutation is provided.

## Same-tab recovery

`ensemble.ui03.composer.v1` stores only versioned unfinished input or unknown input plus the exact frozen creation command/key/task/assignment IDs. Both producer and consumer enforce a 262,144-byte UTF-8 envelope. The actual serialized HTTP command must also fit 65,536 bytes. The validated input bound is below 110 KiB; a command contributes at most 64 KiB and envelope metadata below 2 KiB, within the 256 KiB cap. Unsubmitted invalid input may exceed the cap and remains in memory with a recovery-unavailable notice.

Every first or deliberate reconciliation POST requires successful frozen-record validation, persistence and matching validated readback. Failure sends zero POSTs. Failed writes retain current input in memory and preserve any last successfully saved bytes; the UI never claims newer failed edits will restore. A readback failure also sends nothing and makes no promise about which record will restore.

Pending/unknown input cannot edit, rekey, change project or start another creation. Unknown survives subsequent authentication, permission, availability, validation and conflict failures. Only an exact original receipt matching kind/key/task/project/open/ready/final-version confirms it. No automatic replay occurs. Restoration happens after authentication; expiry/sign-out unmount private UI. This is same-tab on-device recovery, not durable Ensemble work or cross-device storage. No credential, session/CSRF token or fetched API cache is stored.

The existing guarded listener owns Host, exact Origin, sessions, CSRF, strict JSON/byte bounds and same-origin assets/APIs. This delivery adds no deployment, credentials, actual model call, native structured-input availability or release/cutover claim. Qualification is recorded in [UI03 evidence](../evidence/ui03-tasks.md).

## Shared command implementation

The composer and private configuration now share immutable submission ownership, send admission and outcome settlement. Task receipt identity and verified same-tab recovery remain composer policy. Unmounting invalidates completion effects while leaving the frozen unknown record available to the next authenticated mount; reconciliation remains deliberate. See [command lifecycle evidence](../evidence/ui-command-lifecycle.md) for executed proofs and limits.

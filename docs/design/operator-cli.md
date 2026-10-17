# Operator CLI

Status: accepted. This describes intended behaviour, not implemented capabilities
or a delivery plan. Design confirmation does not itself dispatch implementation.

## Purpose

Give the operator and external agents a command-line interface for inspecting
and managing Ensemble, including diagnosing agent-profile instructions and
task execution. Use the domain vocabulary in [CONTEXT.md](../../CONTEXT.md).

## Scope

The first release covers everyday operator work and debugging: project and
agent-profile configuration, tasks, questions, approvals, execution history and
existing recovery actions. Ancillary UI features such as composing line-by-line
code reviews are deferred; this release does not require complete web UI parity.

Support clients on the service host and on another trusted machine over the
existing private network. Both use the running service API.

External clients use dedicated, revocable operator credentials with selectable
read-only or read/write access. Writes retain the service's existing policy and
admission checks. The authenticated web UI creates and revokes these credentials,
revealing a newly created token once. CLI login accepts the token through secure
input rather than requiring it in command-line arguments. The CLI cannot mint
stronger credentials. Tokens expire after 90 days by default, support shorter
selected lifetimes and can be revoked immediately. Authentication status exposes
expiry. Credential and transport details are specified below.

Reuse existing configuration controls. Enabling and disabling each execution
runtime for the installation is a supported mutation (`runtime enable|disable`,
ADR-1012). Expose other runtime and model settings read-only where Ensemble has no
supported edit operation. Adding profile-level model or effort controls is outside
this release.

Service process management and offline backup/restore remain host-local.
Remote clients use the running service for task controls and diagnostics;
they cannot restart, upgrade or restore the service itself.

The CLI is an operator interface, separate from assignment-bound coordination
tools. This work does not reopen the deferred ChatGPT plugin, public MCP endpoint
or native Codex handover in [ADR-1006](../adr/1006-chatgpt-and-native-codex.md).

## Existing foundations and gaps

The operator API already provides task, configuration, assignment history and
recovery reads and revision-aware, receipted commands. Its authentication uses
browser sessions and CSRF checks; a CLI authentication contract is needed.

Project and profile instruction revisions are retained and execution bindings
identify their revisions. JSON configuration reads expose revision numbers and
instruction presence, but not instruction bodies. Captured conversation history
contains bounded, sanitized assistant text and omission records; it is not a
complete transcript or general runtime log feed.

## Diagnostic evidence

Add richer bounded capture for future executions: Ensemble-supplied instructions
and settings, runtime events and available tool calls/results. Apply redaction
and size limits. Preserve explicit gaps for unavailable, omitted or historical
material; do not imply that older executions have newly captured evidence.
Richer capture is on by default for new executions, with a project setting to
reduce capture to the existing baseline history. Changing this setting affects
future capture; it does not erase existing records.

Expose historical instruction/configuration revisions alongside current values
so an external agent can compare the execution's inputs with current settings.
Do not describe Ensemble's captured inputs as the runtime's complete effective
prompt or claim visibility into provider-internal context.

Use separate records for supplied execution inputs, observed runtime settings,
runtime events, tool calls/results and service diagnostic events. Bind records
to the task, assignment, work, conversation and runtime turn where known. Keep
the underlying stable identifiers visible instead of inventing a second run
identity. Record an instruction snapshot before submitting the turn; a failed
capture is an explicit gap and cannot change execution admission or recovery.

Instruction views deliberately disclose authorized project/profile instructions
to both credential scopes. They still redact credentials and excluded private
paths. General history/log views retain instruction redaction. Neither surface
offers an unredacted switch, exports credential files, or promises detection of
every arbitrary secret. Apply known-value and pattern redaction before storage,
and current exclusions at read time; omit content when safe projection fails.

The dedicated views are `GET /api/operator/profiles/ID/instructions` and
`GET /api/operator/projects/ID/instructions`, each listing retained revisions and
selecting the current one or `?revision=N`, and
`GET /api/operator/assignments/ID/instructions`, which shows the assignment's bound
profile/project revisions beside the current ones, whether revision numbers and
stored content match, and the revisions of the latest execution request when one
exists. Only these views leave the disclosed profile's or project's instruction text
unredacted; other instruction revisions, credential references and values, control,
workspace and repository paths and credential patterns stay redacted. Each body is
`available` (with `redacted` when sanitization changed it) or `omitted` with reason
`redaction-unavailable` when exclusions cannot be computed or the projection exceeds
16000 characters. Every view carries provenance
`{source: "retained-revision-records", reconstructed: true, submittedPrompt: "not-captured"}`.

Historical instruction revisions can be displayed when retained, labelled as
reconstructed from revision records. Only an actual captured submission may be
labelled as the supplied prompt. Missing tool events, unknown effective settings
and unavailable old prompts are explicit gaps. Tool activity is diagnostic;
absence is not evidence that no tool ran. Do not collect provider-private reasoning.

The capture is a fourth dedicated instruction projection:
`GET /api/operator/executions/WORK_ID/inputs[?compare=current]` returns each
captured supplied segment (request, role, review references, project and profile
instructions with their revisions) and the submitted byte count and SHA-256, with
provenance `{source: "captured-submission" | "not-captured", effectivePrompt:
"not-captured"}`. Only it leaves the execution's own profile and project
instruction text readable; when no instruction segment was captured it adds a
labelled `reconstructed` block from retained revisions. `GET
/api/operator/executions?task|assignment|project=ID`, `GET
/api/operator/executions/WORK_ID` and `GET
/api/operator/executions/WORK_ID/events?after&limit&kind&severity&since&until`
redact all instruction text. All four are read routes for both credential scopes
and sessions, gated by the capabilities `execution.read` and, for `logs`,
`diagnostics.read`. A work id identifies an execution; direct runs and unknown or
invisible work read as not found. Every read reports capture health:
`toolObservation: "incomplete"` and `reasoning: "not-collected"`.
`GET /api/operator/readiness` (the `doctor` command) is a read route for both
credential scopes and sessions, gated by `diagnostics.read`; its checks are
read-only and value-free.

Capture records are `input`, `setting`, `runtime`, `tool` and `service` items.
Settings carry a source: `service-admitted`, `runtime-reported` or `unknown`.
Service events are the closed set `thread-bound`, `input-captured`, `turn-bound`,
`terminal-observed`, `execution-settled`, `unexpected-request` and
`terminal-anomaly`. Capture gaps (`capture-baseline`, `capture-failed`,
`capture-interrupted`, `input-failed`, `size-limit`, `redaction-unavailable`,
`execution-limit`, `item-limit`, `expired`, `evicted`, `late-event`,
`early-buffer-limit`, `unsupported-event`) are coalesced per execution and map onto
the existing coverage codes without new ones: omitted or size-limited items
`item-omitted`, redacted text `content-redacted`, failed redaction
`redaction-unavailable`, expired, evicted, failed, interrupted, late and limit
gaps `evidence-gap`, and baseline or uncaptured executions `evidence-unavailable`.

Event cursors are the global item sequence. A cursor beyond any issued sequence
is a conflict (`cursor-stale`); one below a pruned range returns that range as an
`expired` or `evicted` gap with counts. Pages stop at 200 items or 1 MiB of
payload. The CLI's `logs --cursor` realises the representative `--after CURSOR`,
because `--after` and `--before` already filter by time. `--follow` polls with a
fresh authenticated request each interval, and `--output jsonl` writes `item`,
`gap`, `end` and `error` records.

### Retention and limits

New diagnostic payloads expire after 30 days by default, with configurable age
and installation-wide storage limits. Initial defaults are 1 GiB of
diagnostic payload per installation, 16 MiB per work execution and 64 KiB per
payload item. These limits include captured prompt content; an oversized item is
marked truncated or omitted, never presented as a complete snapshot.

Expire payloads by age, then evict oldest payloads to enforce the disk cap.
If storage cannot accept a new record, continue execution and report the capture
gap. Report capture health and coverage on diagnostic reads. Coalesce omission
notices so a full disk does not create an unbounded stream of omission records.
Page and buffer limits also apply to polling/following active work.

Preserve compact expiry/omission metadata and references. New pruning applies
only to diagnostic payloads: it does not delete durable safety evidence,
instruction revisions, decisions, receipts, existing baseline history or retained
result/review evidence. Those retain their existing contracts. The payload quota
does not claim to bound the whole database, WAL or filesystem. Document that older
backups can retain payloads removed from the live database.

## Configuration changes

Support preparing a reviewable diff and explicitly applying its exact material
against the inspected revision. Interactive confirmation is not mandatory.
A conflicting revision requires a fresh read and review; applying must not
silently substitute newer material or overwrite concurrent edits.

Configuration preparation produces a local, inspectable change document containing
the service identity, target IDs, expected revisions, exact proposed fields and
a digest. The diff identifies assignments affected at preparation time, labels
that list with its observation time and explains the potential for work to become
stale. The list is informational, not an apply-time fence: assignments created
after preparation may also become stale or held under existing admission rules.
Creating an assignment alone does not invalidate the prepared configuration change.
Applying revalidates identity, digest, revision and service policy; it does not
re-read a changed instructions file and substitute its contents.
Change documents may contain private instructions and use owner-only file access.

Edits preserve immutable prior revisions. Restoring previous content prepares
another change and produces a new revision; it does not rewind history. Existing
assignments retain their bound revisions and may become stale under existing
admission rules. Adoption is a separate, version-checked assignment action using
the current instructions for the next turn. An active turn is not rewritten.

A change document (`ensemble.cli.change/v1`) holds exactly one typed command
without its request key: `profile.create`, `profile.configure`, `project.create`,
`project.configure`, `routing.configure` or `capacity.configure`. The design's
`create` verbs are `prepare-create` followed by `apply`. A prepare writes the
document to `--out FILE`, or by default to a new `./ensemble-<kind>-<id8>.json` that
never overwrites a file; `apply --file FILE --dry-run` prints the stored change
without connecting, and `apply` says when it replays a request this machine
recorded. The document's SHA-256 digest covers
every other field and detects accidental or in-transit modification; it is not a
MAC against a same-user writer, so the service's revision checks and the
installation check still decide. Restore takes only instruction text, and only when
the retained revision is neither redacted nor omitted; other fields have their own
flags. A diff against redacted or withheld current text says so with the
`content-redacted`, `redaction-unavailable` or `content-unavailable` gap; routing
guidance is never read back, so its diff shows only the proposed text.
`capacity.configure` accepts an optional `expectedCurrent` (global limit and the
listed project overrides, `null` meaning none), compared inside the command
transaction; a mismatch is a `409 conflict`. Commands without it hash and behave as
before, so the web UI keeps its last-writer-wins capacity form. Creation and
adoption are deliberately irreversible; revoke, pause or restore instead.

## Authentication and authority

Use a dedicated bearer-token authentication path over the same service command
and read layer. Preserve browser cookie, Origin and CSRF protections; adding CLI
authentication must not make browser-session writes exempt from those checks.
The server enforces read-only versus read/write authority on every endpoint,
including legacy routes and reads with side effects. A command name or HTTP verb
is not the authorization boundary.

Both scopes cover the trusted operator's projects and permitted diagnostic
content; project-scoped credentials and action-by-action permissions are deferred.
Read/write includes explicit question answers, approval decisions and supported
recovery submissions. It never bypasses version checks, exact approval material,
execution holds or existing requirements for independent evidence.

The web UI lists named credentials with scope, creation, expiry and last-use
metadata and supports revocation. Persist only token verification material on
the server. Revocation is irreversible; replacement means issuing a new token.
Rotation permits issuing a replacement before revoking the old token. Check
expiry/revocation on requests and on each bounded follow poll. The CLI can inspect
its auth status or forget its local token, but cannot create credentials, extend
expiry or broaden authority. Logout is local removal, not server revocation.

Use named **connections** for service URL and credential references, avoiding
confusion with agent profiles. Require explicit connection selection when the
target is ambiguous and expose the resolved service/project in write previews.
Use the macOS credential store by default. Support protected token-file input
for unattended callers; do not accept literal token flags or fall back silently
to plaintext storage. Mask interactive token input and never print stored tokens.

A token is `ens_<credential UUID>_<secret>`, with a 256-bit base64url secret; the
service stores its SHA-256 and compares in constant time. Malformed, unknown,
mismatched, expired and revoked tokens receive the same `credential-invalid` 401;
a valid token outside its scope receives `insufficient-scope` 403. Lifetimes are
1–90 days, defaulting to 90. Credential management uses dedicated session-only
endpoints, not receipted commands, so a receipt replay cannot re-reveal a token.
An explicit server-side route-authority table classifies every JSON API route as
read, write or session-only and denies unknown routes; bearer requests never reach
cookie sessions, legacy HTML or slot routes. The browser-push routes are session-only
too (`GET /api/operator/notifications` and `POST` to `/api/operator/notifications/subscriptions`
and `…/subscriptions/<id>/revoke|test`): no CLI command lists, creates or revokes a
subscription, and a bearer request receives the same `forbidden` refusal as credential
management. `GET /api/operator/cli` returns the
API version, capabilities, the service's persistent installation identity and the
calling credential's metadata. A connection records the installation identity at
login; a later mismatch fails as `service-identity-changed`.

Remote connections require HTTPS with certificate verification. Existing loopback
HTTP remains available on the host. Do not send credentials across redirects to
another origin or add automatic insecure/public connectivity. Reads and writes
use the live service rather than opening its database from the client.

Managed assignment execution must not receive operator credentials through
service-provided environment variables, prompts or tool configuration. CLI use
from an Ensemble-managed assignment rejects operator authentication. This is a
guard against accidental privilege crossing, not an OS isolation claim: runtime
and deployment controls still govern same-user file/process access and alternate
HTTP clients. Do not claim the CLI prevents a same-user agent from accessing an
explicitly available host credential.

## Command surface

Command names follow Ensemble's domain: task, assignment, agent profile and
execution. There is no workflow graph or new assignment-stage system.
Provide a packaged `ensemble` executable usable outside this repository, keeping
the existing local operations CLI compatible. Reuse the repository's supported
Node.js version and package tooling; distribution follows
[ADR-1011](../adr/1011-packaging-and-distribution.md).

| Area | First-release operations |
| --- | --- |
| `auth`, `connection` | Login, status, logout; select/list/remove local connections |
| `project` | List/get/create; inspect and prepare/apply supported configuration, instructions, routing and source settings |
| `profile` | List/get/create; inspect revisions; prepare/apply supported fields and restore earlier content as a new revision |
| `task` | List/search/get/create/configure; dependencies; existing task controls, messages and follow-up |
| `assignment` | Get/history; compare bound/current instructions; explicit current-revision adoption |
| `inbox`, `question`, `approval` | Inspect attention; answer supported forms; approve/deny exact reviewed material |
| `execution`, `logs`, `doctor` | List/get; supplied inputs, observed settings, events/tool activity, filtered service diagnostics and bounded follow; the service readiness checks |
| `runtime` | List each execution runtime's setting, state and bound tasks; enable or disable one (`disable` needs `--yes` when bound tasks use it) |
| `recovery` | Inspect eligibility/holds; prepare and submit the existing evidence-bearing operations |
| `result`, `artifact`, `delivery` | Inspect results/retained evidence and existing delivery state; existing refresh and staged comment operations |
| `operation` | Read an existing mutation receipt and reconcile an uncertain command outcome |

Service administration remains the separate host-local surface. Full setup
discovery, line-comment review composition, MCP packaging, remote process control
and runtime or model setting mutations other than runtime enablement are outside
the first release. Existing
configuration operations such as source activation retain their staged previews.
No generic command bypasses the typed operation contracts.

Representative syntax (IDs are placeholders):

```sh
ensemble --connection home profile get PROFILE --output json
ensemble --connection home task get TASK --output json
ensemble --connection home execution list --task TASK --output json
ensemble --connection home execution inputs EXECUTION --compare-current --output json
ensemble --connection home logs --execution EXECUTION --cursor CURSOR --output json
ensemble --connection home doctor --output json
ensemble --connection home profile prepare PROFILE --instructions-file instructions.md --expected-version 4 --out change.json
ensemble --connection home profile apply --file change.json --request-id REQUEST
ensemble --connection home assignment apply-current ASSIGNMENT --expected-version 7 --request-id REQUEST
ensemble --connection home operation get REQUEST --scope SCOPE --output json
```

### Writes and execution effects

Every command reports whether it only saved configuration, queued work, requested
cancellation or completed a synchronous operation. A successful CLI invocation
does not mean asynchronous work completed. Make state-changing verbs explicit;
reads, comparison, authentication and configuration preparation cannot dispatch
work. Existing create/readiness/message operations that can dispatch work describe
that effect in help and their responses. Do not invent a general rerun or
force-unlock operation where the domain has no such action.

Task Stop persists Stop and requests cancellation under existing guarantees;
Resume clears only the operator Stop. Recovery accepts all existing required
evidence and attestations as structured, version-bound input. An external agent
may prepare it, but cannot infer attestations, manufacture independent review or
replace missing evidence with a confirmation flag. Preserve existing staged
review/confirm/send semantics for external comments.

## Machine interface and retries

Human-readable output is the terminal default. `--output json` emits a versioned
envelope containing data, observation time, resolved identity, pagination and
coverage/omission information. Structured errors include a stable code, request
identity, retryability and any known outcome. Send diagnostics to stderr; never
mix progress messages into JSON stdout. Human tables and labels are for people and may
change; scripts use `--output json`. Help is plain text on stdout and never part
of the envelope; a human usage error prints the message and the usage lines of the
command or area it concerns, never the whole command list. A human error of the operator commands ends with one
`Fix:` line naming the command or action that resolves it (`service` and `snapshot`
keep their own lifecycle errors and add the line only to usage errors); the remedy is terminal text only
and is not a field of the JSON envelope. Following uses explicitly selected JSONL
or readable output, bounded polling and resumable cursors.

List reads default to 50 items and cap pages at 200. Filters are server-side.
Do not fetch every page implicitly. Cursors have stable ordering; stale/expired
cursors return an explicit gap or restart instruction, never silent completeness.
Expose whether the service is unavailable, history is unsupported, or requested
payloads were redacted, truncated or expired.

Use UUID request keys and existing service receipt semantics for mutations.
Receipt identity includes the resolved service, command scope/type and UUID;
a UUID alone is not a globally unique receipt lookup. Persist that identity
locally before sending when the caller does not supply `--request-id`. An
uncertain network result returns the full identity and an unknown outcome.
`operation get` requires the scope/type to select the existing receipt store.
Reconcile or retry in the same scope using the same key and exact content; never
resubmit with a fresh identity automatically. Same scope/key with different
content conflicts; reusing a UUID in another scope cannot select its receipt.
Do not store secret request material in a convenience retry log. Nonzero exit
statuses distinguish invalid input (2), authentication/authorization (3),
revision/policy conflict (4), unavailability including TLS and redirect rejection
(5), uncertain outcomes (6) and an unsupported service version or capability (7).
The JSON envelope schema is `ensemble.cli/v1`.

List reads add `pagination: {limit, maxLimit, returned, nextCursor}` to the
envelope, and every browse read adds `coverage: {observedAt, complete, gaps, notes}`
where `observedAt` is the service's read time and `complete` is true only when no
gap is present. Gap codes are a closed set: `more-pages`, `limit-capped`,
`catalog-changed`, `older-history-omitted`, `item-omitted`, `content-redacted`,
`content-unavailable`, `redaction-unavailable`, `evidence-gap`,
`evidence-unavailable` and `review-unavailable`. Routes with lower page caps (task
list 100, search 50) report `limit-capped` and their `maxLimit`. CLI cursors are
opaque tokens bound to the command and its filters; a token from another command or
with different filters is invalid input. A server cursor that no longer resolves
returns `409`, which the CLI reports as `cursor-stale` (exit 4) with an instruction
to restart without `--cursor`. A task-list page whose catalog membership changed
since the previous page reports `catalog-changed` and `continuity: "changed"`.
Downloaded artifacts and evidence items are written only to a new `--out` file
(mode `0600`) after the service's `x-ensemble-sha256` digest, or the item's recorded
digest and size, verify; a mismatch is `integrity-mismatch` (exit 5) and leaves no
file. `x-ensemble-evidence-source` distinguishes retained bytes from a pre-retention
result's still-matching recorded workspace file.

Advertise service API version and capabilities. Older clients ignore additive
fields; unsupported operations or incompatible contracts fail explicitly.
Read-only credentials must receive a server denial even if a caller bypasses the
CLI and submits a write directly. Capability names are `cli.identity`,
`task.read`, `workspace.read`, `task.list`, `task.search`, `task.records`,
`assignment.read`, `instructions.read`, `result.read`, `artifact.read`,
`configuration.write`, `operation.read`, `capacity.read`,
`configuration.impact`, `execution.read`, `diagnostics.read`, `task.write`,
`attention.read`, `attention.write`, `source.write`, `delivery.write`, `recovery.read`
and `recovery.write`; a command whose capabilities the service does not
advertise fails with `unsupported-service` before any other read.

`GET /api/operator/operations?scope=&type=&key=` returns `recorded` with the
receipt `POST /api/operator/commands` returned, or `not-recorded`. It accepts only
the scopes `project:<id>`, `profile:<id>`, `system:capacity` and
`system:runtime:<harness>` (with `runtime.configure`) with the configuration and
adoption types and, for a project, `github.configure` and
`github.preview` (a preview whose selection ID is now excluded text reads
`503 unavailable`), and `assignment:<id>` with the five recovery types (a key reads
`recorded` only under its own type and for that assignment's work), rebuilds the receipt from the stored result with
the same projection as `POST`, and reports a stored result of another shape as
`409 conflict`. `GET /api/operator/projects/:id/impact` and
`/profiles/:id/impact` list at most 200 bound assignments (default 200, `limit`
1–200) with their bound and current revisions, `total` and `truncated`. All three
are `read` routes. On the command route a `403 forbidden` is a policy denial, which
the CLI reports as `policy-denied` (exit 4). A refused connection, DNS or TLS
failure, a redirect or any 4xx did not apply the command; any other transport
failure, timeout, 5xx or unexpected receipt is `command-outcome-unknown` (exit 6).
The CLI exits 2 with `change-document-invalid` or `wrong-service` and 5 with
`journal-unavailable` before sending anything.

Task and attention writes (`task create|configure|add-dependency|remove-dependency|
message|follow-up|stop|resume`, `question answer`, `approval decide`) drive the
existing operator commands unchanged, plus two receipted commands on the same
route: `task.stop` and `task.resume` (`{key, taskId, expectedVersion?}`). Their
receipts, `task-stop {taskId, cancellationRequested}` and `task-resume {taskId,
stopCleared, requeued}`, are recorded in one transaction with the Stop hold change,
scoped to the task: the same key and content replays with no effect, other content
conflicts. `expectedVersion` is optional, so an unrelated task edit cannot block a
Stop. `task.stop` on a Done or Cancelled task is refused with `409 conflict` and the
reason "Only an open task can be stopped. This task is Done." (or Cancelled), after
receipt replay; `task.resume` still clears an existing Stop on such a task. The keyless web Stop and retained Resume forms share the same hold. JSON
`data.effect` is `saved`, `queued`, `cancellation-requested`, `none` or `completed`
(a synchronous operation, such as recovery). Because these intents are repeatable, the
CLI reuses a journal key only while it is unresolved (latest state `sending` or
`unknown`, never after `recorded` or a definite rejection); the output reports
reuse and, for Stop and Resume, whether Stop is in effect after a possible replay.
`operation get` does not read these types: domain task receipts do not record
which task command produced them, so an uncertain outcome is settled by retrying
the same command with its key and checked with `task get`, `question get` or
`approval get`. `GET /api/operator/inbox` accepts `limit` (1–100, default 100),
`kind` (`question|approval|intervention|runtime`) and `project`, each at most once and
applied before paging; a cursor from other parameters is `409`. A `runtime` item is
derived on each read and carries `harness` and `since` instead of task fields.

Sources and delivery drive the existing operator commands; no route, command or
receipt is added. `project prepare-source` writes a `github.configure` change
document from a strict edit file: kept selections are sent as `{id, keep: true}` and
kept links as `{repositoryId, ref}`, so no private query, filter or path is sent
again, new selections take the next free `S-n`, and preview lines follow the web UI
and never show a query, filter, path or reference name. Any save bumps the source
version, so every selection is inactive until previewed again, and marks
observations incomplete; removing a selection discards its definition.
`project preview-source` records `github.preview` after a complete provider read;
its receipt is the original activation, so the CLI also reports the live state.
`project place-task` records `github.place`; its receipt is not readable through
`operation get`, and a rerun after the task moved reports the placement from the
task read. `delivery refresh` (`delivery.refresh`, installation-wide) post-reads
delivery and reports `partial` with gap `evidence-gap` when the provider read failed
or an action is unsettled. Comment requests are scoped `task:<id>`:
`review-comment` uses its key as `operationId`, so `send-comment --review-id R`
sends with key `R`, which the approval binds; before sending it replays the exact
review and refuses unless it is `approved` (a `--review-id` that names no review
is recorded as a new pending review by that replay; nothing is posted). Comment keys use the default journal
reuse, so an identical rerun replays the recorded receipt and a deliberate repeat
needs a new `--request-id`. A send receipt in `confirmed-success` exits 0, `denied`
exits 4 `policy-denied`, `confirmed-failure` exits 4 `conflict` (nothing posted),
and `prepared`, `attempting` or `uncertain` exit 6: do not resend with a new key;
run `delivery refresh`, then `delivery get`. A `409` whose operation the post-read
finds recorded is also exit 6. Definite comment rejections (stale task, review or
confirmation material, reused keys with other material, changed authority, held
admission, a task without a bound issue) are `409`, and an approval without a grant
is `403`; other failures stay `command-outcome-unknown`. Posted comments carry a
hidden `<!-- ensemble-operation:ID -->` marker that the provider read-back matches.
Installation-wide source refresh, `source.review`, handback settlement and a list of
pending comment reviews are not CLI commands.

Recovery drives the five existing evidence-bearing operations through receipted
commands on `POST /api/operator/commands`, scoped `assignment:<id>`:
`recovery.pre-turn.adopt`, `recovery.pre-turn.recover`, `recovery.no-turn.adopt`,
`recovery.no-turn.recover` and `recovery.conversation.replace`. Each carries
`assignmentId` and the existing service command's fields; the API checks the work is
bound to that assignment and calls the unchanged service method with exactly the
inner command the retained `/runtime/control/*` session routes pass, so a key
recorded through either entry point replays through the other. Receipts are
`recovery-adoption {path, assignmentId, workId, witnessId}`, `recovery-resolution
{path, assignmentId, workId, receiptId, state: "reconciled"}` and
`conversation-replacement {assignmentId, revision}`. Definite refusals (stale or
mismatched identity, unverified termination, an existing or missing witness, a
reconciled generation, stale replacement versions, unresolved execution, a task
hold, a key reused for other material or another type) are `409`; malformed
commands are `400`; other failures stay `command-outcome-unknown`.
`GET /api/operator/assignments/:id/recovery-options` (read scope) lists the
assignment's own generations (newest 20, filtered before the bound; writer, capacity
and uncertainty holds are this assignment's, Stop and task holds task-wide) with the
exact identity each command binds and advisory per-path
eligibility with closed blockers (`not-held`, `ownership-released`,
`context-unavailable`, `witness-missing`, `witness-present`, `other-witness`,
`already-reconciled`, `reason-withheld`, `identity-withheld`, `task-held`,
`unresolved-execution`). It discloses the held process identity to both credential
scopes as permitted diagnostic content; a string redaction would change reads
`null` and blocks the paths that would send it. `recovery prepare` writes an
`ensemble.cli.recovery/v1` document (owner-only, at most 512 KiB, canonical-JSON
SHA-256 digest) from that read plus a strict `ensemble.cli.recovery-evidence/v1`
operator file; attestations remain operator assertions the service cannot verify.
`recovery submit` uses the default journal key rule: an identical rerun replays, and
a definitely refused key is not reused. Adoption, recovery and replacement are
irreversible; none resumes or dispatches work, and continuation still needs
replacement plus a new message. Operator Stop/Resume are unchanged; there is no
force unlock, release by time or acknowledgement, and no route for the keyless
bound-turn recovery.

## Acceptance scenarios

The canonical [CLI01–CLI06 scenarios and evidence states](../acceptance.md#operator-cli-acceptance)
qualify the CLI release under epic #893 without changing the standalone MVP or
cutover gates. The scenarios correspond in order to the journeys below.

1. An external agent on the host and on another privately connected machine can
   authenticate, find a failed task, inspect its bound instructions and available
   runtime evidence, compare current settings and produce a configuration diff.
2. A read-only credential can perform that investigation but every write route
   rejects it. Expired/revoked credentials fail, including following active work;
   browser-session protections remain enforced.
3. A reviewed change applies exactly once. Concurrent editing produces a conflict;
   an uncertain response is reconciled without duplicate effects. Applying old
   content creates a new revision. Assignment adoption remains explicit.
4. Questions, approvals, Stop/Resume and supported recovery work through both CLI
   and existing UI entry points with the same material checks and hold behaviour.
   Recovery does not accept fabricated or omitted required assertions.
5. Seeded sensitive values are redacted; required instruction text remains
   inspectable through its dedicated view. Oversized payloads, unsupported runtime
   events, storage failures, pruning and old executions produce explicit gaps.
   Diagnostics never establish success or release ownership.
6. Real-runtime bounded validation demonstrates captured submitted inputs and
   available tool activity, plus an authenticated external-agent investigation.
   Deterministic tests cover absent events, token controls, redaction, quotas,
   expiry, pagination, version conflicts and ambiguous responses.

These scenarios complement existing acceptance requirements for the CLI release.
Delivery scope and sequencing belong to [epic #893](https://github.com/chrisbanes/ensemble/issues/893)
and its native sub-issues; this document is not a parallel implementation plan.

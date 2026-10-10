---
status: accepted
partially_superseded_by: [ADR-1005, ADR-1006, ADR-1008]
---

# Build Ensemble as a standalone service without BB

Superseded in part: [ADR-1005](1005-service-assignment-routing.md) replaces the
separate task-owner role and lead-only initial allocation;
[ADR-1008](1008-claude-code-execution-harness.md) adds Claude Code as a second
execution harness; deferred [ADR-1006](1006-chatgpt-and-native-codex.md) would
extend private transport for an optional ChatGPT plugin endpoint only.

Ensemble removes BB and builds its own service. Ensemble owns scheduling,
execution admission, process supervision, task workspaces, conversation records
and the operator interface, alongside its existing durable coordination core. BB
is not a target backend or a production dependency.

The BB investigation demonstrated accepted queued work executing after guarding
plugins failed startup, and left writer termination guarantees unresolved. A local
pre-submission recovery repair cannot govern work BB already accepted. Owning
these boundaries costs more implementation work, but allows Ensemble to enforce
and test its intended operating contract without depending on BB plugin lifecycle.
The BB prototype and its capability evidence are preserved on
`cb/pipeline-implementation` and in Git history.

This supersedes ADR-1001 and ADR-1003 wherever they assign execution, workspaces,
UI, capacity or cleanup to BB or a replacement host. It also removes ADR-1002's
BB Send-now exception. The agent-led process, portable identities, SQLite,
readiness and dependency authority, durable ownership, permissions, and conservative
recovery semantics remain. Agents decide how work proceeds; there is no configured
process graph.

Standalone does not mean implementing models or every agent harness from scratch.
Reuse an existing agent harness for model interaction and tools through a narrow
integration. The first deployment is macOS on Chris's Mac, with a web operator
interface served by Ensemble and accessible privately over Tailscale with a
separate Ensemble login. Other platforms are deferred. The first installation uses
a fresh database, preserving the BB prototype separately rather than importing its
records.

Codex is the first harness, using the existing operator login; API-key billing for
agent execution is deferred. ADR-1005 separately permits opt-in TypeSafe API access
for assignment routing. Codex App Server is the selected integration surface, with
installed-version qualification still required. Ensemble must prove admission,
cancellation requests, conservative recovery and cooperative workspace ownership;
wrapping another queue does not satisfy that requirement. Runtime and deployment
controls enforce execution access; an in-process service is not a security sandbox.

The reusable core remains in this repository and is not by itself a standalone
implementation. Do not mutate the installed Haze prototype or assume its unfinished
work can migrate. Runtime-specific contracts and dependent implementation are gated
on [S01 #688](https://github.com/chrisbanes/ensemble/issues/688) capability evidence.

## Execution guarantees

The service does not promise crash termination or physical writer exclusion. The
runtime capability probes showed the difference between orchestration, durable
coordination and OS execution containment; see the
[existing evidence matrix](../evidence/s01-existing-evidence-2026-09-28.md).

1. **Crash survival:** already-admitted execution may survive coordinator/App Server
   crashes and continue effects. Unavailable Ensemble cannot admit queued work.
   Preserve ownership/capacity and uncertain submissions; never blindly resubmit or
   automatically release them.
2. **Best-effort Stop:** persist Stop, request cancellation for active task
   execution, including lead turns and assignments, and observe for a bounded
   interval. Continued effects are possible. Unresolved Stop/writer/capacity holds
   remain until independently resolved; time, acknowledgements, empty terminal lists
   or operator acknowledgement do not unlock.
3. **Cooperative normal-success handoff:** Codex's successful terminal status for
   the bound thread/turn, with ended Ensemble-owned callbacks and no known unfinished
   execution or other hold, permits serialized handoff to one successor. Detailed
   tool history is diagnostic; missing items alone do not prevent handoff. This
   accepts incomplete observation, possible unobserved effects and an untracked
   detached child writing alongside the successor, without claiming their policy or
   audit trail is proved. It is not physical writer exclusion. Crash, Stop,
   failure/interruption, ambiguous submission, missing/conflicting terminal
   identity/status, unfinished callbacks and known survivors do not qualify; those
   holds require independent resolution. See the
   [runtime trust boundary](../design/standalone.md#runtime-trust-boundary).
4. **Integration qualification:** S01 qualifies existing-login App Server
   execution, events/results, follow-up or supported resume and cancellation
   requests, plus bounded feasibility of trusted identity, admission, durable state
   and conservative ambiguous-submission handling, against a finite checklist rather
   than every possible model tool or a general tool allowlist. Historical resume is
   not live reattachment; when reattachment is unsupported, visible uncertainty and
   the documented operator recovery route are acceptable. Positive live reattachment
   is not a universal gate.
5. **Approval evidence:** model-originated escalation rejection remains an unproved
   limitation. Effective `workspaceWrite`/`never` selection and attributable write,
   network and live/stored-history evidence can qualify the bounded policy row. The
   product still denies broader command access: the runtime adapter rejects
   unexpected approval callbacks under deterministic tests, and the integrated
   approval flow is qualified before release. Demonstrated policy breaches remain
   blockers.

The default policy uses supported Codex workspace-write controls with explicit
write roots, command network access disabled and no automatic escalation
(`approvalPolicy: never`). Reads retain full access subject to host permissions;
“workspace-limited” must not imply outside-read denial. Disclose temporary roots,
protected paths, ambient credentials and other tool/network surfaces. The exact
policy and recovery route are in the [standalone design](../design/standalone.md).
Strict read isolation and complete descendant containment are separate explicit
product/deployment choices. This does not approve full-access execution, shared
config/login changes, credential copying, a different runtime or deployment.

Process, cleanup and outside-read failures found against stronger contracts remain
valid findings against those contracts; they are not retroactive passes. The
tradeoff is continued effects and possible indefinite loss of workspace/capacity
availability; there is no force-unlock waiver. Actual evidence remains necessary to
pass S01 or release dependent work.

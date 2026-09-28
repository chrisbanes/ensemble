---
status: accepted
partially_superseded_by: ADR-1005
---

# Build Ensemble as a standalone service without BB

The 28 September [ADR-1005](1005-service-assignment-routing.md) supersedes
separate task-owner accountability and lead-only initial allocation where described
here. Project leads retain accountability; the service may route assignments
directly. Existing admission, execution and recovery obligations remain.

On 27 September 2026 Chris decided to remove BB and build Ensemble's own service.
Ensemble owns scheduling, execution admission, process supervision, task workspaces,
conversation records and the operator interface, alongside its existing durable
coordination core. BB is not a target backend or a production dependency.

The BB investigation demonstrated accepted queued work executing after guarding
plugins failed startup, and left writer termination guarantees unresolved. A local
pre-submission recovery repair cannot govern work BB already accepted. Owning
these boundaries costs more implementation work, but allows Ensemble to enforce
and test its intended operating contract without depending on BB plugin lifecycle.
See the [historical capability evidence](../bb-capabilities.md).

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
separate Ensemble login. The first installation uses a fresh database, preserving
the BB prototype separately rather than importing its records. The original
27 September decision required crash termination and physical writer exclusion.
The approved 28 September amendments below supersede those guarantees; none
claims an implemented service or a passing S01 result.
Other platforms are deferred. Codex is the first harness, using the existing operator login; Claude and API-key
billing for agent execution are deferred. ADR-1005 separately permits opt-in
TypeSafe API access for assignment routing. Codex App Server is the selected integration
surface, with installed-version qualification still required. Ensemble
must prove admission, cancellation requests, conservative recovery and cooperative
workspace ownership; wrapping another queue does not satisfy that requirement. Runtime and deployment
controls enforce execution access; an in-process service is not a security sandbox.

The BB prototype source has been retired from this repository; the reusable core
remains and is not a standalone implementation. Historical evidence stays in the
design record. Do not mutate the installed
Haze prototype or assume its unfinished work can migrate. Chris confirmed the shared understanding after reviewing the design, acceptance
scope and delivery sequence on 27 September 2026. Runtime-specific contracts
and dependent implementation remain gated on S01 capability evidence. This decision does not by itself publish tickets or change remote issue state.

## Amendments — 28 September 2026

Chris approved these changes after the S01 probes exposed the difference between
orchestration, durable coordination and OS execution containment. The approved
revision 3–5 contract is recorded at local commit
`56976c0cea82d4dadfac73ab60979e0cfed69c30` on `cb/35-s01-proof`; consolidated evidence
is at `e87ed326182b602c412606d1e88d6ae481188eb2`. See the
[delivery evidence mapping](../delivery.md#evidence-and-remaining-work-mapping) and
[preserved issue history](https://github.com/chrisbanes/ensemble/issues/688).

1. **Crash survival (revision 3):** already-admitted execution may survive
   coordinator/App Server crashes and continue effects. Unavailable Ensemble
   cannot admit queued work. Preserve ownership/capacity and uncertain submissions;
   never blindly resubmit or automatically release them.
2. **Best-effort Stop (revision 4):** persist Stop, request cancellation for active
   task execution, including lead turns and assignments, and observe for a bounded
   interval. Continued effects are possible.
   Unresolved Stop/writer/capacity holds remain until independently resolved; time,
   acknowledgements, empty terminal lists or operator acknowledgement do not unlock.
3. **Cooperative normal-success handoff (revision 5):** an identified successful
   final turn, ended registered tools, complete observations and no known survivor
   permit serialized handoff to one successor. This accepts an untracked detached
   child writing alongside the successor. It is not physical writer exclusion.
   Crash, Stop, failure/interruption, missing observations and known survivors do
   not qualify; those holds still require independent resolution.
4. **Minimum integration reset:** S01 qualifies existing-login App Server execution,
   events/results, follow-up or supported resume and cancellation requests, plus
   bounded feasibility of trusted identity, admission, durable state and conservative
   ambiguous-submission handling. Full service/runtime/UI tests follow in S02–S05.
   Historical resume is not live reattachment; when reattachment is unsupported,
   visible uncertainty and the documented operator recovery route are acceptable.
   Positive live reattachment is not a universal gate.
5. **Runtime trust boundary:** Chris subsequently approved trusting Codex's
   successful terminal status for the bound thread/turn, with ended Ensemble-owned
   callbacks and no known unfinished execution or other hold, for normal cooperative
   handoff. This supersedes revision 5's exhaustive interpretation of "complete
   observations" and "registered tools". Detailed tool history is diagnostic;
   missing items alone do not prevent handoff. Incomplete observation and possible
   unobserved effects or overlapping writers are accepted, without claiming their
   policy/audit trail is proved. Crash, Stop, failure, ambiguous submission,
   missing/conflicting terminal identity/status and unfinished callbacks retain
   holds under the existing recovery rule. S01 qualifies a finite integration
   checklist, not every possible model tool or a general tool allowlist; see the
   [trust boundary](../design/standalone.md#runtime-trust-boundary) and
   [completion rule](../delivery.md#s01-completion-rule).
6. **S01-only approval evidence amendment:** Chris approved retaining unproved
   model-originated escalation rejection as an explicit S01 limitation. Existing
   effective `workspaceWrite`/`never` selection and attributable write, network and
   live/stored-history evidence can qualify that bounded row. The attempted request
   was inconclusive and is not a retroactive rejection. The product still denies
   broader command access: S02 implements and deterministically tests unexpected
   approval-callback rejection in the runtime adapter; S05 qualifies the integrated
   approval flow before release. Demonstrated policy breaches remain blockers.
   This changes no crash/Stop/handoff guarantee and does not itself pass S01 or
   release dependencies. See the [evidence amendment](../delivery.md#s01-only-approval-evidence-amendment--28-september-2026).

The default policy uses supported Codex workspace-write controls with explicit
write roots, command network access disabled and no automatic escalation
(`approvalPolicy: never`). Reads retain full access subject to host permissions;
“workspace-limited” must not imply outside-read denial. Disclose temporary roots,
protected paths, ambient credentials and other tool/network surfaces. The exact
policy and recovery route are in the [standalone design](../design/standalone.md).
Strict read isolation and complete descendant containment are separate explicit
product/deployment choices. This does not approve full-access execution, shared
config/login changes, credential copying, a different runtime or deployment.

Earlier process, cleanup and outside-read failures remain valid findings against
the stronger contracts they tested. They are not retroactive passes. The tradeoff
is continued effects and possible indefinite loss of workspace/capacity availability;
there is no force-unlock waiver. Actual evidence remains necessary to pass S01 or
release dependent work. The installed Haze prototype and Multica CB-35 are unchanged
by this source-contract and GitHub #688 documentation reset.

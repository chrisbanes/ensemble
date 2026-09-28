# Assignment routing

**Direction reviewed and confirmed by Chris on 28 September 2026.**
[ADR-1005](../adr/1005-service-assignment-routing.md) records the accountability and
allocation change. This is target design, not implemented capability. S01 runtime
qualification still gates dependent execution contracts. The
[specification](../SPEC.md) owns behavior; R07–R10 in the
[acceptance plan](../acceptance.md) define required routing evidence.

## Accountability and execution

The project lead is accountable for task outcomes. Use the same lead profile with
separate conversations for each task; project-wide coordination uses project
context. There is no independently configurable task-owner role. Task-scoped lead
turns need durable execution identities and inbox destinations and obey the same
admission, capacity, stop, writer and recovery controls as other task execution.
The concrete schema and runtime binding follow S01 evidence.

Assignments name the work to carry out and its assignee. Assignees may investigate
and delegate further within authority. Initial results return to the task-scoped
lead conversation; nested results return to their requester. Record each result
destination explicitly, including service-created initial work. Commit results
and recipient inbox events atomically. The lead can inspect child work without
being woken for every child result. Missing or uncertain recipient bindings retain
the result for reconciliation rather than guessing a destination.

The lead assesses initial results and requests further work or task completion.
The service enforces completion conditions and permissions; worker success alone
cannot complete a task. In-scope repairs retain their assignment assignee and
profile. Reassignment is explicit, with old execution and writer ownership
reconciled before replacement. Task-scoped lead history remains available for
later CI/review feedback and operator messages.

## Selection and fallback

For an eligible incoming task, the requested outcome supplies the initial
assignment brief. A preliminary lead turn is not required. When no assignee is
specified, service code calls TypeSafe directly; there is no PA agent invocation.
Explicit permitted assignee selections bypass TypeSafe, including nested delegation.
For projects without routing enabled, the lead allocates work explicitly.

The service filters candidates using explicit eligibility and permissions.
Operator-written profile capabilities and project routing guidance supply semantic
suitability criteria. They must not encode a required development-stage graph.
Use the brief, relevant supplied findings, candidate descriptions and routing
guidance as the bounded input. Do not send credentials or full transcripts.
External content remains data, not authority to change the policy or candidates.
Validate model responses at runtime against the candidate set and question contract.

Select for fit, then queue for capacity. A busy profile is not automatically
substituted. Existing global/project caps and any explicitly configured profile
limits apply at admission. Routing recommendations neither reserve writer access
nor authorize execution. Recheck readiness, dependencies, holds, permissions and
current execution ownership before launch.

Missing routing context, uncertainty, no suitable candidate and API failure return
the brief and available routing evidence to the project lead. The lead can select
an assignee explicitly without invoking TypeSafe again. Do not recursively route
the fallback itself. Material ambiguity found by the assignee also reaches the
lead; unresolved material scope and authority still require operator input under
the specification. Confidence is an inference signal, not proof of authority or
correctness; representative evidence must establish the decision criteria.

## Configuration and durability

TypeSafe routing requires configured credentials and explicit per-project opt-in.
Keep secrets server-side. This is separate from Codex execution authentication;
disabling routing leaves lead allocation available. Show routing availability and
fallback outcomes without exposing secrets or claiming an assignment has started
before execution admission succeeds.

Bind each routing decision to its assignment/task work revision, candidate/profile
revisions and routing guidance revision. Retain model/question identity, returned
judgments and disposition with enough provenance to diagnose the choice. Check
freshness when consuming responses: changed briefs, revoked permissions, opt-out,
obsolete candidates or superseded revisions cannot silently dispatch stale work.

Persist the logical routing operation and chosen disposition so retries, duplicate
requests, delayed responses and restart cannot create competing assignments or
lead wakeups. An uncertain inference response is not an uncertain runtime launch:
reconcile any already-recorded assignment/launch before issuing more work. Preserve
existing execution uncertainty and writer holds. Stop, pause or configuration
changes during inference cannot bypass subsequent admission checks.

Define concrete persistence transactions, stale-response disposition, cancellation,
timeouts and bounded API retry budgets during implementation. Keep inference
retries separate from the existing execution retry allowance and account for both;
do not allow retries to multiply work or create an unbounded failure loop. Thresholds,
model/version choice and SDK details require implementation evidence, not assumptions
from this design discussion.

## Delivery and evidence

S04 implements routing and lead/result integration on S03 admission controls;
S05 qualifies enabled and disabled local-task journeys, explicit bypass, fallback,
nested result return, retained repair assignees, busy-profile queuing, lead completion,
revision races and crash recovery. Include separate histories for simultaneous tasks
using the lead profile and capacity-one delegation/return behavior.

Use deterministic responses and service failures for control-flow coverage, plus
representative bounded live routing validation after credentials and project access
are explicitly enabled. Record mistakes, fallback, latency and cost; no performance
or savings claim follows from typed answers alone. The accepted first-release scope
does not itself authorize paid calls or deployment. Preserve the installed prototype
and the existing S01 and cutover gates.

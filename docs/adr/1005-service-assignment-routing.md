---
status: accepted
---

# Route assignments in the service while the project lead retains accountability

The project lead remains accountable for all task outcomes, using separate per-task
conversations with the same lead profile. Defer a separate task-owner role. Ensemble service code invokes TypeSafe directly
to recommend assignment assignees from eligible profiles using their capabilities
and project routing guidance. This avoids a PA agent turn and allows routine
initial allocation without waking the lead, at the cost of a separate optional
API integration and explicit uncertainty, revision and recovery handling.

Explicit permitted assignees bypass routing. Disabled routing uses lead allocation;
uncertain or unavailable routing returns to the lead. Assignees may delegate:
nested results return to their requester, initial results to the lead. The lead
assesses results and requests completion under service-enforced conditions.
Delegation does not transfer accountability. Repairs retain their assignee and
busy selected profiles wait for capacity rather than being silently substituted.

This supersedes ADR-1001's separate task-owner role and lead-only initial allocation,
as retained by ADR-1004. It does not introduce required development stages or
weaken admission, permission, writer, completion or recovery rules. TypeSafe access
requires configured credentials and explicit project opt-in; it does not replace
Codex's existing operator login. Routing belongs in the first standalone release.
The [specification](../SPEC.md), [routing design](../design/assignment-routing.md)
and [acceptance plan](../acceptance.md) define the behavior and required evidence.
This decision does not authorize enabling API access, running paid inference or
altering the installed prototype.

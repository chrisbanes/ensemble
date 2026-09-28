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
the BB prototype separately rather than importing its records. Active agent
execution must stop on service failure, with termination proven before writer
replacement. These are requirements to qualify, not implemented guarantees.
Other platforms are deferred. Codex is the first harness, using the existing operator login; Claude and API-key
billing for agent execution are deferred. ADR-1005 separately permits opt-in
TypeSafe API access for assignment routing. Codex App Server is the integration candidate,
subject to the runtime proof rather than assumed compatibility. Ensemble
must prove control of admission, cancellation, recovery and workspace writers;
wrapping another queue does not satisfy that requirement. Runtime and deployment
controls enforce execution access; an in-process service is not a security sandbox.

The existing BB prototype is transitional code, not a standalone implementation.
Preserve useful core code and historical evidence; remove BB packaging, adapters
and mandatory BB CI in the reviewed replacement work. Do not mutate the installed
Haze prototype or assume its unfinished work can migrate. Chris confirmed the shared understanding after reviewing the design, acceptance
scope and delivery sequence on 27 September 2026. Runtime-specific contracts
and dependent implementation remain gated on S01 capability evidence. This decision does not by itself publish tickets or change remote issue state.

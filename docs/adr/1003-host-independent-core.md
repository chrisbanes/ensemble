---
status: accepted
---

# Keep Ensemble's core independent of its host

Ensemble owns project and task identities, assignments, policy, durable
coordination, results, and recovery decisions in a host-independent core. BB
remains the initial host, loading the core through an adapter; an independent
service or replacement host is not required now. This retains BB's execution
and UI infrastructure while allowing a future host to reuse the product and
its durable work records.

Host adapters supply agent execution, conversations, workspaces, and execution
observations. Operator interfaces call the core, with BB providing the first UI
integration. Moving to another host must preserve product behavior and durable
work records; transferring live conversations and workspaces is not a required
migration guarantee. Whether unfinished assignments can resume on a replacement
host is explicitly deferred; preserving their records does not promise safe
resumption. Detailed migration and adapter contracts remain open.

Adapters must meet the guarantees required by each operation. If a host cannot
meet a requirement, gate the affected feature rather than silently weakening
Ensemble's semantics or rejecting unrelated supported features. An adapter
cannot advertise a capability merely because it exposes a similarly named API;
its behavior must satisfy the relevant acceptance scenarios.

Prove core portability through a standalone test harness running core journeys
and persistence without BB, using an explicit fake host. Keep real BB adapter
integration tests as separate evidence: the harness does not establish BB
compatibility. A second production host is not a first-release requirement.

An installation uses one execution host at a time. Portability supports replacing
that host; concurrent execution across hosts, including host selection per
project or assignment, is outside the initial scope. Keep SQLite as the core's
storage technology, with Ensemble owning its schema and migrations and hosting
supplying database access without a dependency on BB. Multiple database engines
are not required.

Agent profiles retain portable identity and instructions. Execution settings
belong to a versioned host binding, validated by that adapter; changing hosts
requires remapping and validating these settings. Do not pretend that provider,
model, reasoning, permission, or environment choices have universal equivalents.

This supersedes ADR-1001's choice to use BB project identities as Ensemble's
identities and its framing of the product as intrinsically a BB plugin. Its
agent-led coordination model and other product policies remain in force.
This is an accepted design direction, not an implementation claim or permission
to resume product implementation. The technical design, acceptance plan, and
delivery plan describe the target boundaries; detailed implementation and live
capability evidence remain subject to the existing planning and release gates.

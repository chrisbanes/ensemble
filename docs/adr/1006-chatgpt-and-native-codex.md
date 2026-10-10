---
status: accepted
---

# Add optional ChatGPT operations and native Codex tasks after the MVP

Both integrations are deferred until after the standalone MVP. Planning,
feasibility probes and implementation are paused under
[epic #734](https://github.com/chrisbanes/ensemble/issues/734) until Chris
explicitly reopens the work and current APIs, requirements and dependencies are
revalidated. Saved ChatGPT/Codex project placement is optional.

The standalone MVP retains its web UI, Codex App Server execution, GitHub delivery,
A01–A30/R01–R10 acceptance and operational recovery/reviewed cutover. X01–X08
remain deferred acceptance and do not block MVP release or cutover. No unproved
evidence is relabelled as passing. The contracts below describe the retained future
capability, not MVP obligations or implemented behaviour.

## Retained integration requirements

Ensemble remains usable independently by individual self-hosters, initially on
macOS. Its web UI and an optional ChatGPT plugin both support daily task operations:
creation, tracking, durable messages, questions and approvals. Setup and recovery
may remain in the web UI. Ensemble retains projects, policy, scheduling, durable
coordination and execution supervision; the plugin is another operator interface.

ChatGPT access is enabled explicitly per Ensemble project. Expose task content,
results and interaction material, excluding credentials, private instructions and
raw runtime logs. Subscribed completion, question and approval events are required
for the future integration. Events explain outcomes or request input; they do not
grant write authority. Exact reviewed approval material and existing admission checks
continue to govern actions.

Self-hosters enabling ChatGPT supply a reachable, authenticated HTTPS MCP endpoint.
Expose only the plugin API and keep the operator UI and runtime private. Provide
plugin packaging, guided deployment/authentication setup and connection checks;
automatic public endpoint provisioning and an Ensemble-hosted relay are outside
this decision. This amends ADR-1004's private-transport scope only for the optional
plugin endpoint, without changing runtime access or authentication.

New tasks should appear as one main native Codex task with linked, inspectable
worker conversations. Saved host project placement/linkage is optional; tasks
belong to Ensemble projects. Repository tasks default to retained Ensemble
task worktrees. Human inspection does not transfer ownership. Continuing work in
Codex requires explicit handover; Ensemble holds further task dispatch. Explicit
return requires settled-execution and changed-workspace checks before Ensemble
reacquires control. Neither idleness nor operator acknowledgement releases existing
crash, Stop, failure or uncertainty holds. No physical process containment is added.

Native visibility and safe handover remain unproved. App Server
thread creation alone does not establish these capabilities. The project-aware app
tools available inside Codex do not establish a supported standalone service API.
When the work resumes, qualify a disposable native integration before dependent
implementation. If the proof fails, return its evidence and integration-scope
consequences to Chris; do not silently accept managed threads as a substitute.

These are deferred requirements, not implemented capabilities. Existing
standalone qualification and reviewed cutover remain required. Importing historical
Codex tasks, team/RBAC administration and a new execution machine are not included.
See the [integration design](../design/chatgpt-and-native-codex.md) and
[acceptance additions](../acceptance.md#chatgpt-and-native-codex-acceptance).

# ChatGPT and native Codex integration

[ADR-1006](../adr/1006-chatgpt-and-native-codex.md) defers both integrations
until after the standalone MVP. Planning, probes and implementation are paused
until Chris explicitly reopens the work and current APIs, requirements and
dependencies are revalidated. This document retains future behaviour and evidence
gaps. Neither integration is implemented or qualified; X01–X08 do not gate MVP
release or cutover. GitHub issues under
[epic #734](https://github.com/chrisbanes/ensemble/issues/734) own delivery scope;
[native feasibility #724](https://github.com/chrisbanes/ensemble/issues/724) owns
the bounded proof and [integration qualification #728](https://github.com/chrisbanes/ensemble/issues/728)
the assembled integration evidence.

## Operator experience

Ensemble's web UI remains independently usable. Optional ChatGPT daily operations
cover task creation/tracking, durable messages, answers and approval decisions.
Project/profile administration and recovery may open the web UI. A sidebar app
provides project/task navigation; a conversation panel provides task detail beside
discussion. Deep links identify the exact task or interaction. Composer mentions
and model–app context are useful optional enhancements, not additional release
gates; feature availability must be checked on the target host.

Use the MCP Apps bridge for shared UI capabilities and OpenAI extensions for host
surfaces. The current operator pages deny framing and use browser sessions plus
Origin/CSRF checks. Build a dedicated component over validated service commands
and safe read projections; do not relax those web guards to embed the existing UI.

Map authenticated plugin callers to the operator and explicitly enabled projects.
Validate inputs, permissions, operation keys and expected revisions in the service.
Keep task creation distinct from start/readiness and project enablement. Replayed
commands return the same committed outcome; changed or stale requests conflict.
The plugin cannot bypass pause, Stop, dependencies, capacity or ownership holds.

Existing CoordinationView task projections and commands are candidate reusable
seams. Review their contents before exposing them: task-scoped data is not by itself
proof that a field is safe for ChatGPT. Expose task content, results and interaction
material; exclude credentials, private instructions and raw runtime logs from tool
results, component metadata, context sharing, errors and events. Project opt-out or
access revocation must prevent later reads, writes and deliveries.

Approval decisions show the exact retained action, target, requester, revision and
material. A ChatGPT tool confirmation alone does not satisfy Ensemble's approval
contract. Explicit user instructions authorise writes within granted project policy;
an event payload or task content does not supply that authority.

## Endpoint, authentication and installation

The optional plugin uses a reachable HTTPS MCP endpoint with authenticated,
project-scoped access. The public surface is limited to the plugin API and required
authentication/discovery endpoints; the operator UI, database and App Server stay
private. Use the documented MCP OAuth flow and token validation. Existing operator
browser cookies and Codex execution login are separate boundaries.

Self-hosters provide their HTTPS deployment. Ship packaging, a supported setup
recipe and checks for linking, authorised calls, unauthorised rejection and
revocation. Do not automatically provision an endpoint, deploy a hosted relay,
change shared Codex login/configuration or expose the existing private UI.

## Events and durable state

Provide explicit task/project-filtered subscriptions for completion, open questions
and approvals awaiting review. Persist subscriptions and delivery state; validate
and verify callback destinations and sign webhook deliveries. Recheck access on
delivery, retain stable event identity across bounded retries, and handle duplicate
or reordered deliveries without duplicate writes. Subscription expiry, opt-out,
revocation and unsubscribe stop delivery. Missed updates remain discoverable through
authorised reads; callback receipt is not operator acknowledgement or task completion.

Ensemble's durable attention inbox remains the source of truth. Event processing
may explain an outcome or request input, but cannot automatically approve, answer,
create work or send instructions. The configured runtime's command-network policy
does not authorise model execution to send webhooks; delivery belongs to the
service integration. GitHub inbound discovery webhooks remain deferred.

## Native Codex tasks and ownership

Saved Codex project placement/linkage is optional.
No saved-project create/list/select/assign API is required. A task keeps
its Ensemble identity and main lead conversation; assignments bind to worker
threads and may continue across replacement conversations. Preserve native host,
thread and workspace identity, and host project identity when available, without
deriving policy from those IDs or unioning project permissions. Creating and
following new tasks is in scope;
automatic import/adoption of historical native tasks is not.

Present one main native task with linked, inspectable worker conversations. For
repository tasks, create and retain an Ensemble task worktree; human continuation
uses that same workspace. Codex project linkage must not silently replace the task
workspace with the project's main checkout or broaden writable roots.

Record explicit human handover before native continuation and hold further Ensemble
dispatch for the task. Do not overlap human and Ensemble turns in that workspace.
Record explicit return, reconcile execution and workspace changes, and revalidate
permissions, revisions, dependencies and all existing holds before dispatch. After
restart, a task remains under human control or uncertain until reconciliation;
never infer return from idle status. Human work does not automatically complete the
task or authorise merge. If supported APIs cannot coordinate native continuation,
report the limitation instead of claiming that a UI button enforces ownership.

## Feasibility boundary

When last investigated, App Server documented persistent thread creation with cwd,
history and lifecycle notifications, but did not establish a saved desktop-project
API or native placement of independently created threads. Its thread listing
distinguishes appServer sources from the default interactive sources. Codex's
project-aware app tools are host-mediated; their presence in an agent session does
not establish a supported standalone API.

When reopened, the bounded native proof must create a new task in a disposable
local repository/worktree, verify actual native visibility/opening and worker
navigation, observe a harmless worktree change, exercise settled handover in both
directions, and restart Ensemble
without duplicate launch. Record installed versions, integration entrypoints,
identity, observed effects, failure/unproved rows and exact fixture cleanup. Do not
modify production tasks, shared configuration/login or the installed Haze prototype.
Failed or unsupported required rows trigger scope review, not automatic fallback,
new stronger containment requirements or an assumed pass.

The API, native task presentation mechanism, handover controls and auth deployment
details must be settled from evidence before implementation contracts are accepted.

## Official references

- [Plugin extensions](https://developers.openai.com/plugins/build/extensions)
- [MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP authentication](https://developers.openai.com/plugins/build/auth)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events): the documented
  ChatGPT integration requires MCP 2.0 and signed webhook delivery.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)

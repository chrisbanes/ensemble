---
status: accepted
---

# Add Claude Code as a second execution harness

Chris confirmed these decisions on 8 October 2026 under
[epic #777](https://github.com/chrisbanes/ensemble/issues/777). They amend
[ADR-1004](1004-standalone-service.md), which deferred Claude for agent execution.
This records target contracts, not implemented behaviour. Delivery slices,
sequencing and status live in the epic's sub-issues.

## Selection

The execution runtime is an agent profile setting. Codex remains the default.
An assignment conversation stays bound to the harness that started it; changing a
profile's harness affects new conversations only and never migrates a live session.
One task may therefore mix Codex and Claude assignments. Ensemble keeps admission,
ownership, coordination, policy and task completion for every harness.

Claude profiles expose model and reasoning effort, validated against the values the
installed integration supports. Permission mode, tools, sandbox and configuration
sources are Ensemble policy, not profile settings.

## Integration

Use the TypeScript Claude Agent SDK behind the existing `Runtime` interface. Each
turn is one `query()` that resumes the assignment's Claude session, so each turn has
its own `claude` subprocess and process identity. Ensemble mints the turn identity;
the SDK session ID is the conversation identity. Interrupt uses the query's abort
path. Generalise the interface only where the Claude integration demonstrates a
different need.

Ensemble coordination tools are served through an in-process SDK MCP server.

## Authentication

Use the operator's own Claude subscription through a `claude setup-token` token
held with Ensemble's other secrets, mirroring the Codex operator login. API-key
billing stays deferred.

Anthropic's terms bar third-party products from offering subscription login to
others, and say advertised Pro/Max limits assume ordinary, individual use of
Claude Code and the Agent SDK. A single-operator service driven by its owner is
not addressed explicitly. Recheck the
[current terms](https://code.claude.com/docs/en/legal-and-compliance) before
advertising the harness and when self-hosting by others is considered.

## Execution policy

Match the Codex default policy and disclose where enforcement differs:

- `permissionMode: "dontAsk"`, an explicit built-in tool allowlist, Ensemble's MCP
  tools, and every other tool disallowed. No interactive approvals.
- A `PreToolUse` hook sees every tool call, records it, and denies calls outside
  policy, because allow rules bypass `canUseTool`.
- Shell commands run in Claude Code's sandbox (Seatbelt on macOS): writes to the
  task workspace and explicit writable roots only, an empty network allowlist, no
  unsandboxed retry, and failure if the sandbox is unavailable.
- The hook confines file-editing tools to the same roots. This is hook enforcement,
  not OS confinement, and must be disclosed with the effective policy.
- Reads keep full access subject to host permissions, as with Codex.

Agents load no user, project or plugin Claude configuration: no setting sources,
strict MCP configuration and a dedicated Claude configuration directory. Ensemble
supplies repository instructions (`CLAUDE.md`, `AGENTS.md`) as instruction text, so
repository content cannot add permission rules, hooks or MCP servers.

Native `AskUserQuestion` is disabled. Agents ask the operator through
`ensemble_ask_question`, which is durable across restarts.

## Recovery

Claude takes the existing Codex recovery contract. A turn running during a service
crash, process loss or unverified Stop leaves a visible uncertainty hold and
retains writer and capacity holds. Explicit operator recovery may resume the
session; a tool call cut off by the crash is not re-run, and the agent must check
its effects. Nothing silently retries or releases ownership.

## Qualification

Deterministic tests cover fault handling, capability rejection and policy denial.
Before the harness is advertised, bounded real-runtime journeys must pass for a
Claude-only task, a mixed Codex and Claude task, and Stop plus a crash mid-turn.
Untested surfaces remain disclosed limits.

## Outside this decision

OpenCode, Pi, remote workers ([#778](https://github.com/chrisbanes/ensemble/issues/778)),
conversation transfer between harnesses, API-key billing and native Claude
`AskUserQuestion` bridging.

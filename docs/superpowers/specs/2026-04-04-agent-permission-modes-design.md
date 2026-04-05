# Agent Permission Modes Design

## Summary

This design adds explicit per-agent `acpx` permission mode configuration so autonomous agents can opt into unattended execution without changing the default behavior of existing configs.

It also clarifies Ensemble's existing ACP permission setting by separating launch-time `acpx` permission mode from in-session ACP permission-request handling.

## Problem

Ensemble currently launches `acpx` agents with `--agent <name>` and optional `--model <model>`, but it does not pass an explicit `acpx` permission mode. That means runtime behavior depends on whatever default `acpx` chooses for that agent.

For autonomous operation, some agents need an explicit no-prompts mode so runs do not block on interactive permission requests.

There is also a naming problem in the current config surface:

- `agent.permission_policy` sounds like it configures `acpx`
- in reality it only controls how Ensemble answers ACP `session/request_permission` messages after a session is already running

If we add `permission_mode` without clarifying that distinction, the config becomes harder to understand.

## Goals

- Allow each `acpx` agent to opt into an explicit permission mode.
- Preserve current behavior when the new field is omitted.
- Keep the configuration surface minimal and aligned with existing per-agent `acpx` settings.
- Make the difference between `acpx` launch permissions and ACP runtime permission handling obvious.

## Non-Goals

- Introducing a global permission-mode default in this change.
- Changing the behavior of existing configs that omit the new field.
- Redesigning all ACP permission handling.
- Supporting permission-mode configuration for non-`acpx` executors.

## Decision

Add an optional `permission_mode` field under each agent definition:

```yaml
agents:
  builder:
    acpx_agent: claude
    model: sonnet
    permission_mode: approve_all
    prompt_template: templates/build.liquid

  reviewer:
    acpx_agent: codex
    prompt_template: templates/review.liquid
    # omitted => acpx default
```

Behavior rules:

- `agents.<name>.permission_mode` is only meaningful when `acpx_agent` is set.
- If `permission_mode` is omitted, Ensemble passes no permission-mode flag and `acpx` keeps its default behavior.
- If `permission_mode` is set, Ensemble appends the corresponding `acpx` CLI flag when building that agent's spawn command.

Supported values in v1:

- `approve_all` -> `--approve-all`
- `approve_reads` -> `--approve-reads`
- `deny_all` -> `--deny-all`

Unknown values should fail validation.

This is intentionally per-agent rather than global because it matches existing `acpx_agent` and `model` fields and allows different trust levels for different roles.

## Naming Clarification

Rename the existing global runtime setting from:

- `agent.permission_policy`

to:

- `agent.permission_request_policy`

Meaning:

- `agents.<name>.permission_mode` = launch-time `acpx` permission mode
- `agent.permission_request_policy` = Ensemble's policy for responding to ACP `session/request_permission` requests during a running session

This naming split makes the two layers explicit instead of leaving two similarly named settings that operate at different boundaries.

## Config Boundaries

The docs should show these paths side by side:

- `agents.<name>.*` configures how Ensemble launches that specific agent
- `agent.*` configures Ensemble's own runtime behavior while managing ACP sessions

For permissions, that means:

- `agents.<name>.permission_mode` controls launch-time `acpx` flags
- `agent.permission_request_policy` controls how Ensemble answers runtime ACP permission callbacks

## Compatibility And Migration

Compatibility rules:

- Continue reading `agent.permission_policy` for backward compatibility.
- Prefer writing and documenting `agent.permission_request_policy` going forward.
- Treat `agent.permission_policy` as deprecated in docs, not as an immediate validation error.
- If both fields are present with the same value, accept the config, normalize on `permission_request_policy`, and emit a deprecation warning for `permission_policy`.
- If both fields are present with different values, fail validation and require the config to choose one value.

This keeps existing configs working while giving new configs clearer naming.

## Validation

Validation rules should be strict:

- Reject `agents.<name>.permission_mode` when `acpx_agent` is not set.
- Allow `permission_mode` to be omitted with no warning.
- Reject configs that set both `agent.permission_policy` and `agent.permission_request_policy` to different values.

Rejecting invalid combinations is better than silently ignoring them because permission behavior directly affects autonomy and safety.

## Runtime Changes

Runtime behavior should be:

1. Resolve the per-agent spawn command.
2. If the agent uses `acpx_agent`, append `--model` when configured.
3. If the agent also has `permission_mode`, append the matching `acpx` permission-mode flag.
4. Start the ACP session as usual.
5. During the session, continue using `agent.permission_request_policy` to answer ACP permission requests that the agent sends back to Ensemble.

This keeps `acpx` launch behavior in the command-construction path and keeps ACP permission-response behavior in the ACP client.

Example command:

```sh
acpx --approve-all --agent claude --model sonnet
```

If `permission_mode` is omitted, Ensemble should emit no permission flag at all.

## Documentation Changes

Update these surfaces:

- `docs/configuration.md` agent reference for `permission_mode`
- `docs/configuration.md` runtime agent reference for `permission_request_policy`
- examples that use `acpx_agent` and are intended for autonomous execution
- inline code comments or doc comments that currently imply `permission_policy` is an `acpx` setting

Documentation should explicitly say that omitting `permission_mode` preserves `acpx` defaults.

## Testing

Add or update tests for:

- config parsing of `agents.<name>.permission_mode`
- config parsing of `agent.permission_request_policy`
- backward-compatible parsing of legacy `agent.permission_policy`
- validation failure when `permission_mode` is used without `acpx_agent`
- validation failure for unknown `permission_mode` values
- validation failure when both runtime permission-policy keys disagree
- spawn-command construction including the configured `acpx` permission-mode flag
- spawn-command construction when `permission_mode` is omitted, confirming no permission flag is emitted

## Open Question

This design assumes Ensemble should expose a small validated config enum even though it ultimately maps to raw `acpx` CLI flags.

That is slightly more explicit than a raw pass-through string, but it gives operators a stable documented config surface and lets validation catch typos before a run starts.

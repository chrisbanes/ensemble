# Structured ACP Permission Handling Design

## Context

Issue #92 tracks a flaw in Ensemble's direct ACP permission handling. The current implementation receives typed SDK permission requests, but it still decides whether to approve by string-matching serialized tool call text. That is fragile and does not match ACP's permission response model.

ACP permission requests provide:

- a typed `RequestPermissionRequest`
- a `tool_call` update for display/context
- an `options` array of `PermissionOption` values
- each option's stable `option_id`
- each option's semantic `PermissionOptionKind`

The correct client behavior is to choose one of the offered options and respond with that option's ID. Ensemble should not infer authorization semantics from natural-language descriptions, tool titles, or raw payload display fields.

## Goals

- Make direct ACP permission responses protocol-correct.
- Remove description and display-text heuristics from permission decisions.
- Remove compatibility with the legacy `approve_reads_reject_writes` policy.
- Allow advanced users to select a known ACP permission option ID explicitly.
- Emit structured permission events that include option IDs and selected outcomes.
- Keep permission behavior simple, explicit, and testable.

## Non-Goals

- Recreate read-versus-write classification inside Ensemble.
- Preserve old configs that use `approve_reads_reject_writes`.
- Add human-in-the-loop permission UI in this change.
- Change `acpx` runtime launch-time permission modes.

## Policy Model

Replace the open string behavior of `agent.permission_request_policy` with a validated tagged policy:

```yaml
agent:
  permission_request_policy:
    mode: approve_all
```

Supported modes:

- `approve_all`
- `reject_all`
- `select_option`

`select_option` requires an explicit ACP permission option ID:

```yaml
agent:
  permission_request_policy:
    mode: select_option
    option_id: allow_always
```

This is intentionally an option ID selector, not a request ID selector. ACP permission responses select one of the request's offered `PermissionOption.option_id` values. The agent/client chooses those option IDs, so this mode is for users who know the concrete ACP client behavior they are configuring.

`approve_reads_reject_writes` should be removed. If a config still uses it, config loading should fail with a clear error explaining that Ensemble no longer supports heuristic read/write permission classification for direct ACP permission callbacks.

The existing `auto_approve_all` spelling should also be removed. The long-term public config should use `approve_all` because it names the behavior directly and matches `reject_all`.

## Permission Selection

Permission handling should use only structured ACP fields when choosing a response option. Built-in policies use `PermissionOptionKind`; `select_option` uses an exact `PermissionOption.option_id`.

For `select_option`:

1. Find an offered option whose `option_id` exactly matches the configured `option_id`.
2. Select that option regardless of its label or kind.
3. If the option is not offered on this request, respond with `RequestPermissionOutcome::Cancelled`.

For `approve_all`:

1. Select an option with `PermissionOptionKind::AllowAlways` if present.
2. Otherwise select `PermissionOptionKind::AllowOnce` if present.
3. Otherwise respond with `RequestPermissionOutcome::Cancelled`.

For `reject_all`:

1. Select an option with `PermissionOptionKind::RejectOnce` if present.
2. Otherwise select `PermissionOptionKind::RejectAlways` if present.
3. Otherwise respond with `RequestPermissionOutcome::Cancelled`.

When an option is selected, the response must be:

```rust
RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone()))
```

`Cancelled` should mean "no suitable offered option exists" or "the prompt turn was actually cancelled." It should not be the normal representation of a deny decision when a reject option is available.

`select_option` is the only mode that matches a literal option ID. The built-in `approve_all` and `reject_all` modes stay portable by selecting from semantic `PermissionOptionKind` values and then returning the chosen option's ID.

## Event Model

Extend permission events so downstream logs and UI state can represent the ACP decision without parsing free-form strings.

`PermissionRequested` should include:

- `tool_call_id`
- optional tool title, if present on the update
- available options as `{ option_id, name, kind }`

`PermissionResolved` should include:

- `outcome`: `selected` or `cancelled`
- `selected_option_id`, when selected
- `selected_option_kind`, when selected
- `allowed`, derived from the selected kind for internal state handling

The emitted `Warning` and generic `Notification` messages currently used around permission handling should either be removed or reduced to secondary human-readable summaries. Structured permission events should be the primary contract.

## Error Handling

- Unknown `permission_request_policy` values should fail config validation before a run starts.
- Empty option arrays should produce a `Cancelled` permission response and a structured resolved event with no selected option.
- If the SDK responder returns an error, propagate the existing SDK/client error path; do not hide it behind a successful permission event.

## Documentation Updates

Update `docs/SPEC.md` and `docs/configuration.md` to say:

- `agent.permission_request_policy` applies only to direct ACP runtime paths.
- Supported modes are `approve_all`, `reject_all`, and `select_option`.
- Ensemble selects from ACP `PermissionOption[]` by `PermissionOptionKind` and responds using the selected `option_id`.
- `select_option` selects a configured ACP `PermissionOption.option_id` exactly and is intended for client-specific configurations.
- Ensemble does not support read/write permission inference because ACP tool call display fields are not an authorization semantics contract.
- Known option IDs for supported ACP clients should be documented with examples as they are verified. These examples are documentation aids, not protocol guarantees.

## Testing

Add focused unit tests around the permission selection helper:

- `approve_all` selects `AllowAlways` before `AllowOnce`.
- `approve_all` falls back to `AllowOnce`.
- `reject_all` selects `RejectOnce` before `RejectAlways`.
- `reject_all` falls back to `RejectAlways`.
- `select_option` selects the exact configured option ID.
- `select_option` returns `Cancelled` when the configured option ID is not offered.
- no matching option yields `Cancelled`.
- option names, tool titles, and serialized tool call text do not affect selection.

Add config tests:

- `approve_all` parses and validates.
- `reject_all` parses and validates.
- `select_option` requires a non-empty `option_id`.
- `approve_reads_reject_writes` is rejected with a clear message.
- unknown values are rejected with a clear message.

Add event tests where practical:

- permission request events include offered option IDs and kinds.
- permission resolved events include the selected option ID and kind.

## Implementation Notes

The core code change is in `crates/ensemble-core/src/agent/acp_client.rs`. Remove `resolve_permission` and replace `select_permission_option` with a helper that returns a `RequestPermissionOutcome` or a small internal decision struct containing the selected option metadata.

Config validation lives in `crates/ensemble-core/src/config/ensemble.rs`; it should reject unsupported values early rather than allowing the runtime to default to approval.

`crates/ensemble-core/src/agent/events.rs` owns the internal event shape. Updating these event variants may require small downstream adjustments where events are serialized into timeline or state records.

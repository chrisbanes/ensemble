# Agent Permission Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-agent `acpx` permission-mode configuration, rename Ensemble's runtime ACP permission setting to `permission_request_policy`, and preserve compatibility for existing configs.

**Architecture:** Keep the change minimal and local to the existing config/runtime boundaries. Per-agent launch-time behavior stays in `AgentConfig` and `resolve_agent_command(...)`, while runtime ACP permission handling stays global in `AgentRuntimeConfig` and `acp_client.rs`. Use strict validation plus a compatibility parse path for legacy `agent.permission_policy`.

**Tech Stack:** Rust 1.80, Serde/Serde YAML, utoipa schema derives, Tokio async tests, existing `cargo test -p ensemble-core` coverage.

---

## File Map

- `crates/ensemble-core/src/config/ensemble.rs`
  Owns `AgentConfig`, `AgentRuntimeConfig`, YAML parsing, defaults, and config validation.
- `crates/ensemble-core/src/error.rs`
  Owns config and pipeline-facing error variants if validation needs a more specific message than the existing generic invalid-agent error.
- `crates/ensemble-core/src/agent/mod.rs`
  Owns `resolve_agent_command(...)` and the handoff from config to ACP session startup.
- `crates/ensemble-core/src/agent/acp_client.rs`
  Owns runtime handling of ACP `session/request_permission` callbacks.
- `crates/ensemble-core/src/config/form.rs`
  Owns guided config form extraction and YAML merge/writeback behavior.
- `crates/ensemble-core/src/api/config_edit_handler.rs`
  Owns config-edit endpoint tests and guided-form fixtures that currently still use `permission_policy`.
- `crates/ensemble-core/src/api/openapi.rs`
  Re-exports the guided config schema types through utoipa; usually updated automatically by struct changes, but keep it in scope for compiler fallout.
- `crates/ensemble-core/tests/api_endpoints.rs`
  Integration coverage for setup/defaults and config-edit API behavior.
- `crates/ensemble-core/src/orchestrator/mod.rs`
  Contains config fixture YAML in tests that currently uses `agent.permission_policy`.
- `docs/configuration.md`
  User-facing config reference that must document both `agents.<name>.permission_mode` and `agent.permission_request_policy`.
- `docs/SPEC.md`
  Product specification that currently describes `agent.permission_policy`; update it to the clearer runtime name.
- `crates/ensemble-core/src/orchestrator/mod.rs`
  Contains representative inline YAML examples in tests; audit them as example surfaces for the canonical runtime key and optional per-agent `permission_mode` usage.
- `docs/superpowers/specs/2026-03-30-ensemble-init-design.md`
  Historical design doc with stale language that currently says `permission_policy` is managed by `acpx`; update it so repository docs do not contradict the new meaning.
- `docs/superpowers/specs/2026-04-04-agent-permission-modes-design.md`
  Approved design spec for this implementation.

---

### Task 1: Add Config Fields, Compatibility Parsing, And Validation

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/error.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Write the failing config tests for the new permission fields**

Add unit tests in `crates/ensemble-core/src/config/ensemble.rs` for these cases:

```rust
#[test]
fn test_parse_config_with_agent_permission_mode() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    permission_mode: approve_all
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#;

    let config = parse_config(yaml).unwrap();
    assert_eq!(config.agents["builder"].permission_mode.as_deref(), Some("approve_all"));
}

#[test]
fn test_parse_config_with_permission_request_policy() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
agent:
  permission_request_policy: reject_all
"#;

    let config = parse_config(yaml).unwrap();
    assert_eq!(config.agent.permission_request_policy, "reject_all");
}

#[test]
fn test_parse_config_accepts_legacy_permission_policy_key() {
    // parse legacy key and normalize to permission_request_policy
}

#[test]
fn test_parse_config_accepts_equal_legacy_and_canonical_permission_keys() {
    // parse both keys with same value, normalize to permission_request_policy
}

#[test]
fn test_parse_config_rejects_conflicting_permission_policy_keys() {
    // same YAML contains both keys with different values
}

#[test]
fn test_validate_permission_mode_requires_acpx_agent() {
    // executor/model agent with permission_mode should fail validation
}

#[test]
fn test_validate_permission_mode_rejects_unknown_value() {
    // permission_mode: maybe_later should fail validation
}
```

- [ ] **Step 2: Run the targeted config tests to capture the current baseline**

Run: `cargo test -p ensemble-core config::ensemble::tests`
Expected: FAIL because `permission_mode` and `permission_request_policy` do not exist yet.

- [ ] **Step 3: Add the minimal config fields and parse normalization path**

In `crates/ensemble-core/src/config/ensemble.rs`:

1. Add `permission_mode: Option<String>` to `AgentConfig`.
2. Rename `AgentRuntimeConfig.permission_policy` to `permission_request_policy`.
3. Keep the runtime default value as `"auto_approve_all"` via a renamed helper.
4. Replace the direct `serde_yaml::from_str(...)` parse in `parse_config(...)` with a small YAML-value normalization pass that:
   - reads `agent.permission_policy` when `agent.permission_request_policy` is absent
   - accepts both keys when equal
   - rejects both keys when different
   - normalizes the parsed config to the canonical `permission_request_policy` field
   - emits a deprecation warning when the legacy key is present, including the equal-values dual-key case
5. Extend `validate_config(...)` to:
   - reject `permission_mode` unless `acpx_agent` is present
   - reject unknown `permission_mode` strings outside `approve_all`, `approve_reads`, and `deny_all`

Use `tracing::warn!` for the deprecation path unless the existing config-loading code already has a project-standard warning collector. Keep the implementation local to `ensemble.rs` unless `error.rs` needs a new specific variant for a clearer validation message.

- [ ] **Step 4: Run the targeted config tests to verify parsing and validation**

Run: `cargo test -p ensemble-core config::ensemble::tests`
Expected: PASS

If the deprecation warning test captures logs, run the smallest targeted command that covers it and assert the legacy-key warning text appears once.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/error.rs
git commit -m "feat: add agent permission mode config"
```

### Task 2: Apply Permission Settings In The ACP Runtime Path

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write the failing runtime tests for command construction and renamed policy usage**

Extend `crates/ensemble-core/src/agent/mod.rs` tests with cases like:

```rust
#[test]
fn test_resolve_agent_command_includes_approve_all_flag() {
    let config = crate::config::ensemble::AgentConfig {
        acpx_agent: Some("claude".to_string()),
        model: Some("sonnet".to_string()),
        permission_mode: Some("approve_all".to_string()),
        executor: None,
        prompt: None,
        prompt_template: None,
        reasoning_level: None,
    };

    let cmd = resolve_agent_command(Some(&config), "default-cmd");
    assert_eq!(cmd, "acpx --approve-all --agent 'claude' --model 'sonnet'");
}

#[test]
fn test_resolve_agent_command_omits_permission_flag_when_unset() {
    // same shape with permission_mode: None should stay at today's command form
}
```

Also add one regression test that exercises the renamed runtime field through existing config fixture helpers if a direct unit test is easier than a full agent-session test.

- [ ] **Step 2: Run the targeted agent tests to confirm they fail first**

Run: `cargo test -p ensemble-core agent::mod::tests`
Expected: FAIL because `resolve_agent_command(...)` does not append permission flags yet.

- [ ] **Step 3: Implement the minimal command mapping and renamed runtime field usage**

In `crates/ensemble-core/src/agent/mod.rs`:

1. Extend `resolve_agent_command(...)` so `permission_mode` maps to exact `acpx` flags:
   - `approve_all` -> `--approve-all`
   - `approve_reads` -> `--approve-reads`
   - `deny_all` -> `--deny-all`
2. Append the permission flag before `--agent ...` so the final command matches the approved design.
3. Switch the turn loop to pass `config.agent.permission_request_policy` into `run_turn(...)`.

In `crates/ensemble-core/src/agent/acp_client.rs`:

1. Rename function parameters and local variable names from `permission_policy` to `permission_request_policy`.
2. Keep the existing ACP request-response behavior unchanged.

In `crates/ensemble-core/src/orchestrator/mod.rs`, update inline YAML fixtures to the canonical runtime key so tests and examples stop reinforcing the old name.

- [ ] **Step 4: Run the targeted runtime tests to verify the new command behavior**

Run: `cargo test -p ensemble-core agent::mod::tests`
Expected: PASS

Run: `cargo test -p ensemble-core orchestrator::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/agent/mod.rs crates/ensemble-core/src/agent/acp_client.rs crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "feat: pass acpx permission mode to agent commands"
```

### Task 3: Normalize Guided Config Editing And API Fixtures

**Files:**
- Modify: `crates/ensemble-core/src/config/form.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Test: `crates/ensemble-core/src/config/form.rs`
- Test: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Test: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Write the failing guided-form and API tests**

Add/adjust tests for these behaviors:

```rust
#[test]
fn extract_guided_form_includes_agent_permission_mode() {
    // parse config with builder.permission_mode and assert it appears in GuidedAgentForm
}

#[test]
fn apply_guided_form_writes_permission_request_policy_key() {
    // merged YAML should contain permission_request_policy and not reintroduce legacy key
}

#[tokio::test]
async fn config_edit_defaults_use_permission_request_policy_field_name() {
    // handler fixture or API response should use the canonical runtime field name
}
```

- [ ] **Step 2: Run the targeted guided-form and API tests before changing code**

Run: `cargo test -p ensemble-core config::form::tests`
Expected: FAIL because the guided form does not expose the new fields yet.

Run: `cargo test -p ensemble-core config_edit_handler`
Expected: FAIL once the new assertions are added.

- [ ] **Step 3: Update form extraction, merge logic, and API fixtures**

In `crates/ensemble-core/src/config/form.rs`:

1. Add `permission_mode: Option<String>` to `GuidedAgentForm`.
2. Rename `GuidedAgentRuntimeForm.permission_policy` to `permission_request_policy`.
3. Update `extract_guided_form(...)` to populate both new fields from canonical config.
4. Update `apply_guided_form(...)` so agent entries write `permission_mode` when present.
5. Update `apply_guided_form(...)` so the runtime section writes `permission_request_policy` and removes legacy `permission_policy` from the merged YAML if present.

In `crates/ensemble-core/src/api/config_edit_handler.rs` and `crates/ensemble-core/tests/api_endpoints.rs`:

1. Rename inline fixtures and assertions to the canonical runtime field.
2. Add one regression assertion that saved guided YAML contains `permission_request_policy`.

Touch `crates/ensemble-core/src/api/openapi.rs` only if the schema registration or compiler output requires it.

- [ ] **Step 4: Run the targeted guided-form and API tests to verify canonical writeback**

Run: `cargo test -p ensemble-core config::form::tests`
Expected: PASS

Run: `cargo test -p ensemble-core config_edit_handler`
Expected: PASS

Run: `cargo test -p ensemble-core --test api_endpoints`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/form.rs crates/ensemble-core/src/api/config_edit_handler.rs crates/ensemble-core/src/api/openapi.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "refactor: normalize permission settings in config editor"
```

### Task 4: Update User-Facing Documentation And Verify The Final Surface

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/SPEC.md`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `docs/superpowers/specs/2026-03-30-ensemble-init-design.md`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/config/form.rs`
- Test: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Add the final documentation assertions to existing tests where helpful**

If there is already a config-string serialization test in `ensemble.rs` or `form.rs`, extend it so the final YAML/examples check for:

```rust
assert!(yaml.contains("permission_request_policy:"));
assert!(yaml.contains("permission_mode: approve_all"));
assert!(!yaml.contains("permission_policy:"));
```

Only add these assertions where the test already produces representative YAML; do not create a large new test harness just for docs.

- [ ] **Step 2: Run the full ensemble-core test suite before docs changes**

Run: `cargo test -p ensemble-core`
Expected: PASS

- [ ] **Step 3: Update the docs to match the implemented config surface**

In `docs/configuration.md`:

1. Add `permission_mode` to the `agents` table with the supported values and the note that omission preserves `acpx` defaults.
2. Rename the runtime row to `permission_request_policy`.
3. Clarify that `agents.*` controls launch-time `acpx` flags, while `agent.*` controls Ensemble runtime session behavior.

In `docs/SPEC.md`:

1. Replace `agent.permission_policy` references with `agent.permission_request_policy` where they describe runtime ACP callbacks.
2. Add `agents.*.permission_mode` to the agent-config section if that section enumerates per-agent runtime knobs.
3. Keep the language explicit that `permission_request_policy` governs ACP `session/request_permission` handling, not `acpx` launch mode.

In `docs/superpowers/specs/2026-03-30-ensemble-init-design.md`:

1. Replace the stale statement that `permission_policy` is managed by `acpx`.
2. Clarify that the old name referred to Ensemble runtime callback handling, while launch-time `acpx` behavior now belongs to per-agent `permission_mode`.

Audit example surfaces:

1. Review inline YAML examples in `crates/ensemble-core/src/orchestrator/mod.rs` and keep them on the canonical `permission_request_policy` key.
2. If any example in this repository currently demonstrates autonomous `acpx_agent` execution, add `permission_mode` there; otherwise document in the PR/implementation notes that `docs/configuration.md` is the only user-facing example updated in this change.

In `crates/ensemble-core/src/agent/mod.rs`:

1. Update the `resolve_agent_command(...)` doc comment so it mentions `permission_mode` alongside `acpx_agent` and `model`.
2. Remove any wording that implies `permission_request_policy` affects the `acpx` spawn command.

- [ ] **Step 4: Run the full verification commands**

Run: `cargo test -p ensemble-core`
Expected: PASS

Run: `cargo fmt --all -- --check`
Expected: PASS

Run: `cargo clippy -p ensemble-core -- -D warnings`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/configuration.md docs/SPEC.md docs/superpowers/specs/2026-03-30-ensemble-init-design.md crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/agent/mod.rs crates/ensemble-core/src/config/form.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "docs: clarify acpx and ACP permission settings"
```

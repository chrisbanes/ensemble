# ACPX Runtime Permission Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every configured ACPX `permission_mode` reaches all real `AcpxRuntime` commands while omitted modes preserve ACPX defaults and invalid modes fail before process launch.

**Architecture:** Keep `PermissionMode` as the single mapping from config values to ACPX flags. Add a crate-visible typed permission option to `AcpxCommandOptions`, parse the agent setting once at the runtime boundary, and let the shared ACPX command builder apply the flag consistently to session setup, prompts, cancellation, and cleanup. Cover the real runtime path with command-capture tests rather than extending the legacy command-resolution tests that `AcpxRuntime` does not use.

**Tech Stack:** Rust 2021, Tokio process execution, `serde_yaml` configuration, Cargo test, Clippy, rustfmt, Vitest/React setup UI tests

---

## File Structure

- Modify `crates/ensemble-core/src/agent/acpx_runtime.rs`: parse the configured mode into the typed command options and add end-to-end runtime command regression tests.
- Modify `crates/ensemble-core/src/agent/acpx_cli.rs`: carry the typed mode and append its global ACPX flag in the shared command builder.
- Verify without modifying `crates/ensemble-core/src/config/ensemble.rs`: its existing `PermissionMode` parser, flag mapping, and unknown-value validation remain the source of truth.
- Verify without modifying `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`, `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx`, and `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx`: these already restrict UI values to `approve_all`, `approve_reads`, and `deny_all`.
- No canonical documentation change is required: `docs/SPEC.md:672-675` and `docs/configuration.md:283` already describe the intended behavior this bug fix restores.

### Task 1: Add Real Runtime Regression Coverage

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs:535-556`
- Test: `crates/ensemble-core/src/agent/acpx_runtime.rs` test module near `acpx_runtime_passes_reasoning_level_to_acpx_commands`

- [ ] **Step 1: Make the test config helper accept an optional permission mode**

Replace the current `test_config` body with a delegating helper so tests can exercise configured and omitted modes without duplicating the full YAML fixture:

```rust
fn test_config() -> Arc<crate::config::ensemble::EnsembleConfig> {
    test_config_with_permission_mode(None)
}

fn test_config_with_permission_mode(
    permission_mode: Option<&str>,
) -> Arc<crate::config::ensemble::EnsembleConfig> {
    let permission_mode = permission_mode
        .map(|mode| format!("\n    permission_mode: {mode}"))
        .unwrap_or_default();
    Arc::new(
        parse_config(&format!(
            r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex{permission_mode}
    prompt: hi
steps:
  - name: build
    agent: builder
workspace:
  root: /tmp/test
on_success: Done
on_failure: Failed
"#
        ))
        .unwrap(),
    )
}
```

- [ ] **Step 2: Write a failing runtime command test for all modes and omission**

Add this test beside the existing reasoning-level command test. It must run `AcpxRuntime::run_step`, capture every spawned command, and assert the configured flag appears on session setup, both visible/hidden prompts, and session cleanup. The omission case must prove none of the permission flags are added.

```rust
#[tokio::test]
async fn acpx_runtime_passes_permission_mode_to_acpx_commands() {
    let cases = [
        (Some("approve_all"), Some("--approve-all")),
        (Some("approve_reads"), Some("--approve-reads")),
        (Some("deny_all"), Some("--deny-all")),
        (None, None),
    ];

    for (permission_mode, expected_flag) in cases {
        let workspace = tempfile::TempDir::new().unwrap();
        let args_path = workspace.path().join("args.txt");
        let script_path = write_mock_acpx_script(
            workspace.path(),
            &format!(
                r#"#!/usr/bin/env bash
printf '%s\n' "$*" >> "{}"
case "$*" in
  *" sessions ensure --name "*)
    exit 0
    ;;
  *" prompt --session "*)
    cat > /dev/null
    printf '%s\n' \
      '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{{\"result\":\"succeeded\"}}"}}}}}}}}' \
      '{{"jsonrpc":"2.0","id":1,"result":{{"stopReason":"end_turn"}}}}'
    exit 0
    ;;
  *" sessions close "*)
    exit 0
    ;;
esac
exit 1
"#,
                args_path.display()
            ),
        );

        let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let issue = test_issue("issue-1", "Todo");
        let config = test_config_with_permission_mode(permission_mode);
        let request = AgentRunRequest {
            config,
            issue: &issue,
            agent_name: "builder",
            step_name: "build",
            step_kind: StepKind::Agent,
            attempt: None,
            timeout_ms: TEST_TIMEOUT_MS,
            interaction_response: None,
            workspace_path: workspace.path(),
            event_tx: tx,
            cancel_token: CancellationToken::new(),
            step_outputs: StepOutputTemplateContext::default(),
        };

        runner.run_step(&request, "finish the task").await.unwrap();

        let commands: Vec<String> = std::fs::read_to_string(args_path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert!(!commands.is_empty());
        for flag in ["--approve-all", "--approve-reads", "--deny-all"] {
            assert_eq!(
                commands.iter().all(|command| command.contains(flag)),
                expected_flag == Some(flag),
                "permission flag mismatch for mode {permission_mode:?}: {commands:?}"
            );
        }
    }
}
```

- [ ] **Step 3: Write a failing runtime test that prevents silent fallback for invalid values**

Add a second test that builds an in-memory config with an unsupported value. The config validator already rejects this value; this test also protects direct `AcpxRuntime` callers from silently launching with ACPX defaults if validation is bypassed.

```rust
#[tokio::test]
async fn acpx_runtime_rejects_unknown_permission_mode_before_launch() {
    let workspace = tempfile::TempDir::new().unwrap();
    let invoked_path = workspace.path().join("invoked.flag");
    let script_path = write_mock_acpx_script(
        workspace.path(),
        &format!(
            "#!/usr/bin/env bash\ntouch \"{}\"\nexit 0\n",
            invoked_path.display()
        ),
    );
    let runner = AcpxRuntime::with_cli(AcpxCli::new(script_path));
    let (tx, _rx) = tokio::sync::mpsc::channel(16);
    let issue = test_issue("issue-1", "Todo");
    let config = test_config_with_permission_mode(Some("maybe"));
    let request = AgentRunRequest {
        config,
        issue: &issue,
        agent_name: "builder",
        step_name: "build",
        step_kind: StepKind::Agent,
        attempt: None,
        timeout_ms: TEST_TIMEOUT_MS,
        interaction_response: None,
        workspace_path: workspace.path(),
        event_tx: tx,
        cancel_token: CancellationToken::new(),
        step_outputs: StepOutputTemplateContext::default(),
    };

    let error = runner
        .run_step(&request, "finish the task")
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        AgentError::PromptError { reason }
            if reason.contains("unsupported permission_mode 'maybe'")
    ));
    assert!(!invoked_path.exists(), "acpx must not launch for an invalid mode");
}
```

- [ ] **Step 4: Run the new tests and verify they fail for the expected reasons**

Run:

```bash
cargo test -p ensemble-core agent::acpx_runtime::tests::acpx_runtime_passes_permission_mode_to_acpx_commands -- --exact
cargo test -p ensemble-core agent::acpx_runtime::tests::acpx_runtime_rejects_unknown_permission_mode_before_launch -- --exact
```

Expected: the command-propagation test fails because no permission flag is present, and the invalid-mode test fails because the current runtime launches ACPX instead of returning `AgentError::PromptError`.

### Task 2: Thread the Typed Mode Through ACPX Commands

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs:8-39`
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs` option literals in tests near lines 626, 664, 705, 746, 789, and 843
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs:9-15,117-137`
- Test: `crates/ensemble-core/src/agent/acpx_runtime.rs`

- [ ] **Step 1: Add the typed permission mode to `AcpxCommandOptions`**

Import the existing config enum and add a crate-visible field so the public options type does not expose a crate-private type:

```rust
use crate::config::ensemble::PermissionMode;
use crate::error::AgentError;

#[derive(Debug, Clone, Copy, Default)]
pub struct AcpxCommandOptions<'a> {
    pub model: Option<&'a str>,
    pub reasoning_level: Option<&'a str>,
    pub(crate) permission_mode: Option<PermissionMode>,
}
```

In each existing explicit `AcpxCommandOptions` test literal in `acpx_cli.rs`, add:

```rust
permission_mode: None,
```

Keep `AcpxCommandOptions::default()` call sites unchanged.

- [ ] **Step 2: Apply the flag in the shared ACPX command builder**

At the start of `append_global_args`, before adapter-specific `--agent` or generic `--model` handling, append the flag from the typed mode:

```rust
fn append_global_args(
    adapter: &AcpxAgentAdapter<'_>,
    invocation: &AcpxAgentInvocation,
    command: &mut Command,
    options: AcpxCommandOptions<'_>,
) {
    if let Some(permission_mode) = options.permission_mode {
        command.arg(permission_mode.acpx_flag());
    }

    if let Some(raw_command) = invocation.raw_command() {
        command.args(["--agent", raw_command]);
    } else if let Some(model) = adapter.generic_model_arg(options.model) {
        command.args(["--model", model]);
    }

    if let Some(reasoning_level) = options.reasoning_level {
        command.args(["--reasoning-level", reasoning_level]);
    }
}
```

Because `ensure_session` and `base_command` both call `append_global_args`, this single change covers session setup, visible and hidden prompts, cancellation, and close without duplicating flag logic.

- [ ] **Step 3: Parse once and reject invalid values at the runtime boundary**

Extend the existing config import in `acpx_runtime.rs` and build the typed option before any ACPX process is started:

```rust
use crate::config::ensemble::PermissionMode;
use crate::error::AgentError;

let permission_mode = agent
    .permission_mode
    .as_deref()
    .map(|value| {
        PermissionMode::parse(value).ok_or_else(|| AgentError::PromptError {
            reason: format!(
                "agent '{}' has unsupported permission_mode '{}'",
                request.agent_name, value
            ),
        })
    })
    .transpose()?;
let command_options = AcpxCommandOptions {
    model: agent.model.as_deref(),
    reasoning_level: agent.reasoning_level.as_deref(),
    permission_mode,
};
```

Also add `permission_mode = agent.permission_mode.as_deref()` to the nearby `debug!` fields so launch diagnostics show the selected mode without changing behavior.

- [ ] **Step 4: Run the runtime and CLI test modules**

Run:

```bash
cargo test -p ensemble-core agent::acpx_runtime::tests
cargo test -p ensemble-core agent::acpx_cli::tests
```

Expected: PASS. The four runtime cases observe exactly the intended flag behavior, the invalid mode does not launch a process, and existing model/reasoning/adapter command tests remain green.

- [ ] **Step 5: Run the existing config validation tests**

Run:

```bash
cargo test -p ensemble-core test_validate_permission_mode
cargo test -p ensemble-core test_permission_mode_exposes_acpx_flags
```

Expected: PASS. This confirms all three supported strings still validate and map correctly, while `maybe` and invalid runtime combinations are rejected.

- [ ] **Step 6: Format and commit the focused fix**

Run:

```bash
cargo fmt --all
git add crates/ensemble-core/src/agent/acpx_cli.rs crates/ensemble-core/src/agent/acpx_runtime.rs
git commit -m "fix: honor acpx runtime permission mode"
```

Expected: rustfmt completes without errors and the commit contains only the two runtime files.

### Task 3: Verify UI Agreement and the Full Rust Change

**Files:**
- Verify: `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`
- Verify: `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx`
- Verify: `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx`
- Verify: `docs/SPEC.md:672-675`
- Verify: `docs/configuration.md:283`

- [ ] **Step 1: Run the existing setup UI tests that cover permission-mode filtering and persistence**

Run from `crates/ensemble-ui/src-ui`:

```bash
pnpm test -- src/components/config/GuidedEditor.test.tsx src/components/config/SetupWizard.test.tsx src/pages/ConfigPage.test.tsx
```

Expected: PASS. No UI source change is needed because all setup surfaces already use the backend-supported set `approve_all`, `approve_reads`, and `deny_all`.

- [ ] **Step 2: Run core tests and lint the affected crate**

Run from the repository root:

```bash
cargo test -p ensemble-core
cargo clippy -p ensemble-core --all-targets -- -D warnings
cargo fmt --all -- --check
```

Expected: all commands exit successfully with no warnings or formatting differences.

- [ ] **Step 3: Confirm the final diff is scoped to issue 318**

Run:

```bash
git status --short
git diff HEAD^ -- crates/ensemble-core/src/agent/acpx_cli.rs crates/ensemble-core/src/agent/acpx_runtime.rs
```

Expected: the implementation diff contains only typed option propagation, strict runtime parsing, command flag insertion, and the new regression tests. Canonical docs remain unchanged because they already specify the corrected behavior.

## Acceptance Criteria Mapping

- Every supported mode reaches the real ACPX runtime invocation: Task 1 tests all three modes through `AcpxRuntime::run_step`; Task 2 applies the typed flag in the shared builder used by every lifecycle command.
- Unsupported values fail instead of falling back silently: the existing config tests are rerun, and Task 1 adds a runtime-boundary rejection test before process launch.
- Runtime command tests cover `approve_all`, `approve_reads`, `deny_all`, and omission: Task 1 uses a four-case command-capture table.
- Setup UI values match runtime behavior: Task 3 verifies the existing UI filtering and persistence tests against the same three-value set.

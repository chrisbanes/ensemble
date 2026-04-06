# acpx Runtime Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken ACP-over-`acpx` execution path with an `acpx` session runtime that supports structured event streaming, while retaining an explicit direct-runtime escape hatch.

**Architecture:** Introduce a runtime abstraction inside `crates/ensemble-core/src/agent/` with two backends: `AcpxRuntime` for `acpx_agent`-based execution and `DirectRuntime` for explicit lower-level execution. Move the current ACP-specific session logic behind the direct backend, add an `acpx` CLI transport that manages `sessions ensure` / `prompt` / `cancel` / `sessions close`, and normalize `acpx` JSON output into orchestration-friendly runtime events that can later power web UI logs.

**Tech Stack:** Rust 2021, tokio async process/io, serde/serde_json, tracing, tempfile, existing orchestrator worker event channel.

---

## File Structure

### Create
- `crates/ensemble-core/src/agent/runtime.rs` — runtime backend selection, runtime trait, backend factory.
- `crates/ensemble-core/src/agent/acpx_runtime.rs` — `AcpxRuntime` runner implementation.
- `crates/ensemble-core/src/agent/acpx_cli.rs` — low-level `acpx` command/session transport and event stream parser.
- `docs/configuration.md` (plan modifies, not creates) — runtime semantics update.

### Modify
- `crates/ensemble-core/src/agent/mod.rs` — split current `AcpAgentRunner` responsibilities, route through runtime abstraction.
- `crates/ensemble-core/src/agent/events.rs` — replace ACP-specific naming with runtime-agnostic events and add `acpx`-oriented log/tool/cancel events.
- `crates/ensemble-core/src/agent/acp_client.rs` — keep as direct backend transport, remove assumptions that it powers `acpx_agent`.
- `crates/ensemble-core/src/config/ensemble.rs` — add explicit runtime selection for escape hatch; validate `permission_request_policy` semantics per runtime.
- `crates/ensemble-core/src/error.rs` — add `acpx` runtime/parse/session errors.
- `crates/ensemble-core/src/api/bootstrap.rs` — instantiate runtime-aware agent runner.
- `crates/ensemble-core/src/orchestrator/mod.rs` — consume runtime-agnostic event names and ensure state tracking still works.
- `docs/SPEC.md` — document `acpx` command/session runtime model instead of raw ACP-over-`acpx`.

### Existing tests to extend
- `crates/ensemble-core/src/agent/mod.rs` unit tests
- `crates/ensemble-core/src/agent/acp_client.rs` unit tests
- `crates/ensemble-core/src/orchestrator/mod.rs` tests
- `crates/ensemble-core/src/config/ensemble.rs` tests

---

### Task 1: Introduce runtime abstraction and runtime-agnostic events

**Files:**
- Create: `crates/ensemble-core/src/agent/runtime.rs`
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write the failing event/runtime selection tests**

Add tests near the bottom of `crates/ensemble-core/src/agent/mod.rs` covering default runtime selection and new event names:

```rust
#[test]
fn runtime_kind_defaults_to_acpx_for_acpx_agent() {
    let config = parse_config(r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    prompt: hi
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#).unwrap();

    let agent = config.agents.get("builder").unwrap();
    assert_eq!(runtime::RuntimeKind::for_agent(agent), runtime::RuntimeKind::Acpx);
}

#[test]
fn runtime_event_name_exposes_output_chunk() {
    let event = AgentEvent::OutputChunk {
        stream: RuntimeStream::Stdout,
        content: "hello".to_string(),
    };
    assert_eq!(event.event_name(), "output_chunk");
    assert_eq!(event.message_for_state().as_deref(), Some("hello"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk cargo test -p ensemble-core runtime_kind_defaults_to_acpx_for_acpx_agent runtime_event_name_exposes_output_chunk`
Expected: FAIL with missing `runtime` module / missing `OutputChunk` variant.

- [ ] **Step 3: Add runtime selection module**

Create `crates/ensemble-core/src/agent/runtime.rs`:

```rust
use crate::config::ensemble::AgentConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Acpx,
    Direct,
}

impl RuntimeKind {
    pub fn for_agent(agent: &AgentConfig) -> Self {
        match agent.runtime.as_deref() {
            Some("direct") => Self::Direct,
            Some("acpx") => Self::Acpx,
            Some(_) | None if agent.acpx_agent.is_some() => Self::Acpx,
            _ => Self::Direct,
        }
    }
}
```

In `crates/ensemble-core/src/agent/mod.rs`, expose the module:

```rust
pub mod runtime;
```

- [ ] **Step 4: Replace ACP-specific event vocabulary with runtime-agnostic variants**

Update `crates/ensemble-core/src/agent/events.rs` to introduce these types and variants:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize)]
pub enum AgentEvent {
    SessionStarted { session_id: String, agent_pid: Option<String> },
    PromptStarted,
    OutputChunk { stream: RuntimeStream, content: String },
    ToolCall { title: String, detail: Option<String> },
    RunCompleted { usage: Option<TokenUsage> },
    RunFailed { reason: String, usage: Option<TokenUsage> },
    Cancelled { reason: Option<String> },
    Warning { message: String },
    Notification { message: String },
    OtherMessage { raw: String },
    Malformed { line: String },
}
```

Update `event_name()` and `message_for_state()` accordingly.

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk cargo test -p ensemble-core runtime_kind_defaults_to_acpx_for_acpx_agent runtime_event_name_exposes_output_chunk`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/runtime.rs crates/ensemble-core/src/agent/events.rs crates/ensemble-core/src/agent/mod.rs
git commit -m "refactor: add runtime abstraction for agent backends"
```

---

### Task 2: Add `acpx` CLI transport and event parser

**Files:**
- Create: `crates/ensemble-core/src/agent/acpx_cli.rs`
- Modify: `crates/ensemble-core/src/error.rs`
- Test: `crates/ensemble-core/src/agent/acpx_cli.rs`

- [ ] **Step 1: Write failing `acpx` transport tests**

Create tests in `crates/ensemble-core/src/agent/acpx_cli.rs` using a mock shell script that emits NDJSON lines:

```rust
#[tokio::test]
async fn ensure_session_uses_sessions_ensure_command() {
    let dir = tempfile::TempDir::new().unwrap();
    let script = write_mock_acpx_script(dir.path(), r#"
#!/usr/bin/env bash
printf '%s\n' "$*" > "$MOCK_ACPX_ARGS_FILE"
"#);

    let client = AcpxCli::new(script.into());
    client.ensure_session("codex", "build-session", dir.path(), None).await.unwrap();

    let args = std::fs::read_to_string(dir.path().join("args.txt")).unwrap();
    assert!(args.contains("sessions ensure"));
    assert!(args.contains("--name build-session"));
}

#[tokio::test]
async fn prompt_stream_maps_output_and_completion_events() {
    let dir = tempfile::TempDir::new().unwrap();
    let script = write_mock_acpx_script(dir.path(), r#"
#!/usr/bin/env bash
cat <<'JSON'
{"event":"prompt.started","session":"s1"}
{"event":"output","stream":"stdout","text":"hello"}
{"event":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}
JSON
"#);

    let client = AcpxCli::new(script.into());
    let events = client
        .run_prompt("codex", "build-session", dir.path(), "hi", None)
        .await
        .unwrap();

    assert!(matches!(events[0], AgentEvent::PromptStarted));
    assert!(matches!(events[1], AgentEvent::OutputChunk { .. }));
    assert!(matches!(events[2], AgentEvent::RunCompleted { .. }));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk cargo test -p ensemble-core ensure_session_uses_sessions_ensure_command prompt_stream_maps_output_and_completion_events`
Expected: FAIL with missing `AcpxCli` / missing helpers.

- [ ] **Step 3: Add `AcpxCli` transport skeleton**

Create `crates/ensemble-core/src/agent/acpx_cli.rs`:

```rust
use std::path::Path;
use tokio::process::Command;

use crate::error::AgentError;
use super::events::{AgentEvent, RuntimeStream, TokenUsage};

pub struct AcpxCli {
    executable: String,
}

impl AcpxCli {
    pub fn new(executable: String) -> Self {
        Self { executable }
    }

    pub async fn ensure_session(
        &self,
        agent: &str,
        session_name: &str,
        cwd: &Path,
        model: Option<&str>,
    ) -> Result<(), AgentError> {
        let mut cmd = self.base_command(agent, cwd, model);
        cmd.args(["sessions", "ensure", "--name", session_name]);
        let status = cmd.status().await.map_err(|e| AgentError::IoError {
            reason: format!("failed to start acpx sessions ensure: {e}"),
        })?;
        if !status.success() {
            return Err(AgentError::SessionStartupFailed {
                reason: format!("acpx sessions ensure exited with {status}"),
            });
        }
        Ok(())
    }
```

Continue with:
- `run_prompt(...) -> Result<Vec<AgentEvent>, AgentError>`
- `cancel(...)`
- `close_session(...)`
- `base_command(...)` adding `--format json --json-strict --cwd <cwd>` and supported permission flags

- [ ] **Step 4: Implement JSON event parsing**

Add a parser helper in the same file:

```rust
fn map_event(value: serde_json::Value) -> AgentEvent {
    match value.get("event").and_then(|v| v.as_str()) {
        Some("prompt.started") => AgentEvent::PromptStarted,
        Some("output") => AgentEvent::OutputChunk {
            stream: match value.get("stream").and_then(|v| v.as_str()) {
                Some("stderr") => RuntimeStream::Stderr,
                _ => RuntimeStream::Stdout,
            },
            content: value.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        },
        Some("warning") => AgentEvent::Warning {
            message: value.get("message").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        },
        Some("completed") => AgentEvent::RunCompleted {
            usage: value.get("usage").cloned().and_then(|v| serde_json::from_value::<TokenUsage>(v).ok()),
        },
        Some("cancelled") => AgentEvent::Cancelled {
            reason: value.get("reason").and_then(|v| v.as_str()).map(str::to_string),
        },
        Some("failed") => AgentEvent::RunFailed {
            reason: value.get("reason").and_then(|v| v.as_str()).unwrap_or("acpx run failed").to_string(),
            usage: None,
        },
        _ => AgentEvent::OtherMessage { raw: value.to_string() },
    }
}
```

If a line is invalid JSON, emit `AgentEvent::Malformed { line }` rather than failing the whole run immediately.

- [ ] **Step 5: Add dedicated `acpx` runtime errors**

In `crates/ensemble-core/src/error.rs`, add:

```rust
#[error("acpx command failed: {command} — {reason}")]
AcpxCommandFailed { command: String, reason: String },
#[error("acpx final status missing: {context}")]
AcpxFinalStatusMissing { context: String },
```

Use them in `acpx_cli.rs` for non-zero exit and unknown-final-state cases.

- [ ] **Step 6: Run tests to verify they pass**

Run: `rtk cargo test -p ensemble-core ensure_session_uses_sessions_ensure_command prompt_stream_maps_output_and_completion_events`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/agent/acpx_cli.rs crates/ensemble-core/src/error.rs
git commit -m "feat: add acpx cli transport"
```

---

### Task 3: Implement `AcpxRuntime` runner and keep ACP transport as direct backend

**Files:**
- Create: `crates/ensemble-core/src/agent/acpx_runtime.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write failing runtime execution tests**

Add a new test in `crates/ensemble-core/src/agent/mod.rs`:

```rust
#[tokio::test]
async fn acpx_agent_runner_emits_runtime_events_and_success() {
    let workspace = tempfile::TempDir::new().unwrap();
    let runner = AcpAgentRunner::new(Arc::new(RwLock::new(test_config())));
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);

    let result = runner.run(AgentRunRequest {
        config: test_config(),
        issue: &test_issue(),
        agent_name: "builder",
        step_name: "build",
        attempt: None,
        interaction_response: None,
        workspace_path: workspace.path(),
        event_tx: tx,
    }).await.unwrap();

    assert!(matches!(result, WorkerResult::Success));
    assert!(collect_event_names(&mut rx).await.contains(&"prompt_started".to_string()));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk cargo test -p ensemble-core acpx_agent_runner_emits_runtime_events_and_success`
Expected: FAIL because the current runner still uses `AcpSession` directly.

- [ ] **Step 3: Implement `AcpxRuntime` runner**

Create `crates/ensemble-core/src/agent/acpx_runtime.rs` with a focused runner:

```rust
pub struct AcpxRuntime {
    cli: AcpxCli,
}

impl AcpxRuntime {
    pub fn new() -> Self {
        Self { cli: AcpxCli::new("acpx".to_string()) }
    }

    pub async fn run_step(&self, request: AgentRunRequest<'_>, prompt: String) -> Result<WorkerResult, AgentError> {
        let agent = request.config.agents.get(request.agent_name).unwrap();
        let session_name = format!("{}-{}-attempt-{}", request.issue.id, request.step_name, request.attempt.unwrap_or(1));
        self.cli.ensure_session(agent.acpx_agent.as_deref().unwrap(), &session_name, request.workspace_path, agent.model.as_deref()).await?;
        let events = self.cli.run_prompt(agent.acpx_agent.as_deref().unwrap(), &session_name, request.workspace_path, &prompt, agent.model.as_deref()).await?;
        for event in events {
            emit_runtime_event(&request.event_tx, request.issue.id.as_str(), request.step_name, event).await;
        }
        self.cli.close_session(agent.acpx_agent.as_deref().unwrap(), &session_name, request.workspace_path, agent.model.as_deref()).await.ok();
        Ok(detect_worker_result(request.workspace_path).await)
    }
}
```

Use a helper that infers failure/cancelled/unknown-final-state from the last terminal event.

- [ ] **Step 4: Rework `AcpAgentRunner` into a runtime dispatcher**

In `crates/ensemble-core/src/agent/mod.rs`, keep prompt building and workspace prep, but route execution like this:

```rust
let agent_config = config.agents.get(agent_name).ok_or_else(...)?;
match runtime::RuntimeKind::for_agent(agent_config) {
    runtime::RuntimeKind::Acpx => {
        let runtime = acpx_runtime::AcpxRuntime::new();
        runtime.run_step(request, prompt).await
    }
    runtime::RuntimeKind::Direct => {
        let runtime = direct_runtime::DirectRuntime::new();
        runtime.run_step(request, prompt).await
    }
}
```

If creating a separate `direct_runtime.rs` feels like unnecessary churn, keep the existing ACP-backed logic in `mod.rs` temporarily but isolate it behind a `run_direct_step(...)` helper.

- [ ] **Step 5: Rename ACP-specific events in direct path**

Update the existing `acp_client.rs` event emission to use new names:

```rust
AgentEvent::TurnStarted => AgentEvent::PromptStarted
AgentEvent::TurnUpdate { content } => AgentEvent::OutputChunk { stream: RuntimeStream::Stdout, content }
AgentEvent::TurnCompleted { usage } => AgentEvent::RunCompleted { usage }
AgentEvent::TurnFailed { reason, usage } => AgentEvent::RunFailed { reason, usage }
```

Map permission requests to `Warning` or `Notification` in the direct path instead of keeping `acpx`-only semantics in the shared event type.

- [ ] **Step 6: Run tests to verify they pass**

Run: `rtk cargo test -p ensemble-core acpx_agent_runner_emits_runtime_events_and_success`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/agent/mod.rs crates/ensemble-core/src/agent/acp_client.rs crates/ensemble-core/src/agent/acpx_runtime.rs
 git commit -m "feat: route acpx agents through acpx runtime"
```

---

### Task 4: Add explicit runtime config and validation

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/config/form.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`
- Test: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Write failing config tests**

Add tests in `crates/ensemble-core/src/config/ensemble.rs`:

```rust
#[test]
fn acpx_agent_defaults_runtime_to_acpx() {
    let config = parse_config(r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    prompt: hi
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#).unwrap();
    assert_eq!(config.agents["builder"].runtime.as_deref(), None);
    assert_eq!(RuntimeKind::for_agent(&config.agents["builder"]), RuntimeKind::Acpx);
}

#[test]
fn permission_request_policy_is_rejected_for_acpx_runtime_override() {
    let config = parse_config(r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: codex
    runtime: acpx
    prompt: hi
agent:
  permission_request_policy: manual
steps:
  - name: build
    agent: builder
on_success: Done
on_failure: Failed
"#).unwrap();
    let err = validate_config(&config).unwrap_err();
    assert!(err.to_string().contains("permission_request_policy"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk cargo test -p ensemble-core acpx_agent_defaults_runtime_to_acpx permission_request_policy_is_rejected_for_acpx_runtime_override`
Expected: FAIL with missing `runtime` field / validation.

- [ ] **Step 3: Add explicit runtime field to `AgentConfig`**

In `crates/ensemble-core/src/config/ensemble.rs`:

```rust
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    // existing fields...
}
```

Validation rules:
- `runtime: acpx` requires `acpx_agent`
- `runtime: direct` is always allowed when existing direct fields are valid
- unknown runtime strings fail validation
- omitted runtime + `acpx_agent` => `AcpxRuntime`
- omitted runtime + no `acpx_agent` => `DirectRuntime`

- [ ] **Step 4: Wire runtime through guided form / API shape**

Update:
- `crates/ensemble-core/src/config/form.rs`
- `crates/ensemble-core/src/api/config_edit_handler.rs`
- `crates/ensemble-core/tests/api_endpoints.rs`

Add `runtime?: string` to the guided agent form and preserve it only when explicitly set. Do **not** force-writing `runtime: acpx` for normal `acpx_agent` entries unless the user explicitly chose it.

- [ ] **Step 5: Update permission policy validation**

In `validate_config(...)`, add logic like:

```rust
let any_acpx = config.agents.values().any(|agent| RuntimeKind::for_agent(agent) == RuntimeKind::Acpx);
if any_acpx && config.agent.permission_request_policy != default_permission_request_policy() {
    return Err(ConfigError::ConfigWriteRejected {
        reason: "agent.permission_request_policy is ignored for acpx runtime; remove it or use direct runtime".to_string(),
    }.into());
}
```

If this is too strict for mixed configs, narrow it to agents explicitly configured as direct vs acpx and document the limitation in the spec/docs task.

- [ ] **Step 6: Run tests to verify they pass**

Run: `rtk cargo test -p ensemble-core acpx_agent_defaults_runtime_to_acpx permission_request_policy_is_rejected_for_acpx_runtime_override`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/config/form.rs crates/ensemble-core/src/api/config_edit_handler.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "feat: add runtime selection config"
```

---

### Task 5: Update orchestrator/bootstrap wiring and regression coverage

**Files:**
- Modify: `crates/ensemble-core/src/api/bootstrap.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/src/api/bootstrap.rs`

- [ ] **Step 1: Write failing regression tests**

Add orchestrator-facing tests ensuring new event names still update state and that `acpx_agent` workers no longer expect ACP startup messages:

```rust
#[tokio::test]
async fn handle_agent_update_accepts_prompt_started_and_output_chunk() {
    let orchestrator = test_orchestrator();
    orchestrator.handle_worker_event(WorkerEvent::AgentUpdate {
        issue_id: "1".to_string(),
        step_name: "build".to_string(),
        event: AgentEvent::PromptStarted,
        timestamp: chrono::Utc::now(),
    }).await;
    orchestrator.handle_worker_event(WorkerEvent::AgentUpdate {
        issue_id: "1".to_string(),
        step_name: "build".to_string(),
        event: AgentEvent::OutputChunk { stream: RuntimeStream::Stdout, content: "hi".to_string() },
        timestamp: chrono::Utc::now(),
    }).await;
}
```

And a transport regression test in bootstrap/agent tests that asserts no `initialize` JSON is sent when `acpx_agent` is used by injecting a mock `acpx` executable and checking argv/stdin.

- [ ] **Step 2: Run tests to verify they fail**

Run: `rtk cargo test -p ensemble-core handle_agent_update_accepts_prompt_started_and_output_chunk`
Expected: FAIL with missing event handling.

- [ ] **Step 3: Update orchestrator worker-event handling**

In `crates/ensemble-core/src/orchestrator/mod.rs`, update match arms to consume new event names:

```rust
AgentEvent::PromptStarted => { /* mark running */ }
AgentEvent::RunCompleted { usage } | AgentEvent::RunFailed { usage, .. } => { /* token accounting */ }
AgentEvent::OutputChunk { content, .. } => { /* recent-event/state message */ }
AgentEvent::Cancelled { .. } => { /* state messaging */ }
AgentEvent::Warning { message } => { /* warning tracking */ }
```

Preserve current token aggregation and timeline behavior.

- [ ] **Step 4: Keep bootstrap wiring minimal**

In `crates/ensemble-core/src/api/bootstrap.rs`, keep the same `Arc<dyn AgentRunner>` instantiation but verify that `AcpAgentRunner::new(...)` now means runtime-dispatcher, not ACP-over-`acpx` specifically. Update comments/tests accordingly.

- [ ] **Step 5: Run tests to verify they pass**

Run: `rtk cargo test -p ensemble-core handle_agent_update_accepts_prompt_started_and_output_chunk`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/api/bootstrap.rs
git commit -m "refactor: wire orchestrator to runtime-agnostic agent events"
```

---

### Task 6: Update docs and run full verification

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`
- Modify: `docs/superpowers/specs/2026-04-05-acpx-runtime-integration-design.md` (only if implementation reveals spec wording drift)

- [ ] **Step 1: Update runtime docs**

In `docs/SPEC.md`, replace statements that imply raw ACP-over-`acpx` with language like:

```md
When `agents.<name>.acpx_agent` is set, Ensemble executes that step through the `acpx` command/session runtime. Ensemble does not speak ACP JSON-RPC directly to `acpx`; instead it manages `acpx` sessions and consumes structured runtime events.
```

In `docs/configuration.md`, add/update:
- `runtime` field on agents (`acpx` / `direct`)
- `acpx_agent` defaulting behavior
- note that `agent.permission_request_policy` applies only to direct runtime paths

- [ ] **Step 2: Run targeted tests**

Run:
```bash
rtk cargo test -p ensemble-core agent::
rtk cargo test -p ensemble-core orchestrator::
rtk cargo test -p ensemble-core config::
```
Expected: PASS.

- [ ] **Step 3: Run full Rust verification**

Run:
```bash
rtk cargo test --workspace --exclude ensemble-desktop
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
```
Expected: all PASS.

- [ ] **Step 4: Commit final docs/cleanup**

```bash
git add docs/SPEC.md docs/configuration.md docs/superpowers/specs/2026-04-05-acpx-runtime-integration-design.md
git commit -m "docs: describe acpx runtime integration"
```

---

## Self-Review

### Spec coverage
- Runtime abstraction and dual backends: Tasks 1, 3, 4
- `acpx` session runtime replacing ACP-over-`acpx`: Tasks 2, 3, 5
- Event/log streaming for future web UI logs: Tasks 1, 2, 5
- Separate session per step / fresh session per retry: Tasks 2, 3, 5
- Direct-runtime escape hatch: Tasks 3, 4
- Config semantics for `permission_request_policy`: Task 4
- Docs/spec updates: Task 6

### Placeholder scan
- No TBD/TODO markers
- Every code-changing task includes concrete file paths, code snippets, and commands
- Regression coverage included explicitly

### Type consistency
- Runtime selector name: `RuntimeKind`
- Backend names: `AcpxRuntime`, `DirectRuntime`
- Shared event variants: `PromptStarted`, `OutputChunk`, `RunCompleted`, `RunFailed`, `Cancelled`, `Warning`


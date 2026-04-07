# ACPX Shared JSON-RPC Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify ACP/ACPX message parsing so both direct ACP sessions and the `acpx` CLI runtime correctly handle JSON-RPC `session/update` envelopes and terminal `stopReason` responses.

**Architecture:** Introduce a shared ACP protocol parsing module in `ensemble-core` that normalizes JSON-RPC lines into runtime-friendly signals (output chunks, usage deltas, stop reasons, permission requests). Refactor both `acp_client.rs` and `acpx_cli.rs` to use the same helpers instead of maintaining divergent message-shape assumptions. Keep flat legacy `{"event": ...}` mapping as fallback in `acpx_cli` only for backward compatibility.

**Tech Stack:** Rust 2021, tokio async process I/O, serde/serde_json, thiserror, tracing, cargo test.

---

### Task 1: Add shared ACP protocol parser module

**Files:**
- Create: `crates/ensemble-core/src/agent/protocol.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/agent/protocol.rs` (unit tests in `#[cfg(test)]`)

- [ ] **Step 1: Write failing tests for nested ACP update extraction**

```rust
#[test]
fn parse_agent_message_chunk_from_nested_update() {
    let line = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "hello"}
            }
        }
    });

    let parsed = parse_session_update(&line).unwrap();
    assert_eq!(parsed.output_text.as_deref(), Some("hello"));
}

#[test]
fn parse_stop_reason_from_prompt_response_result() {
    let line = json!({
        "jsonrpc": "2.0",
        "id": 7,
        "result": {"stopReason": "end_turn"}
    });

    let stop = parse_stop_reason_from_result(&line).unwrap();
    assert_eq!(stop, StopReason::EndTurn);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk cargo test -p ensemble-core parse_agent_message_chunk_from_nested_update -- --exact`
Expected: FAIL with unresolved parser functions / module not found.

- [ ] **Step 3: Implement `protocol.rs` minimal parser API**

```rust
pub struct ParsedSessionUpdate {
    pub output_text: Option<String>,
    pub usage: Option<TokenUsage>,
    pub stop_reason: Option<StopReason>,
    pub permission_request: Option<PermissionRequest>,
}

pub fn parse_jsonrpc(line: &str) -> Option<JsonRpcMessage> { /* serde_json::from_str */ }
pub fn parse_session_update(value: &serde_json::Value) -> Option<ParsedSessionUpdate> { /* flat + nested */ }
pub fn parse_stop_reason_from_result(value: &serde_json::Value) -> Option<StopReason> { /* result.stopReason */ }
```

- [ ] **Step 4: Export parser module from `agent/mod.rs`**

```rust
pub mod protocol;
```

- [ ] **Step 5: Run parser tests to green**

Run: `rtk cargo test -p ensemble-core parse_agent_message_chunk_from_nested_update parse_stop_reason_from_prompt_response_result`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/protocol.rs crates/ensemble-core/src/agent/mod.rs
git commit -m "feat(agent): add shared ACP JSON-RPC protocol parser"
```

### Task 2: Refactor `acpx_cli` to use shared parser for JSON-RPC streams

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs`
- Test: `crates/ensemble-core/src/agent/acpx_cli.rs`

- [ ] **Step 1: Write failing test for ACPX JSON-RPC stream**

```rust
#[tokio::test]
async fn prompt_stream_maps_jsonrpc_updates_and_stop_reason() {
    // script emits session/update(agent_message_chunk) then id/result(stopReason=end_turn)
    // expect OutputChunk then RunCompleted
}
```

- [ ] **Step 2: Run test to verify it fails on current mapper**

Run: `rtk cargo test -p ensemble-core prompt_stream_maps_jsonrpc_updates_and_stop_reason -- --exact`
Expected: FAIL with `AcpxFinalStatusMissing` (no flat terminal event seen).

- [ ] **Step 3: Replace `map_event`-only path with shared parser-first logic**

```rust
while let Some(line) = reader.next_line().await? {
    if let Some(msg) = protocol::parse_jsonrpc(&line) {
        handle_jsonrpc_message(&msg, &mut saw_terminal_event, &mut on_event).await;
        continue;
    }

    // fallback compatibility for legacy flat {"event": ...}
    match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(value) => { /* old map_event path */ }
        Err(_) => on_event(AgentEvent::Malformed { line }).await,
    }
}
```

- [ ] **Step 4: Add stop-reason mapping from JSON-RPC response result**

```rust
match stop_reason {
    StopReason::EndTurn | StopReason::MaxTokens => AgentEvent::RunCompleted { usage: None },
    StopReason::Cancelled => AgentEvent::Cancelled { reason: Some("stop reason: cancelled".into()) },
    other => AgentEvent::RunFailed { reason: format!("stop reason: {}", other.as_str()), usage: None },
}
```

- [ ] **Step 5: Keep legacy flat-event compatibility tests green**

Run: `rtk cargo test -p ensemble-core prompt_stream_maps_output_and_completion_events prompt_stream_maps_jsonrpc_updates_and_stop_reason`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/acpx_cli.rs
git commit -m "fix(acpx): parse JSON-RPC prompt streams via shared protocol parser"
```

### Task 3: Refactor `acp_client` to consume shared parser

**Files:**
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Test: `crates/ensemble-core/src/agent/acp_client.rs`

- [ ] **Step 1: Write failing regression test for nested `params.update` content**

```rust
#[tokio::test]
async fn run_turn_handles_nested_session_update_content() {
    // fake ACP output with params.update.sessionUpdate=agent_message_chunk
    // expect OutputChunk event and successful turn completion
}
```

- [ ] **Step 2: Run test to verify it fails pre-refactor**

Run: `rtk cargo test -p ensemble-core run_turn_handles_nested_session_update_content -- --exact`
Expected: FAIL because current `stream_turn` only checks `params.content` / `params.stopReason` flat fields.

- [ ] **Step 3: Swap ad-hoc field lookups for shared parser output**

```rust
if let Some(parsed) = protocol::parse_session_update(params) {
    if let Some(usage) = parsed.usage { last_usage = Some(usage); }
    if let Some(text) = parsed.output_text { emit OutputChunk(text); }
    if let Some(stop) = parsed.stop_reason { return map_stop_reason(stop, last_usage.clone()); }
}
```

- [ ] **Step 4: Preserve permission request flow and unknown-message behavior**

```rust
// keep existing request/response handling for session/request_permission
// keep AgentEvent::OtherMessage fallback for unsupported notifications
```

- [ ] **Step 5: Run targeted ACP client tests**

Run: `rtk cargo test -p ensemble-core run_turn_handles_nested_session_update_content`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/acp_client.rs
git commit -m "refactor(agent): share ACP message parsing in direct runtime"
```

### Task 4: End-to-end runtime regression tests and verification

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs` (tests only if needed)
- Modify: `crates/ensemble-core/src/agent/mod.rs` (tests only if needed)
- Optional docs update: `docs/pipelines.md` (if runtime event wording changed)

- [ ] **Step 1: Add/adjust runtime integration test fixtures to JSON-RPC shape**

```rust
// Replace flat {"event":"..."} fixture in at least one runtime integration test
// with session/update + result.stopReason payloads.
```

- [ ] **Step 2: Run focused integration tests**

Run:
- `rtk cargo test -p ensemble-core acpx_runtime_emits_runtime_events_and_success -- --exact`
- `rtk cargo test -p ensemble-core acpx_agent_runner_emits_runtime_events_and_success -- --exact`

Expected: PASS

- [ ] **Step 3: Run crate-level validation**

Run:
- `rtk cargo test -p ensemble-core`
- `rtk cargo clippy -p ensemble-core -- -D warnings`
- `rtk cargo fmt --all -- --check`

Expected: all PASS with no warnings.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/agent/acpx_runtime.rs crates/ensemble-core/src/agent/mod.rs docs/pipelines.md
git commit -m "test(agent): add JSON-RPC regressions for acpx/direct runtimes"
```

## Self-Review Checklist

- Spec coverage: includes shared parsing module, acpx runtime path, direct ACP path, and regression verification.
- Placeholder scan: no TBD/TODO placeholders in actionable steps; each task contains file paths and commands.
- Type consistency: shared parser outputs (`ParsedSessionUpdate`, `StopReason`, `TokenUsage`) are reused across both runtimes.


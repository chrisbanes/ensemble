# Runtime-First Verdict + Automatic Fallback Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make runtime verdicts the true primary source again, keep file fallback + default approve behavior, and remove user prompt boilerplate by auto-injecting fallback verdict instructions.

**Architecture:** Extend worker/runtime plumbing to carry an optional runtime verdict payload into orchestrator verdict resolution. Keep `resolve_verdict()` priority unchanged (runtime -> file -> default approve), but add explicit verdict-source observability. Inject Ensemble-owned fallback instructions at prompt assembly with a default-on config escape hatch.

**Tech Stack:** Rust 2021, tokio, serde/serde_json/serde_yaml, tracing, thiserror, tempfile

---

## File Structure

### Modified Files

| File | Responsibility |
|---|---|
| `crates/ensemble-core/src/agent/events.rs` | Extend worker result payload to carry optional runtime verdict JSON |
| `crates/ensemble-core/src/agent/protocol.rs` | Parse optional verdict payload from `session/update` messages |
| `crates/ensemble-core/src/agent/acp_client.rs` | Track last runtime verdict seen during turn streaming |
| `crates/ensemble-core/src/agent/acpx_cli.rs` | Track runtime verdict from ACPX JSON stream and return it |
| `crates/ensemble-core/src/agent/acpx_runtime.rs` | Forward runtime verdict into `WorkerResult::Success` |
| `crates/ensemble-core/src/agent/mod.rs` | Central prompt assembly injection + direct-runtime verdict propagation |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Pass runtime verdict into `resolve_verdict` and log verdict source/value |
| `crates/ensemble-core/src/pipeline/verdict.rs` | Add source-aware resolve helper (or equivalent) and tests |
| `crates/ensemble-core/src/config/ensemble.rs` | Add `agent.inject_verdict_fallback_instructions` config field + default |
| `docs/configuration.md` | Document new runtime-level config flag |
| `docs/pipelines.md` | Clarify runtime-first verdict behavior and automatic fallback injection |

---

### Task 1: Add source-carrying verdict model (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/pipeline/verdict.rs`
- Test: `crates/ensemble-core/src/pipeline/verdict.rs` (existing test module)

- [ ] **Step 1: Add worker success payload type**

Update `WorkerResult` to carry optional runtime verdict JSON:

```rust
#[derive(Debug, Clone)]
pub enum WorkerResult {
    Success {
        runtime_verdict: Option<serde_json::Value>,
    },
    BlockedOnHuman { request: InteractionRequestDraft },
    Failed { error: String },
}
```

Keep helper working:

```rust
pub fn is_success(&self) -> bool {
    matches!(self, WorkerResult::Success { .. })
}
```

- [ ] **Step 2: Add source-aware resolve API in verdict module**

Introduce:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictSource {
    Runtime,
    File,
    Default,
}

pub struct ResolvedVerdict {
    pub verdict: Verdict,
    pub source: VerdictSource,
}

pub async fn resolve_verdict_with_source(
    runtime_verdict: Option<&serde_json::Value>,
    workspace: &Path,
) -> ResolvedVerdict { /* runtime -> file -> default */ }
```

Keep existing `resolve_verdict(...) -> Verdict` as a thin wrapper for compatibility:

```rust
pub async fn resolve_verdict(runtime_verdict: Option<&serde_json::Value>, workspace: &Path) -> Verdict {
    resolve_verdict_with_source(runtime_verdict, workspace).await.verdict
}
```

- [ ] **Step 3: Write failing tests for source behavior**

Add tests:

```rust
#[tokio::test]
async fn test_resolve_with_source_runtime_beats_file() { /* expect source Runtime */ }

#[tokio::test]
async fn test_resolve_with_source_file_when_runtime_missing() { /* expect source File */ }

#[tokio::test]
async fn test_resolve_with_source_default_when_none() { /* expect source Default */ }
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cargo test --workspace -p ensemble-core pipeline::verdict
```

Expected: all verdict tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/agent/events.rs crates/ensemble-core/src/pipeline/verdict.rs
git commit -m "feat: add runtime verdict payload and source-aware verdict resolution"
```

---

### Task 2: Plumb runtime verdict from ACP/ACPX workers (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/agent/protocol.rs`
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs`
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/agent/protocol.rs`
- Test: `crates/ensemble-core/src/agent/acpx_cli.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Extend parsed session update with verdict**

In `protocol.rs`:

```rust
pub struct ParsedSessionUpdate {
    pub output_text: Option<String>,
    pub usage: Option<TokenUsage>,
    pub stop_reason: Option<StopReason>,
    pub permission_request: Option<PermissionRequest>,
    pub verdict: Option<serde_json::Value>,
}
```

Add extraction helper that accepts either `params.verdict` or `params.update.verdict`.

- [ ] **Step 2: Add protocol tests for verdict extraction**

Add tests:

```rust
#[test]
fn parse_session_update_extracts_verdict_from_params() { /* verdict approve */ }

#[test]
fn parse_session_update_extracts_verdict_from_nested_update() { /* verdict reject */ }
```

- [ ] **Step 3: Capture last runtime verdict in ACP direct path**

In `AcpSession::stream_turn`, track `last_verdict: Option<serde_json::Value>` from parsed updates and return it in `TurnResult::Completed` / `Failed`:

```rust
pub enum TurnResult {
    Completed { usage: Option<TokenUsage>, runtime_verdict: Option<serde_json::Value> },
    Failed { reason: String, usage: Option<TokenUsage>, runtime_verdict: Option<serde_json::Value> },
}
```

- [ ] **Step 4: Capture last runtime verdict in ACPX path**

In `acpx_cli.rs`, track the same `last_verdict` and return a run outcome struct (or equivalent) consumed by `acpx_runtime.rs`.

Example shape:

```rust
pub struct PromptOutcome {
    pub runtime_verdict: Option<serde_json::Value>,
}
```

- [ ] **Step 5: Forward runtime verdict into worker exit result**

In `agent/mod.rs` + `acpx_runtime.rs`, return:

```rust
WorkerResult::Success { runtime_verdict }
```

For file-only/legacy paths, use `runtime_verdict: None`.

- [ ] **Step 6: Update/extend worker-result tests**

In `agent/mod.rs` tests, assert success variant includes `runtime_verdict: None` in non-runtime-verdict scenarios.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
cargo test --workspace -p ensemble-core agent::protocol
cargo test --workspace -p ensemble-core agent::acpx_cli
cargo test --workspace -p ensemble-core agent::tests
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-core/src/agent/protocol.rs crates/ensemble-core/src/agent/acp_client.rs crates/ensemble-core/src/agent/acpx_cli.rs crates/ensemble-core/src/agent/acpx_runtime.rs crates/ensemble-core/src/agent/mod.rs
git commit -m "feat: propagate runtime verdict payloads through agent runtimes"
```

---

### Task 3: Wire orchestrator to runtime-first resolution + observability (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs` (existing tests)

- [ ] **Step 1: Use source-aware resolver in worker success handler**

Update success match arm:

```rust
match result {
    WorkerResult::Success { runtime_verdict } => {
        let resolved = match workspace_path {
            Some(wp) => resolve_verdict_with_source(runtime_verdict.as_ref(), &wp).await,
            None => ResolvedVerdict { verdict: Verdict::Approve, source: VerdictSource::Default },
        };
        // pass resolved.verdict to pipeline engine
    }
    // ...
}
```

- [ ] **Step 2: Add verdict source/value logging**

Emit structured fields before pipeline transition:

```rust
info!(
    issue_id = %issue_id,
    step = step_name,
    verdict_source = ?resolved.source,
    verdict_value = %match &resolved.verdict { Verdict::Approve => "approve", Verdict::Reject { .. } => "reject" },
    "resolved step verdict"
);
```

Also emit warn when source is `Default` and step completed successfully.

- [ ] **Step 3: Add orchestrator tests**

Add tests for:
- Runtime verdict passed in `WorkerResult::Success` wins over file.
- Missing runtime verdict falls back to file.
- Missing both remains approve with default source path.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cargo test --workspace -p ensemble-core orchestrator::tests
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "feat: use runtime-first verdict resolution in orchestrator"
```

---

### Task 4: Add automatic fallback verdict-instruction injection (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Add config flag with default true**

In `AgentRuntimeConfig`:

```rust
#[serde(default = "default_inject_verdict_fallback_instructions")]
pub inject_verdict_fallback_instructions: bool,

fn default_inject_verdict_fallback_instructions() -> bool {
    true
}
```

Update `Default` impl and config parsing tests.

- [ ] **Step 2: Add shared prompt injection helper in agent module**

Create helper:

```rust
fn maybe_append_verdict_fallback_instruction(
    prompt: String,
    enabled: bool,
) -> String { /* append once, idempotent */ }
```

Append after `render_prompt_with_interaction_response(...)` in `build_prompt` first-turn path.

Suggested injected block (exact constant):

```text
If you cannot return a structured runtime verdict, write .ensemble/verdict.json with:
{"verdict":"approve"}
or
{"verdict":"reject","summary":"<reason>"}
```

- [ ] **Step 3: Add unit tests for injection behavior**

Add tests in `agent/mod.rs`:

```rust
#[test]
fn injects_verdict_block_when_enabled() { /* contains block */ }

#[test]
fn does_not_inject_when_disabled() { /* unchanged */ }

#[test]
fn does_not_duplicate_when_prompt_already_contains_block() { /* single instance */ }
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cargo test --workspace -p ensemble-core config::ensemble
cargo test --workspace -p ensemble-core agent::tests
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/agent/mod.rs
git commit -m "feat: auto-inject fallback verdict instructions into prompts"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/pipelines.md`

- [ ] **Step 1: Document new runtime config flag**

In `docs/configuration.md` under `agent.*` runtime fields, add:

```md
| `inject_verdict_fallback_instructions` | boolean | `true` | Appends Ensemble-owned fallback instructions so agents can write `.ensemble/verdict.json` when no structured runtime verdict is emitted. |
```

- [ ] **Step 2: Update verdict docs**

In `docs/pipelines.md` verdict section, clarify:
- Runtime verdict is primary source.
- `.ensemble/verdict.json` is fallback.
- Ensemble auto-injects fallback instruction by default.
- No source still defaults to approve.

- [ ] **Step 3: Run workspace verification**

Run:

```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
```

Expected: all pass.

- [ ] **Step 4: Commit docs + final polish**

```bash
git add docs/configuration.md docs/pipelines.md
git commit -m "docs: clarify runtime-first verdicts and fallback injection"
```

---

## Self-Review Checklist

- Spec coverage:
  - Runtime-first verdict restoration: covered by Tasks 1-3.
  - Fallback instruction auto-injection: covered by Task 4.
  - Source observability: covered by Task 3.
  - Backward-compatible defaults/docs: covered by Tasks 1 + 5.
- Placeholder scan: no unresolved placeholders remain.
- Type consistency:
  - `WorkerResult::Success { runtime_verdict }` is used consistently in agent runtimes and orchestrator.
  - Verdict source naming is consistent: `Runtime`, `File`, `Default`.


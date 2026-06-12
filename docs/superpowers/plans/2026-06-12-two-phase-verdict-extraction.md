# Two-phase Verdict Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every successful agent step produce one validated runtime `StepOutput` through a visible working turn followed by a hidden extraction turn.

**Architecture:** Add a strict result validator and shared extraction prompt module, then change the worker/orchestrator contract from optional raw verdicts to typed `StepOutput`. Direct ACP and `acpx` both keep the same session open for a hidden extraction prompt and one hidden repair prompt; hidden turns collect output and usage but do not emit timeline events.

**Tech Stack:** Rust 2021, Tokio, serde/serde_json, async-trait, existing ACP SDK, existing `acpx` CLI adapter, Markdown docs

---

## Scope Check

The approved spec covers one coherent runtime contract change. It touches validation, worker results, both runtime adapters, tests, and docs, but those pieces all serve the same behavior: mandatory strict two-phase step results.

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Modify | `crates/ensemble-core/src/pipeline/verdict.rs` | Add strict `StepOutput` validation and JSON parsing; later remove production fallback helpers. |
| Create | `crates/ensemble-core/src/agent/extraction.rs` | Build extraction and repair prompts; convert hidden-turn runtime payload/text into validated `StepOutput`. |
| Modify | `crates/ensemble-core/src/agent/mod.rs` | Export extraction module, remove verdict fallback prompt injection, change worker success wiring. |
| Modify | `crates/ensemble-core/src/agent/events.rs` | Change `WorkerResult::Success` to carry typed `StepOutput`. |
| Modify | `crates/ensemble-core/src/agent/acp_client.rs` | Add visible/hidden turn metadata, collect visible answer text, run extraction and repair hidden turns. |
| Modify | `crates/ensemble-core/src/agent/acpx_cli.rs` | Add prompt visibility, capture prompt output text, suppress hidden prompt events. |
| Modify | `crates/ensemble-core/src/agent/acpx_runtime.rs` | Keep `acpx` sessions open through visible prompt, extraction prompt, optional repair, and close. |
| Modify | `crates/ensemble-core/src/orchestrator/mod.rs` | Consume typed `StepOutput` directly instead of resolving optional runtime/file/default verdicts. |
| Modify | `crates/ensemble-core/src/config/ensemble.rs` | Remove verdict fallback injection config from typed runtime config. |
| Modify | `docs/SPEC.md`, `docs/configuration.md`, `docs/pipelines.md` | Document mandatory two-phase runtime results and remove fallback/default result behavior. |

## Task 1: Add Strict StepOutput Validation

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/verdict.rs`

- [ ] **Step 1: Add failing strict validation tests**

Add these tests inside `#[cfg(test)] mod tests` in `crates/ensemble-core/src/pipeline/verdict.rs`:

```rust
#[test]
fn validate_step_output_accepts_succeeded() {
    let output = validate_step_output_value(&json!({
        "result": "succeeded",
        "summary": "finished",
        "output": {"branch": "issue-184"}
    }))
    .unwrap();

    assert_eq!(output.result, StepResult::Succeeded);
    assert_eq!(output.summary.as_deref(), Some("finished"));
    assert_eq!(output.output, Some(json!({"branch": "issue-184"})));
}

#[test]
fn validate_step_output_requires_summary_for_failed() {
    let err = validate_step_output_value(&json!({"result": "failed"})).unwrap_err();

    assert!(
        err.to_string().contains("failed results require a non-empty summary"),
        "{err}"
    );
}

#[test]
fn validate_step_output_requires_summary_for_concern() {
    let err = validate_step_output_value(&json!({
        "result": "concern",
        "summary": "   "
    }))
    .unwrap_err();

    assert!(
        err.to_string().contains("concern results require a non-empty summary"),
        "{err}"
    );
}

#[test]
fn validate_step_output_rejects_legacy_verdict_key() {
    let err = validate_step_output_value(&json!({
        "verdict": "approve",
        "summary": "legacy"
    }))
    .unwrap_err();

    assert!(
        err.to_string().contains("unknown field `verdict`"),
        "{err}"
    );
}

#[test]
fn validate_step_output_rejects_unknown_keys() {
    let err = validate_step_output_value(&json!({
        "result": "succeeded",
        "extra": true
    }))
    .unwrap_err();

    assert!(err.to_string().contains("unknown field `extra`"), "{err}");
}

#[test]
fn parse_step_output_json_rejects_non_json_text() {
    let err = parse_step_output_json("approved, looks good").unwrap_err();

    assert!(err.to_string().contains("invalid JSON step output"), "{err}");
}
```

- [ ] **Step 2: Run strict validation tests and verify they fail**

Run:

```bash
rtk cargo test -p ensemble-core pipeline::verdict::tests::validate_step_output -- --nocapture
rtk cargo test -p ensemble-core pipeline::verdict::tests::parse_step_output_json_rejects_non_json_text -- --exact
```

Expected: FAIL because `validate_step_output_value` and `parse_step_output_json` do not exist.

- [ ] **Step 3: Add strict validation types and functions**

In `crates/ensemble-core/src/pipeline/verdict.rs`, add `Display` import:

```rust
use std::fmt;
```

Add these types and functions after `VerdictPayload`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOutputValidationError {
    message: String,
}

impl StepOutputValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for StepOutputValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StepOutputValidationError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictStepOutputPayload {
    result: StrictStepResult,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    output: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StrictStepResult {
    Succeeded,
    Failed,
    Concern,
}

pub fn parse_step_output_json(text: &str) -> Result<StepOutput, StepOutputValidationError> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| {
        StepOutputValidationError::new(format!("invalid JSON step output: {error}"))
    })?;
    validate_step_output_value(&value)
}

pub fn validate_step_output_value(
    value: &serde_json::Value,
) -> Result<StepOutput, StepOutputValidationError> {
    let payload: StrictStepOutputPayload = serde_json::from_value(value.clone()).map_err(|error| {
        StepOutputValidationError::new(format!("invalid StepOutput payload: {error}"))
    })?;

    let summary = payload.summary.map(|value| value.trim().to_string());
    let result = match payload.result {
        StrictStepResult::Succeeded => StepResult::Succeeded,
        StrictStepResult::Failed => {
            let Some(summary) = summary.as_ref().filter(|value| !value.is_empty()) else {
                return Err(StepOutputValidationError::new(
                    "failed results require a non-empty summary",
                ));
            };
            StepResult::Failed {
                summary: summary.clone(),
            }
        }
        StrictStepResult::Concern => {
            let Some(summary) = summary.as_ref().filter(|value| !value.is_empty()) else {
                return Err(StepOutputValidationError::new(
                    "concern results require a non-empty summary",
                ));
            };
            StepResult::Concern {
                summary: summary.clone(),
            }
        }
    };

    Ok(StepOutput {
        result,
        summary,
        output: payload.output,
    })
}
```

- [ ] **Step 4: Run strict validation tests and verify they pass**

Run:

```bash
rtk cargo test -p ensemble-core pipeline::verdict::tests::validate_step_output -- --nocapture
rtk cargo test -p ensemble-core pipeline::verdict::tests::parse_step_output_json_rejects_non_json_text -- --exact
```

Expected: PASS.

- [ ] **Step 5: Commit strict validator**

Run:

```bash
rtk git add crates/ensemble-core/src/pipeline/verdict.rs
rtk git commit -m "Add strict step output validation"
```

## Task 2: Add Shared Extraction Prompt Module

**Files:**
- Create: `crates/ensemble-core/src/agent/extraction.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Create failing extraction module tests**

Create `crates/ensemble-core/src/agent/extraction.rs` with these tests and stub signatures:

```rust
use crate::error::AgentError;
use crate::pipeline::verdict::{parse_step_output_json, validate_step_output_value, StepOutput};

pub(crate) fn build_extraction_prompt(
    _step_name: &str,
    _issue_identifier: &str,
    _original_prompt: &str,
    _working_answer: &str,
) -> String {
    String::new()
}

pub(crate) fn build_repair_prompt(_validation_error: &str, _previous_payload: &str) -> String {
    String::new()
}

pub(crate) fn validate_extraction_payload(
    _runtime_payload: Option<&serde_json::Value>,
    _output_text: &str,
) -> Result<StepOutput, AgentError> {
    Err(AgentError::ResponseError {
        reason: "stubbed for failing extraction test".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::verdict::StepResult;
    use serde_json::json;

    #[test]
    fn extraction_prompt_contains_context_and_schema() {
        let prompt = build_extraction_prompt(
            "review",
            "repo#184",
            "Review this change",
            "The implementation is sound.",
        );

        assert!(prompt.contains("Step: review"));
        assert!(prompt.contains("Issue: repo#184"));
        assert!(prompt.contains("Review this change"));
        assert!(prompt.contains("The implementation is sound."));
        assert!(prompt.contains("\"result\": \"succeeded | failed | concern\""));
        assert!(prompt.contains("Return only a JSON object"));
    }

    #[test]
    fn repair_prompt_contains_error_and_previous_payload() {
        let prompt = build_repair_prompt(
            "failed results require a non-empty summary",
            "{\"result\":\"failed\"}",
        );

        assert!(prompt.contains("failed results require a non-empty summary"));
        assert!(prompt.contains("{\"result\":\"failed\"}"));
        assert!(prompt.contains("Return only the corrected JSON object"));
    }

    #[test]
    fn validate_extraction_payload_prefers_runtime_payload() {
        let output = validate_extraction_payload(
            Some(&json!({"result":"failed","summary":"tests failed"})),
            "{\"result\":\"succeeded\"}",
        )
        .unwrap();

        assert_eq!(
            output.result,
            StepResult::Failed {
                summary: "tests failed".to_string()
            }
        );
    }

    #[test]
    fn validate_extraction_payload_parses_hidden_text_without_runtime_payload() {
        let output = validate_extraction_payload(None, "{\"result\":\"succeeded\"}").unwrap();

        assert_eq!(output.result, StepResult::Succeeded);
    }

    #[test]
    fn validate_extraction_payload_reports_validation_error() {
        let err = validate_extraction_payload(None, "{\"result\":\"failed\"}").unwrap_err();

        assert!(
            err.to_string().contains("failed results require a non-empty summary"),
            "{err}"
        );
    }
}
```

In `crates/ensemble-core/src/agent/mod.rs`, add:

```rust
pub mod extraction;
```

- [ ] **Step 2: Run extraction tests and verify they fail**

Run:

```bash
rtk cargo test -p ensemble-core agent::extraction::tests -- --nocapture
```

Expected: FAIL because the extraction functions return stubs.

- [ ] **Step 3: Implement extraction prompts and payload validation**

Replace the stub bodies in `crates/ensemble-core/src/agent/extraction.rs` with:

```rust
pub(crate) fn build_extraction_prompt(
    step_name: &str,
    issue_identifier: &str,
    original_prompt: &str,
    working_answer: &str,
) -> String {
    format!(
        "Extract the Ensemble step result from the completed working turn.\n\n\
         Step: {step_name}\n\
         Issue: {issue_identifier}\n\n\
         Original step prompt:\n\
         ---\n\
         {original_prompt}\n\
         ---\n\n\
         Visible working answer:\n\
         ---\n\
         {working_answer}\n\
         ---\n\n\
         Required JSON schema, expressed by example:\n\
         {{\n\
           \"result\": \"succeeded | failed | concern\",\n\
           \"summary\": \"required for failed or concern; optional for succeeded\",\n\
           \"output\": {{}}\n\
         }}\n\n\
         Rules:\n\
         - Return only a JSON object.\n\
         - Use result=succeeded only when the working answer completed the step.\n\
         - Use result=failed for blocking failures and include a non-empty summary.\n\
         - Use result=concern for non-blocking concerns and include a non-empty summary.\n\
         - Omit output when there is no structured downstream data.\n\
         - Do not include any keys other than result, summary, and output."
    )
}

pub(crate) fn build_repair_prompt(validation_error: &str, previous_payload: &str) -> String {
    format!(
        "The previous Ensemble step result was invalid.\n\n\
         Validation error:\n\
         {validation_error}\n\n\
         Previous payload:\n\
         {previous_payload}\n\n\
         Return only the corrected JSON object using exactly these keys: result, summary, output. \
         The result value must be one of succeeded, failed, or concern. Failed and concern require a non-empty summary."
    )
}

pub(crate) fn validate_extraction_payload(
    runtime_payload: Option<&serde_json::Value>,
    output_text: &str,
) -> Result<StepOutput, AgentError> {
    if let Some(value) = runtime_payload {
        return validate_step_output_value(value).map_err(|error| AgentError::ResponseError {
            reason: error.to_string(),
        });
    }

    parse_step_output_json(output_text.trim()).map_err(|error| AgentError::ResponseError {
        reason: error.to_string(),
    })
}
```

- [ ] **Step 4: Run extraction tests and verify they pass**

Run:

```bash
rtk cargo test -p ensemble-core agent::extraction::tests -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit extraction prompt module**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/mod.rs crates/ensemble-core/src/agent/extraction.rs
rtk git commit -m "Add verdict extraction prompts"
```

## Task 3: Change Worker Success to Typed StepOutput

**Files:**
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: affected tests in the same files

- [ ] **Step 1: Change `WorkerResult::Success` shape**

In `crates/ensemble-core/src/agent/events.rs`, add:

```rust
use crate::pipeline::verdict::StepOutput;
```

Change the enum variant to:

```rust
Success {
    output: StepOutput,
    approval_request: Option<StepApprovalRequestDraft>,
},
```

- [ ] **Step 2: Add a temporary helper for current runtime paths**

In `crates/ensemble-core/src/agent/mod.rs`, replace `detect_worker_result_with_runtime_verdict` with:

```rust
async fn detect_worker_result_with_output(
    workspace_path: &Path,
    output: crate::pipeline::verdict::StepOutput,
    step_name: &str,
) -> WorkerResult {
    let interaction_path = workspace_path
        .join(".ensemble")
        .join("interaction-request.json");
    let approval_path = workspace_path
        .join(".ensemble")
        .join("approval-request.json");

    let interaction_request = match tokio::fs::read_to_string(&interaction_path).await {
        Ok(contents) => match serde_json::from_str::<InteractionRequestDraft>(&contents) {
            Ok(request) => Some(request),
            Err(error) => {
                return WorkerResult::Failed {
                    error: format!("failed to parse .ensemble/interaction-request.json: {error}"),
                }
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return WorkerResult::Failed {
                error: format!("failed to read .ensemble/interaction-request.json: {error}"),
            }
        }
    };

    let approval_request = match tokio::fs::read_to_string(&approval_path).await {
        Ok(contents) => match serde_json::from_str::<StepApprovalRequestDraft>(&contents) {
            Ok(request) => Some(request),
            Err(error) => {
                return WorkerResult::Failed {
                    error: format!("failed to parse .ensemble/approval-request.json: {error}"),
                }
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return WorkerResult::Failed {
                error: format!("failed to read .ensemble/approval-request.json: {error}"),
            }
        }
    };

    let step_verdict_path = workspace_path
        .join(".ensemble")
        .join(format!("verdict-{step_name}.json"));
    let legacy_verdict_path = workspace_path.join(".ensemble").join("verdict.json");
    let verdict_exists = tokio::fs::try_exists(&step_verdict_path)
        .await
        .unwrap_or(false)
        || tokio::fs::try_exists(&legacy_verdict_path)
            .await
            .unwrap_or(false);

    match interaction_request {
        Some(_) if approval_request.is_some() => WorkerResult::Failed {
            error: "agent produced both .ensemble/interaction-request.json and .ensemble/approval-request.json"
                .to_string(),
        },
        Some(_) if verdict_exists => WorkerResult::Failed {
            error:
                "agent produced both .ensemble/interaction-request.json and .ensemble/verdict.json"
                    .to_string(),
        },
        Some(request) => WorkerResult::BlockedOnHuman { request },
        None => WorkerResult::Success {
            output,
            approval_request,
        },
    }
}
```

Add this helper in the same file for temporary compile support:

```rust
fn transitional_succeeded_output() -> crate::pipeline::verdict::StepOutput {
    crate::pipeline::verdict::StepOutput {
        result: crate::pipeline::verdict::StepResult::Succeeded,
        summary: None,
        output: None,
    }
}
```

Update the test-only helper to:

```rust
#[cfg(test)]
async fn detect_worker_result(workspace_path: &Path, step_name: &str) -> WorkerResult {
    detect_worker_result_with_output(workspace_path, transitional_succeeded_output(), step_name)
        .await
}
```

- [ ] **Step 3: Update runtime call sites to compile**

In `crates/ensemble-core/src/agent/mod.rs`, change the final direct runtime success construction from:

```rust
Ok(detect_worker_result_with_runtime_verdict(
    request.workspace_path,
    final_verdict,
    request.step_name,
)
.await)
```

to:

```rust
let output = final_verdict
    .as_ref()
    .and_then(crate::pipeline::verdict::parse_step_output_from_value)
    .unwrap_or_else(transitional_succeeded_output);

Ok(detect_worker_result_with_output(request.workspace_path, output, request.step_name).await)
```

In `crates/ensemble-core/src/agent/acpx_runtime.rs`, change the import:

```rust
use super::{detect_worker_result_with_output, AgentRunRequest};
```

Change the success path to:

```rust
let output = outcome
    .runtime_verdict
    .as_ref()
    .and_then(crate::pipeline::verdict::parse_step_output_from_value)
    .unwrap_or_else(super::transitional_succeeded_output);

Ok(detect_worker_result_with_output(request.workspace_path, output, request.step_name).await)
```

- [ ] **Step 4: Update orchestrator success handling**

In `crates/ensemble-core/src/orchestrator/mod.rs`, remove these imports:

```rust
use crate::pipeline::verdict::{resolve_verdict_with_source, StepResult, VerdictSource};
```

Replace them with:

```rust
use crate::pipeline::verdict::StepResult;
```

In `handle_worker_exit`, replace:

```rust
WorkerResult::Success {
    runtime_verdict,
    approval_request,
} => {
```

with:

```rust
WorkerResult::Success {
    output,
    approval_request,
} => {
```

Replace the verdict resolution block with:

```rust
let resolved_output = output;
let verdict_value = match &resolved_output.result {
    StepResult::Succeeded => "succeeded",
    StepResult::Failed { .. } => "failed",
    StepResult::Concern { .. } => "concern",
};
info!(
    issue_id = %issue_id,
    step = step_name,
    verdict_value,
    "received validated step result"
);
```

Replace later uses of `resolved.result` and `resolved.output` in this match arm with:

```rust
resolved_output.result
resolved_output
```

Before calling the existing `run.step_completed` method, add:

```rust
let result = resolved_output.result.clone();
```

Use `result` for logging and failure-summary decisions that occur after `resolved_output` is moved
into `run.step_completed`.

- [ ] **Step 5: Update tests and mocks**

Search for `runtime_verdict:` in `crates/ensemble-core/src` and replace each affected
`WorkerResult::Success` test fixture with:

```rust
WorkerResult::Success {
    output: crate::pipeline::verdict::StepOutput {
        result: crate::pipeline::verdict::StepResult::Succeeded,
        summary: None,
        output: None,
    },
    approval_request: None,
}
```

For tests that previously used a rejecting runtime verdict, use:

```rust
WorkerResult::Success {
    output: crate::pipeline::verdict::StepOutput {
        result: crate::pipeline::verdict::StepResult::Failed {
            summary: "tests failed".to_string(),
        },
        summary: Some("tests failed".to_string()),
        output: None,
    },
    approval_request: None,
}
```

For tests that previously used runtime output JSON, preserve it under:

```rust
output: Some(serde_json::json!({"risk": "high"})),
```

- [ ] **Step 6: Run compile-focused tests**

Run:

```bash
rtk cargo test -p ensemble-core agent::events::tests
rtk cargo test -p ensemble-core orchestrator::tests::test_worker_exit_runtime_verdict_overrides_file_verdict -- --exact
```

Expected: the old runtime-verdict override test will fail or need renaming because runtime/file precedence is no longer the contract. Replace that test with a typed-output test:

```rust
#[tokio::test]
async fn test_worker_exit_uses_typed_step_output() {
    let config = Arc::new(RwLock::new(make_config()));
    let issues = Arc::new(RwLock::new(vec![]));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker { issues });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
        cancellation_probe: None,
    });
    let dir = tempfile::TempDir::new().unwrap();
    let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
    let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);

    let orchestrator = Orchestrator::new(
        config.clone(),
        tracker,
        runner,
        workspace_mgr,
        dir.path(),
        shutdown_rx,
    );

    {
        let cfg = config.read().await;
        let mut state = orchestrator.state.write().await;
        state.add_running(&test_issue("1", "Todo"), None);
        let dag = build_dag(&cfg.steps).unwrap();
        let mut pipeline_run = PipelineRun::new("1".to_string(), 1, dag);
        pipeline_run.start();
        pipeline_run.mark_running("build", "session-1".to_string());
        state.insert_pipeline_run("1", pipeline_run, Arc::new(cfg.clone()));
    }

    orchestrator
        .handle_worker_exit(
            "1",
            "build",
            WorkerResult::Success {
                output: crate::pipeline::verdict::StepOutput {
                    result: crate::pipeline::verdict::StepResult::Failed {
                        summary: "tests failed".to_string(),
                    },
                    summary: Some("tests failed".to_string()),
                    output: None,
                },
                approval_request: None,
            },
        )
        .await;

    let state = orchestrator.state.read().await;
    let run = state.get_pipeline_run("1").unwrap();
    assert!(matches!(
        run.step_states.get("build"),
        Some(crate::pipeline::engine::StepState::Failed { summary })
            if summary == "tests failed"
    ));
}
```

Then run:

```bash
rtk cargo test -p ensemble-core orchestrator::tests -- --nocapture
```

Expected: PASS after updating all success variants.

- [ ] **Step 7: Commit worker contract change**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/events.rs crates/ensemble-core/src/agent/mod.rs crates/ensemble-core/src/agent/acpx_runtime.rs crates/ensemble-core/src/orchestrator/mod.rs
rtk git commit -m "Use typed step output for worker success"
```

## Task 4: Implement Two-phase Direct ACP Sessions

**Files:**
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Add direct ACP session turn types**

In `crates/ensemble-core/src/agent/acp_client.rs`, add near `AcpSessionConfig`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnVisibility {
    Visible,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnPurpose {
    Working,
    Extraction,
    Repair,
}

#[derive(Debug, Clone)]
pub struct SessionTurn {
    pub prompt: String,
    pub visibility: TurnVisibility,
    pub purpose: TurnPurpose,
}

#[derive(Debug, Clone)]
pub struct AcpSessionOutcome {
    pub output: crate::pipeline::verdict::StepOutput,
    pub turn_results: Vec<TurnResult>,
    pub capabilities: DiscoveredCapabilities,
}
```

Extend `TurnResult::Completed` and `TurnResult::Failed` to include captured output text:

```rust
Completed {
    usage: Option<TokenUsage>,
    runtime_verdict: Option<serde_json::Value>,
    output_text: String,
},
Failed {
    reason: String,
    usage: Option<TokenUsage>,
    runtime_verdict: Option<serde_json::Value>,
    output_text: String,
},
```

- [ ] **Step 2: Update `run_acp_session` signature**

Change:

```rust
pub async fn run_acp_session(
    config: AcpSessionConfig,
    prompts: Vec<String>,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<
    (
        Option<serde_json::Value>,
        Vec<TurnResult>,
        DiscoveredCapabilities,
    ),
    AgentError,
>
```

to:

```rust
pub async fn run_acp_session(
    config: AcpSessionConfig,
    turns: Vec<SessionTurn>,
    issue_id: &str,
    step_name: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<AcpSessionOutcome, AgentError>
```

- [ ] **Step 3: Capture output text and suppress hidden events**

Inside the per-turn loop, replace `prompts.iter()` with `turns.iter()`.

Before the `turn_future`, add:

```rust
let mut output_text = String::new();
let visible = turn.visibility == TurnVisibility::Visible;
```

Change:

```rust
if let Some(content) = parsed.output_text {
    emit_event(
        event_tx,
        issue_id,
        step_name,
        AgentEvent::OutputChunk {
            stream: RuntimeStream::Stdout,
            content,
        },
    )
    .await;
}
```

to:

```rust
if let Some(content) = parsed.output_text {
    output_text.push_str(&content);
    if visible {
        emit_event(
            event_tx,
            issue_id,
            step_name,
            AgentEvent::OutputChunk {
                stream: RuntimeStream::Stdout,
                content,
            },
        )
        .await;
    }
}
```

Wrap `PromptStarted`, `RunCompleted`, and `RunFailed` emissions with this shape:

```rust
if visible {
    emit_event(event_tx, issue_id, step_name, AgentEvent::PromptStarted).await;
}
```

Apply the same `if visible` guard to the existing `AgentEvent::RunCompleted` and
`AgentEvent::RunFailed` emissions.

- [ ] **Step 4: Validate extraction and repair results**

After each completed hidden extraction or repair turn, validate the payload:

```rust
if matches!(turn.purpose, TurnPurpose::Extraction | TurnPurpose::Repair) {
    match crate::agent::extraction::validate_extraction_payload(
        runtime_verdict.as_ref(),
        &output_text,
    ) {
        Ok(output) => {
            let mut v = final_output_inner.lock().await;
            *v = Some(output);
        }
        Err(error) if turn.purpose == TurnPurpose::Extraction => {
            let repair_prompt = crate::agent::extraction::build_repair_prompt(
                &error.to_string(),
                runtime_verdict
                    .as_ref()
                    .map(serde_json::Value::to_string)
                    .unwrap_or_else(|| output_text.clone())
                    .as_str(),
            );
            queued_repair_turn = Some(SessionTurn {
                prompt: repair_prompt,
                visibility: TurnVisibility::Hidden,
                purpose: TurnPurpose::Repair,
            });
        }
        Err(error) => {
            let mut err = session_error_inner.lock().await;
            *err = Some(format!("verdict extraction failed: {error}"));
            return Ok(());
        }
    }
}
```

Implement this with a mutable turn queue, not a fixed `for` loop, so repair can be appended once:

```rust
let mut turns: std::collections::VecDeque<SessionTurn> = turns.iter().cloned().collect();
while let Some(turn) = turns.pop_front() {
    // existing turn body
    if let Some(repair_turn) = queued_repair_turn.take() {
        turns.push_back(repair_turn);
    }
}
```

Use `final_output: Arc<Mutex<Option<StepOutput>>>` instead of `final_verdict`.

- [ ] **Step 5: Build direct ACP visible and extraction turns in `run_direct_step`**

In `crates/ensemble-core/src/agent/mod.rs`, import:

```rust
use acp_client::{SessionTurn, TurnPurpose, TurnVisibility};
```

Replace the `max_turns` prompt vector construction with one working prompt:

```rust
let working_prompt = self
    .build_prompt(
        config.as_ref(),
        BuildPromptRequest {
            issue: request.issue,
            agent_name: request.agent_name,
            step_name: request.step_name,
            step_kind: request.step_kind,
            attempt: request.attempt,
            workspace_path: request.workspace_path,
            turn_number: 1,
            step_outputs: &request.step_outputs,
        },
    )
    .await?;

let extraction_prompt = crate::agent::extraction::build_extraction_prompt(
    request.step_name,
    &request.issue.identifier,
    &working_prompt,
    "{{WORKING_ANSWER_FROM_VISIBLE_TURN}}",
);
```

Do not keep the literal marker in production. Instead, construct the extraction prompt inside `run_acp_session` after the visible turn completes. Pass an extraction context:

```rust
pub struct ExtractionContext {
    pub step_name: String,
    pub issue_identifier: String,
    pub original_prompt: String,
}
```

Change `run_acp_session` to accept `working_turn: SessionTurn` plus `ExtractionContext`. After the
visible turn completes, call:

```rust
let extraction_prompt = crate::agent::extraction::build_extraction_prompt(
    &extraction_context.step_name,
    &extraction_context.issue_identifier,
    &extraction_context.original_prompt,
    &visible_output_text,
);
```

- [ ] **Step 6: Run direct ACP tests**

Run:

```bash
rtk cargo test -p ensemble-core agent::acp_client::tests -- --nocapture
rtk cargo test -p ensemble-core agent::tests::build_prompt -- --nocapture
```

Expected: PASS after updating expected `TurnResult` patterns to include `output_text`.

- [ ] **Step 7: Commit direct ACP extraction**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/acp_client.rs crates/ensemble-core/src/agent/mod.rs
rtk git commit -m "Run hidden verdict extraction for direct ACP"
```

## Task 5: Implement Two-phase `acpx` Runtime

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs`
- Modify: `crates/ensemble-core/src/agent/acpx_runtime.rs`

- [ ] **Step 1: Add prompt visibility to `AcpxCli`**

In `crates/ensemble-core/src/agent/acpx_cli.rs`, add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptVisibility {
    Visible,
    Hidden,
}
```

Change `PromptOutcome` to:

```rust
#[derive(Debug, Clone, Default)]
pub struct PromptOutcome {
    pub runtime_verdict: Option<serde_json::Value>,
    pub output_text: String,
}
```

Add a `visibility: PromptVisibility` parameter to `run_prompt`.

- [ ] **Step 2: Capture output text and suppress hidden events**

Inside `run_prompt`, add:

```rust
let mut output_text = String::new();
let visible = visibility == PromptVisibility::Visible;
```

Change output handling to:

```rust
if let Some(content) = update.output_text {
    output_text.push_str(&content);
    if visible {
        on_event(AgentEvent::OutputChunk {
            stream: RuntimeStream::Stdout,
            content,
        })
        .await;
    }
}
```

Wrap permission warnings, stop reason events, error events, and `OtherMessage` events in `if visible`.

Return:

```rust
Ok(PromptOutcome {
    runtime_verdict: last_runtime_verdict,
    output_text,
})
```

- [ ] **Step 3: Run existing `acpx_cli` tests and update call sites**

Run:

```bash
rtk cargo test -p ensemble-core agent::acpx_cli::tests -- --nocapture
```

Expected: FAIL at compile because tests and callers need the new visibility argument.

Add `PromptVisibility::Visible` to existing visible prompt calls in tests and runtime code.

Add this test:

```rust
#[tokio::test]
async fn hidden_prompt_captures_output_without_emitting_events() {
    let temp = TempDir::new().unwrap();
    let script = write_mock_acpx_script(
        temp.path(),
        r#"
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"result\":\"succeeded\"}"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}'
"#,
    );
    let cli = AcpxCli::new(script);
    let mut events = Vec::new();

    let outcome = cli
        .run_prompt(
            "codex",
            "session",
            temp.path(),
            "extract",
            AcpxCommandOptions::default(),
            PromptVisibility::Hidden,
            |event| {
                events.push(event);
                async {}
            },
        )
        .await
        .unwrap();

    assert_eq!(outcome.output_text, "{\"result\":\"succeeded\"}");
    assert!(events.is_empty());
}
```

- [ ] **Step 4: Update `AcpxRuntime::run_step` flow**

In `crates/ensemble-core/src/agent/acpx_runtime.rs`, after the visible prompt succeeds, build the extraction prompt:

```rust
let extraction_prompt = crate::agent::extraction::build_extraction_prompt(
    request.step_name,
    &request.issue.identifier,
    prompt,
    &outcome.output_text,
);
```

Run a hidden extraction prompt before closing the session:

```rust
let extraction_outcome = self
    .cli
    .run_prompt(
        acpx_agent,
        &session_name,
        request.workspace_path,
        &extraction_prompt,
        command_options,
        PromptVisibility::Hidden,
        |_| async {},
    )
    .await?;
```

Validate it:

```rust
let output = match crate::agent::extraction::validate_extraction_payload(
    extraction_outcome.runtime_verdict.as_ref(),
    &extraction_outcome.output_text,
) {
    Ok(output) => output,
    Err(error) => {
        let previous_payload = extraction_outcome
            .runtime_verdict
            .as_ref()
            .map(serde_json::Value::to_string)
            .unwrap_or_else(|| extraction_outcome.output_text.clone());
        let repair_prompt =
            crate::agent::extraction::build_repair_prompt(&error.to_string(), &previous_payload);
        let repair_outcome = self
            .cli
            .run_prompt(
                acpx_agent,
                &session_name,
                request.workspace_path,
                &repair_prompt,
                command_options,
                PromptVisibility::Hidden,
                |_| async {},
            )
            .await?;
        crate::agent::extraction::validate_extraction_payload(
            repair_outcome.runtime_verdict.as_ref(),
            &repair_outcome.output_text,
        )
        .map_err(|error| AgentError::ResponseError {
            reason: format!("verdict extraction failed: {error}"),
        })?
    }
};
```

Pass `output` to:

```rust
detect_worker_result_with_output(request.workspace_path, output, request.step_name).await
```

- [ ] **Step 5: Ensure sessions close after extraction errors**

Keep the existing `close_session` helper call in a path that runs after visible prompt success, extraction success,
extraction validation failure, and repair validation failure. Use this structure:

```rust
let step_result = async {
    let visible_outcome = self
        .cli
        .run_prompt(
            acpx_agent,
            &session_name,
            request.workspace_path,
            prompt,
            command_options,
            PromptVisibility::Visible,
            |event| {
                cb_count.fetch_add(1, Ordering::Relaxed);
                emit_event(&request.event_tx, &request.issue.id, request.step_name, event)
            },
        )
        .await?;

    let extraction_prompt = crate::agent::extraction::build_extraction_prompt(
        request.step_name,
        &request.issue.identifier,
        prompt,
        &visible_outcome.output_text,
    );

    let extraction_outcome = self
        .cli
        .run_prompt(
            acpx_agent,
            &session_name,
            request.workspace_path,
            &extraction_prompt,
            command_options,
            PromptVisibility::Hidden,
            |_| async {},
        )
        .await?;

    crate::agent::extraction::validate_extraction_payload(
        extraction_outcome.runtime_verdict.as_ref(),
        &extraction_outcome.output_text,
    )
    .map_err(|error| AgentError::ResponseError {
        reason: format!("verdict extraction failed: {error}"),
    })
}
.await;

close_session(
    &self.cli,
    acpx_agent,
    &session_name,
    request.workspace_path,
    command_options,
)
.await;

let output = step_result?;
```

Then extend the `Err(error)` branch inside `step_result` to run the one repair prompt before
returning `AgentError::ResponseError`.

- [ ] **Step 6: Run `acpx` runtime tests**

Run:

```bash
rtk cargo test -p ensemble-core agent::acpx_cli::tests -- --nocapture
rtk cargo test -p ensemble-core agent::acpx_runtime::tests -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit `acpx` extraction**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/acpx_cli.rs crates/ensemble-core/src/agent/acpx_runtime.rs
rtk git commit -m "Run hidden verdict extraction for acpx"
```

## Task 6: Remove Production Fallback Verdict Paths

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/pipeline/verdict.rs`
- Modify: tests in those files

- [ ] **Step 1: Remove verdict fallback prompt injection**

In `crates/ensemble-core/src/agent/mod.rs`, remove the whole `verdict_fallback_instruction`
function and the whole `maybe_append_verdict_fallback_instruction` function.

In `build_prompt`, replace:

```rust
Ok(maybe_append_verdict_fallback_instruction(
    rendered,
    config.agent.inject_verdict_fallback_instructions,
    step_name,
))
```

with:

```rust
Ok(rendered)
```

Remove prompt-injection tests that assert `.ensemble/verdict-{step}.json` instructions are appended or disabled.

- [ ] **Step 2: Remove config field**

In `crates/ensemble-core/src/config/ensemble.rs`, remove from `AgentRuntimeConfig`:

```rust
#[serde(default = "default_inject_verdict_fallback_instructions")]
#[serde(alias = "inject_verdict_instructions")]
pub inject_verdict_fallback_instructions: bool,
```

Remove `default_inject_verdict_fallback_instructions()` and remove the field from `Default for AgentRuntimeConfig`.

Update config tests that expected `agent.inject_verdict_fallback_instructions`.

- [ ] **Step 3: Remove production resolver usage**

In `crates/ensemble-core/src/pipeline/verdict.rs`, keep these strict functions:

```rust
parse_step_output_json
validate_step_output_value
```

Keep `StepResult`, `StepOutput`, and `ResolvedResult` only if tests or public API still need them. Remove production use of:

```rust
read_verdict_file
read_step_output_file
resolve_verdict
resolve_verdict_with_source
VerdictSource
parse_verdict_from_value
parse_step_output_from_value
```

If removing all at once creates broad test churn, mark legacy file helpers with `#[cfg(test)]` first, then remove tests that exercise production fallback behavior.

- [ ] **Step 4: Remove transitional success helper**

In `crates/ensemble-core/src/agent/mod.rs`, delete:

```rust
fn transitional_succeeded_output() -> crate::pipeline::verdict::StepOutput
```

No production runtime should construct success without validated extraction output after Tasks 4 and 5.

- [ ] **Step 5: Run fallback-removal tests**

Run:

```bash
rtk cargo test -p ensemble-core pipeline::verdict::tests -- --nocapture
rtk cargo test -p ensemble-core agent::tests -- --nocapture
rtk cargo test -p ensemble-core config::ensemble::tests -- --nocapture
```

Expected: PASS after removing or replacing fallback-specific tests.

- [ ] **Step 6: Commit fallback removal**

Run:

```bash
rtk git add crates/ensemble-core/src/agent/mod.rs crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/pipeline/verdict.rs
rtk git commit -m "Remove verdict fallback result paths"
```

## Task 7: Update Documentation

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`
- Modify: `docs/pipelines.md`

- [ ] **Step 1: Update pipeline result docs**

In `docs/pipelines.md`, replace the “Results” section with:

```markdown
## Results

After an agent finishes its visible working turn, Ensemble runs a hidden extraction turn in the same
runtime session. The extraction turn produces the step's structured result. Extraction messages are
not shown in the timeline.

Every successful agent step must produce:

```json
{
  "result": "succeeded",
  "summary": "optional human-readable summary",
  "output": {
    "optional": "structured data for downstream steps"
  }
}
```

Failed and concern results require a non-empty `summary`:

```json
{
  "result": "failed",
  "summary": "Tests are failing - 3 test cases need fixes"
}
```

```json
{
  "result": "concern",
  "summary": "Naming is inconsistent, but the implementation is usable"
}
```

If extraction produces invalid JSON or violates the result contract, Ensemble runs one hidden repair
turn. If repair also fails, the worker fails and the orchestrator applies the configured retry or
failure behavior.

Verdict files and default-success fallback are not part of the runtime result contract.
```
```

- [ ] **Step 2: Update configuration docs**

In `docs/configuration.md`, remove the `agent.inject_verdict_fallback_instructions` row and the alias note:

```markdown
| `inject_verdict_fallback_instructions` | boolean | `true` |
```

Remove:

```markdown
`agent.inject_verdict_instructions` is accepted as a shorter alias for `agent.inject_verdict_fallback_instructions`.
```

Add under `### agent`:

```markdown
Agent step results are extracted by Ensemble through a hidden second turn in the same runtime
session. There is no config switch for this behavior.
```

- [ ] **Step 3: Update SPEC runtime result sections**

In `docs/SPEC.md`, replace references to:

```markdown
Collects verdict (ACP protocol field or `.ensemble/verdict.json` fallback).
```

with:

```markdown
Collects a validated `StepOutput` from Ensemble's hidden extraction turn.
```

Replace any result precedence list that mentions ACP, file fallback, and default success with:

```markdown
Agent-backed steps produce results through two runtime turns:

1. A visible working turn where the agent reasons freely.
2. A hidden extraction turn where Ensemble extracts a strict `StepOutput`.

The extraction payload is validated before the pipeline state machine sees it. Invalid extraction
gets one hidden repair turn. If repair fails, the worker fails; Ensemble does not default the step
to success.
```

- [ ] **Step 4: Run documentation search**

Run:

```bash
rtk rg -n "verdict.json|verdict-\\{|default.*success|inject_verdict|approve|reject" docs crates/ensemble-core/src
```

Expected: no matches in current production code for `inject_verdict`, `.ensemble/verdict`, or
default-success result resolution. Matches in old design documents under `docs/superpowers/specs/`
and `docs/superpowers/plans/` can remain.

- [ ] **Step 5: Commit docs**

Run:

```bash
rtk git add docs/SPEC.md docs/configuration.md docs/pipelines.md
rtk git commit -m "Document two-phase verdict extraction"
```

## Task 8: Final Verification

**Files:**
- No direct edits unless verification finds failures.

- [ ] **Step 1: Run core tests**

Run:

```bash
rtk cargo test -p ensemble-core
```

Expected: PASS.

- [ ] **Step 2: Run non-desktop workspace tests**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
```

Expected: PASS.

- [ ] **Step 3: Run CLI web-ui checks**

Run:

```bash
rtk SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
rtk SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
```

Expected: PASS.

- [ ] **Step 4: Run clippy and formatting**

Run:

```bash
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
```

Expected: PASS.

- [ ] **Step 5: Check final git state**

Run:

```bash
rtk git status --short --branch
```

Expected: clean working tree. If verification produced edits, return to the task that owns those
files, apply the concrete fix there, rerun that task's verification command, and commit with that
task's commit pattern.

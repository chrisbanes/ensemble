# Step Output Passing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a completed pipeline step publish a structured output payload that downstream steps can read from Liquid prompt templates.

**Architecture:** Extend the existing verdict payload contract instead of adding a second artifact format: ACP verdict values and `.ensemble/verdict.json` may include `summary` and arbitrary JSON under `output`. Parse that into a new `StepOutput` model, store outputs on `PipelineRun` keyed by step name, and pass a read-only prompt context into each dispatched agent run. Downstream templates can use `steps["review-a"].summary`, `steps["review-a"].output.findings`, or iterate `dependency_outputs` for immediate dependency outputs in configured dependency order.

**Tech Stack:** Rust 2021, `serde`, `serde_json`, `liquid`, existing `tokio` tests

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `crates/ensemble-core/src/pipeline/verdict.rs` | Define `StepOutput`, parse output-bearing verdict payloads, keep verdict resolution source behavior |
| Modify | `crates/ensemble-core/src/pipeline/engine.rs` | Store per-step outputs on `PipelineRun` and expose prompt context for downstream steps |
| Modify | `crates/ensemble-core/src/config/template.rs` | Render Liquid prompts with optional step-output globals |
| Modify | `crates/ensemble-core/src/agent/mod.rs` | Carry output context through `AgentRunRequest` and prompt building |
| Modify | `crates/ensemble-core/src/orchestrator/mod.rs` | Capture resolved output on worker exit and attach dependency outputs before dispatching next steps |
| Modify | `docs/SPEC.md`, `docs/pipelines.md`, `docs/configuration.md` | Document the output contract and Liquid variables |

## Contract

Agents may emit:

```json
{
  "verdict": "approve",
  "summary": "Reviewed the implementation and found no blockers.",
  "output": {
    "findings": [],
    "risk": "low"
  }
}
```

`verdict` remains optional and defaults to approve through the existing resolver. `summary` is now retained for both approve and reject verdicts. `output` must be any JSON value; when omitted it is `null` in templates.

Templates get:

```liquid
{% for dep in dependency_outputs %}
## {{ dep.step }}
Verdict: {{ dep.verdict }}
Summary: {{ dep.summary }}
{% endfor %}

{% assign review = steps["review-a"] %}
Risk: {{ review.output.risk }}
```

`dependency_outputs` contains only the current step's direct dependencies, sorted in the step's configured `depends` order. `steps` contains all outputs already produced in the current pipeline run.

## Task 1: Add Output-Aware Verdict Parsing

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/verdict.rs`

- [ ] **Step 1: Write failing parser tests**

Add tests near the existing verdict parser tests:

```rust
#[test]
fn test_parse_step_output_from_runtime_value() {
    let value = json!({
        "verdict": "approve",
        "summary": "review passed",
        "output": {"risk": "low", "findings": []}
    });

    let output = parse_step_output_from_value(&value).unwrap();

    assert_eq!(output.verdict, Verdict::Approve);
    assert_eq!(output.summary.as_deref(), Some("review passed"));
    assert_eq!(output.output, Some(json!({"risk":"low","findings":[]})));
}

#[tokio::test]
async fn test_read_step_output_file_preserves_approve_summary_and_output() {
    let dir = TempDir::new().unwrap();
    write_verdict_file(
        &dir,
        r#"{"verdict":"approve","summary":"ok","output":{"files":["src/lib.rs"]}}"#,
    )
    .await;

    let output = read_step_output_file(dir.path()).await.unwrap().unwrap();

    assert_eq!(output.verdict, Verdict::Approve);
    assert_eq!(output.summary.as_deref(), Some("ok"));
    assert_eq!(output.output, Some(json!({"files":["src/lib.rs"]})));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core pipeline::verdict::tests::test_parse_step_output_from_runtime_value -- --exact
```

Expected: FAIL because `StepOutput` and `parse_step_output_from_value` do not exist.

- [ ] **Step 3: Add `StepOutput` and extend the internal payload**

Add this above `ResolvedVerdict`:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct StepOutput {
    pub verdict: Verdict,
    pub summary: Option<String>,
    pub output: Option<serde_json::Value>,
}
```

Change `VerdictPayload` to:

```rust
#[derive(Debug, Deserialize)]
struct VerdictPayload {
    verdict: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    output: Option<serde_json::Value>,
}
```

Change `ResolvedVerdict` to:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedVerdict {
    pub verdict: Verdict,
    pub output: StepOutput,
    pub source: VerdictSource,
}
```

- [ ] **Step 4: Add parsing helpers**

Add these functions below `parse_verdict_from_value`:

```rust
pub fn parse_step_output_from_value(value: &serde_json::Value) -> Option<StepOutput> {
    let payload: VerdictPayload = serde_json::from_value(value.clone()).ok()?;
    step_output_from_payload(&payload)
}

pub async fn read_step_output_file(
    workspace: &Path,
) -> Result<Option<StepOutput>, std::io::Error> {
    let path = workspace.join(".ensemble").join("verdict.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let payload: VerdictPayload = serde_json::from_str(&contents)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            Ok(step_output_from_payload(&payload))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
```

Change `read_verdict_file` to call `read_step_output_file(workspace).await.map(|value| value.map(|output| output.verdict))`.

- [ ] **Step 5: Preserve existing verdict behavior**

Replace `verdict_from_payload` with:

```rust
fn verdict_from_payload(payload: &VerdictPayload) -> Option<Verdict> {
    step_output_from_payload(payload).map(|output| output.verdict)
}

fn step_output_from_payload(payload: &VerdictPayload) -> Option<StepOutput> {
    let verdict = match payload.verdict.as_deref() {
        Some(v) if v.eq_ignore_ascii_case("approve") => Verdict::Approve,
        Some(v) if v.eq_ignore_ascii_case("reject") => Verdict::Reject {
            summary: payload.summary.clone().unwrap_or_default(),
        },
        _ => return None,
    };

    Some(StepOutput {
        verdict,
        summary: payload.summary.clone(),
        output: payload.output.clone(),
    })
}
```

- [ ] **Step 6: Update `resolve_verdict_with_source`**

When ACP or file parsing succeeds, return the parsed `StepOutput` and its cloned verdict. For the default case, return:

```rust
let output = StepOutput {
    verdict: Verdict::Approve,
    summary: None,
    output: None,
};
ResolvedVerdict {
    verdict: output.verdict.clone(),
    output,
    source: VerdictSource::Default,
}
```

For malformed file rejection, build a `StepOutput` with the generated reject verdict, the same summary text, and `output: None`.

- [ ] **Step 7: Run verdict tests**

Run:

```bash
cargo test -p ensemble-core pipeline::verdict
```

Expected: PASS.

## Task 2: Store Step Outputs on PipelineRun

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/engine.rs`

- [ ] **Step 1: Write failing state-machine tests**

Add:

```rust
#[test]
fn downstream_context_contains_direct_dependency_outputs() {
    use crate::pipeline::verdict::StepOutput;
    use serde_json::json;

    let steps = vec![
        make_step("build", "builder", &[]),
        make_step("review-a", "reviewer", &["build"]),
        make_step("review-b", "reviewer", &["build"]),
        make_step("synth", "synthesizer", &["review-a", "review-b"]),
    ];
    let mut run = make_run(&steps);

    run.step_completed(
        "build",
        StepOutput {
            verdict: Verdict::Approve,
            summary: Some("built".to_string()),
            output: Some(json!({"artifact":"branch"})),
        },
        false,
    );
    run.step_completed(
        "review-a",
        StepOutput {
            verdict: Verdict::Approve,
            summary: Some("a ok".to_string()),
            output: Some(json!({"risk":"low"})),
        },
        false,
    );
    run.step_completed(
        "review-b",
        StepOutput {
            verdict: Verdict::Approve,
            summary: Some("b ok".to_string()),
            output: Some(json!({"risk":"medium"})),
        },
        false,
    );

    let context = run.output_context_for("synth").unwrap();

    assert_eq!(context.dependency_outputs.len(), 2);
    assert_eq!(context.dependency_outputs[0].step, "review-a");
    assert_eq!(context.dependency_outputs[1].step, "review-b");
    assert_eq!(context.steps["review-a"].summary.as_deref(), Some("a ok"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p ensemble-core pipeline::engine::tests::downstream_context_contains_direct_dependency_outputs -- --exact
```

Expected: FAIL because `output_context_for` does not exist and `step_completed` still takes `Verdict`.

- [ ] **Step 3: Add prompt context types**

Import `StepOutput` and `serde::Serialize`, then add:

```rust
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StepOutputTemplateEntry {
    pub step: String,
    pub verdict: String,
    pub summary: Option<String>,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StepOutputTemplateContext {
    pub steps: HashMap<String, StepOutputTemplateEntry>,
    pub dependency_outputs: Vec<StepOutputTemplateEntry>,
}
```

- [ ] **Step 4: Store outputs in `PipelineRun`**

Add a field:

```rust
pub step_outputs: HashMap<String, StepOutput>,
```

Initialize it in `PipelineRun::new` with `HashMap::new()`.

- [ ] **Step 5: Change `step_completed` to accept `StepOutput`**

Change the signature to:

```rust
pub fn step_completed(
    &mut self,
    step_name: &str,
    output: StepOutput,
    approval_requested: bool,
) -> PipelineAction
```

At the top of the method:

```rust
let verdict = output.verdict.clone();
self.step_outputs.insert(step_name.to_string(), output);
```

Leave the existing state-transition logic driven by `verdict`.

- [ ] **Step 6: Add context builder**

Add:

```rust
pub fn output_context_for(&self, step_name: &str) -> Option<StepOutputTemplateContext> {
    let step = self.dag.steps.iter().find(|step| step.name == step_name)?;
    let steps = self
        .step_outputs
        .iter()
        .map(|(name, output)| (name.clone(), template_entry(name, output)))
        .collect();
    let dependency_outputs = step
        .depends
        .iter()
        .filter_map(|dep| self.step_outputs.get(dep).map(|output| template_entry(dep, output)))
        .collect();

    Some(StepOutputTemplateContext {
        steps,
        dependency_outputs,
    })
}

fn template_entry(step: &str, output: &StepOutput) -> StepOutputTemplateEntry {
    StepOutputTemplateEntry {
        step: step.to_string(),
        verdict: match &output.verdict {
            Verdict::Approve => "approve".to_string(),
            Verdict::Reject { .. } => "reject".to_string(),
        },
        summary: output.summary.clone(),
        output: output.output.clone(),
    }
}
```

- [ ] **Step 7: Update existing engine tests**

Replace calls like:

```rust
run.step_completed("build", Verdict::Approve, false)
```

with:

```rust
run.step_completed("build", approve_output(), false)
```

Add test helpers:

```rust
fn approve_output() -> StepOutput {
    StepOutput {
        verdict: Verdict::Approve,
        summary: None,
        output: None,
    }
}

fn reject_output(summary: &str) -> StepOutput {
    StepOutput {
        verdict: Verdict::Reject {
            summary: summary.to_string(),
        },
        summary: Some(summary.to_string()),
        output: None,
    }
}
```

- [ ] **Step 8: Run pipeline engine tests**

Run:

```bash
cargo test -p ensemble-core pipeline::engine
```

Expected: PASS.

## Task 3: Expose Outputs to Liquid Templates

**Files:**
- Modify: `crates/ensemble-core/src/config/template.rs`

- [ ] **Step 1: Write failing template tests**

Add:

```rust
#[test]
fn test_render_with_step_outputs() {
    use crate::pipeline::engine::{StepOutputTemplateContext, StepOutputTemplateEntry};
    use serde_json::json;
    use std::collections::HashMap;

    let mut steps = HashMap::new();
    steps.insert(
        "review-a".to_string(),
        StepOutputTemplateEntry {
            step: "review-a".to_string(),
            verdict: "approve".to_string(),
            summary: Some("looks good".to_string()),
            output: Some(json!({"risk":"low"})),
        },
    );
    let context = StepOutputTemplateContext {
        steps: steps.clone(),
        dependency_outputs: vec![steps["review-a"].clone()],
    };

    let rendered = render_prompt_with_context(
        "{{ steps[\"review-a\"].summary }} / {{ dependency_outputs[0].output.risk }}",
        &test_issue(),
        None,
        None,
        Some(&context),
    )
    .unwrap();

    assert_eq!(rendered, "looks good / low");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p ensemble-core config::template::tests::test_render_with_step_outputs -- --exact
```

Expected: FAIL because `render_prompt_with_context` does not exist.

- [ ] **Step 3: Add the generalized renderer**

Import `StepOutputTemplateContext` and add:

```rust
pub fn render_prompt_with_context(
    template_str: &str,
    issue: &Issue,
    attempt: Option<u32>,
    interaction_response: Option<&InteractionResponse>,
    step_outputs: Option<&StepOutputTemplateContext>,
) -> Result<String, ConfigError> {
    let parser =
        ParserBuilder::with_stdlib()
            .build()
            .map_err(|e| ConfigError::TemplateParseError {
                reason: e.to_string(),
            })?;

    let template = parser
        .parse(template_str)
        .map_err(|e| ConfigError::TemplateParseError {
            reason: e.to_string(),
        })?;

    let mut issue_obj = liquid::object!({
        "id": issue.id,
        "identifier": issue.identifier,
        "title": issue.title,
        "priority": issue.priority,
        "state": issue.state,
        "labels": issue.labels,
    });

    issue_obj.insert(
        "description".into(),
        issue
            .description
            .as_ref()
            .map_or(liquid::model::Value::Nil, |desc| {
                liquid::model::Value::scalar(desc.clone())
            }),
    );
    issue_obj.insert(
        "branch_name".into(),
        issue
            .branch_name
            .as_ref()
            .map_or(liquid::model::Value::Nil, |branch_name| {
                liquid::model::Value::scalar(branch_name.clone())
            }),
    );
    issue_obj.insert(
        "url".into(),
        issue.url.as_ref().map_or(liquid::model::Value::Nil, |url| {
            liquid::model::Value::scalar(url.clone())
        }),
    );

    let mut globals = liquid::object!({
        "issue": issue_obj,
    });

    if let Some(a) = attempt {
        globals.insert("attempt".into(), liquid::model::Value::scalar(a as i64));
    }

    if let Some(response) = interaction_response {
        globals.insert(
            "interaction_response".into(),
            liquid::model::to_value(response).map_err(|e| ConfigError::TemplateRenderError {
                reason: e.to_string(),
            })?,
        );
    }

    if let Some(step_outputs) = step_outputs {
        let value = liquid::model::to_value(step_outputs).map_err(|e| {
            ConfigError::TemplateRenderError {
                reason: e.to_string(),
            }
        })?;
        if let liquid::model::Value::Object(object) = value {
            for (key, value) in object {
                globals.insert(key, value);
            }
        }
    }

    template
        .render(&globals)
        .map_err(|e| ConfigError::TemplateRenderError {
            reason: e.to_string(),
        })
}
```

Replace the existing wrappers with:

```rust
pub fn render_prompt(
    template_str: &str,
    issue: &Issue,
    attempt: Option<u32>,
) -> Result<String, ConfigError> {
    render_prompt_with_context(template_str, issue, attempt, None, None)
}

pub fn render_prompt_with_interaction_response(
    template_str: &str,
    issue: &Issue,
    attempt: Option<u32>,
    interaction_response: Option<&InteractionResponse>,
) -> Result<String, ConfigError> {
    render_prompt_with_context(template_str, issue, attempt, interaction_response, None)
}
```

- [ ] **Step 4: Run template tests**

Run:

```bash
cargo test -p ensemble-core config::template
```

Expected: PASS.

## Task 4: Wire Prompt Context Through Agent Runs

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify tests in the same file

- [ ] **Step 1: Add fields to request structs**

Import `StepOutputTemplateContext`. Add to `AgentRunRequest`:

```rust
pub step_outputs: StepOutputTemplateContext,
```

Add to `BuildPromptRequest`:

```rust
step_outputs: &'a StepOutputTemplateContext,
```

- [ ] **Step 2: Render with the output context**

Replace the call to `render_prompt_with_interaction_response` with:

```rust
let rendered = render_prompt_with_context(
    &template_str,
    issue,
    attempt,
    interaction_response
        .as_ref()
        .map(|response| &response.response),
    Some(step_outputs),
)
.map_err(|e| AgentError::PromptError {
    reason: e.to_string(),
})?;
```

- [ ] **Step 3: Update request construction in tests**

Every `AgentRunRequest` struct literal in `crates/ensemble-core/src/agent/mod.rs` and `crates/ensemble-core/tests/` must include:

```rust
step_outputs: StepOutputTemplateContext::default(),
```

- [ ] **Step 4: Add an agent prompt test**

Add:

```rust
#[tokio::test]
async fn build_prompt_includes_step_outputs() {
    use crate::pipeline::engine::{StepOutputTemplateContext, StepOutputTemplateEntry};
    use serde_json::json;
    use std::collections::HashMap;

    let runner = test_runner();
    let config = parse_config(
        r#"
tracker:
  kind: todo_file
agents:
  synth:
    prompt: 'Risk: {{ steps["review-a"].output.risk }}'
steps:
  - name: synth
    agent: synth
on_success: Done
on_failure: Todo
"#,
    )
    .unwrap();

    let mut steps = HashMap::new();
    steps.insert(
        "review-a".to_string(),
        StepOutputTemplateEntry {
            step: "review-a".to_string(),
            verdict: "approve".to_string(),
            summary: None,
            output: Some(json!({"risk":"low"})),
        },
    );
    let context = StepOutputTemplateContext {
        steps,
        dependency_outputs: vec![],
    };
    let workspace = tempfile::TempDir::new().unwrap();

    let rendered = runner
        .build_prompt(
            &config,
            BuildPromptRequest {
                issue: &test_issue(),
                agent_name: "synth",
                step_name: "synth",
                attempt: None,
                workspace_path: workspace.path(),
                turn_number: 1,
                step_outputs: &context,
            },
        )
        .await
        .unwrap();

    assert!(rendered.contains("Risk: low"));
}
```

- [ ] **Step 5: Run agent tests**

Run:

```bash
cargo test -p ensemble-core agent::tests::build_prompt_includes_step_outputs -- --exact
```

Expected: PASS after implementation.

## Task 5: Wire Orchestrator Completion and Dispatch

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs` test request literals that are compiled by orchestrator tests

- [ ] **Step 1: Add output context to `StepDispatchContext`**

Import `StepOutputTemplateContext` and add:

```rust
step_outputs: StepOutputTemplateContext,
```

- [ ] **Step 2: Initial dispatch uses empty context**

In `dispatch_issue`, add to the initial `StepDispatchContext`:

```rust
step_outputs: StepOutputTemplateContext::default(),
```

- [ ] **Step 3: Worker task passes context into `AgentRunRequest`**

Clone `dispatch.step_outputs` before `tokio::spawn` and include it in `AgentRunRequest`:

```rust
let step_outputs = dispatch.step_outputs.clone();
step_outputs,
```

- [ ] **Step 4: Store resolved output on completion**

In `handle_worker_exit`, change:

```rust
run.step_completed(step_name, resolved.verdict, approval_request.is_some())
```

to:

```rust
run.step_completed(step_name, resolved.output, approval_request.is_some())
```

- [ ] **Step 5: Build output context for downstream dispatches**

Before each downstream `dispatch_step`, read the context from the pipeline run:

```rust
let step_outputs = {
    let state = self.state.read().await;
    state
        .get_pipeline_run(issue_id)
        .and_then(|run| run.output_context_for(&req.step_name))
        .unwrap_or_default()
};
```

Add `step_outputs` to the downstream `StepDispatchContext`.

- [ ] **Step 6: Preserve outputs across approval gates**

In the approval-gate resume path, wherever `PipelineAction::Dispatch(requests)` is handled after `approve_gate`, use the same context builder from Step 5. This matters because the output is recorded when the worker exits, but downstream dispatch happens only after human approval.

- [ ] **Step 7: Update all `AgentRunRequest` literals**

Run:

```bash
rg -n "AgentRunRequest \\{" crates/ensemble-core/src crates/ensemble-core/tests
```

Every literal must include `step_outputs: StepOutputTemplateContext::default()` unless it is the real dispatch path from Step 3.

- [ ] **Step 8: Run focused orchestrator tests**

Run:

```bash
cargo test -p ensemble-core orchestrator::tests -- --test-threads=1
```

Expected: PASS.

## Task 6: Documentation and Contract Tests

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/pipelines.md`
- Modify: `docs/configuration.md`
- Modify or add integration tests under `crates/ensemble-core/tests/`

- [ ] **Step 1: Update the spec domain model**

In `docs/SPEC.md`, extend the Verdict section to include:

```markdown
- `output` (JSON value or null) — arbitrary structured data produced by a step for downstream prompt templates.

Prompt templates for downstream steps receive:

- `steps` — map of completed step name to `{ step, verdict, summary, output }`.
- `dependency_outputs` — ordered list of direct dependency outputs for the step being dispatched.
```

- [ ] **Step 2: Document the user-facing pipeline pattern**

In `docs/pipelines.md`, add an example:

```yaml
steps:
  - name: implement
    agent: implementer
  - name: review-a
    agent: reviewer
    depends: [implement]
  - name: review-b
    agent: reviewer
    depends: [implement]
  - name: synthesize
    agent: synthesizer
    depends: [review-a, review-b]
```

With a synthesizer prompt snippet:

```liquid
{% for review in dependency_outputs %}
## {{ review.step }}
{{ review.summary }}
{{ review.output.findings | json }}
{% endfor %}
```

- [ ] **Step 3: Add an integration-level test for rendering dependency outputs**

Add `crates/ensemble-core/tests/step_output_templates.rs` with a small `PipelineRun` and `render_prompt_with_context` test that mirrors the synthesis example. This catches public API drift across modules.

- [ ] **Step 4: Run final checks**

Run:

```bash
cargo test -p ensemble-core pipeline::verdict
cargo test -p ensemble-core pipeline::engine
cargo test -p ensemble-core config::template
cargo test -p ensemble-core agent::tests::build_prompt_includes_step_outputs -- --exact
cargo test -p ensemble-core orchestrator::tests -- --test-threads=1
cargo fmt --all -- --check
```

Expected: all commands PASS.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Liquid access to hyphenated step names is awkward | Medium | Support `steps["review-a"]` and `dependency_outputs`; document both |
| Stale `.ensemble/verdict.json` from prior turns affects output | Low | Existing `prepare_workspace` removes `verdict.json` before each run; keep output in that file |
| Approve summaries are lost if only `Verdict::Approve` is passed around | High | Store `StepOutput` separately and drive state transitions from its `verdict` field |
| Output context grows large | Medium | Do not persist in global history or UI in this issue; only keep in active `PipelineRun` memory |
| Strict Liquid rendering breaks templates that reference missing outputs | Medium | Keep `steps` and `dependency_outputs` always defined; missing named step fields should still fail fast |

## Open Questions

- Should output be restricted to JSON objects, or can it be any JSON value? This plan allows any JSON value to preserve flexibility.
- Should future work persist step outputs into history/timeline after completion? This plan keeps issue 174 scoped to downstream consumption during an active run.

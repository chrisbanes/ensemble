# Step-level retry and agent results — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Verdict → Result (add `Concern`), add step-level retry with per-step `on_failure` config, and support fixup agent injection on retry.

**Architecture:** Three sequential phases. Phase 1 renames `Verdict` to `Result` and adds `Concern` — a pure refactor with no behavior change. Phase 2 adds `StepDag::downstream_steps` and `PipelineRun::retry_from_step` — core step-level retry primitives. Phase 3 wires `on_failure` config into the orchestrator, conditionally preserving PipelineRun state, and adds the fixup step injection.

**Tech Stack:** Rust, tokio, serde, petgraph (if needed for downstream computation)

**Spec:** `docs/superpowers/specs/2026-06-11-step-retry-and-results-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/ensemble-core/src/pipeline/verdict.rs` | `StepResult` enum + parser rename, add `Concern` |
| `crates/ensemble-core/src/pipeline/engine.rs` | `StepState` rename, `retry_from_step`, `retry_from_step_with_fixup`, `Concern` handling |
| `crates/ensemble-core/src/pipeline/dag.rs` | `StepDag::downstream_steps()` |
| `crates/ensemble-core/src/config/ensemble.rs` | `OnFailure` enum, `on_failure` + `fixup_agent` on `StepConfig` |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Route failures through `on_failure`, preserve PipelineRun, fixup dispatch |
| `crates/ensemble-core/src/orchestrator/retry.rs` | `retry_from_step` + `with_fixup` on `RetryEntry`, `schedule_failure_retry` signature |
| `crates/ensemble-core/src/orchestrator/state.rs` | `retry_issue` route still calls `remove_pipeline_run` |
| `crates/ensemble-core/src/tracker/model.rs` | `RetryEntry` new fields |
| `crates/ensemble-core/src/api/controls.rs` | `?step=` query param on retry endpoint |
| `crates/ensemble-core/src/agent/mod.rs` | Propagate `Concern` to `WorkerResult::Success` |
| `crates/ensemble-core/src/agent/events.rs` | Rename `verdict` references to `result` |
| `docs/pipelines.md` | Document results, `on_failure`, step-level retry |

---

## Phase 1: Rename Verdict → Result + add Concern

### Task 1: Rename Verdict enum to StepResult in verdict.rs

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/verdict.rs`

- [ ] **Step 1: Rename Verdict to StepResult, rename variants, add Concern**

Open `crates/ensemble-core/src/pipeline/verdict.rs`. Replace lines 6-13:

```rust
/// The result returned by an agent at the end of a pipeline step.
#[derive(Debug, Clone, PartialEq)]
pub enum StepResult {
    /// The step completed successfully; continue to the next step or mark success.
    Succeeded,
    /// The step raised concerns but did not fail. Pipeline continues.
    /// Downstream steps (especially synthesis) should review the flagged output.
    Concern { summary: String },
    /// The step failed; retry or mark failure.
    Failed { summary: String },
}
```

- [ ] **Step 2: Rename StepOutput.verdict field to result**

On `StepOutput` struct (lines 22-27), rename `verdict: Verdict` to `result: StepResult`:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct StepOutput {
    pub result: StepResult,
    pub summary: Option<String>,
    pub output: Option<serde_json::Value>,
}
```

- [ ] **Step 3: Rename ResolvedVerdict to ResolvedResult**

On `ResolvedVerdict` struct (lines 29-33), rename and update field:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedResult {
    pub result: StepResult,
    pub output: StepOutput,
    pub source: VerdictSource,
}
```

- [ ] **Step 4: Update VerdictPayload and verdict_from_payload to parse result/concern**

Add a `result: Option<String>` field to `VerdictPayload`, keeping `verdict` as the legacy alias. In `step_output_from_payload` (lines 181-195), prefer `result`, fall back to `verdict`, and add `"concern"` parsing:

```rust
fn step_output_from_payload(payload: &VerdictPayload) -> Option<StepOutput> {
    // Prefer the new `result` field, but keep `verdict` as a legacy alias
    // for existing ACP/file payloads.
    let raw_result = payload.result.as_deref().or(payload.verdict.as_deref());
    let result = match raw_result {
        Some(v) if v.eq_ignore_ascii_case("approve") => StepResult::Succeeded,
        Some(v) if v.eq_ignore_ascii_case("succeeded") => StepResult::Succeeded,
        Some(v) if v.eq_ignore_ascii_case("concern") => StepResult::Concern {
            summary: payload.summary.clone().unwrap_or_default(),
        },
        Some(v) if v.eq_ignore_ascii_case("reject") => StepResult::Failed {
            summary: payload.summary.clone().unwrap_or_default(),
        },
        Some(v) if v.eq_ignore_ascii_case("failed") => StepResult::Failed {
            summary: payload.summary.clone().unwrap_or_default(),
        },
        _ => return None,
    };

    Some(StepOutput {
        result,
        summary: payload.summary.clone(),
        output: payload.output.clone(),
    })
}
```

- [ ] **Step 5: Update resolve_verdict_with_source return type and all verdict references**

In `resolve_verdict_with_source` (lines 117-174), rename `verdict` field accesses to `result`:

```rust
pub async fn resolve_verdict_with_source(
    acp_verdict: Option<&serde_json::Value>,
    workspace: &Path,
    step_name: &str,
) -> ResolvedResult {
    // 1. Try ACP event.
    if let Some(value) = acp_verdict {
        if let Some(output) = parse_step_output_from_value(value) {
            return ResolvedResult {
                result: output.result.clone(),
                output,
                source: VerdictSource::Runtime,
            };
        }
    }

    // 2. Try file.
    match read_step_output_file(workspace, step_name).await {
        Ok(Some(output)) => {
            return ResolvedResult {
                result: output.result.clone(),
                output,
                source: VerdictSource::File,
            };
        }
        Ok(None) => {}
        Err(e) => {
            let msg = format!("failed to parse .ensemble/verdict-{step_name}.json: {e}");
            let failed = StepResult::Failed {
                summary: msg.clone(),
            };
            let output = StepOutput {
                result: failed.clone(),
                summary: Some(msg),
                output: None,
            };
            return ResolvedResult {
                result: failed,
                output,
                source: VerdictSource::File,
            };
        }
    }

    // 3. Default.
    warn!("no result source found for step, defaulting to Succeeded");
    let output = StepOutput {
        result: StepResult::Succeeded,
        summary: None,
        output: None,
    };
    ResolvedResult {
        result: output.result.clone(),
        output,
        source: VerdictSource::Default,
    }
}
```

- [ ] **Step 6: Update resolve_verdict to use ResolvedResult**

```rust
pub async fn resolve_verdict(
    acp_verdict: Option<&serde_json::Value>,
    workspace: &Path,
    step_name: &str,
) -> StepResult {
    resolve_verdict_with_source(acp_verdict, workspace, step_name)
        .await
        .result
}
```

- [ ] **Step 7: Update tests**

In `mod tests` (lines 197-407), replace all `Verdict::Approve` with `StepResult::Succeeded`, `Verdict::Reject { summary }` with `StepResult::Failed { summary }`, and update field accesses from `.verdict` to `.result`. Add a `Concern` parsing test:

```rust
#[test]
fn test_parse_concern() {
    let value = json!({ "verdict": "concern", "summary": "naming issues found" });
    assert_eq!(
        parse_verdict_from_value(&value),
        Some(StepResult::Concern {
            summary: "naming issues found".to_string()
        })
    );
}
```

And add a backward-compat test for old `"approve"` / `"reject"` strings:

```rust
#[test]
fn test_parse_legacy_approve_reject() {
    assert_eq!(
        parse_verdict_from_value(&json!({ "verdict": "approve" })),
        Some(StepResult::Succeeded)
    );
    assert_eq!(
        parse_verdict_from_value(&json!({ "verdict": "reject", "summary": "nope" })),
        Some(StepResult::Failed { summary: "nope".to_string() })
    );
}
```

Add a forward-format test for the new `result` field:

```rust
#[test]
fn test_parse_result_field() {
    assert_eq!(
        parse_verdict_from_value(&json!({ "result": "failed", "summary": "nope" })),
        Some(StepResult::Failed { summary: "nope".to_string() })
    );
}
```

- [ ] **Step 8: Run tests, fix compilation**

Run: `cargo test -p ensemble-core -- pipeline::verdict`
Expected: All tests pass with renamed types.

- [ ] **Step 9: Commit**

```bash
git add crates/ensemble-core/src/pipeline/verdict.rs
git commit -m "refactor: rename Verdict to StepResult, add Concern variant"
```

### Task 2: Propagate rename through pipeline/engine.rs

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/engine.rs`

- [ ] **Step 1: Update import**

Line 7: change `use crate::pipeline::verdict::{StepOutput, Verdict};` to `use crate::pipeline::verdict::{StepOutput, StepResult};`.

- [ ] **Step 2: Rename StepState variants**

Lines 23-28: rename `Rejected { summary }` to `Failed { summary: String }`:

```rust
pub enum StepState {
    Pending,
    Running { session_id: String },
    BlockedOnHuman { interaction_request_id: String },
    AwaitingApproval { interaction_request_id: Option<String> },
    Passed,
    Failed { summary: String },
    /// Step failed due to an agent crash or runtime error.
    Errored { error: String },
}
```

Wait — we need to distinguish between an agent returning `Failed` (semantic failure: "I tried and it didn't work") vs the agent crashing (runtime error: "I died"). Let me check the current usage. Currently `Failed` is for runtime errors (line 28) and `Rejected` is for agent rejections. After rename: `Failed` for semantic failure from agent, `Errored` for runtime crashes.

Actually, looking at the spec more carefully — the spec says `Failed` is the rename of `Reject`. The runtime error state should stay separate. So:

```rust
pub enum StepState {
    Pending,
    Running { session_id: String },
    BlockedOnHuman { interaction_request_id: String },
    AwaitingApproval { interaction_request_id: Option<String> },
    Passed,
    /// Step returned a Failed result from the agent.
    Failed { summary: String },
    /// Step errored due to an agent crash or runtime failure.
    Errored { error: String },
}
```

- [ ] **Step 3: Update StepState::is_terminal**

Line 34-39: `Rejected` → `Failed`, keep `Errored`:

```rust
pub fn is_terminal(&self) -> bool {
    matches!(
        self,
        Self::Passed | Self::Failed { .. } | Self::Errored { .. }
    )
}
```

- [ ] **Step 4: Update step_completed to handle Verdict→Result and add Concern**

Lines 162-224: Replace `verdict` with `result`, handle `StepResult::Concern`:

```rust
pub fn step_completed(
    &mut self,
    step_name: &str,
    output: StepOutput,
    approval_requested: bool,
) -> PipelineAction {
    let result = output.result.clone();
    self.step_outputs.insert(step_name.to_string(), output);
    match result {
        StepResult::Succeeded => match self.gate_check(step_name, approval_requested) {
            ApprovalGateCheck::EligibleGating => {
                let approval_state = self.approval_state_for(step_name);
                self.step_states.insert(
                    step_name.to_string(),
                    StepState::AwaitingApproval {
                        interaction_request_id: None,
                    },
                );
                PipelineAction::AwaitingApproval {
                    step: step_name.to_string(),
                    approval_state,
                }
            }
            ApprovalGateCheck::UnconfiguredButRequested => {
                self.step_states.insert(
                    step_name.to_string(),
                    StepState::Errored {
                        error: format!(
                            "worker requested approval for step '{step_name}' but it has no approval configuration"
                        ),
                    },
                );
                PipelineAction::Failed {
                    step: step_name.to_string(),
                    reason: format!(
                        "step '{step_name}' has no approval configuration but the worker requested one"
                    ),
                }
            }
            ApprovalGateCheck::NotRequested => {
                self.step_states
                    .insert(step_name.to_string(), StepState::Passed);
                if self.all_passed() {
                    PipelineAction::Succeeded
                } else {
                    self.find_dispatchable()
                }
            }
        },
        StepResult::Concern { summary: _ } => {
            // Concern does not halt the pipeline. Treat like Succeeded
            // but flag output so downstream steps can see the concern.
            self.step_states
                .insert(step_name.to_string(), StepState::Passed);
            if self.all_passed() {
                PipelineAction::Succeeded
            } else {
                self.find_dispatchable()
            }
        }
        StepResult::Failed { summary } => {
            self.step_states.insert(
                step_name.to_string(),
                StepState::Failed {
                    summary: summary.clone(),
                },
            );
            PipelineAction::Failed {
                step: step_name.to_string(),
                reason: summary,
            }
        }
    }
}
```

- [ ] **Step 5: Update reject_gate to use Failed**

Lines 264-281: `StepState::Rejected` → `StepState::Failed`:

```rust
pub fn reject_gate(&mut self, step_name: &str, reason: String) -> PipelineAction {
    if !matches!(
        self.step_states.get(step_name),
        Some(StepState::AwaitingApproval { .. })
    ) {
        return PipelineAction::Waiting;
    }

    self.step_states.insert(
        step_name.to_string(),
        StepState::Failed {
            summary: reason.clone(),
        },
    );
    PipelineAction::Failed {
        step: step_name.to_string(),
        reason,
    }
}
```

- [ ] **Step 6: Update step_failed to use Errored**

Lines 306-317: `StepState::Failed` → `StepState::Errored` for runtime crashes:

```rust
pub fn step_failed(&mut self, step_name: &str, error: String) -> PipelineAction {
    self.step_states.insert(
        step_name.to_string(),
        StepState::Errored {
            error: error.clone(),
        },
    );
    PipelineAction::Failed {
        step: step_name.to_string(),
        reason: error,
    }
}
```

- [ ] **Step 7: Update template_entry to use StepResult and result terminology**

Rename `StepOutputTemplateEntry.verdict` to `result`. Lines 439-449: `Verdict::Approve` → `StepResult::Succeeded`, `Verdict::Reject` → `StepResult::Failed`, and emit result values:

```rust
fn template_entry(step: &str, output: &StepOutput) -> StepOutputTemplateEntry {
    StepOutputTemplateEntry {
        step: step.to_string(),
        result: match &output.result {
            StepResult::Succeeded => "succeeded".to_string(),
            StepResult::Concern { .. } => "concern".to_string(),
            StepResult::Failed { .. } => "failed".to_string(),
        },
        summary: output.summary.clone(),
        output: output.output.clone(),
    }
}
```

- [ ] **Step 8: Update all tests in engine.rs**

In `mod tests` (lines 452-1197), update all `Verdict::Approve` to `StepResult::Succeeded`, `Verdict::Reject { summary }` to `StepResult::Failed { summary }`, and `StepState::Rejected { summary }` to `StepState::Failed { summary }`. Update `StepState::Failed { error }` to `StepState::Errored { error }`.

Update `approve_output()`:
```rust
fn approve_output() -> StepOutput {
    StepOutput {
        result: StepResult::Succeeded,
        summary: None,
        output: None,
    }
}
```

Update `reject_output()`:
```rust
fn reject_output(summary: &str) -> StepOutput {
    StepOutput {
        result: StepResult::Failed {
            summary: summary.to_string(),
        },
        summary: Some(summary.to_string()),
        output: None,
    }
}
```

- [ ] **Step 9: Run tests**

Run: `cargo test -p ensemble-core -- pipeline::engine`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add crates/ensemble-core/src/pipeline/engine.rs
git commit -m "refactor: propagate StepResult rename through pipeline engine, add Concern handling"
```

### Task 3: Propagate rename through orchestrator and remaining crates

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`

- [ ] **Step 1: Update all Verdict references in orchestrator/mod.rs**

Search for `Verdict::` in mod.rs and replace:
- `Verdict::Approve` → `StepResult::Succeeded`
- `Verdict::Reject { summary }` → `StepResult::Failed { summary }`
- `verdict_value = "approve"` → `result_value = "succeeded"`
- `verdict_value = "reject"` → `result_value = "failed"`

Key locations to update (search for `Verdict::` and `ResolvedVerdict`):
- Import line 49: `use crate::pipeline::verdict::{resolve_verdict_with_source, Verdict, VerdictSource};` → `resolve_verdict_with_source, StepResult, VerdictSource`
- Lines 992-1001 (resolve_verdict_with_source usage): update `.verdict` to `.result`
- History constants (lines 89-91): update verdict values
- `rejection_comment_for_step` (line 1433): `StepState::Rejected` → `StepState::Failed`

- [ ] **Step 2: Update state.rs**

Line 658: `crate::pipeline::engine::StepState::Rejected { .. }` → `crate::pipeline::engine::StepState::Failed { .. }`

- [ ] **Step 3: Update all Verdict references in agent/**

In `agent/mod.rs` and `agent/events.rs`: update all `Verdict::` references to `StepResult::`.

- [ ] **Step 4: Update API handlers**

In `api/handlers.rs`: update any `Verdict` or `Rejected` references.

- [ ] **Step 5: Run full workspace build and test**

Run: `cargo build --workspace --exclude ensemble-desktop 2>&1 | head -80`
Expected: Compilation succeeds (or lists remaining rename targets).

Fix any remaining compilation errors by searching for `Verdict::` across the workspace:
Run: `rg "Verdict::" --type rust crates/`

- [ ] **Step 6: Run full test suite**

Run: `cargo test --workspace --exclude ensemble-desktop`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/
git commit -m "refactor: propagate StepResult rename through orchestrator, agent, and API layers"
```

---

## Phase 2: Step-level retry core

### Task 4: Add StepDag::downstream_steps

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/dag.rs`

- [ ] **Step 1: Write failing test**

Add to `mod tests` in dag.rs:

```rust
#[test]
fn test_downstream_steps_linear() {
    let steps = vec![
        make_step("a", "agent1", &[]),
        make_step("b", "agent1", &[]),
        make_step("c", "agent1", &[]),
    ];
    let dag = build_dag(&steps).unwrap();

    let ds = dag.downstream_steps("b");
    let mut names: Vec<&str> = ds.iter().map(|s| s.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["b", "c"]);
}

#[test]
fn test_downstream_steps_parallel() {
    let steps = vec![
        make_step("build", "builder", &[]),
        make_step("review-a", "reviewer", &["build"]),
        make_step("review-b", "reviewer", &["build"]),
        make_step("synth", "synth", &["review-a", "review-b"]),
    ];
    let dag = build_dag(&steps).unwrap();

    let ds = dag.downstream_steps("review-a");
    let mut names: Vec<&str> = ds.iter().map(|s| s.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["review-a", "synth"]);
    // review-b is NOT downstream of review-a
}

#[test]
fn test_downstream_steps_root() {
    let steps = vec![
        make_step("a", "agent1", &[]),
        make_step("b", "agent1", &[]),
    ];
    let dag = build_dag(&steps).unwrap();

    let ds = dag.downstream_steps("a");
    let mut names: Vec<&str> = ds.iter().map(|s| s.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["a", "b"]);
}

#[test]
fn test_downstream_steps_leaf() {
    let steps = vec![
        make_step("a", "agent1", &[]),
        make_step("b", "agent1", &[]),
    ];
    let dag = build_dag(&steps).unwrap();

    let ds = dag.downstream_steps("b");
    let mut names: Vec<&str> = ds.iter().map(|s| s.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["b"]);
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cargo test -p ensemble-core -- pipeline::dag::tests::test_downstream_steps_linear`
Expected: FAIL — `downstream_steps` method doesn't exist.

- [ ] **Step 3: Implement downstream_steps**

Add method to `impl StepDag` (after line 25):

```rust
impl StepDag {
    // ... existing methods later

    /// Return the set of step names that transitively depend on `step_name`,
    /// including `step_name` itself. Uses BFS through the dependency graph.
    pub fn downstream_steps(&self, step_name: &str) -> HashSet<String> {
        let mut result = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(step_name.to_string());

        // Build an adjacency map: dep_name -> Vec<step_name> (reverse edges)
        let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
        for step in &self.steps {
            for dep in &step.depends {
                dependents.entry(dep.as_str()).or_default().push(step.name.as_str());
            }
        }

        while let Some(current) = queue.pop_front() {
            if !result.insert(current.clone()) {
                continue; // already visited
            }
            if let Some(deps) = dependents.get(current.as_str()) {
                for dependent in deps {
                    queue.push_back(dependent.to_string());
                }
            }
        }

        result
    }
}
```

Add the import at the top of dag.rs: `use std::collections::{HashMap, HashSet, VecDeque};` (already has HashMap, HashSet, VecDeque imported).

- [ ] **Step 4: Run tests**

Run: `cargo test -p ensemble-core -- pipeline::dag`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/pipeline/dag.rs
git commit -m "feat: add StepDag::downstream_steps for transitive dependency computation"
```

### Task 5: Add PipelineRun step-level retry primitives

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/engine.rs`

- [ ] **Step 1: Write failing tests**

Add to `mod tests` in engine.rs (before the closing `}` of mod tests):

```rust
#[test]
fn test_retry_from_step_resets_failed_and_downstream() {
    // build → review-a ──→ synth
    //       → review-b ──→
    let steps = vec![
        make_step("build", "builder", &[]),
        make_step("review-a", "reviewer", &["build"]),
        make_step("review-b", "reviewer", &["build"]),
        make_step("synth", "synthesizer", &["review-a", "review-b"]),
    ];
    let mut run = make_run(&steps);

    // Simulate: build passed, review-a passed, review-b failed
    run.step_states.insert("build".to_string(), StepState::Passed);
    run.step_states.insert("review-a".to_string(), StepState::Passed);
    run.step_states.insert("review-b".to_string(), StepState::Failed {
        summary: "review-b found issues".to_string(),
    });
    // synth never ran (Pending)

    let reset = run.retry_from_step("review-b");

    // review-b + synth (downstream) should be reset
    assert!(reset.contains("review-b"));
    assert!(reset.contains("synth"));
    assert_eq!(reset.len(), 2);

    // build and review-a should remain Passed
    assert_eq!(run.step_states["build"], StepState::Passed);
    assert_eq!(run.step_states["review-a"], StepState::Passed);

    // review-b and synth should be Pending
    assert_eq!(run.step_states["review-b"], StepState::Pending);
    assert_eq!(run.step_states["synth"], StepState::Pending);
}

#[test]
fn test_retry_from_step_leaf_only() {
    let steps = vec![
        make_step("build", "builder", &[]),
        make_step("review", "reviewer", &[]),
    ];
    let mut run = make_run(&steps);

    run.step_states.insert("build".to_string(), StepState::Passed);
    run.step_states.insert("review".to_string(), StepState::Failed {
        summary: "bad".to_string(),
    });

    let reset = run.retry_from_step("review");

    assert_eq!(reset, HashSet::from(["review".to_string()]));
    assert_eq!(run.step_states["review"], StepState::Pending);
    assert_eq!(run.step_states["build"], StepState::Passed);
}

#[test]
fn test_retry_from_step_root_resets_all() {
    let steps = vec![
        make_step("build", "builder", &[]),
        make_step("review", "reviewer", &[]),
    ];
    let mut run = make_run(&steps);

    run.step_states.insert("build".to_string(), StepState::Passed);
    run.step_states.insert("review".to_string(), StepState::Passed);

    let reset = run.retry_from_step("build");

    assert!(reset.contains("build"));
    assert!(reset.contains("review"));
    assert_eq!(reset.len(), 2);
    assert_eq!(run.step_states["build"], StepState::Pending);
    assert_eq!(run.step_states["review"], StepState::Pending);
}

#[test]
fn test_retry_from_step_with_fixup_injects_fixup_before_failed_step() {
    let steps = vec![
        make_step("build", "builder", &[]),
        make_step("synth", "synth", &["build"]),
    ];
    let mut run = make_run(&steps);
    run.step_states.insert("build".to_string(), StepState::Passed);
    run.step_states.insert("synth".to_string(), StepState::Failed {
        summary: "synthesis conflict".to_string(),
    });
    let reset = run.retry_from_step_with_fixup("synth", "fixer");
    assert!(reset.contains("synth"));
    assert!(run.step_states.contains_key("fixup-synth"));
    assert_eq!(run.step_states["fixup-synth"], StepState::Pending);
    let synth = run.dag.steps.iter().find(|s| s.name == "synth").unwrap();
    assert_eq!(synth.depends, vec!["fixup-synth"]);
    let fixup = run.dag.steps.iter().find(|s| s.name == "fixup-synth").unwrap();
    assert_eq!(fixup.depends, vec!["build"]);
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cargo test -p ensemble-core -- pipeline::engine::tests::test_retry_from_step_resets_failed_and_downstream`
Expected: FAIL — `retry_from_step` and `retry_from_step_with_fixup` do not exist.

- [ ] **Step 3: Implement retry_from_step and retry_from_step_with_fixup**

Add to `impl PipelineRun` (after `step_failed`, around line 317):

```rust
/// Reset `step_name` and all transitive downstream dependents to `Pending`.
/// Clears their outputs from `step_outputs`. Returns the set of reset step names.
/// Steps that are already `Pending` remain `Pending` (no-op).
pub fn retry_from_step(&mut self, step_name: &str) -> HashSet<String> {
    let downstream = self.dag.downstream_steps(step_name);

    for name in &downstream {
        self.step_states.insert(name.clone(), StepState::Pending);
        self.step_outputs.remove(name);
    }

    downstream
}

/// Same as retry_from_step, but injects a synthetic fixup step between the
/// reset step's dependencies and the reset step itself.
pub fn retry_from_step_with_fixup(
    &mut self,
    step_name: &str,
    fixup_agent: &str,
) -> HashSet<String> {
    let fixup_name = format!("fixup-{step_name}");
    let original_deps: Vec<String> = self.dag.steps
        .iter()
        .find(|s| s.name == step_name)
        .map(|s| s.depends.clone())
        .unwrap_or_default();
    let reset = self.retry_from_step(step_name);
    let fixup_step = crate::pipeline::dag::DagStep {
        name: fixup_name.clone(),
        agent: fixup_agent.to_string(),
        kind: crate::config::ensemble::StepKind::Agent,
        tracker_state: None,
        approval: None,
        depends: original_deps.clone(),
        on_failure: crate::config::ensemble::OnFailure::RetryStep,
        fixup_agent: None,
    };
    let failed_idx = self.dag.steps.iter()
        .position(|s| s.name == step_name)
        .unwrap_or(self.dag.steps.len());
    self.dag.steps.insert(failed_idx, fixup_step);
    if let Some(step) = self.dag.steps.iter_mut().find(|s| s.name == step_name) {
        step.depends = vec![fixup_name.clone()];
    }
    self.step_states.insert(fixup_name, StepState::Pending);
    reset
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p ensemble-core -- pipeline::engine`
Expected: All tests pass including the new retry tests.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/pipeline/engine.rs
git commit -m "feat: add PipelineRun step-level retry primitives"
```

---

## Phase 3: on_failure config + orchestrator wiring

### Task 6: Add OnFailure enum and StepConfig fields

**Files:**
- Modify: `crates/ensemble-core/src/error.rs`
- Modify: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Add a generic invalid-step config error**

In `PipelineError`, add:

```rust
#[error("invalid step config for {step}: {reason}")]
InvalidStepConfig { step: String, reason: String },
```

- [ ] **Step 2: Add OnFailure enum**

After `StepKind` impl (around line 371), add:

```rust
/// Controls what happens when a step fails (returns [`StepResult::Failed`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OnFailure {
    /// Whole-issue retry (existing behavior). Destroy PipelineRun, restart from scratch.
    #[default]
    RetryIssue,
    /// Step-level retry. Reset failed step + downstream, preserve passed steps.
    RetryStep,
    /// Inject a fixup agent before retrying the failed step.
    Fixup,
    /// Halt the pipeline. Do not retry. Wait for manual intervention.
    Halt,
}
```

- [ ] **Step 3: Add on_failure and fixup_agent to StepConfig**

Modify `StepConfig` (lines 374-386):

```rust
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct StepConfig {
    pub name: String,
    #[serde(default, skip_serializing_if = "StepKind::is_agent")]
    pub kind: StepKind,
    pub agent: String,
    pub depends: Option<Vec<String>>,
    pub tracker_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<StepApprovalConfig>,
    /// Controls retry behavior when this step fails.
    #[serde(default, skip_serializing_if = "OnFailure::is_default")]
    pub on_failure: OnFailure,
    /// Agent to use for fixup retry. Required when on_failure is "fixup".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixup_agent: Option<String>,
}
```

Add `is_default` helper for `OnFailure`:

```rust
impl OnFailure {
    pub fn is_default(&self) -> bool {
        matches!(self, Self::RetryIssue)
    }
}
```

- [ ] **Step 4: Update DagStep to carry on_failure and fixup_agent**

In `dag.rs`, update `DagStep`:

```rust
pub struct DagStep {
    pub name: String,
    pub agent: String,
    pub kind: StepKind,
    pub tracker_state: Option<String>,
    pub approval: Option<StepApprovalConfig>,
    pub depends: Vec<String>,
    pub on_failure: OnFailure,
    pub fixup_agent: Option<String>,
}
```

And in `build_dag`, copy the new fields:

```rust
resolved.push(DagStep {
    name: step.name.clone(),
    agent: step.agent.clone(),
    kind: step.kind,
    tracker_state: step.tracker_state.clone(),
    approval: step.approval.clone(),
    depends: deps,
    on_failure: step.on_failure,
    fixup_agent: step.fixup_agent.clone(),
});
```

- [ ] **Step 5: Compile and fix cascading changes**

Run: `cargo build -p ensemble-core 2>&1 | head -40`
Expected: May have compilation errors in dag.rs if `OnFailure` isn't imported. Add `use crate::config::ensemble::OnFailure;` to dag.rs if needed.

- [ ] **Step 6: Write config validation tests**

Update `validate_config` so `on_failure: fixup` requires a configured `fixup_agent`, and the named fixup agent exists in `config.agents`:

```rust
for step in &config.steps {
    if step.on_failure == OnFailure::Fixup {
        let Some(fixup_agent) = step.fixup_agent.as_ref() else {
            return Err(PipelineError::InvalidStepConfig {
                step: step.name.clone(),
                reason: "on_failure: fixup requires fixup_agent".to_string(),
            });
        };
        if !config.agents.contains_key(fixup_agent) {
            return Err(PipelineError::UnknownAgent {
                name: fixup_agent.clone(),
            });
        }
    }
}
```

Add to `mod tests` in ensemble.rs (or dag.rs):

```rust
#[test]
fn test_step_config_on_failure_defaults_to_retry_issue() {
    let yaml = r#"
name: build
agent: builder
"#;
    let step: StepConfig = serde_yaml::from_str(yaml).unwrap();
    assert_eq!(step.on_failure, OnFailure::RetryIssue);
    assert!(step.fixup_agent.is_none());
}
```

Add validation tests for `on_failure: fixup` without `fixup_agent` and with an unknown `fixup_agent`.

- [ ] **Step 7: Run tests**

Run: `cargo test -p ensemble-core -- config`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add crates/ensemble-core/src/error.rs crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/pipeline/dag.rs
git commit -m "feat: add OnFailure enum and on_failure/fixup_agent fields to StepConfig"
```

### Task 7: Add retry_from_step fields to RetryEntry

**Files:**
- Modify: `crates/ensemble-core/src/tracker/model.rs`
- Modify: `crates/ensemble-core/src/orchestrator/retry.rs`

- [ ] **Step 1: Add fields to RetryEntry**

In `tracker/model.rs`, lines 71-78:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryEntry {
    pub issue_id: String,
    pub identifier: String,
    pub attempt: u32,
    pub due_at_ms: u64,
    pub error: Option<String>,
    /// If set, retry from this step (step-level retry). None = whole-issue.
    #[serde(default)]
    pub retry_from_step: Option<String>,
    /// Whether to inject a fixup agent before retrying.
    #[serde(default)]
    pub with_fixup: bool,
}
```

- [ ] **Step 2: Update schedule_failure_retry signature in retry.rs**

Add `retry_from_step: Option<String>` and `with_fixup: bool` parameters to `schedule_failure_retry` (line 58):

```rust
pub fn schedule_failure_retry(
    state: &mut OrchestratorState,
    issue_id: &str,
    identifier: &str,
    attempt: u32,
    max_backoff_ms: u64,
    max_cycles: u32,
    error: &str,
    retry_from_step: Option<String>,
    with_fixup: bool,
) -> Option<u64> {
```

And in the `RetryEntry` construction:

```rust
let entry = RetryEntry {
    issue_id: issue_id.to_string(),
    identifier: identifier.to_string(),
    attempt,
    due_at_ms,
    error: Some(error.to_string()),
    retry_from_step,
    with_fixup,
};
```

- [ ] **Step 3: Update all schedule_failure_retry call sites**

Search for all `schedule_failure_retry(` calls and add `None, false` as the last two arguments. Run:

```bash
rg "schedule_failure_retry\(" --type rust crates/
```

This will find call sites in:
- `orchestrator/mod.rs` (multiple locations)
- `orchestrator/retry.rs` (tests)

Add `None, false` to each call.

- [ ] **Step 4: Update retry.rs tests**

Update `test_schedule_failure_retry` and other tests to pass `None, false`.

- [ ] **Step 5: Run tests**

Run: `cargo test -p ensemble-core -- orchestrator::retry`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/tracker/model.rs crates/ensemble-core/src/orchestrator/retry.rs crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "feat: add retry_from_step and with_fixup to RetryEntry"
```

### Task 8: Wire on_failure routing in orchestrator

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Add helper to read on_failure from config**

Add a method or inline logic in `handle_worker_exit` to read `on_failure` for a step. In the `PipelineAction::Failed { step, reason }` handler (around line 1188), add before the retry scheduling:

```rust
let on_failure = {
    let config = self.config.read().await;
    config.steps
        .iter()
        .find(|s| s.name == step)
        .map(|s| s.on_failure)
        .unwrap_or_default()
};
```

- [ ] **Step 2: Route based on on_failure**

Replace lines 1201-1238 (the `if let Some(entry) = state.remove_running(issue_id)` block) with routing logic:

```rust
match on_failure {
    OnFailure::RetryStep => {
        // Step-level retry: reset failed step + downstream, preserve PipelineRun
        if let Some(run) = state.get_pipeline_run_mut(issue_id) {
            run.retry_from_step(&step);
        }
        if let Some(entry) = state.remove_running(issue_id) {
            state.add_runtime_seconds(&entry);
            completed_identifier = Some(entry.identifier.clone());
            history_run_id = entry.run_id.clone();
            let retry_scheduled = schedule_failure_retry(
                &mut state,
                issue_id,
                &entry.identifier,
                next_attempt(entry.retry_attempt),
                config.agent.max_retry_backoff_ms,
                config.max_cycles,
                &reason,
                Some(step.clone()),
                false,
            );
            final_failure = retry_scheduled.is_none();
            if final_failure {
                history_record = state.get_pipeline_run(issue_id).map(|run| {
                    rejection_comment = Self::rejection_comment_for_step(run, &step);
                    self.build_history_record(
                        issue_id,
                        HISTORY_OUTCOME_FAILED,
                        Some(reason.clone()),
                        &entry,
                        run,
                        completed_at,
                    )
                });
            }
            if retry_scheduled.is_none() && self.tracker.supports_writes() {
                if let Err(e) = self
                    .tracker
                    .set_issue_state(issue_id, &config.on_failure)
                    .await
                {
                    warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                }
            }
        }
        // Do NOT remove_pipeline_run for RetryStep
    }
    OnFailure::Fixup => {
        // Fixup: inject fixup agent, then retry
        let Some(fixup_agent) = config.steps
            .iter()
            .find(|s| s.name == step)
            .and_then(|s| s.fixup_agent.clone()) else {
            error!(issue_id = %issue_id, step = %step, "fixup step missing fixup_agent after config validation");
            state.remove_pipeline_run(issue_id);
            return;
        };

        if let Some(run) = state.get_pipeline_run_mut(issue_id) {
            run.retry_from_step_with_fixup(&step, &fixup_agent);
        }
        if let Some(entry) = state.remove_running(issue_id) {
            state.add_runtime_seconds(&entry);
            completed_identifier = Some(entry.identifier.clone());
            history_run_id = entry.run_id.clone();
            let retry_scheduled = schedule_failure_retry(
                &mut state,
                issue_id,
                &entry.identifier,
                next_attempt(entry.retry_attempt),
                config.agent.max_retry_backoff_ms,
                config.max_cycles,
                &reason,
                Some(step.clone()),
                true, // with_fixup
            );
            final_failure = retry_scheduled.is_none();
            if final_failure {
                // same history record logic as RetryStep
                history_record = state.get_pipeline_run(issue_id).map(|run| {
                    self.build_history_record(
                        issue_id,
                        HISTORY_OUTCOME_FAILED,
                        Some(reason.clone()),
                        &entry,
                        run,
                        completed_at,
                    )
                });
            }
            if retry_scheduled.is_none() && self.tracker.supports_writes() {
                if let Err(e) = self
                    .tracker
                    .set_issue_state(issue_id, &config.on_failure)
                    .await
                {
                    warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                }
            }
        }
        // Do NOT remove_pipeline_run for Fixup
    }
    OnFailure::Halt => {
        // Halt: do not retry, do not remove PipelineRun, keep issue claimed
        warn!(
            issue_id = %issue_id,
            step = %step,
            reason = %reason,
            "pipeline halted, waiting for manual intervention"
        );
        if let Some(entry) = state.remove_running(issue_id) {
            state.add_runtime_seconds(&entry);
            let agent_name = config.steps
                .iter()
                .find(|s| s.name == step)
                .map(|s| s.agent.clone())
                .unwrap_or_default();
            state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
                issue_id: issue_id.to_string(),
                identifier: entry.identifier.clone(),
                interaction_request_id: format!("halted:{issue_id}:{step}"),
                step_name: step.clone(),
                kind: crate::interaction::model::InteractionKind::Handoff,
                prompt: reason.clone(),
                agent_name,
                retry_attempt: entry.retry_attempt,
                started_at: Some(entry.started_at),
                agent_input_tokens: entry.agent_input_tokens,
                agent_output_tokens: entry.agent_output_tokens,
                agent_total_tokens: entry.agent_total_tokens,
                requested_at: chrono::Utc::now(),
                run_id: entry.run_id.clone(),
                issue: Some(entry.issue.clone()),
            });
        }
        // Do NOT remove_pipeline_run, do NOT schedule retry
        // Do NOT call remove_claimed — issue stays claimed
    }
    OnFailure::RetryIssue => {
        // Existing whole-issue retry behavior
        if let Some(entry) = state.remove_running(issue_id) {
            state.add_runtime_seconds(&entry);
            completed_identifier = Some(entry.identifier.clone());
            history_run_id = entry.run_id.clone();
            let retry_scheduled = schedule_failure_retry(
                &mut state,
                issue_id,
                &entry.identifier,
                next_attempt(entry.retry_attempt),
                config.agent.max_retry_backoff_ms,
                config.max_cycles,
                &reason,
                None,  // whole-issue
                false,
            );
            final_failure = retry_scheduled.is_none();
            if final_failure {
                history_record = state.get_pipeline_run(issue_id).map(|run| {
                    rejection_comment = Self::rejection_comment_for_step(run, &step);
                    self.build_history_record(
                        issue_id,
                        HISTORY_OUTCOME_FAILED,
                        Some(reason.clone()),
                        &entry,
                        run,
                        completed_at,
                    )
                });
            }
            if retry_scheduled.is_none() && self.tracker.supports_writes() {
                if let Err(e) = self
                    .tracker
                    .set_issue_state(issue_id, &config.on_failure)
                    .await
                {
                    warn!(issue_id = %issue_id, error = %e, "failed to set tracker failure state");
                }
            }
        }
        state.remove_pipeline_run(issue_id);
    }
}
```

- [ ] **Step 3: Update dispatch_issue to reuse PipelineRun for step-level retries**

In `dispatch_issue` (line 580), add an early-return block at the top (after `let cycle = ...`). When a PipelineRun already exists for this issue, skip `build_dag` + `PipelineRun::new` + `insert_pipeline_run`. Instead: re-add to running, call `start()` on the existing run, and dispatch the returned requests through the same dispatch loop.

The key change is inserting right after line 592 (`let cycle = attempt.unwrap_or(1);`):

```rust
// Check for existing PipelineRun (step-level retry preserved it)
{
    let state = self.state.read().await;
    if state.get_pipeline_run(&issue.id).is_some() {
        drop(state);
        // Reuse existing run — retry_from_step was already applied
        let (config_snapshot, action) = {
            let mut state = self.state.write().await;
            state.add_running(issue, attempt);
            let config = state.get_pipeline_config(&issue.id).cloned();
            let action = state.get_pipeline_run_mut(&issue.id)
                .map(|run| { run.cycle = cycle; run.start() })
                .unwrap_or(PipelineAction::Waiting);
            (config, action)
        };

        info!(event = ISSUE_DISPATCH_STARTED, issue_id = %issue.id,
              identifier = %issue.identifier, cycle = cycle,
              "resuming with existing pipeline (step-level retry)");

        if let PipelineAction::Dispatch(requests) = action {
            if let Some(config) = config_snapshot {
                for req in requests {
                    // Same dispatch loop as below — prepare workspace, dispatch_step
                    let workspace_path = match self.prepare_step_workspace(issue, &config).await {
                        Ok(path) => path,
                        Err(error) => { /* ... failure handling ... */ return; }
                    };
                    let step_outputs = {
                        let state = self.state.read().await;
                        state.get_pipeline_run(&issue.id)
                            .and_then(|r| r.output_context_for(&req.step_name))
                            .unwrap_or_default()
                    };
                    let _ = self.dispatch_step(
                        issue, Arc::clone(&config),
                        StepDispatchContext {
                            step_name: &req.step_name, agent_name: &req.agent_name,
                            step_kind: req.step_kind, tracker_state: req.tracker_state.as_deref(),
                            attempt, interaction_response: None,
                            workspace_path, step_outputs,
                        },
                    ).await;
                }
            }
        }
        return;
    }
}
// ... existing dispatch_issue code continues unchanged
```

The dispatch loop is duplicated from the existing loop because of async borrow constraints — the state lock cannot be held across `.await` calls to `prepare_step_workspace` and `dispatch_step`.

- [ ] **Step 4: Compile and fix errors**

Run: `cargo build -p ensemble-core 2>&1 | head -50`
Expected: Initial compilation errors from the new code. Fix borrow/async issues by moving lock acquisitions.

- [ ] **Step 5: Run all tests**

Run: `cargo test --workspace --exclude ensemble-desktop`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "feat: wire on_failure routing and step-level retry dispatch in orchestrator"
```

### Task 9: Update API retry endpoint for step-level retry

**Files:**
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`

- [ ] **Step 1: Add find_issue_id_by_identifier to OrchestratorState**

In state.rs, add:

```rust
/// Find the issue_id for a given identifier across active control states.
pub fn find_issue_id_by_identifier(&self, identifier: &str) -> Option<String> {
    for (id, entry) in &self.running {
        if entry.identifier == identifier { return Some(id.clone()); }
    }
    for (id, entry) in &self.retry_attempts {
        if entry.identifier == identifier { return Some(id.clone()); }
    }
    for (id, entry) in &self.waiting_on_human {
        if entry.identifier == identifier { return Some(id.clone()); }
    }
    None
}
```

- [ ] **Step 2: Add step query parameter to post_retry**

In controls.rs, update `post_retry`:

```rust
#[derive(Debug, Deserialize)]
struct RetryQuery {
    #[serde(default)]
    step: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/v1/{identifier}/retry",
    operation_id = "postRetry",
    params(
        ("identifier" = String, Path, description = "Issue identifier"),
        ("step" = Option<String>, Query, description = "Step name for step-level retry")
    ),
    // ... existing responses
)]
pub async fn post_retry(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
    Query(query): Query<RetryQuery>,
) -> impl IntoResponse {
    let mut lock = state.orchestrator_state.write().await;

    let issue_id = match find_issue_presence(&lock, &identifier) {
        IssuePresence::Retrying(id) => id,
        IssuePresence::Running(_) => {
            return issue_error_response(StatusCode::CONFLICT, "not_retrying",
                format!("issue '{}' is currently running", identifier));
        }
        IssuePresence::Finalizing(_) => {
            return issue_error_response(StatusCode::CONFLICT, "not_retrying",
                format!("issue '{}' is finalizing", identifier));
        }
        IssuePresence::Missing => {
            // Check for halted issues (PipelineRun exists, not running/retrying)
            match lock.find_issue_id_by_identifier(&identifier) {
                Some(id) => id,
                None => return issue_error_response(StatusCode::NOT_FOUND,
                    "issue_not_found", format!("no issue with identifier '{}'", identifier)),
            }
        }
    };

    if let Some(step_name) = &query.step {
        // Step-level retry: apply retry_from_step on PipelineRun, schedule retry
        let Some(run) = lock.get_pipeline_run_mut(&issue_id) else {
            return issue_error_response(StatusCode::CONFLICT, "no_pipeline_run",
                format!("issue '{}' has no resumable pipeline run", identifier));
        };
        run.retry_from_step(step_name);
        // Schedule retry with step info
        let identifier_copy = lock.running.get(&issue_id)
            .map(|e| e.identifier.clone())
            .or_else(|| lock.waiting_on_human.get(&issue_id)
                .map(|e| e.identifier.clone()))
            .unwrap_or(identifier.clone());
        let attempt = lock.running.get(&issue_id)
            .and_then(|e| e.retry_attempt)
            .map(|a| a + 1)
            .unwrap_or(1);
        let config = state.config.read().await;
        // Remove any existing retry entry before replacing it with the manual step retry.
        lock.remove_retry(&issue_id);
        lock.remove_waiting_on_human(&issue_id);
        schedule_failure_retry(
            &mut lock, &issue_id, &identifier_copy, attempt,
            config.agent.max_retry_backoff_ms, config.max_cycles,
            "manual step-level retry",
            Some(step_name.clone()), false,
        );
    } else {
        // Whole-issue retry (existing behavior)
        lock.remove_retry(&issue_id);
        lock.remove_claimed(&issue_id);
        // If halted, also remove pipeline run for clean fresh start
        lock.remove_pipeline_run(&issue_id);
    }

    drop(lock);
    state.refresh_requested.notify_one();

    (StatusCode::OK, Json(RetryResponse {
        retried: true,
        issue_identifier: identifier,
        message: if query.step.is_some() {
            "step-level retry queued".to_string()
        } else {
            "removed from retry queue, will be re-dispatched on next poll".to_string()
        },
    })).into_response()
}
```

- [ ] **Step 3: Update utoipa path annotations**

Add the query param schema and update the `params` in the `#[utoipa::path]` attribute to include `step`.

- [ ] **Step 4: Run API tests**

Run: `cargo test -p ensemble-core -- api::controls`
Expected: Tests pass, update any that need `Query` extraction.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/orchestrator/state.rs
git commit -m "feat: add step-level retry to API with ?step= query parameter"
```

### Task 10: Update documentation

**Files:**
- Modify: `docs/pipelines.md`

- [ ] **Step 1: Update verdict → result in pipeline docs**

Replace references to "verdict" with "result" throughout. Update value names: `"approve"` → `"succeeded"`, `"reject"` → `"failed"`. Add `"concern"` documentation.

- [ ] **Step 2: Add on_failure and step-level retry sections**

After the existing "Retries and cycles" section, add:

```markdown
## Step-level retry

When a step fails, step-level retry preserves passed steps and only re-runs the failed step and downstream dependents. Configured per step with `on_failure`:

```yaml
steps:
  - name: implement
    agent: builder
    on_failure: halt
  - name: review
    agent: reviewer
    on_failure: retry_step
  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [review-a, review-b]
    on_failure: fixup
    fixup_agent: fixer
```

### on_failure values

| Value | Behavior |
|-------|----------|
| `retry_issue` | Whole-issue retry (default). |
| `retry_step` | Step-level retry. Reset failed + downstream only. |
| `fixup` | Inject fixup agent before retrying. |
| `halt` | Stop pipeline. Require manual retry. |

### Concern result

Agents can return `Concern` to flag issues without halting the pipeline. Downstream steps see concerns in `dependency_outputs`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/pipelines.md
git commit -m "docs: update for results, step-level retry, on_failure, and Concern"
```

---

## Verification

```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
```

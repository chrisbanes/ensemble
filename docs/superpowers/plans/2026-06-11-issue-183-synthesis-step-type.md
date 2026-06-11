# Synthesis Step Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `kind: synthesis` pipeline step that runs an agent with all direct dependency `StepOutput` values available for merge, comparison, or adjudication.

**Architecture:** Build this on top of the step-output passing work that already exists: `PipelineRun` stores `StepOutput` values, and prompt templates already receive `steps` plus `dependency_outputs`. The new step kind is a configuration and scheduling semantic: existing steps default to `agent`, synthesis steps require explicit non-empty dependencies, dispatch carries the kind, and the agent prompt receives synthesis-specific runtime guidance while still using the configured agent runtime and verdict/output contract.

**Tech Stack:** Rust 2021, `serde`, `serde_yaml`, `serde_json`, `liquid`, `tokio`, React, TypeScript, Vitest

---

## Contract

Config:

```yaml
steps:
  - name: implement
    agent: builder
  - name: review-a
    agent: reviewer
    depends: [implement]
  - name: review-b
    agent: reviewer
    depends: [implement]
  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [review-a, review-b]
```

Rules:

- Existing configs keep working because omitted `kind` means `agent`.
- `kind: synthesis` still requires `agent`; the configured agent performs the synthesis.
- `kind: synthesis` must declare `depends` explicitly and the list must be non-empty.
- Synthesis steps receive final structured outputs only: each `dependency_outputs[]` entry contains `{ step, verdict, summary, output }`.
- Failed or rejected dependencies still block downstream dispatch as they do today. Approved dependencies with `output: null` are surfaced as `output: null`, not filtered.
- A synthesis step emits the same verdict contract as any other step: `verdict`, `summary`, and optional arbitrary JSON `output`.

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Modify | `crates/ensemble-core/src/config/ensemble.rs` | Add `StepKind`, parse/default `steps[].kind`, validate synthesis dependencies |
| Modify | `crates/ensemble-core/src/error.rs` | Add a specific validation error for invalid synthesis step configuration |
| Modify | `crates/ensemble-core/src/config/draft.rs` | Convert the new validation error to guided/YAML validation issues |
| Modify | `crates/ensemble-core/src/pipeline/dag.rs` | Preserve `StepKind` in resolved DAG steps |
| Modify | `crates/ensemble-core/src/pipeline/engine.rs` | Carry `StepKind` in `DispatchRequest` and keep output context ordering unchanged |
| Modify | `crates/ensemble-core/src/orchestrator/mod.rs` | Pass step kind from dispatch to agent runs |
| Modify | `crates/ensemble-core/src/agent/mod.rs` | Add synthesis prompt guidance when `request.step_kind == StepKind::Synthesis` |
| Modify | `crates/ensemble-core/src/config/form.rs` | Round-trip `kind` through guided config form extraction and merge |
| Modify | `crates/ensemble-core/src/api/config_edit_handler.rs` | Include `kind` in setup/guided response conversion where steps are serialized manually |
| Modify | `crates/ensemble-core/src/observability/snapshot.rs` and `crates/ensemble-core/src/orchestrator/state.rs` | Include step kind in runtime workflow snapshots if those structs expose step metadata |
| Modify | `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.tsx` | Add an Agent/Synthesis step kind control |
| Modify | `crates/ensemble-ui/src-ui/src/pages/ConfigStatus.tsx` | Display synthesis steps distinctly |
| Modify | `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.test.tsx` | Cover kind rendering and update callbacks |
| Modify | `docs/SPEC.md`, `docs/configuration.md`, `docs/pipelines.md` | Document the new step kind and synthesis pattern |

## Task 1: Add Step Kind to Typed Config

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/error.rs`
- Modify: `crates/ensemble-core/src/config/draft.rs`

- [ ] **Step 1: Write failing config parser and validation tests**

Add these tests near the existing `validate_config` tests in `crates/ensemble-core/src/config/ensemble.rs`:

```rust
#[test]
fn test_step_kind_defaults_to_agent() {
    let config = parse_config(
        r#"
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
"#,
    )
    .unwrap();

    assert_eq!(config.steps[0].kind, StepKind::Agent);
}

#[test]
fn test_parse_synthesis_step_kind() {
    let config = parse_config(
        r#"
tracker:
  kind: todo_file
agents:
  builder:
    acpx_agent: claude
    prompt: "Build it."
  synthesizer:
    acpx_agent: claude
    prompt: "Merge dependency outputs."
steps:
  - name: build
    agent: builder
  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [build]
on_success: Done
on_failure: Failed
"#,
    )
    .unwrap();

    assert_eq!(config.steps[1].kind, StepKind::Synthesis);
    assert!(validate_config(&config).is_ok());
}

#[test]
fn test_validate_synthesis_step_requires_explicit_dependencies() {
    let config = parse_config(
        r#"
tracker:
  kind: todo_file
agents:
  synth:
    acpx_agent: claude
    prompt: "Merge dependency outputs."
steps:
  - name: synthesize
    kind: synthesis
    agent: synth
on_success: Done
on_failure: Failed
"#,
    )
    .unwrap();

    let err = validate_config(&config).unwrap_err();
    assert!(matches!(
        err,
        PipelineError::InvalidSynthesisStep { step, reason }
            if step == "synthesize" && reason.contains("explicit non-empty depends")
    ));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core config::ensemble::tests::test_step_kind_defaults_to_agent config::ensemble::tests::test_parse_synthesis_step_kind config::ensemble::tests::test_validate_synthesis_step_requires_explicit_dependencies
```

Expected: FAIL because `StepKind` and `InvalidSynthesisStep` do not exist.

- [ ] **Step 3: Add the typed step kind**

In `crates/ensemble-core/src/config/ensemble.rs`, add this enum above `StepConfig`:

```rust
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    #[default]
    Agent,
    Synthesis,
}

impl StepKind {
    pub fn is_agent(self) -> bool {
        matches!(self, Self::Agent)
    }
}
```

Change `StepConfig` to include the new defaulted field:

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
}
```

- [ ] **Step 4: Add a validation error**

In `crates/ensemble-core/src/error.rs`, add this variant to `PipelineError`:

```rust
#[error("invalid synthesis step {step}: {reason}")]
InvalidSynthesisStep { step: String, reason: String },
```

In `validate_config`, after duplicate step-name validation and before `build_dag(&config.steps)?`, add:

```rust
for step in &config.steps {
    if step.kind == StepKind::Synthesis && step.depends.as_ref().is_none_or(Vec::is_empty) {
        return Err(PipelineError::InvalidSynthesisStep {
            step: step.name.clone(),
            reason: "synthesis steps require explicit non-empty depends".to_string(),
        });
    }
}
```

Use `step.depends.as_ref().map_or(true, Vec::is_empty)` instead if the Rust version in CI rejects `Option::is_none_or`.

- [ ] **Step 5: Map the validation error for draft validation**

In `crates/ensemble-core/src/config/draft.rs`, add a match arm to `pipeline_error_to_validation_issue`:

```rust
PipelineError::InvalidSynthesisStep { step, reason } => ValidationIssue {
    kind: ValidationIssueKind::Config,
    message: format!("invalid synthesis step '{}': {}", step, reason),
    section: "workflow".to_string(),
    field: Some("kind".to_string()),
    path: Some(format!("steps.{}", step)),
},
```

- [ ] **Step 6: Run focused config tests**

Run:

```bash
cargo test -p ensemble-core config::ensemble::tests::test_step_kind_defaults_to_agent config::ensemble::tests::test_parse_synthesis_step_kind config::ensemble::tests::test_validate_synthesis_step_requires_explicit_dependencies
```

Expected: PASS.

## Task 2: Carry Step Kind Through DAG and Dispatch

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/dag.rs`
- Modify: `crates/ensemble-core/src/pipeline/engine.rs`
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/observability/snapshot.rs`

- [ ] **Step 1: Write failing DAG and dispatch tests**

In `crates/ensemble-core/src/pipeline/dag.rs`, add:

```rust
#[test]
fn test_dag_preserves_synthesis_kind() {
    let steps = vec![
        StepConfig {
            name: "review-a".to_string(),
            kind: StepKind::Agent,
            agent: "reviewer".to_string(),
            depends: Some(vec![]),
            tracker_state: None,
            approval: None,
        },
        StepConfig {
            name: "synthesize".to_string(),
            kind: StepKind::Synthesis,
            agent: "synth".to_string(),
            depends: Some(vec!["review-a".to_string()]),
            tracker_state: None,
            approval: None,
        },
    ];

    let dag = build_dag(&steps).unwrap();
    let synth = dag.steps.iter().find(|step| step.name == "synthesize").unwrap();

    assert_eq!(synth.kind, StepKind::Synthesis);
}
```

In `crates/ensemble-core/src/pipeline/engine.rs`, add:

```rust
#[test]
fn dispatch_request_carries_synthesis_kind() {
    let steps = vec![
        StepConfig {
            name: "review-a".to_string(),
            kind: StepKind::Agent,
            agent: "reviewer".to_string(),
            depends: Some(vec![]),
            tracker_state: None,
            approval: None,
        },
        StepConfig {
            name: "synthesize".to_string(),
            kind: StepKind::Synthesis,
            agent: "synth".to_string(),
            depends: Some(vec!["review-a".to_string()]),
            tracker_state: None,
            approval: None,
        },
    ];
    let mut run = make_run(&steps);

    assert!(matches!(run.start(), PipelineAction::Dispatch(_)));
    let action = run.step_completed("review-a", approve_output(), false);

    match action {
        PipelineAction::Dispatch(requests) => {
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].step_name, "synthesize");
            assert_eq!(requests[0].step_kind, StepKind::Synthesis);
        }
        other => panic!("expected synthesis dispatch, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core pipeline::dag::tests::test_dag_preserves_synthesis_kind pipeline::engine::tests::dispatch_request_carries_synthesis_kind
```

Expected: FAIL because `DagStep` and `DispatchRequest` do not carry kind yet.

- [ ] **Step 3: Add kind to DAG and dispatch structs**

In `crates/ensemble-core/src/pipeline/dag.rs`, import `StepKind`, add `pub kind: StepKind` to `DagStep`, and copy `kind: step.kind` when building resolved steps.

In `crates/ensemble-core/src/pipeline/engine.rs`, import `StepKind`, add `pub step_kind: StepKind` to `DispatchRequest`, and set it in `find_dispatchable`:

```rust
DispatchRequest {
    step_name: s.name.clone(),
    step_kind: s.kind,
    agent_name: s.agent.clone(),
    tracker_state: s.tracker_state.clone(),
}
```

Update test helper `StepConfig` literals in touched modules to include `kind: StepKind::Agent`.

- [ ] **Step 4: Preserve kind in runtime snapshots**

If `CompletedWorkflowStep`, `WorkflowStepInfo`, or step detail structs in `crates/ensemble-core/src/orchestrator/state.rs` and `crates/ensemble-core/src/observability/snapshot.rs` represent configured step metadata, add:

```rust
pub kind: StepKind,
```

Populate it from `StepConfig.kind` or `DagStep.kind`. Existing API JSON should now include `"kind": "agent"` or `"kind": "synthesis"`.

- [ ] **Step 5: Run focused pipeline and snapshot tests**

Run:

```bash
cargo test -p ensemble-core pipeline::dag pipeline::engine observability::snapshot orchestrator::state
```

Expected: PASS.

## Task 3: Add Synthesis Prompt Guidance

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Write failing prompt test**

In `crates/ensemble-core/src/agent/mod.rs`, add a test next to `build_prompt_includes_step_outputs`:

```rust
#[tokio::test]
async fn build_prompt_adds_synthesis_guidance_for_synthesis_step() {
    use crate::config::ensemble::StepKind;
    use crate::pipeline::engine::{StepOutputTemplateContext, StepOutputTemplateEntry};
    use std::collections::HashMap;

    let runner = test_runner();
    let config = parse_config(
        r#"
tracker:
  kind: todo_file
agents:
  synth:
    prompt: 'Merge: {% for dep in dependency_outputs %}{{ dep.step }} {{ dep.summary }}{% endfor %}'
steps:
  - name: review-a
    agent: synth
    depends: []
  - name: synthesize
    kind: synthesis
    agent: synth
    depends: [review-a]
on_success: Done
on_failure: Todo
"#,
    )
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let context = StepOutputTemplateContext {
        steps: HashMap::from([(
            "review-a".to_string(),
            StepOutputTemplateEntry {
                step: "review-a".to_string(),
                verdict: "approve".to_string(),
                summary: Some("risk is low".to_string()),
                output: Some(serde_json::json!({"risk": "low"})),
            },
        )]),
        dependency_outputs: vec![StepOutputTemplateEntry {
            step: "review-a".to_string(),
            verdict: "approve".to_string(),
            summary: Some("risk is low".to_string()),
            output: Some(serde_json::json!({"risk": "low"})),
        }],
    };

    let prompt = runner
        .build_prompt(
            &config,
            BuildPromptRequest {
                issue: &test_issue(),
                agent_name: "synth",
                step_name: "synthesize",
                step_kind: StepKind::Synthesis,
                attempt: None,
                workspace_path: tmp.path(),
                turn_number: 1,
                step_outputs: &context,
            },
        )
        .await
        .unwrap();

    assert!(prompt.contains("This is a synthesis step."));
    assert!(prompt.contains("dependency_outputs"));
    assert!(prompt.contains("risk is low"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cargo test -p ensemble-core agent::tests::build_prompt_adds_synthesis_guidance_for_synthesis_step -- --exact
```

Expected: FAIL because `BuildPromptRequest` and `AgentRunRequest` do not include `step_kind`.

- [ ] **Step 3: Thread `StepKind` into agent requests**

In `crates/ensemble-core/src/agent/mod.rs`, add `StepKind` to imports and to both request structs:

```rust
pub step_kind: StepKind,
```

Update every test `AgentRunRequest` and `BuildPromptRequest` literal in `agent/mod.rs` and `acpx_runtime.rs` with `step_kind: StepKind::Agent` unless the test is explicitly synthesis-focused.

In `crates/ensemble-core/src/orchestrator/mod.rs`, add `step_kind: StepKind` to `StepDispatchContext`, populate it from `DispatchRequest.step_kind`, and pass it into `AgentRunRequest`.

- [ ] **Step 4: Add synthesis guidance**

In `crates/ensemble-core/src/agent/mod.rs`, add:

```rust
fn maybe_append_synthesis_instruction(rendered: String, step_kind: StepKind) -> String {
    if step_kind != StepKind::Synthesis {
        return rendered;
    }

    format!(
        "{rendered}\n\n\
         This is a synthesis step. Use the `dependency_outputs` Liquid data already rendered above as the authoritative set of direct predecessor results. \
         Merge, compare, or adjudicate those final structured outputs. Do not assume intermediate tool calls or hidden reasoning are available unless the prompt included them explicitly. \
         Return a normal Ensemble verdict with a concise `summary` and, when useful, a structured `output` JSON value describing the merged result."
    )
}
```

Call it after `render_prompt_with_context` and before `maybe_append_interaction_policy_instruction`:

```rust
let rendered = maybe_append_synthesis_instruction(rendered, step_kind);
let rendered = maybe_append_interaction_policy_instruction(
    rendered,
    resolve_interaction_policy_instruction(config, agent_name, step_name).as_deref(),
);
```

- [ ] **Step 5: Run focused agent and orchestrator tests**

Run:

```bash
cargo test -p ensemble-core agent::tests::build_prompt_adds_synthesis_guidance_for_synthesis_step orchestrator::tests
```

Expected: PASS.

## Task 4: Round-Trip Kind Through Config Editing APIs

**Files:**
- Modify: `crates/ensemble-core/src/config/form.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Modify: `crates/ensemble-core/tests/openapi_spec.rs`

- [ ] **Step 1: Write failing guided form tests**

In `crates/ensemble-core/src/config/form.rs`, add:

```rust
#[test]
fn extract_guided_form_includes_step_kind() {
    let raw = r#"
tracker:
  kind: todo_file
agents:
  synth:
    acpx_agent: claude
    prompt: Merge.
steps:
  - name: synthesize
    kind: synthesis
    agent: synth
    depends: [review-a]
on_success: Done
on_failure: Failed
"#;

    let form = extract_guided_form(raw).unwrap();

    assert_eq!(form.steps[0].kind.as_deref(), Some("synthesis"));
}

#[test]
fn apply_guided_form_writes_step_kind() {
    let base = r#"
tracker:
  kind: todo_file
agents:
  synth:
    acpx_agent: claude
    prompt: Merge.
steps:
  - name: synthesize
    agent: synth
on_success: Done
on_failure: Failed
"#;
    let mut form = extract_guided_form(base).unwrap();
    form.steps[0].kind = Some("synthesis".to_string());
    form.steps[0].depends = vec!["review-a".to_string()];

    let merged = apply_guided_form(base, &form).unwrap();

    assert!(merged.contains("kind: synthesis"));
    assert!(merged.contains("depends:"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cargo test -p ensemble-core config::form::tests::extract_guided_form_includes_step_kind config::form::tests::apply_guided_form_writes_step_kind
```

Expected: FAIL because `GuidedStepForm` has no `kind`.

- [ ] **Step 3: Add optional kind to guided form**

In `GuidedStepForm`, add:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub kind: Option<String>,
```

When extracting:

```rust
kind: (s.kind != StepKind::Agent).then(|| "synthesis".to_string()),
```

When applying:

```rust
step_mapping.remove("kind");
if let Some(ref kind) = s.kind {
    if kind != "agent" {
        step_mapping.insert("kind".into(), kind.clone().into());
    }
}
```

- [ ] **Step 4: Include kind in manually serialized setup shapes**

In `crates/ensemble-core/src/api/config_edit_handler.rs`, update the `steps` JSON conversion that emits `"agent_role"`:

```rust
"kind": match step.kind {
    crate::config::ensemble::StepKind::Agent => "agent",
    crate::config::ensemble::StepKind::Synthesis => "synthesis",
},
```

If setup request structs have a `SetupStep` equivalent, add `kind: Option<String>` there too and map it into generated `StepConfig.kind`.

- [ ] **Step 5: Run config API tests**

Run:

```bash
cargo test -p ensemble-core config::form api::config_edit_handler tests::openapi_spec
```

Expected: PASS. If `tests::openapi_spec` updates a checked-in OpenAPI snapshot, inspect the diff and keep only the schema changes for `StepKind`, `StepConfig.kind`, and `GuidedStepForm.kind`.

## Task 5: Update Frontend Config UI

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/config/WorkflowEditor.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/ConfigPage.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/ConfigStatus.tsx`

- [ ] **Step 1: Write failing UI test**

In `WorkflowEditor.test.tsx`, update `mockDraft.steps` to include `kind: "agent"` and add:

```tsx
it("allows marking a step as synthesis", async () => {
  const user = userEvent.setup();
  renderWithProviders(<WorkflowEditor value={mockDraft} onChange={mockOnChange} />);

  await user.click(screen.getAllByLabelText(/step kind/i)[1]);
  await user.click(screen.getByRole("option", { name: /synthesis/i }));

  expect(mockOnChange).toHaveBeenCalled();
  const lastCall = mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1];
  expect(lastCall?.[0].steps[1].kind).toBe("synthesis");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test -- WorkflowEditor.test.tsx --run
```

Expected: FAIL because the workflow editor has no kind selector.

- [ ] **Step 3: Add kind to frontend workflow types and mapping**

In `WorkflowEditor.tsx`, change `WorkflowStep`:

```ts
export interface WorkflowStep {
  name: string;
  kind?: "agent" | "synthesis";
  agent: string;
  depends: string[];
  tracker_state?: string | null;
}
```

Set new steps to `kind: "agent"`. Add a compact `Select` labelled `Step Kind` next to the agent select:

```tsx
<Select
  value={step.kind ?? "agent"}
  onValueChange={(val) =>
    updateStep(index, { kind: val as "agent" | "synthesis" })
  }
>
  <SelectTrigger aria-label={`Step kind ${step.name}`} id={`step-kind-${index}`}>
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="agent">Agent</SelectItem>
    <SelectItem value="synthesis">Synthesis</SelectItem>
  </SelectContent>
</Select>
```

In `ConfigPage.tsx`, preserve `kind` when mapping form steps:

```ts
steps: form.steps.map((step) => ({
  name: step.name,
  kind: step.kind ?? "agent",
  agent: step.agent,
  depends: step.depends ?? [],
  tracker_state: step.tracker_state ?? null,
})),
```

When submitting back to the API, omit `"agent"` or `undefined` if the backend form keeps kind optional:

```ts
kind: step.kind && step.kind !== "agent" ? step.kind : undefined,
```

- [ ] **Step 4: Show synthesis in config status**

In `ConfigStatus.tsx`, update step badges:

```tsx
{(step.kind ?? "agent") === "synthesis" && (
  <span className="ml-1 opacity-70">synthesis</span>
)}
```

Keep the current agent and dependency display.

- [ ] **Step 5: Run frontend tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test -- WorkflowEditor.test.tsx ConfigPage.test.tsx --run
```

Expected: PASS.

## Task 6: Update Documentation

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`
- Modify: `docs/pipelines.md`

- [ ] **Step 1: Update config reference**

In `docs/configuration.md`, add `kind` to the step fields table:

```markdown
| `kind` | string | `agent` | Step kind. Use `agent` for normal steps and `synthesis` for steps that merge direct dependency outputs. |
```

Add a short synthesis example under the pipeline section using the YAML from the contract above.

- [ ] **Step 2: Update pipeline docs**

In `docs/pipelines.md`, revise “Accessing dependency outputs” so the synthesis example uses:

```yaml
  - name: synthesize
    kind: synthesis
    agent: synthesizer
    depends: [review-a, review-b]
```

Add the rule:

```markdown
Synthesis steps must declare `depends` explicitly. Ensemble passes only final dependency outputs into the prompt context; intermediate tool calls and hidden reasoning are not injected.
```

- [ ] **Step 3: Update the spec**

In `docs/SPEC.md`, update `StepConfig` to include:

```markdown
- `kind` (string, optional, default `"agent"`)
  - `"agent"` — normal agent-backed step.
  - `"synthesis"` — agent-backed step intended to merge or adjudicate direct dependency outputs.
```

In the prompt-template section, state that synthesis steps receive the same `steps` and `dependency_outputs` variables as any downstream step, with runtime synthesis guidance appended to the first turn prompt.

- [ ] **Step 4: Verify docs mention every new behavior**

Run:

```bash
rg -n "kind: synthesis|synthesis steps|dependency_outputs|StepConfig" docs/SPEC.md docs/configuration.md docs/pipelines.md
```

Expected: output includes the new config field, validation rule, and pipeline example.

## Task 7: Final Verification

**Files:**
- No new files
- Verify workspace-wide behavior

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
cargo test -p ensemble-core config::ensemble config::form pipeline::dag pipeline::engine agent::tests::build_prompt_adds_synthesis_guidance_for_synthesis_step api::config_edit_handler tests::openapi_spec
```

Expected: PASS.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test -- WorkflowEditor.test.tsx ConfigPage.test.tsx --run
```

Expected: PASS.

- [ ] **Step 3: Run pre-push checks required for touched areas**

Run from repo root:

```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
```

If UI files changed, also run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test
pnpm run build
```

Expected: all commands exit 0.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Existing configs fail to parse | High | `StepKind` defaults to `Agent`; docs and tests verify omitted kind works |
| Guided config editing drops `kind` | Medium | Add `GuidedStepForm.kind` extraction and merge tests |
| Synthesis step dispatches without outputs | Medium | Validation requires explicit non-empty dependencies; existing scheduler only dispatches after dependencies pass |
| Synthesis prompt gets too much hidden context | Low | Runtime guidance says only rendered final dependency outputs are authoritative |
| UI generated API types lag backend schema | Medium | Run OpenAPI and frontend build checks; update checked-in generated types if build requires it |

## Open Questions

- Should `kind: synthesis` require at least two dependencies instead of one? This plan enforces explicit non-empty dependencies to support summarizer-style synthesis over one predecessor while still preventing root synthesis steps.
- Should the default `ensemble init` wizard offer a synthesis step preset? This plan updates guided editing but does not change init defaults, keeping the first release focused on first-class support for hand-authored and guided configs.

## Self-Review

- Spec coverage: the plan covers config schema, validation, DAG/dispatch propagation, prompt behavior, output semantics, UI config editing, API schema, and docs.
- Placeholder scan: no task relies on undefined implementation work; every code-changing step names the files and concrete snippets to add or modify.
- Type consistency: `StepKind::Agent`, `StepKind::Synthesis`, `steps[].kind`, `GuidedStepForm.kind`, `DispatchRequest.step_kind`, `AgentRunRequest.step_kind`, and `BuildPromptRequest.step_kind` are used consistently throughout the plan.

# Structured ACP Permission Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile direct ACP permission heuristics with typed policy selection that responds using ACP `PermissionOption.option_id` values.

**Architecture:** `ensemble-core` owns the durable config shape, validation, runtime policy selection, and structured agent events. The direct ACP runtime will convert a typed `PermissionRequestPolicy` into a selected permission option or `Cancelled` outcome using only structured ACP fields. Guided config and docs will be updated to expose the new tagged policy shape and remove legacy string policies.

**Tech Stack:** Rust 2021, serde/serde_yaml, utoipa, agent-client-protocol SDK, tokio tests, React/TypeScript guided config UI, Vitest.

---

## File Structure

- Modify `crates/ensemble-core/src/config/ensemble.rs`: add typed `PermissionRequestPolicy`, parse defaults, validate `select_option.option_id`, remove legacy `permission_policy` normalization, and update config tests.
- Modify `crates/ensemble-core/src/agent/acp_client.rs`: select permission options from typed policy, return selected option IDs through SDK responder, and emit structured permission events.
- Modify `crates/ensemble-core/src/agent/events.rs`: add structured permission option/event types and update `message_for_state`.
- Modify `crates/ensemble-core/src/agent/mod.rs`: pass cloned typed policy into `AcpSessionConfig`.
- Modify `crates/ensemble-core/src/config/form.rs`: expose the tagged policy in guided config extraction/merge and update tests.
- Modify `crates/ensemble-core/src/api/config_edit_handler.rs`: update guided form test fixtures and assertions for tagged policy output.
- Modify `crates/ensemble-core/src/orchestrator/mod.rs`: update embedded YAML test fixtures from `auto_approve_all` string to tagged `approve_all`.
- Modify `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`: update the local guided form type to the tagged permission policy.
- Modify `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.test.tsx` and `crates/ensemble-ui/src-ui/src/pages/ConfigPage.test.tsx`: update fixtures.
- Modify `docs/SPEC.md` and `docs/configuration.md`: document `approve_all`, `reject_all`, `select_option`, and client-specific option ID examples.

---

### Task 1: Add Typed Permission Policy Config

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Write failing config tests**

Add these tests near the existing permission request policy tests in `crates/ensemble-core/src/config/ensemble.rs`:

```rust
#[test]
fn test_parse_config_with_approve_all_permission_request_policy() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: "Review it."
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
agent:
  permission_request_policy:
    mode: approve_all
"#;
    let config = parse_config(yaml).unwrap();
    assert_eq!(
        config.agent.permission_request_policy,
        PermissionRequestPolicy::approve_all()
    );
    assert!(validate_config(&config).is_ok());
}

#[test]
fn test_parse_config_with_select_option_permission_request_policy() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: "Review it."
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
agent:
  permission_request_policy:
    mode: select_option
    option_id: allow_always
"#;
    let config = parse_config(yaml).unwrap();
    assert_eq!(
        config.agent.permission_request_policy,
        PermissionRequestPolicy::select_option("allow_always")
    );
    assert!(validate_config(&config).is_ok());
}

#[test]
fn select_option_permission_request_policy_requires_option_id() {
    let config = parse_config(
        r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hi
agent:
  permission_request_policy:
    mode: select_option
    option_id: ""
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
    )
    .unwrap();

    let err = validate_config(&config).unwrap_err();
    assert!(err.to_string().contains("option_id"));
}

#[test]
fn legacy_string_permission_request_policy_is_rejected() {
    let error = parse_config(
        r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hi
agent:
  permission_request_policy: auto_approve_all
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
    )
    .unwrap_err();

    assert!(error.to_string().contains("permission_request_policy"));
}

#[test]
fn legacy_permission_policy_key_is_rejected() {
    let error = parse_config(
        r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: hi
agent:
  permission_policy:
    mode: approve_all
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
"#,
    )
    .unwrap_err();

    assert!(error.to_string().contains("permission_policy"));
}
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
rtk cargo test -p ensemble-core permission_request_policy
```

Expected: tests fail because `PermissionRequestPolicy` does not exist and the config field is still a `String`.

- [ ] **Step 3: Implement typed policy**

In `crates/ensemble-core/src/config/ensemble.rs`, add these types near `AgentRuntimeConfig`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRequestPolicyMode {
    ApproveAll,
    RejectAll,
    SelectOption,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
pub struct PermissionRequestPolicy {
    pub mode: PermissionRequestPolicyMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
}

impl PermissionRequestPolicy {
    pub fn approve_all() -> Self {
        Self {
            mode: PermissionRequestPolicyMode::ApproveAll,
            option_id: None,
        }
    }

    pub fn reject_all() -> Self {
        Self {
            mode: PermissionRequestPolicyMode::RejectAll,
            option_id: None,
        }
    }

    pub fn select_option(option_id: impl Into<String>) -> Self {
        Self {
            mode: PermissionRequestPolicyMode::SelectOption,
            option_id: Some(option_id.into()),
        }
    }

    pub fn is_default(&self) -> bool {
        self == &Self::approve_all()
    }
}
```

Change `AgentRuntimeConfig.permission_request_policy`:

```rust
#[serde(default = "default_permission_request_policy")]
pub permission_request_policy: PermissionRequestPolicy,
```

Change the default helper:

```rust
fn default_permission_request_policy() -> PermissionRequestPolicy {
    PermissionRequestPolicy::approve_all()
}
```

Replace `normalize_agent_permission_request_policy(&mut value)?;` in `parse_config` with a rejection helper:

```rust
reject_legacy_agent_permission_policy(&value)?;
```

Add this helper near the old normalization helper and delete `normalize_agent_permission_request_policy`:

```rust
fn reject_legacy_agent_permission_policy(
    value: &serde_yaml::Value,
) -> Result<(), crate::error::ConfigError> {
    let Some(agent) = value
        .as_mapping()
        .and_then(|root| root.get(serde_yaml::Value::String("agent".to_string())))
        .and_then(serde_yaml::Value::as_mapping)
    else {
        return Ok(());
    };

    let legacy_key = serde_yaml::Value::String("permission_policy".to_string());
    if agent.contains_key(&legacy_key) {
        return Err(crate::error::ConfigError::ConfigParseError {
            reason: "agent.permission_policy is no longer supported; use agent.permission_request_policy.mode instead".to_string(),
        });
    }

    Ok(())
}
```

In `validate_config`, add validation before the acpx-only permission check:

```rust
if matches!(
    config.agent.permission_request_policy.mode,
    PermissionRequestPolicyMode::SelectOption
) && config
    .agent
    .permission_request_policy
    .option_id
    .as_deref()
    .map(str::trim)
    .unwrap_or("")
    .is_empty()
{
    return Err(PipelineError::InvalidRuntimeConfig {
        agent: "agent".to_string(),
        reason: "permission_request_policy.mode select_option requires a non-empty option_id"
            .to_string(),
    });
}
```

Change the acpx-only check to use `is_default()`:

```rust
if any_acpx
    && !any_direct
    && !config.agent.permission_request_policy.is_default()
{
    return Err(PipelineError::InvalidRuntimeConfig {
        agent: "agent".to_string(),
        reason: "permission_request_policy is ignored for acpx runtime; remove it or use direct runtime".to_string(),
    });
}
```

Update existing tests that assert `"auto_approve_all"` or `"manual"` to use the new tagged policy. Delete the tests that accepted `permission_policy` as a legacy alias.

- [ ] **Step 4: Run config tests**

Run:

```bash
rtk cargo test -p ensemble-core permission_request_policy
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/config/ensemble.rs
rtk git commit -m "Add typed ACP permission policy config"
```

---

### Task 2: Implement Structured ACP Permission Selection

**Files:**
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write failing permission selection tests**

In `crates/ensemble-core/src/agent/acp_client.rs`, update the test imports to include `RequestPermissionOutcome` and `SelectedPermissionOutcome` if needed, then replace the existing `select_permission_option_*` tests with:

```rust
fn selected_option_id(outcome: RequestPermissionOutcome) -> Option<String> {
    match outcome {
        RequestPermissionOutcome::Selected(selected) => Some(selected.option_id.to_string()),
        RequestPermissionOutcome::Cancelled => None,
        _ => None,
    }
}

#[test]
fn approve_all_selects_allow_always_before_allow_once() {
    let options = vec![
        PermissionOption::new("allow_once", "Allow once", PermissionOptionKind::AllowOnce),
        PermissionOption::new("allow_always", "Allow always", PermissionOptionKind::AllowAlways),
    ];

    let decision = resolve_permission_outcome(&PermissionRequestPolicy::approve_all(), &options);

    assert_eq!(selected_option_id(decision.outcome), Some("allow_always".to_string()));
    assert!(decision.allowed);
}

#[test]
fn approve_all_falls_back_to_allow_once() {
    let options = vec![
        PermissionOption::new("reject_once", "Reject once", PermissionOptionKind::RejectOnce),
        PermissionOption::new("allow_once", "Allow once", PermissionOptionKind::AllowOnce),
    ];

    let decision = resolve_permission_outcome(&PermissionRequestPolicy::approve_all(), &options);

    assert_eq!(selected_option_id(decision.outcome), Some("allow_once".to_string()));
    assert!(decision.allowed);
}

#[test]
fn reject_all_selects_reject_once_before_reject_always() {
    let options = vec![
        PermissionOption::new("reject_always", "Reject always", PermissionOptionKind::RejectAlways),
        PermissionOption::new("reject_once", "Reject once", PermissionOptionKind::RejectOnce),
    ];

    let decision = resolve_permission_outcome(&PermissionRequestPolicy::reject_all(), &options);

    assert_eq!(selected_option_id(decision.outcome), Some("reject_once".to_string()));
    assert!(!decision.allowed);
}

#[test]
fn reject_all_falls_back_to_reject_always() {
    let options = vec![PermissionOption::new(
        "reject_always",
        "Reject always",
        PermissionOptionKind::RejectAlways,
    )];

    let decision = resolve_permission_outcome(&PermissionRequestPolicy::reject_all(), &options);

    assert_eq!(selected_option_id(decision.outcome), Some("reject_always".to_string()));
    assert!(!decision.allowed);
}

#[test]
fn select_option_uses_exact_option_id() {
    let options = vec![
        PermissionOption::new("allow_once", "Read-only looking label", PermissionOptionKind::AllowOnce),
        PermissionOption::new("custom-deny", "Allow all text", PermissionOptionKind::RejectAlways),
    ];

    let decision = resolve_permission_outcome(
        &PermissionRequestPolicy::select_option("custom-deny"),
        &options,
    );

    assert_eq!(selected_option_id(decision.outcome), Some("custom-deny".to_string()));
    assert!(!decision.allowed);
}

#[test]
fn select_option_cancels_when_option_id_is_not_offered() {
    let options = vec![PermissionOption::new(
        "allow_once",
        "Allow once",
        PermissionOptionKind::AllowOnce,
    )];

    let decision = resolve_permission_outcome(
        &PermissionRequestPolicy::select_option("allow_always"),
        &options,
    );

    assert_eq!(selected_option_id(decision.outcome), None);
    assert!(!decision.allowed);
}
```

- [ ] **Step 2: Run failing selection tests**

Run:

```bash
rtk cargo test -p ensemble-core acp_client::tests
```

Expected: tests fail because `resolve_permission_outcome` and typed config imports are missing.

- [ ] **Step 3: Implement permission decision helper**

In `crates/ensemble-core/src/agent/acp_client.rs`, update imports:

```rust
use agent_client_protocol::schema::{
    ContentBlock, EnvVariable, InitializeRequest, McpServer, McpServerStdio, NewSessionRequest,
    PermissionOption, PermissionOptionId, PermissionOptionKind, ProtocolVersion,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigSelectOptions, SessionNotification, SessionUpdate,
    SetSessionModeRequest, StopReason as SdkStopReason,
};
use crate::config::ensemble::{
    DiscoveredCapabilities, ModeDefinition, ModelDefinition, PermissionRequestPolicy,
    PermissionRequestPolicyMode,
};
```

Change `AcpSessionConfig.permission_request_policy`:

```rust
pub permission_request_policy: PermissionRequestPolicy,
```

Delete `resolve_permission` and `select_permission_option`. Add:

```rust
#[derive(Debug, Clone)]
struct PermissionDecision {
    outcome: RequestPermissionOutcome,
    selected_option_id: Option<PermissionOptionId>,
    selected_option_kind: Option<PermissionOptionKind>,
    allowed: bool,
}

fn selected_decision(option: &PermissionOption) -> PermissionDecision {
    let allowed = matches!(
        option.kind,
        PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
    );
    PermissionDecision {
        outcome: RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            option.option_id.clone(),
        )),
        selected_option_id: Some(option.option_id.clone()),
        selected_option_kind: Some(option.kind),
        allowed,
    }
}

fn cancelled_decision() -> PermissionDecision {
    PermissionDecision {
        outcome: RequestPermissionOutcome::Cancelled,
        selected_option_id: None,
        selected_option_kind: None,
        allowed: false,
    }
}

fn find_option_by_kind(
    options: &[PermissionOption],
    kind: PermissionOptionKind,
) -> Option<&PermissionOption> {
    options.iter().find(|option| option.kind == kind)
}

fn resolve_permission_outcome(
    policy: &PermissionRequestPolicy,
    options: &[PermissionOption],
) -> PermissionDecision {
    let selected = match policy.mode {
        PermissionRequestPolicyMode::ApproveAll => find_option_by_kind(
            options,
            PermissionOptionKind::AllowAlways,
        )
        .or_else(|| find_option_by_kind(options, PermissionOptionKind::AllowOnce)),
        PermissionRequestPolicyMode::RejectAll => find_option_by_kind(
            options,
            PermissionOptionKind::RejectOnce,
        )
        .or_else(|| find_option_by_kind(options, PermissionOptionKind::RejectAlways)),
        PermissionRequestPolicyMode::SelectOption => policy
            .option_id
            .as_deref()
            .and_then(|option_id| {
                options
                    .iter()
                    .find(|option| option.option_id.to_string() == option_id)
            }),
    };

    selected.map(selected_decision).unwrap_or_else(cancelled_decision)
}
```

In `run_acp_session`, keep `let permission_policy = config.permission_request_policy.clone();` but now it clones the typed policy. Replace the callback selection block with:

```rust
let decision = resolve_permission_outcome(&permission_policy, &request.options);
let response = RequestPermissionResponse::new(decision.outcome);
```

Keep temporary `Notification` emission using `decision.allowed`; Task 3 will replace it with structured events.

In `crates/ensemble-core/src/agent/mod.rs`, update the `AcpSessionConfig` construction to pass the typed policy clone without converting to a string.

- [ ] **Step 4: Run selection tests**

Run:

```bash
rtk cargo test -p ensemble-core acp_client::tests
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/agent/acp_client.rs crates/ensemble-core/src/agent/mod.rs
rtk git commit -m "Select ACP permission options structurally"
```

---

### Task 3: Emit Structured Permission Events

**Files:**
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/agent/acp_client.rs`

- [ ] **Step 1: Write failing event serialization tests**

Add these tests to the `#[cfg(test)]` module in `crates/ensemble-core/src/agent/acp_client.rs`:

```rust
#[test]
fn permission_option_event_kind_serializes_as_snake_case() {
    let option = AgentPermissionOption {
        option_id: "allow_always".to_string(),
        name: "Allow always".to_string(),
        kind: AgentPermissionOptionKind::AllowAlways,
    };

    let value = serde_json::to_value(option).unwrap();

    assert_eq!(
        value,
        serde_json::json!({
            "option_id": "allow_always",
            "name": "Allow always",
            "kind": "allow_always"
        })
    );
}

#[test]
fn permission_requested_message_uses_tool_title() {
    let event = AgentEvent::PermissionRequested {
        tool_call_id: "tool-1".to_string(),
        title: Some("Run tests".to_string()),
        options: vec![],
    };

    assert_eq!(event.message_for_state().as_deref(), Some("Run tests"));
}
```

- [ ] **Step 2: Run failing event tests**

Run:

```bash
rtk cargo test -p ensemble-core permission_
```

Expected: tests fail because the structured event types do not exist.

- [ ] **Step 3: Add event types and event fields**

In `crates/ensemble-core/src/agent/events.rs`, add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: AgentPermissionOptionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentPermissionOutcome {
    Selected,
    Cancelled,
}
```

Replace the permission event variants:

```rust
PermissionRequested {
    tool_call_id: String,
    title: Option<String>,
    options: Vec<AgentPermissionOption>,
},
PermissionResolved {
    outcome: AgentPermissionOutcome,
    selected_option_id: Option<String>,
    selected_option_kind: Option<AgentPermissionOptionKind>,
    allowed: bool,
},
```

Update `message_for_state`:

```rust
AgentEvent::PermissionRequested { title, .. } => {
    title.as_deref().map(truncate_for_state)
}
AgentEvent::PermissionResolved {
    outcome,
    selected_option_id,
    ..
} => Some(Cow::Owned(match selected_option_id {
    Some(option_id) => format!("permission {outcome:?}: {option_id}"),
    None => format!("permission {outcome:?}"),
})),
```

Update imports in `acp_client.rs`:

```rust
use super::events::{
    AgentEvent, AgentPermissionOption, AgentPermissionOptionKind, AgentPermissionOutcome,
    RuntimeStream, TokenUsage, WorkerEvent,
};
```

Add conversion helpers in `acp_client.rs`:

```rust
fn event_permission_kind(kind: PermissionOptionKind) -> AgentPermissionOptionKind {
    match kind {
        PermissionOptionKind::AllowOnce => AgentPermissionOptionKind::AllowOnce,
        PermissionOptionKind::AllowAlways => AgentPermissionOptionKind::AllowAlways,
        PermissionOptionKind::RejectOnce => AgentPermissionOptionKind::RejectOnce,
        PermissionOptionKind::RejectAlways => AgentPermissionOptionKind::RejectAlways,
        _ => AgentPermissionOptionKind::RejectOnce,
    }
}

fn event_permission_options(options: &[PermissionOption]) -> Vec<AgentPermissionOption> {
    options
        .iter()
        .map(|option| AgentPermissionOption {
            option_id: option.option_id.to_string(),
            name: option.name.clone(),
            kind: event_permission_kind(option.kind),
        })
        .collect()
}
```

Add `tool_title` extraction:

```rust
let tool_call_id = request.tool_call.tool_call_id.to_string();
let title = request.tool_call.fields.title.clone();
```

Replace the current warning/notification permission events with:

```rust
emit_event(
    &event_tx_clone,
    &issue_id_owned,
    &step_name_owned,
    AgentEvent::PermissionRequested {
        tool_call_id,
        title,
        options: event_permission_options(&request.options),
    },
)
.await;

let decision = resolve_permission_outcome(&permission_policy, &request.options);
let response = RequestPermissionResponse::new(decision.outcome);

emit_event(
    &event_tx_clone,
    &issue_id_owned,
    &step_name_owned,
    AgentEvent::PermissionResolved {
        outcome: if decision.selected_option_id.is_some() {
            AgentPermissionOutcome::Selected
        } else {
            AgentPermissionOutcome::Cancelled
        },
        selected_option_id: decision
            .selected_option_id
            .as_ref()
            .map(ToString::to_string),
        selected_option_kind: decision.selected_option_kind.map(event_permission_kind),
        allowed: decision.allowed,
    },
)
.await;
```

- [ ] **Step 4: Run event tests**

Run:

```bash
rtk cargo test -p ensemble-core permission_
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/agent/events.rs crates/ensemble-core/src/agent/acp_client.rs
rtk git commit -m "Emit structured ACP permission events"
```

---

### Task 4: Update Guided Config Backend Shape

**Files:**
- Modify: `crates/ensemble-core/src/config/form.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`

- [ ] **Step 1: Write failing guided form tests**

In `crates/ensemble-core/src/config/form.rs`, replace the old `apply_guided_form_writes_permission_request_policy_without_legacy_key` expectations and add:

```rust
#[test]
fn extract_guided_form_includes_tagged_permission_request_policy() {
    let yaml = r#"
tracker:
  kind: todo_file
agents:
  reviewer:
    runtime: direct
    executor: codex
    model: gpt-5
    prompt: "Review it."
steps:
  - name: review
    agent: reviewer
on_success: Done
on_failure: Failed
agent:
  permission_request_policy:
    mode: select_option
    option_id: allow_always
"#;

    let form = extract_guided_form(yaml).unwrap();

    assert_eq!(form.runtime.agent.permission_request_policy.mode, "select_option");
    assert_eq!(
        form.runtime.agent.permission_request_policy.option_id.as_deref(),
        Some("allow_always")
    );
}

#[test]
fn apply_guided_form_writes_tagged_permission_request_policy() {
    let raw = r#"
tracker:
  kind: todo_file
  path: TODO.md
agents:
  builder:
    acpx_agent: claude
    prompt: hello
steps:
  - name: implement
    agent: builder
agent:
  permission_request_policy:
    mode: reject_all
on_success: Done
on_failure: Failed
"#;
    let mut form = guided_form_with_workspace_root("/tmp/ws");
    form.runtime.agent.permission_request_policy = GuidedPermissionRequestPolicyForm {
        mode: "select_option".to_string(),
        option_id: Some("allow_always".to_string()),
    };

    let merged = apply_guided_form(raw, &form).unwrap();
    let val: serde_yaml::Value = serde_yaml::from_str(&merged).unwrap();
    let policy = val
        .get("agent")
        .unwrap()
        .get("permission_request_policy")
        .unwrap()
        .as_mapping()
        .unwrap();

    assert_eq!(
        policy
            .get("mode")
            .and_then(serde_yaml::Value::as_str),
        Some("select_option")
    );
    assert_eq!(
        policy
            .get("option_id")
            .and_then(serde_yaml::Value::as_str),
        Some("allow_always")
    );
}
```

- [ ] **Step 2: Run failing guided form tests**

Run:

```bash
rtk cargo test -p ensemble-core tagged_permission_request_policy
```

Expected: tests fail because the guided form still uses `String`.

- [ ] **Step 3: Implement guided form policy type**

In `crates/ensemble-core/src/config/form.rs`, import the policy type:

```rust
use crate::config::ensemble::{
    ModeDefinition, ModelDefinition, PermissionRequestPolicy, PermissionRequestPolicyMode, StepKind,
};
```

Add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct GuidedPermissionRequestPolicyForm {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
}

impl From<&PermissionRequestPolicy> for GuidedPermissionRequestPolicyForm {
    fn from(policy: &PermissionRequestPolicy) -> Self {
        let mode = match policy.mode {
            PermissionRequestPolicyMode::ApproveAll => "approve_all",
            PermissionRequestPolicyMode::RejectAll => "reject_all",
            PermissionRequestPolicyMode::SelectOption => "select_option",
        }
        .to_string();
        Self {
            mode,
            option_id: policy.option_id.clone(),
        }
    }
}
```

Change `GuidedAgentRuntimeForm.permission_request_policy`:

```rust
pub permission_request_policy: GuidedPermissionRequestPolicyForm,
```

In `extract_guided_form`, set:

```rust
permission_request_policy: GuidedPermissionRequestPolicyForm::from(
    &config.agent.permission_request_policy,
),
```

In `apply_guided_form`, replace the string insertion with a mapping:

```rust
let mut policy = serde_yaml::Mapping::new();
policy.insert(
    serde_yaml::Value::String("mode".to_string()),
    serde_yaml::Value::String(form.runtime.agent.permission_request_policy.mode.clone()),
);
if let Some(option_id) = form
    .runtime
    .agent
    .permission_request_policy
    .option_id
    .clone()
    .filter(|value| !value.trim().is_empty())
{
    policy.insert(
        serde_yaml::Value::String("option_id".to_string()),
        serde_yaml::Value::String(option_id),
    );
}
am.insert(
    "permission_request_policy".into(),
    serde_yaml::Value::Mapping(policy),
);
am.remove("permission_policy");
```

Update all test fixture builders to use:

```rust
permission_request_policy: GuidedPermissionRequestPolicyForm {
    mode: "approve_all".to_string(),
    option_id: None,
},
```

Update `crates/ensemble-core/src/api/config_edit_handler.rs` fixtures from string policy values to:

```rust
permission_request_policy: GuidedPermissionRequestPolicyForm {
    mode: "approve_all".to_string(),
    option_id: None,
},
```

and import `GuidedPermissionRequestPolicyForm` where needed.

- [ ] **Step 4: Run guided backend tests**

Run:

```bash
rtk cargo test -p ensemble-core tagged_permission_request_policy
rtk cargo test -p ensemble-core save_guided_form_writes_permission_request_policy_to_saved_yaml
```

Expected: selected tests pass.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/config/form.rs crates/ensemble-core/src/api/config_edit_handler.rs
rtk git commit -m "Update guided config permission policy shape"
```

---

### Task 5: Update Frontend Guided Config Types

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.test.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/ConfigPage.test.tsx`

- [ ] **Step 1: Update frontend fixtures to fail typecheck first**

Change all guided form test fixtures that currently use:

```ts
permission_request_policy: "auto",
```

to:

```ts
permission_request_policy: { mode: "approve_all" },
```

Run:

```bash
rtk pnpm --dir crates/ensemble-ui/src-ui test -- --run GuidedEditor.test.tsx ConfigPage.test.tsx
```

Expected: TypeScript/Vitest fails because `GuidedForm` still expects a string.

- [ ] **Step 2: Update local guided form type**

In `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`, add:

```ts
interface PermissionRequestPolicy {
  mode: "approve_all" | "reject_all" | "select_option";
  option_id?: string;
}
```

Change the runtime agent type:

```ts
permission_request_policy: PermissionRequestPolicy;
```

No visible UI control is required in this task unless one already exists for the runtime permission policy. The guided editor should preserve and send the object shape it receives.

- [ ] **Step 3: Run frontend tests**

Run:

```bash
rtk pnpm --dir crates/ensemble-ui/src-ui test -- --run GuidedEditor.test.tsx ConfigPage.test.tsx
```

Expected: selected frontend tests pass.

- [ ] **Step 4: Commit**

```bash
rtk git add crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.test.tsx crates/ensemble-ui/src-ui/src/pages/ConfigPage.test.tsx
rtk git commit -m "Update guided UI permission policy type"
```

---

### Task 6: Update Docs and Fixtures

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Update docs**

In `docs/configuration.md`, replace the `permission_request_policy` row with:

```markdown
| `permission_request_policy.mode` | string | `"approve_all"` | Direct ACP permission policy: `approve_all`, `reject_all`, or `select_option` |
| `permission_request_policy.option_id` | string | — | Required when `mode: select_option`; must match an offered ACP `PermissionOption.option_id` |
```

Replace the legacy note with:

```markdown
`agent.permission_request_policy` only applies to direct ACP runtime paths. If all configured agents resolve to the `acpx` runtime, leave this at its default. In mixed configurations, it still applies only to agents using the direct runtime.

`select_option` is client-specific. It selects an offered ACP `PermissionOption.option_id` exactly and cancels the permission request if that option is not offered.
```

In `docs/SPEC.md`, update the config reference and direct ACP permission section to show:

```yaml
agent:
  permission_request_policy:
    mode: approve_all
```

and:

```yaml
agent:
  permission_request_policy:
    mode: select_option
    option_id: allow_always
```

Document that Ensemble no longer supports read/write inference and that verified option IDs should be documented per ACP client as examples, not protocol guarantees.

- [ ] **Step 2: Update embedded orchestrator YAML fixtures**

In `crates/ensemble-core/src/orchestrator/mod.rs`, replace each fixture occurrence:

```yaml
permission_request_policy: auto_approve_all
```

with:

```yaml
permission_request_policy:
  mode: approve_all
```

- [ ] **Step 3: Run doc/fixture affected tests**

Run:

```bash
rtk cargo test -p ensemble-core orchestrator
rtk cargo test -p ensemble-core config
```

Expected: relevant tests pass.

- [ ] **Step 4: Commit**

```bash
rtk git add docs/SPEC.md docs/configuration.md crates/ensemble-core/src/orchestrator/mod.rs
rtk git commit -m "Document structured ACP permission policies"
```

---

### Task 7: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Format**

Run:

```bash
rtk cargo fmt --all
```

Expected: command succeeds.

- [ ] **Step 2: Run core tests**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
```

Expected: tests pass.

- [ ] **Step 3: Run clippy**

Run:

```bash
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
```

Expected: clippy passes with no warnings.

- [ ] **Step 4: Run frontend tests**

Run:

```bash
rtk pnpm --dir crates/ensemble-ui/src-ui test
```

Expected: frontend tests pass.

- [ ] **Step 5: Run frontend build**

Run:

```bash
rtk pnpm --dir crates/ensemble-ui/src-ui run build
```

Expected: frontend build passes.

- [ ] **Step 6: Confirm the worktree is clean**

Run:

```bash
rtk git status --short
```

Expected: no output.

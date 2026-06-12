# Web UI Agent Capability Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make web setup and guided config editing use discovered ACP models and modes instead of free-text/read-only fields, and pass configured `reasoning_level` to `acpx`.

**Architecture:** Reuse the existing ACP capability discovery types already present in `ensemble-core`: `ModelDefinition`, `ModeDefinition`, and `DiscoveredCapabilities`. Populate those capabilities in setup agent discovery responses, persist selected model/reasoning/mode fields through setup and guided forms, and update the React controls to prefer dropdowns with custom fallbacks when discovery data is available.

**Tech Stack:** Rust 2021, tokio, axum SSE, serde/utoipa OpenAPI, React 19, TypeScript, shadcn/Radix Select, Vitest, orval.

---

## File Structure

- Modify `crates/ensemble-core/src/config/setup.rs`
  - Extend `SetupAgent` with `reasoning_level` and `permission_mode`.
  - Emit those fields from generated setup YAML when present.
  - Add a typed `discover_agent_info(name, label)` helper or equivalent so REST and SSE can reuse capability discovery.

- Modify `crates/ensemble-core/src/api/config_edit_handler.rs`
  - Populate `DiscoveredAgentInfo.available_models` and `available_modes` in `get_setup_agents`.
  - Populate the same fields in `get_setup_agents_stream`.
  - Add API tests for discovery metadata serialization and setup save behavior.

- Modify `crates/ensemble-core/src/agent/mod.rs`
  - Append `--reasoning-level <value>` when an `acpx_agent` has `reasoning_level`.
  - Add command-resolution tests.

- Modify `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx`
  - Replace model free text with a discovered-model dropdown plus custom fallback.
  - Add reasoning-level and mode/permission controls.
  - Treat `available_modes` as the source for `permission_mode` only when the discovered IDs match backend-supported permission modes.
  - Copy discovered capabilities into selected setup agents when an agent is selected.

- Modify `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`
  - Replace read-only agent display for `model`, `reasoning_level`, and `permission_mode` with inline controls.
  - Use stored `available_models` and `available_modes` from the guided form.
  - Filter mode options to backend-supported `permission_mode` values so the guided editor does not produce invalid YAML.

- Modify `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.test.tsx`
  - Extend the EventSource mock with discovered capabilities.
  - Add tests for model dropdown, custom fallback, reasoning selection, and mode selection.

- Modify `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.test.tsx`
  - Add tests proving inline edits call `onValidate`/`onSave` with updated agent fields.

- Regenerate generated client files under `crates/ensemble-ui/src-ui/src/generated/`
  - Run `pnpm run codegen` from `crates/ensemble-ui/src-ui`.

- Update docs if behavior changes:
  - `docs/configuration.md` for `agents.<name>.reasoning_level`, `permission_mode`, and discovered `available_models`/`available_modes` if not already documented.
  - `docs/SPEC.md` only if it describes the setup wizard or runtime launch arguments.

---

### Task 1: Backend Setup Schema And YAML Persistence

**Files:**
- Modify: `crates/ensemble-core/src/config/setup.rs`
- Test: `crates/ensemble-core/src/config/setup.rs`

- [ ] **Step 1: Write failing tests for setup agent fields**

Add tests near the existing `generate_yaml` tests in `crates/ensemble-core/src/config/setup.rs`:

```rust
#[test]
fn generate_yaml_includes_reasoning_level_and_permission_mode() {
    let request = SetupRequest {
        tracker: SetupTracker::TodoFile {
            path: PathBuf::from("TODO.md"),
        },
        repos: vec![],
        agents: vec![SetupAgent {
            role: "builder".to_string(),
            acpx_agent: "claude".to_string(),
            model: Some("sonnet".to_string()),
            reasoning_level: Some("high".to_string()),
            permission_mode: Some("approve_reads".to_string()),
            prompt: Some("Build it.".to_string()),
            prompt_file: None,
        }],
        steps: vec![SetupStep {
            name: "build".to_string(),
            agent_role: "builder".to_string(),
            kind: None,
            depends: vec![],
            tracker_state: None,
        }],
        on_success: "Done".to_string(),
        on_failure: "Failed".to_string(),
    };

    let yaml = generate_yaml(&request);

    assert!(yaml.contains("model: sonnet"));
    assert!(yaml.contains("reasoning_level: high"));
    assert!(yaml.contains("permission_mode: approve_reads"));
}
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```bash
rtk cargo test -p ensemble-core config::setup::tests::generate_yaml_includes_reasoning_level_and_permission_mode
```

Expected: FAIL because `SetupAgent` has no `reasoning_level` or `permission_mode` fields yet.

- [ ] **Step 3: Extend `SetupAgent` and YAML generation**

Change `SetupAgent` in `crates/ensemble-core/src/config/setup.rs`:

```rust
pub struct SetupAgent {
    pub role: String,
    pub acpx_agent: String,
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Inline prompt text (optional)
    pub prompt: Option<String>,
    /// Path to prompt template file (optional, maps to prompt_template in config)
    pub prompt_file: Option<String>,
}
```

In `generate_yaml`, after the existing `model` block, add:

```rust
if let Some(ref reasoning_level) = agent.reasoning_level {
    agent_map.insert(
        "reasoning_level".into(),
        serde_yaml::Value::String(reasoning_level.clone()),
    );
}
if let Some(ref permission_mode) = agent.permission_mode {
    agent_map.insert(
        "permission_mode".into(),
        serde_yaml::Value::String(permission_mode.clone()),
    );
}
```

Update any existing test `SetupAgent` literals in `setup.rs` to include:

```rust
reasoning_level: None,
permission_mode: None,
```

- [ ] **Step 4: Run targeted setup tests**

Run:

```bash
rtk cargo test -p ensemble-core config::setup::tests::generate_yaml_includes_reasoning_level_and_permission_mode
rtk cargo test -p ensemble-core config::setup
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/setup.rs
git commit -m "feat: persist setup agent capability selections"
```

---

### Task 2: Populate Setup Discovery Capabilities

**Files:**
- Modify: `crates/ensemble-core/src/config/setup.rs`
- Modify: `crates/ensemble-core/src/api/config_edit_handler.rs`
- Test: `crates/ensemble-core/src/api/config_edit_handler.rs`

- [ ] **Step 1: Write failing tests for `DiscoveredAgentInfo` capability fields**

Add a small pure helper in the production code first only if needed for testability:

```rust
fn discovered_agent_info_from_parts(
    name: String,
    label: String,
    version: String,
    capabilities: crate::config::setup::AgentCapabilities,
) -> DiscoveredAgentInfo {
    DiscoveredAgentInfo {
        name,
        label,
        version,
        available_models: if capabilities.typed_models.is_empty() {
            capabilities
                .available_models
                .into_iter()
                .map(|id| crate::config::ensemble::ModelDefinition {
                    name: id.clone(),
                    id,
                    description: None,
                })
                .collect()
        } else {
            capabilities.typed_models
        },
        available_modes: capabilities.available_modes,
    }
}
```

Then add a test:

```rust
#[test]
fn discovered_agent_info_includes_typed_capabilities() {
    let info = discovered_agent_info_from_parts(
        "claude".to_string(),
        "Claude".to_string(),
        "1.0.0".to_string(),
        crate::config::setup::AgentCapabilities {
            available_models: vec![],
            typed_models: vec![crate::config::ensemble::ModelDefinition {
                id: "sonnet".to_string(),
                name: "Claude Sonnet".to_string(),
                description: Some("Balanced".to_string()),
            }],
            available_modes: vec![crate::config::ensemble::ModeDefinition {
                id: "plan".to_string(),
                name: "Plan".to_string(),
                description: Some("Plan first".to_string()),
            }],
        },
    );

    assert_eq!(info.available_models[0].id, "sonnet");
    assert_eq!(info.available_models[0].name, "Claude Sonnet");
    assert_eq!(info.available_modes[0].id, "plan");
}
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```bash
rtk cargo test -p ensemble-core api::config_edit_handler::tests::discovered_agent_info_includes_typed_capabilities
```

Expected: FAIL until the helper exists and the mapping is wired.

- [ ] **Step 3: Reuse the helper in REST and SSE discovery**

In `get_setup_agents`, replace the hardcoded empty vectors:

```rust
let agent_infos: Vec<DiscoveredAgentInfo> = agents
    .into_iter()
    .map(|a| DiscoveredAgentInfo {
        name: a.name.clone(),
        label: a.label,
        version: a.version,
        available_models: Vec::new(),
        available_modes: Vec::new(),
    })
    .collect();
```

with a concurrent capability probe per discovered agent. Keep failures best-effort:

```rust
let mut agent_infos = Vec::new();
for agent in agents {
    let capabilities = crate::config::setup::discover_agent_capabilities(&agent.name).await;
    agent_infos.push(discovered_agent_info_from_parts(
        agent.name,
        agent.label,
        agent.version,
        capabilities,
    ));
}
```

In `get_setup_agents_stream`, change the task body to probe version first, then capabilities:

```rust
probe_tasks.spawn(async move {
    let version = crate::config::setup::probe_agent(&name).await?;
    let capabilities = crate::config::setup::discover_agent_capabilities(&name).await;
    Some(discovered_agent_info_from_parts(
        name,
        label,
        version,
        capabilities,
    ))
});
```

If serial capability probing in `get_setup_agents` is too slow, use a `JoinSet` there too. Preserve the existing response behavior: discovery failures return an empty list, and per-agent capability failures return empty capability vectors for that agent.

- [ ] **Step 4: Run backend API tests**

Run:

```bash
rtk cargo test -p ensemble-core api::config_edit_handler
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/config_edit_handler.rs crates/ensemble-core/src/config/setup.rs
git commit -m "feat: expose discovered agent capabilities in setup API"
```

---

### Task 3: Pass Reasoning Level To ACPX

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write failing command-resolution test**

Add a test near the existing `resolve_agent_command` tests:

```rust
#[test]
fn resolve_agent_command_includes_reasoning_level_for_acpx_agent() {
    let config = crate::config::ensemble::AgentConfig {
        acpx_agent: Some("builder".to_string()),
        model: Some("gpt-5".to_string()),
        reasoning_level: Some("high".to_string()),
        ..Default::default()
    };

    let command = resolve_agent_command(Some(&config), "fallback").unwrap();

    assert_eq!(command.program, PathBuf::from("acpx"));
    assert_eq!(
        command.args,
        vec![
            "--agent".to_string(),
            "builder".to_string(),
            "--model".to_string(),
            "gpt-5".to_string(),
            "--reasoning-level".to_string(),
            "high".to_string(),
        ]
    );
}
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```bash
rtk cargo test -p ensemble-core agent::tests::resolve_agent_command_includes_reasoning_level_for_acpx_agent
```

Expected: FAIL because the args omit `--reasoning-level`.

- [ ] **Step 3: Append the launch flag in `resolve_agent_command`**

In `resolve_agent_command`, immediately after the `model` block:

```rust
if let Some(ref reasoning_level) = ac.reasoning_level {
    args.push("--reasoning-level".to_string());
    args.push(reasoning_level.clone());
}
```

Do not add this to non-`acpx_agent` executor paths.

- [ ] **Step 4: Decide whether discovery should include reasoning level**

Keep `resolve_acpx_acp_command` unchanged unless manual testing proves `acpx` requires `--reasoning-level` during capability discovery. Discovery should usually remain minimal because it only needs `configOptions`.

- [ ] **Step 5: Run targeted agent tests**

Run:

```bash
rtk cargo test -p ensemble-core agent::tests::resolve_agent_command_includes_reasoning_level_for_acpx_agent
rtk cargo test -p ensemble-core agent::tests::resolve_agent_command
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/mod.rs
git commit -m "feat: pass reasoning level to acpx agents"
```

---

### Task 4: Setup Wizard Capability Controls

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.test.tsx`

- [ ] **Step 1: Extend the EventSource mock with capabilities**

In `SetupWizard.test.tsx`, change `mockAgents` entries to include capability data:

```ts
const mockAgents = [
  {
    name: "builder",
    label: "Builder Agent",
    version: "1.0.0",
    available_models: [
      { id: "default", name: "Default" },
      { id: "sonnet", name: "Sonnet" },
    ],
    available_modes: [
      { id: "approve_reads", name: "Approve reads" },
      { id: "approve_all", name: "Approve all" },
    ],
  },
  {
    name: "reviewer",
    label: "Reviewer Agent",
    version: "1.0.0",
    available_models: [],
    available_modes: [],
  },
];
```

- [ ] **Step 2: Write failing UI tests**

Add tests that navigate to the Agents step, select `Builder Agent`, then assert:

```ts
expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
expect(screen.getByText("Sonnet")).toBeInTheDocument();
expect(screen.getByLabelText(/reasoning/i)).toBeInTheDocument();
expect(screen.getByLabelText(/mode/i)).toBeInTheDocument();
```

Add a save/validate flow assertion that the request body contains:

```ts
expect(body.setup.agents[0]).toMatchObject({
  acpx_agent: "builder",
  model: "sonnet",
  reasoning_level: "high",
  permission_mode: "approve_reads",
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- SetupWizard.test.tsx
```

Expected: FAIL because the controls do not exist or do not write those fields.

- [ ] **Step 4: Add helper functions in `SetupWizard.tsx`**

Add helpers above the component:

```ts
const CUSTOM_VALUE = "__custom__";
const NONE_VALUE = "__none__";

function capabilityLabel(item: { id: string; name: string; description?: string | null }) {
  return item.name || item.id;
}

function findDiscoveredAgent(
  agents: DiscoveredAgentInfo[],
  name: string | null | undefined
) {
  return agents.find((agent) => agent.name === name);
}
```

Use `available_models` and `available_modes` from the selected discovered agent. For `reasoning_level`, use a fixed option list until ACP exposes a dedicated reasoning category:

```ts
const REASONING_LEVELS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
];
```

- [ ] **Step 5: Replace model free-text with dropdown plus custom fallback**

When `selectedDiscoveredAgent.available_models` has items, render a `Select` with those items and `Custom...`. Store `"default"` as `null` to match the CLI behavior:

```tsx
<Select
  value={customModels[index] ? CUSTOM_VALUE : agent.model ?? "default"}
  onValueChange={(value) => {
    if (value === CUSTOM_VALUE) {
      setCustomModels((prev) => ({ ...prev, [index]: true }));
      return;
    }
    setCustomModels((prev) => ({ ...prev, [index]: false }));
    setDraft((prev) => {
      const newAgents = [...prev.agents];
      newAgents[index] = { ...agent, model: value === "default" ? null : value };
      return { ...prev, agents: newAgents };
    });
  }}
>
  <SelectTrigger id={`agent-model-${index}`}>
    <SelectValue placeholder="Select model" />
  </SelectTrigger>
  <SelectContent>
    {selectedDiscoveredAgent.available_models.map((model) => (
      <SelectItem key={model.id} value={model.id}>
        {capabilityLabel(model)}
      </SelectItem>
    ))}
    <SelectItem value={CUSTOM_VALUE}>Custom...</SelectItem>
  </SelectContent>
</Select>
```

If no models are available or custom mode is active, keep an `Input` below the select:

```tsx
<Input
  id={`agent-model-custom-${index}`}
  value={agent.model || ""}
  onChange={(event) => updateAgent(index, { model: event.target.value || null })}
  placeholder="e.g., gpt-5"
/>
```

- [ ] **Step 6: Add reasoning-level select**

Render:

```tsx
<Select
  value={agent.reasoning_level ?? NONE_VALUE}
  onValueChange={(value) =>
    updateAgent(index, { reasoning_level: value === NONE_VALUE ? null : value })
  }
>
  <SelectTrigger id={`agent-reasoning-${index}`}>
    <SelectValue placeholder="Select reasoning" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value={NONE_VALUE}>Default</SelectItem>
    {REASONING_LEVELS.map((level) => (
      <SelectItem key={level.id} value={level.id}>
        {level.name}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

- [ ] **Step 7: Add mode/permission select from discovered modes**

Map `available_modes` to `permission_mode` only for IDs the backend already accepts. `AgentConfig` does not currently have a separate arbitrary `mode` field, and `EnsembleConfig::validate` rejects `permission_mode` values outside `approve_all`, `approve_reads`, and `deny_all`.

Add helpers:

```ts
const PERMISSION_MODE_FALLBACKS = [
  { id: "approve_reads", name: "Approve reads" },
  { id: "approve_all", name: "Approve all" },
  { id: "deny_all", name: "Deny all" },
];

const SUPPORTED_PERMISSION_MODES = new Set(
  PERMISSION_MODE_FALLBACKS.map((mode) => mode.id)
);

function permissionModeOptions(
  availableModes: Array<{ id: string; name: string; description?: string | null }> | undefined
) {
  const discovered = (availableModes ?? []).filter((mode) =>
    SUPPORTED_PERMISSION_MODES.has(mode.id)
  );
  return discovered.length > 0 ? discovered : PERMISSION_MODE_FALLBACKS;
}
```

Render:

```tsx
<Select
  value={agent.permission_mode ?? NONE_VALUE}
  onValueChange={(value) =>
    updateAgent(index, { permission_mode: value === NONE_VALUE ? null : value })
  }
>
  <SelectTrigger id={`agent-mode-${index}`}>
    <SelectValue placeholder="Select mode" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value={NONE_VALUE}>Default</SelectItem>
    {permissionModeOptions(selectedDiscoveredAgent?.available_modes).map((mode) => (
      <SelectItem key={mode.id} value={mode.id}>
        {capabilityLabel(mode)}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

If issue scope later requires storing ACP modes such as `plan` that are not ACPX permission flags, add a separate backend config field in a follow-up issue instead of overloading `permission_mode`.

- [ ] **Step 8: Run SetupWizard tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- SetupWizard.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx crates/ensemble-ui/src-ui/src/components/config/SetupWizard.test.tsx
git commit -m "feat: add setup wizard agent capability controls"
```

---

### Task 5: Guided Editor Inline Agent Controls

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.test.tsx`

- [ ] **Step 1: Extend `GuidedForm.agents` type**

In `GuidedEditor.tsx`, add:

```ts
available_models?: Array<{ id: string; name: string; description?: string | null }>;
available_modes?: Array<{ id: string; name: string; description?: string | null }>;
```

to the agent type.

- [ ] **Step 2: Write failing inline-edit tests**

Update `initialForm.agents[0]` in `GuidedEditor.test.tsx`:

```ts
model: "sonnet",
reasoning_level: "medium",
available_models: [
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
],
available_modes: [
  { id: "approve_reads", name: "Approve reads" },
  { id: "approve_all", name: "Approve all" },
],
```

Add a test that selects `Opus`, `High`, and `Approve all`, clicks Save, and asserts the `onSave` argument:

```ts
expect(onSave).toHaveBeenCalledWith(
  expect.objectContaining({
    agents: [
      expect.objectContaining({
        name: "builder",
        model: "opus",
        reasoning_level: "high",
        permission_mode: "approve_all",
      }),
    ],
  })
);
```

- [ ] **Step 3: Run the targeted test and verify failure**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- GuidedEditor.test.tsx
```

Expected: FAIL because the agent fields are read-only.

- [ ] **Step 4: Render editable controls**

Replace the read-only agent grid for model/reasoning/mode with controlled `Select`/`Input` controls. Keep `acpx_agent`, `executor`, and prompt display unchanged unless editing them is already supported elsewhere.

Use the same constants and helper semantics as `SetupWizard.tsx`:

```tsx
<Select
  value={agent.model ?? NONE_VALUE}
  onValueChange={(value) =>
    handleAgentChange(agent.name, { model: value === NONE_VALUE ? undefined : value })
  }
>
  <SelectTrigger id={`guided-agent-model-${agent.name}`}>
    <SelectValue placeholder="Default" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value={NONE_VALUE}>Default</SelectItem>
    {(agent.available_models ?? []).map((model) => (
      <SelectItem key={model.id} value={model.id}>
        {model.name || model.id}
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

For agents without `available_models`, render an `Input` for `model`.

Add a `reasoning_level` select using `low`, `medium`, `high`.

Add a `permission_mode` select using filtered `available_modes` or the fallback permission-mode list. Use the same `SUPPORTED_PERMISSION_MODES` and `permissionModeOptions` helpers from `SetupWizard.tsx`.

- [ ] **Step 5: Add `handleAgentChange`**

Add:

```ts
function handleAgentChange(
  name: string,
  patch: Partial<GuidedForm["agents"][number]>
) {
  setForm((prev) => ({
    ...prev,
    agents: prev.agents.map((agent) =>
      agent.name === name ? { ...agent, ...patch } : agent
    ),
  }));
}
```

Use `undefined` for cleared optional fields so `save_guided_form` removes them.

- [ ] **Step 6: Run guided editor tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test -- GuidedEditor.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.test.tsx
git commit -m "feat: edit agent capabilities in guided config"
```

---

### Task 6: Regenerate OpenAPI Client And Verify Type Integration

**Files:**
- Modify: `crates/ensemble-ui/src-ui/openapi.json`
- Modify: `crates/ensemble-ui/src-ui/src/generated/**`

- [ ] **Step 1: Regenerate the OpenAPI spec and client**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm run codegen
```

Expected: generated `SetupAgent` includes `reasoning_level` and `permission_mode`; `DiscoveredAgentInfo` includes `available_models` and `available_modes`.

- [ ] **Step 2: Run TypeScript tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm run build
```

Expected: PASS.

- [ ] **Step 4: Commit generated files**

```bash
git add crates/ensemble-ui/src-ui/openapi.json crates/ensemble-ui/src-ui/src/generated
git commit -m "chore: regenerate config API client"
```

---

### Task 7: Documentation And Full Verification

**Files:**
- Modify if needed: `docs/configuration.md`
- Modify if needed: `docs/SPEC.md`

- [ ] **Step 1: Check documentation coverage**

Run:

```bash
rtk rg -n "reasoning_level|permission_mode|available_models|available_modes|acpx" docs/configuration.md docs/SPEC.md
```

Expected: identify whether the new UI/setup behavior and `--reasoning-level` launch behavior are documented.

- [ ] **Step 2: Update docs when needed**

If `docs/configuration.md` does not already document `reasoning_level`, add it to the per-agent fields table:

```markdown
| `reasoning_level` | string | no | Optional ACPX reasoning level passed as `--reasoning-level <value>` for `acpx_agent` agents. Common values are `low`, `medium`, and `high`; unsupported values are left to the selected agent/runtime to reject. |
```

If `available_models` and `available_modes` are documented as runtime-discovered metadata, clarify that the web UI can use them to render dropdowns and that they may be omitted from hand-written configs.

- [ ] **Step 3: Run Rust verification**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
```

Expected: PASS.

- [ ] **Step 4: Run frontend verification**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test
rtk pnpm run build
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

If docs changed:

```bash
git add docs/configuration.md docs/SPEC.md
git commit -m "docs: document agent capability selection"
```

If docs did not need changes, note that in the implementation summary.

---

## Self-Review

- Spec coverage:
  - Issue item 1 is covered by Task 4 model dropdown with custom fallback.
  - Issue item 2 is covered by Task 4 and Task 5 reasoning-level controls.
  - Issue item 3 is covered by Task 4 and Task 5 mode/permission controls from backend-compatible `available_modes`; arbitrary ACP modes should get a dedicated config field in a follow-up rather than being forced into `permission_mode`.
  - Issue item 4 is covered by Task 2 SSE and REST discovery metadata.
  - Issue item 5 is covered by Task 3 `--reasoning-level`.
  - Issue item 6 is covered by Task 5 guided inline editing.

- Placeholder scan:
  - No `TBD`, generic edge-case placeholders, or undefined task references remain.

- Type consistency:
  - Backend setup uses `reasoning_level` and `permission_mode` because those are existing `AgentConfig`/guided-form fields.
  - Discovery keeps `available_models` as `ModelDefinition[]` and `available_modes` as `ModeDefinition[]`, matching `DiscoveredAgentInfo` and guided form capability fields.
  - UI cleared optional fields use `null` for generated setup types where existing code already uses `null`, and `undefined` for guided editor local form fields where existing code uses optional properties.

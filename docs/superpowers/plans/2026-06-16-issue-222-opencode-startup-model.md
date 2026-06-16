# Issue 222 Opencode Startup Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `acpx_agent: opencode` with `model: provider/model` launch opencode through its startup model flag instead of ACP generic `--model`.

**Architecture:** Add a small model-application strategy for acpx-backed agents. Existing agents keep using acpx's generic top-level `--model`; opencode with a configured model uses the raw ACP command path `opencode --model <model> acp` so model selection happens before the ACP session starts. Reuse that strategy for the direct acpx CLI runtime and the ACP capability-discovery command so discovery does not retry a known unsupported generic model path.

**Tech Stack:** Rust 2021, tokio process tests, existing `shell_words` command parsing/quoting, serde YAML setup generation, existing acpx runtime and init wizard tests.

---

## File Structure

### Modify
- `crates/ensemble-core/src/agent/acpx_cli.rs` — add an acpx agent invocation helper and use it when building `sessions ensure`, `prompt`, `cancel`, and `sessions close` commands.
- `crates/ensemble-core/src/agent/mod.rs` — reuse the same opencode startup model rule for ACP capability discovery.
- `crates/ensemble-cli/src/commands/init/agents.rs` — extract a pure model-selection helper so init only preserves/writes models for agents with an applicable model path.
- `docs/configuration.md` — document opencode model semantics for `acpx_agent`.
- `docs/SPEC.md` — document that some acpx adapters apply model selection at process startup, not through ACP generic model switching.

### Existing Tests To Extend
- `crates/ensemble-core/src/agent/acpx_cli.rs` unit tests.
- `crates/ensemble-core/src/agent/mod.rs` unit tests near `resolve_acpx_acp_command_includes_agent_and_model`.
- `crates/ensemble-cli/src/commands/init/agents.rs` unit tests.

---

### Task 1: Add Opencode Startup Model Command Mapping

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs`

- [ ] **Step 1: Write the failing opencode argv test**

In `crates/ensemble-core/src/agent/acpx_cli.rs`, replace the existing `ensure_session_puts_model_before_agent` test with this pair of tests. The first preserves generic behavior for normal agents. The second locks opencode to adapter startup model behavior.

```rust
#[tokio::test]
async fn ensure_session_puts_generic_model_before_non_opencode_agent() {
    let dir = tempfile::TempDir::new().unwrap();
    let args_path = dir.path().join("args.txt");
    let script = write_mock_acpx_script(
        dir.path(),
        &format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"{}\"\n",
            args_path.display()
        ),
    );

    let client = AcpxCli::new(script);
    client
        .ensure_session(
            "codex",
            "build-session",
            dir.path(),
            AcpxCommandOptions {
                model: Some("gpt-5.4/medium"),
                reasoning_level: None,
            },
        )
        .await
        .unwrap();

    let args = std::fs::read_to_string(args_path).unwrap();
    let argv: Vec<&str> = args.lines().collect();
    let model_pos = argv.iter().position(|arg| *arg == "--model").unwrap();
    let agent_pos = argv.iter().position(|arg| *arg == "codex").unwrap();

    assert!(model_pos < agent_pos, "argv was {argv:?}");
    assert_eq!(argv[model_pos + 1], "gpt-5.4/medium");
}

#[tokio::test]
async fn ensure_session_uses_opencode_startup_model_command() {
    let dir = tempfile::TempDir::new().unwrap();
    let args_path = dir.path().join("args.txt");
    let script = write_mock_acpx_script(
        dir.path(),
        &format!(
            "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"{}\"\n",
            args_path.display()
        ),
    );

    let client = AcpxCli::new(script);
    client
        .ensure_session(
            "opencode",
            "build-session",
            dir.path(),
            AcpxCommandOptions {
                model: Some("opencode-go/kimi-k2.5"),
                reasoning_level: None,
            },
        )
        .await
        .unwrap();

    let args = std::fs::read_to_string(args_path).unwrap();
    let argv: Vec<&str> = args.lines().collect();

    assert_eq!(argv[0], "--agent");
    assert_eq!(argv[1], "opencode --model opencode-go/kimi-k2.5 acp");
    assert!(
        !argv.iter().any(|arg| *arg == "--model"),
        "generic --model must not be passed to acpx for opencode: {argv:?}"
    );
    assert!(argv.ends_with(&["sessions", "ensure", "--name", "build-session"]));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk cargo test -p ensemble-core ensure_session_uses_opencode_startup_model_command -- --exact
```

Expected: FAIL because current command construction passes top-level `--model` and uses positional `opencode`.

- [ ] **Step 3: Add an acpx invocation helper**

Add this helper near `AcpxCommandOptions` in `crates/ensemble-core/src/agent/acpx_cli.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
enum AcpxAgentInvocation {
    BuiltIn(String),
    RawCommand(String),
}

impl AcpxAgentInvocation {
    fn for_agent(agent: &str, model: Option<&str>) -> Self {
        if agent == "opencode" {
            if let Some(model) = model {
                return Self::RawCommand(format!(
                    "opencode --model {} acp",
                    shell_words::quote(model)
                ));
            }
        }

        Self::BuiltIn(agent.to_string())
    }

    fn append_global_args(&self, command: &mut Command, options: AcpxCommandOptions<'_>) {
        match self {
            Self::BuiltIn(_) => {
                if let Some(model) = options.model {
                    command.args(["--model", model]);
                }
            }
            Self::RawCommand(raw_command) => {
                command.args(["--agent", raw_command]);
            }
        }

        if let Some(reasoning_level) = options.reasoning_level {
            command.args(["--reasoning-level", reasoning_level]);
        }
    }

    fn append_agent_command(&self, command: &mut Command) {
        if let Self::BuiltIn(agent) = self {
            command.arg(agent);
        }
    }
}
```

- [ ] **Step 4: Use the helper in every acpx command builder**

In `ensure_session`, replace the direct `--model` block and positional `.arg(agent)` with:

```rust
let invocation = AcpxAgentInvocation::for_agent(agent, options.model);
invocation.append_global_args(&mut command, options);
command
    .arg("--cwd")
    .arg(cwd.display().to_string())
    .args(["--format", "json", "--json-strict"]);
invocation.append_agent_command(&mut command);
command.args(["sessions", "ensure", "--name", session_name]);
```

In `base_command`, replace the direct `--model` block and positional `.arg(agent)` with:

```rust
let invocation = AcpxAgentInvocation::for_agent(agent, options.model);
invocation.append_global_args(&mut command, options);
command
    .arg("--cwd")
    .arg(cwd.display().to_string())
    .args(["--format", "json", "--json-strict"]);
invocation.append_agent_command(&mut command);
```

This makes `run_prompt`, `cancel`, and `close_session` inherit the same mapping through `base_command`.

- [ ] **Step 5: Run focused acpx CLI tests**

Run:

```bash
rtk cargo test -p ensemble-core agent::acpx_cli::tests::ensure_session_puts_generic_model_before_non_opencode_agent agent::acpx_cli::tests::ensure_session_uses_opencode_startup_model_command -- --exact
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/acpx_cli.rs
git commit -m "fix: launch opencode with startup model flag"
```

---

### Task 2: Keep Capability Discovery Off Generic Opencode `--model`

**Files:**
- Modify: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write the failing discovery command test**

Add this test next to `resolve_acpx_acp_command_includes_agent_and_model` in `crates/ensemble-core/src/agent/mod.rs`:

```rust
#[test]
fn resolve_acpx_acp_command_uses_opencode_startup_model_command() {
    let resolved = resolve_acpx_acp_command(&crate::config::ensemble::AgentConfig {
        runtime: Some("acpx".to_string()),
        executor: None,
        model: Some("opencode-go/kimi-k2.5".to_string()),
        acpx_agent: Some("opencode".to_string()),
        permission_mode: None,
        prompt: Some("Build it.".to_string()),
        prompt_template: None,
        reasoning_level: None,
        available_models: Vec::new(),
        available_modes: Vec::new(),
    })
    .unwrap();

    assert_eq!(resolved.program, PathBuf::from("opencode"));
    assert_eq!(
        resolved.args,
        vec![
            "--model".to_string(),
            "opencode-go/kimi-k2.5".to_string(),
            "acp".to_string(),
        ]
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk cargo test -p ensemble-core resolve_acpx_acp_command_uses_opencode_startup_model_command -- --exact
```

Expected: FAIL because `resolve_acpx_acp_command` currently returns `acpx --agent opencode --model ...`.

- [ ] **Step 3: Add a discovery command helper**

Add this helper above `resolve_acpx_acp_command`:

```rust
fn resolve_acpx_discovery_command(
    acpx_name: &str,
    model: Option<&str>,
) -> ResolvedCommand {
    if acpx_name == "opencode" {
        if let Some(model) = model {
            return ResolvedCommand {
                program: PathBuf::from("opencode"),
                args: vec!["--model".to_string(), model.to_string(), "acp".to_string()],
                env: Vec::new(),
            };
        }
    }

    let mut args = vec!["--agent".to_string(), acpx_name.to_string()];
    if let Some(model) = model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    ResolvedCommand {
        program: PathBuf::from("acpx"),
        args,
        env: Vec::new(),
    }
}
```

Update `resolve_acpx_acp_command` to call it:

```rust
Ok(resolve_acpx_discovery_command(
    acpx_name,
    agent_config.model.as_deref(),
))
```

- [ ] **Step 4: Keep the existing generic discovery test green**

Update no assertions in `resolve_acpx_acp_command_includes_agent_and_model`; it should continue to expect:

```rust
vec![
    "--agent".to_string(),
    "codex".to_string(),
    "--model".to_string(),
    "gpt-5".to_string(),
]
```

- [ ] **Step 5: Run focused discovery tests**

Run:

```bash
rtk cargo test -p ensemble-core resolve_acpx_acp_command_includes_agent_and_model resolve_acpx_acp_command_uses_opencode_startup_model_command -- --exact
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/agent/mod.rs
git commit -m "fix: discover opencode capabilities with startup model"
```

---

### Task 3: Guard Init Model Persistence

**Files:**
- Modify: `crates/ensemble-cli/src/commands/init/agents.rs`

- [ ] **Step 1: Write pure helper tests**

Add these tests in the existing `#[cfg(test)] mod tests`:

```rust
#[test]
fn should_offer_model_selection_for_multiple_discovered_models() {
    let caps = AgentCapabilities {
        available_models: vec!["default".to_string(), "sonnet".to_string()],
        ..Default::default()
    };

    assert!(should_offer_model_selection("codex", &caps));
}

#[test]
fn should_not_offer_model_selection_without_discovered_models() {
    let caps = AgentCapabilities::default();

    assert!(!should_offer_model_selection("codex", &caps));
}

#[test]
fn should_preserve_existing_model_only_for_startup_model_agents() {
    let caps = AgentCapabilities::default();

    assert_eq!(
        retained_existing_model("opencode", &caps, Some("opencode-go/kimi-k2.5")),
        Some("opencode-go/kimi-k2.5".to_string())
    );
    assert_eq!(retained_existing_model("codex", &caps, Some("gpt-5")), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk cargo test -p ensemble-cli should_preserve_existing_model_only_for_startup_model_agents -- --exact
```

Expected: FAIL because the helper functions do not exist.

- [ ] **Step 3: Add model-selection helpers**

Add these functions above `ask_roles`:

```rust
fn supports_adapter_startup_model(agent_name: &str) -> bool {
    agent_name == "opencode"
}

fn should_offer_model_selection(agent_name: &str, caps: &AgentCapabilities) -> bool {
    let has_choices = caps.available_models.len() > 1;
    has_choices || (supports_adapter_startup_model(agent_name) && has_choices)
}

fn retained_existing_model(
    agent_name: &str,
    caps: &AgentCapabilities,
    existing_model: Option<&str>,
) -> Option<String> {
    if should_offer_model_selection(agent_name, caps) {
        return None;
    }

    if supports_adapter_startup_model(agent_name) {
        return existing_model.map(str::to_string);
    }

    None
}
```

- [ ] **Step 4: Use the helpers in `ask_roles`**

Replace the `let model = if caps.available_models.len() > 1 { ... } else { None };` block with:

```rust
let model = if should_offer_model_selection(agent_name, &caps) {
    let model_default = existing_model.unwrap_or("default");
    let default_idx = caps
        .available_models
        .iter()
        .position(|m| m == model_default)
        .unwrap_or(0);

    let chosen = inquire::Select::new(
        &format!("  {agent_name} → model"),
        caps.available_models.clone(),
    )
    .with_starting_cursor(default_idx)
    .prompt()
    .map_err(|e| e.to_string())?;

    if chosen == "default" {
        None
    } else {
        Some(chosen)
    }
} else {
    retained_existing_model(agent_name, &caps, existing_model)
};
```

This keeps fresh init from inventing `model:` when no applicable selection exists, and it prevents reconfigure from deleting an existing opencode model that the runtime can now apply through startup flags.

- [ ] **Step 5: Run init helper tests**

Run:

```bash
rtk cargo test -p ensemble-cli should_offer_model_selection_for_multiple_discovered_models should_not_offer_model_selection_without_discovered_models should_preserve_existing_model_only_for_startup_model_agents -- --exact
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-cli/src/commands/init/agents.rs
git commit -m "fix: preserve supported opencode model config during init"
```

---

### Task 4: Update Documentation

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Update configuration reference**

In `docs/configuration.md`, under the agent fields table or immediately after it, add:

```markdown
For `acpx_agent` entries, `model` normally maps to acpx's generic model selection.
Some adapters require startup-time model selection instead. `acpx_agent: opencode`
uses opencode's startup command (`opencode --model <provider/model> acp`) so
`model: provider/model` remains valid even when opencode does not advertise ACP
generic model switching.
```

- [ ] **Step 2: Update the service spec**

In `docs/SPEC.md` section `4.1.3 Agent Config`, extend the `model` bullet:

```markdown
- `model` (string or null) — model to use for the agent. For `acpx_agent` adapters
  that advertise ACP model switching, this is applied through acpx generic model
  selection. For adapters with startup-only model selection, implementations apply
  the model to the adapter process before ACP initialization; opencode is one such
  adapter.
```

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md docs/SPEC.md
git commit -m "docs: document adapter startup model selection"
```

---

### Task 5: Verification

**Files:**
- No source edits expected.

- [ ] **Step 1: Run targeted Rust tests**

Run:

```bash
rtk cargo test -p ensemble-core agent::acpx_cli::tests::ensure_session_puts_generic_model_before_non_opencode_agent agent::acpx_cli::tests::ensure_session_uses_opencode_startup_model_command -- --exact
rtk cargo test -p ensemble-core resolve_acpx_acp_command_includes_agent_and_model resolve_acpx_acp_command_uses_opencode_startup_model_command -- --exact
rtk cargo test -p ensemble-cli should_offer_model_selection_for_multiple_discovered_models should_not_offer_model_selection_without_discovered_models should_preserve_existing_model_only_for_startup_model_agents -- --exact
```

Expected: all PASS.

- [ ] **Step 2: Run broader affected test suites**

Run:

```bash
rtk cargo test -p ensemble-core agent::acpx_cli::tests
rtk cargo test -p ensemble-core agent::tests
rtk cargo test -p ensemble-cli init
```

Expected: all PASS.

- [ ] **Step 3: Run pre-push Rust checks for this change**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
```

Expected: all PASS.

---

## Self-Review

- Spec coverage: The plan covers runtime launch, ACP capability discovery, init-time model persistence, docs, and verification from issue 222.
- Placeholder scan: No `TBD`, `TODO`, or deferred implementation steps remain.
- Type consistency: The plan uses existing `AcpxCommandOptions`, `ResolvedCommand`, `AgentCapabilities`, and `AgentConfig` fields without introducing new serialized config schema.
- Scope check: This is a single focused fix. It intentionally does not add a generalized adapter registry until another adapter needs startup-only model selection.

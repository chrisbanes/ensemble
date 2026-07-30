# Ensemble

Ensemble is CI for autonomous coding agents. It turns issue-tracker work into repeatable, config-driven agent pipelines: poll for eligible tickets, create isolated workspaces, run named agents through explicit steps, collect structured results, and move tracker state at workflow boundaries.

## How it works

Ensemble reads issues from a tracker (GitHub Projects/repository labels, Notion, or a local TODO file), creates a workspace directory for each one, and runs a pipeline of named agents against it. Each agent gets a prompt rendered from the issue context and previous step outputs. Ensemble runs a hidden extraction turn to collect a strict `StepOutput` (`succeeded`, `failed`, or `concern`) and uses the configured pipeline policy to continue, retry, or fail the issue. Failed issues retry with exponential backoff.

All behavior is configured in a `config.yaml` file that lives in a configuration directory (default: `~/.config/ensemble/` on Linux, `~/Library/Application Support/ensemble/` on macOS).

## Install

Tagged releases publish CLI and desktop artifacts and update the Homebrew tap. Once a release is
available:

```sh
brew install ensemble
```

Or build from source:

```sh
git clone https://github.com/chrisbanes/ensemble.git
cd ensemble
cargo install --path crates/ensemble-cli
```

Source installs are headless by default and include `ensemble init`, `ensemble run`, and
`ensemble open-config-dir`. To include the embedded web dashboard, generate the frontend first and
enable the `web-ui` feature:

```sh
cd crates/ensemble-ui/src-ui
pnpm install --frozen-lockfile
pnpm run codegen
cd ../../..
cargo install --path crates/ensemble-cli --features web-ui
```

## Quick start

**1. Create a configuration directory:**

```sh
ensemble init
```

This walks you through setting up your tracker, agents, and pipeline. It creates a configuration directory containing:
- `config.yaml` — main configuration file
- `templates/` — prompt templates
- `.env` — environment variables (auto-loaded)
- `~/ensemble/TODO.md` — default TODO tracker state (if using todo_file)

**2. Or write one by hand:**

Create a directory for your config (e.g., `~/.config/ensemble/`) and add a `config.yaml`:

```yaml
tracker:
  kind: todo_file
  # path defaults to ~/ensemble/TODO.md if not specified

agents:
  builder:
    acpx_agent: claude
    prompt_template: templates/implement.liquid

steps:
  - name: build
    agent: builder

on_success: Done
on_failure: Failed
```

**3. Run:**

```sh
ensemble run
```

Ensemble polls the tracker, picks up eligible issues, and runs them through the pipeline.

To also start the web dashboard:

```sh
ensemble web --port 3000
```

The `web` subcommand is available in release builds and source builds installed with
`--features web-ui`.

Then open `http://localhost:3000` in your browser.

## Configuration location

By default, Ensemble looks for configuration in your system's config directory:
- **Linux:** `~/.config/ensemble/`
- **macOS:** `~/Library/Application Support/ensemble/`
- **Windows:** `%APPDATA%\ensemble\`

You can override this with:
- `--config-dir <path>` flag
- `ENSEMBLE_CONFIG_DIR` environment variable

**Open the config directory:**

```sh
ensemble open-config-dir
```

This opens the resolved configuration directory in your system's file manager. If the directory doesn't exist, it will suggest running `ensemble init`.

**Legacy note:** The old `ENSEMBLE_CONFIG` environment variable and `--config` flag are no longer supported. Use `ENSEMBLE_CONFIG_DIR` and `--config-dir` instead.

## Core concepts

**Trackers** connect Ensemble to your issue source. Supported: GitHub Projects/repository labels (`github`), Notion (`notion`), and local TODO files (`todo_file`). The tracker defines which states are active (pollable) and terminal (done). For `todo_file`, the default path is `~/ensemble/TODO.md`.

**Agents** are named definitions that pair an executor (like `claude-code`) with a prompt. Prompts can be inline strings or [Liquid](https://shopify.github.io/liquid/) template files with access to issue context.

**Pipelines** are a DAG of steps, each referencing an agent. Steps run sequentially by default. Use `depends` to create parallel branches. This is the CI-like contract: the pipeline, not the agent, defines the delivery gates. See [Pipeline Guide](docs/pipelines.md).

**Workspaces** are isolated directories created per-issue. They persist across retries and get cleaned up when the issue reaches a terminal state. Shell hooks run at lifecycle points (create, before/after run, remove).

**Step outputs** are how Ensemble turns agent work into pipeline decisions. After the visible working turn, Ensemble asks the same runtime session for structured JSON with `result`, optional `summary`, and optional downstream `output`. Verdict files and default-success fallbacks are not part of the current runtime contract.

**Human interactions** are thread-scoped and deterministic: when an agent blocks for human input, Ensemble creates a tracker thread and accepts strict slash commands (`/approve`, `/reject`, `/answer`) with first-valid-command-wins semantics.

## Documentation

- [Configuration Reference](docs/configuration.md) — every `config.yaml` field
- [Pipeline Guide](docs/pipelines.md) — steps, DAGs, step outputs, retries
- [SDD Workflow](docs/sdd-workflow.md) — parent planning issues, wave execution issues, and board rules
- [Domain Glossary](CONTEXT.md) — canonical terms used by the runtime and documentation
- [Architecture Decisions](docs/adr/) — durable architectural choices and their rationale
- [Contributing](docs/contributing.md) — building, testing, project structure
- [Roadmap](docs/roadmap.md) — what's built, what's coming

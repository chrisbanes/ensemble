# Ensemble

Ensemble is a service that orchestrates coding agents against your issue tracker. It polls for work, creates isolated workspaces, runs agents through a configurable pipeline, and writes results back to the tracker.

## How it works

Ensemble reads issues from a tracker (GitHub Projects/repository labels, Notion, or a local TODO file), creates a workspace directory for each one, and runs a pipeline of named agents against it. Each agent gets a prompt rendered from the issue context. Agents report verdicts (approve/reject), and Ensemble transitions the issue state accordingly. Failed issues retry with exponential backoff.

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

**Pipelines** are a DAG of steps, each referencing an agent. Steps run sequentially by default. Use `depends` to create parallel branches. See [Pipeline Guide](docs/pipelines.md).

**Workspaces** are isolated directories created per-issue. They persist across retries and get cleaned up when the issue reaches a terminal state. Shell hooks run at lifecycle points (create, before/after run, remove).

**Verdicts** are how agents report results. An agent can approve (step passes) or reject with a summary (step fails). Ensemble reads verdicts from the ACP protocol or a `.ensemble/verdict.json` file in the workspace.

## Documentation

- [Configuration Reference](docs/configuration.md) — every `config.yaml` field
- [Pipeline Guide](docs/pipelines.md) — steps, DAGs, verdicts, retries
- [SDD Workflow](docs/sdd-workflow.md) — parent planning issues, wave execution issues, and board rules
- [Contributing](docs/contributing.md) — building, testing, project structure
- [Roadmap](docs/roadmap.md) — what's built, what's coming

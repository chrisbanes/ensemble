# Roadmap

## What's working today

- **Configuration** — `ensemble.yaml` loader with typed config, environment variable resolution, and validation
- **Trackers** — GitHub Projects v2 (full GraphQL read/write) and local TODO file backends
- **Pipelines** — DAG-based step execution with sequential and parallel steps
- **Verdicts** — ACP protocol and `.ensemble/verdict.json` file fallback
- **Agents** — ACP client over stdio (JSON-RPC 2.0) for agent communication
- **Orchestrator** — Poll-dispatch-reconcile loop with state management and retry logic
- **Workspaces** — Per-issue directory isolation with lifecycle hooks
- **API** — REST endpoints (axum) with OpenAPI spec generation
- **Live streaming** — WebSocket endpoint for real-time pipeline events
- **Dashboard** — React SPA with issue overview, detail views, and history
- **Init wizard** — `ensemble init` interactive setup with agent discovery
- **Desktop app** — Tauri 2 scaffold

## What's coming

- **CLI orchestrator wiring** — the orchestrator loop is implemented but not yet spawned by `ensemble run` (it's the last integration step)
- **Desktop integration** — connecting the Tauri shell to ensemble-core so the desktop app starts the orchestrator and serves the dashboard
- **Homebrew distribution** — `brew install ensemble`

## Not planned

These are explicitly out of scope:

- Multi-tenant control plane or SaaS hosting
- General-purpose workflow engine or distributed job scheduler
- Built-in business logic for editing tickets, PRs, or comments (that's the agent's job)
- Mandating a single sandbox or approval policy (left to the deployment environment)

# Roadmap

## What's working today

- **Configuration** — `config.yaml` loader with typed config, environment variable resolution, and validation
- **Trackers** — GitHub Projects v2, GitHub repository labels, Notion, and local TODO file backends
- **Pipelines** — DAG-based step execution with sequential and parallel steps
- **Verdicts** — ACP protocol and `.ensemble/verdict.json` file fallback
- **Agents** — ACP client over stdio (JSON-RPC 2.0) for agent communication
- **Orchestrator** — Poll-dispatch-reconcile loop with state management and retry logic
- **Workspaces** — Per-issue directory isolation with lifecycle hooks
- **API** — REST endpoints (axum) with OpenAPI spec generation
- **Live streaming** — WebSocket endpoint for real-time pipeline events
- **Dashboard** — React SPA with issue overview, detail views, and history
- **Init wizard** — `ensemble init` interactive setup with agent discovery
- **Desktop app** — Tauri 2 shell that serves the shared dashboard and starts the shared orchestrator runtime

## What's coming

- **Release verification** — cut and verify the first public Homebrew release from the tag-driven release workflow
- **Richer tracker feedback** — continue expanding tracker comments and handoff summaries where the backend supports them

## Not planned

These are explicitly out of scope:

- Multi-tenant control plane or SaaS hosting
- General-purpose workflow engine or distributed job scheduler
- Built-in business logic for editing tickets, PRs, or comments (that's the agent's job)
- Mandating a single sandbox or approval policy (left to the deployment environment)

---
status: accepted
---

# Share one core runtime across all hosts

Ensemble is a Cargo workspace in which `ensemble-core` owns configuration, trackers, pipelines, orchestration, workspaces, persistence, and the HTTP API. The headless CLI, web CLI, and Tauri desktop app are thin hosts over the same bootstrap and embedded UI assets, preventing host-specific orchestration drift and keeping GUI dependencies out of headless builds.

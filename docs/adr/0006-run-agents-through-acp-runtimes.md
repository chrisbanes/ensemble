---
status: accepted
---

# Run agents through ACP runtimes

Agent execution uses the typed Agent Client Protocol rather than per-agent output parsing. Agents with an `acpx_agent` use the acpx session runtime and capability discovery by default, while an explicit direct runtime remains available as an escape hatch so Ensemble gains a uniform protocol without making one launcher mandatory.

---
status: accepted
---

# Treat the config directory as a runtime boundary

An Ensemble installation is configured by a directory containing `config.yaml`; prompt paths and other relative configuration are resolved from that directory rather than the process working directory. The CLI flag, environment override, and platform default select the directory in that order, making desktop startup deterministic and allowing one configuration to coordinate multiple repositories.

---
status: accepted
---

# Treat the config directory as a runtime boundary

An Ensemble installation is configured by a directory containing `config.yaml`; prompt paths and other relative configuration are resolved from that directory rather than the process working directory. The CLI flag, environment override, and platform default select the directory in that order, making desktop startup deterministic and allowing one configuration to coordinate multiple repositories.

The resolved configuration directory also defines one immutable root-resource
generation for the process. Workspace, SQLite history and timeline, transcript,
journal, and repository resources are not migrated live. Changes to the
effective `workspace.root` or ordered repository configuration are persisted but
reported as restart-required.

Reload is a serialized prepare-quiesce-commit transaction shared by filesystem
events and all configuration save surfaces. Candidate values remain private
while preparation runs. The exact active runtime then enters one-way
quiescence, drains workers and persistence, and must provide positive completion
proof before the document, observed mtime, config-derived state, and prepared
runtime cross generations together. The replacement starts only after that
synchronous commit.

Invalid candidates, preparation failures, and busy or ambiguous handovers keep
the last-known-good generation and leave the candidate mtime unconsumed. A
quiescing runtime remains the registered owner and can be replaced by a later
retry after it finishes; it is never relaunched or detached. Operator
diagnostics use allowlisted categories rather than candidate values so resolved
secrets cannot be exposed.

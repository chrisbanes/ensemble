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

Setup extends this transaction with one private versioned journal inside the
configuration directory. Before `config.yaml` is persisted, Ensemble records
the exact raw-byte digest, normalized companion destinations, owner-only
payloads, and complete before-images. The public config remains the only
user-editable document. Preparation resolves matching staged dotenv values but
keeps final template and tracker paths; companion contents become visible only
after exact runtime quiescence and before the retained synchronous commit.

All hosts recover the setup journal before parsing config or constructing
workspace, history, timeline, transcript, and orchestrator resources. Matching
staged or partially published generations resume forward. Digest drift restores
all before-images, and malformed state, unsafe permissions, or incomplete
rollback fails closed. API saves, watcher reloads, offline CLI setup, and
startup therefore share one recovery owner rather than separate staging
semantics.

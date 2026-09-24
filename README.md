# Ensemble

Ensemble is being rebuilt as a persistent service that coordinates agents across
issue tracker boards. Agent instructions determine how work proceeds; Ensemble
will own durable coordination, execution, permissions, and recovery.

## Current status

This branch contains the accepted design and a dependency-free Rust library
scaffold. It does not yet run agents, connect trackers, or provide a dashboard.

The previous implementation is preserved on `cb/pipeline-implementation` at
`272adb7`. The fresh implementation lives on `cb/agent-coordination`, retaining
Git history. Existing pipeline configuration and persisted runs are not supported
by the redesign. Finish or explicitly retire existing runs before an operational
cutover.

## Design

- A board is a configured queue from one tracker, with its own lead, instructions,
  and permissions. Multiple tracker kinds remain supported by the target design.
- Board leads delegate to concurrent issue owners using operator-defined agent
  profiles. Instructions determine planning, implementation, and review.
- Ensemble records assignments, handoffs, pending work, and human interactions.
  Each issue has one owning board across the service.
- Events wake agents, with periodic reconciliation for missed changes. Work can
  recover across conversations and service restarts.
- Plugins connect trackers, agent runtimes, and tools. Permission enforcement
  covers agents' actual access, including direct tool and shell use.
- A shared dashboard supervises all boards. The initial deployment will place the
  service and agents on one dedicated always-on host.

See [the glossary](CONTEXT.md), [the architecture decision](docs/adr/0020-let-agent-instructions-direct-the-work-process.md),
and [the fresh implementation decision](docs/adr/0021-start-a-fresh-implementation.md).

## Development

The existing Rust 1.98.1 toolchain pin and Rust 1.95 minimum are retained.

```sh
cargo build --locked
cargo test --locked
cargo clippy --all-targets --locked -- -D warnings
cargo fmt --all -- --check
```

The scaffold has no behavioural tests yet. There are no release or deployment
workflows on this branch.

## License

Apache-2.0. See [LICENSE](LICENSE).

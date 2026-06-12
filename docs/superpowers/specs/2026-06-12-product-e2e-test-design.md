# Product E2E workflow test

**Date:** 2026-06-12
**Issue:** [#197](https://github.com/chrisbanes/ensemble/issues/197)
**Status:** Design

## Context

Ensemble has unit, integration, API, orchestrator, workspace, and desktop launch smoke coverage, but no CI-safe black-box product test that starts Ensemble the way a user would. Issue #197 asks for at least one full workflow that uses local fixtures, avoids external credentials, and verifies observable state through public API or UI surfaces.

The first test should be the simplest reliable path: a happy-path web/CLI workflow. Retry and human-interaction coverage remain follow-up tests once the fixture is stable.

## Goals

- Start the real `ensemble` CLI binary in `web` mode.
- Use only temporary local files and localhost networking.
- Use the `todo_file` tracker and a mock local `acpx` executable.
- Verify the workflow through public HTTP APIs, tracker-visible file state, and persisted runtime artifacts.
- Run in normal CI as part of `cargo test --workspace --exclude ensemble-desktop`.
- Document how to run the E2E test locally.

## Non-Goals

- Browser automation against the React UI.
- Desktop/Tauri E2E coverage.
- Failure, retry, or human-interaction coverage in the first test.
- Real GitHub, Notion, ACP credentials, or live agent processes.

## Test Location

Add the test under `crates/ensemble-cli/tests/`, because Cargo integration tests for `ensemble-cli` can spawn the built CLI binary using `CARGO_BIN_EXE_ensemble`. This exercises the packaged command-line entrypoint instead of calling `ensemble-core` internals directly.

## Fixture Setup

The test creates a temporary directory containing:

- `config.yaml`
- `TODO.md`
- `workspaces/`
- `bin/acpx`, a mock executable placed first in the spawned process `PATH`

The config uses:

- `tracker.kind: todo_file`
- `tracker.path` pointing at the temp `TODO.md`
- active state `Todo`
- terminal state `Done`
- one `acpx_agent` agent with an inline prompt
- one `implement` step with `tracker_state: In Progress`
- `on_success: Done`
- `on_failure: Failed`
- a short polling interval so the test does not wait on the production default
- a temp workspace root

The TODO fixture starts with one active issue:

```markdown
## Todo

- [E2E-1] Exercise product workflow
  Verify that Ensemble can run a local black-box workflow.

## In Progress

## Done

## Failed
```

## Mock Agent

The mock executable is named `acpx` so the spawned `ensemble` binary uses it through normal command resolution. The test must not rely on `#[cfg(test)]` environment hooks such as `ENSEMBLE_TEST_ACPX_EXECUTABLE`, because those are not compiled into the spawned release/test binary.

The mock supports the commands used by `AcpxRuntime`:

- `sessions ensure ...` exits successfully.
- `prompt --session ...` writes a deterministic ACP JSON-RPC `session/update` stream to stdout, including text output, token usage, `stopReason: end_turn`, and a structured successful result.
- `sessions close ...` exits successfully.
- unexpected commands exit non-zero with a diagnostic.

The successful result should use the current result terminology, for example:

```json
{"result":"succeeded","summary":"mock agent completed","output":{"artifact":"mock"}}
```

## Process Lifecycle

The test starts:

```sh
ensemble web --config-dir <temp-config-dir> --host 127.0.0.1 --port <free-port>
```

Use a pre-bound local port chosen by the test, then release it before spawning the child. This avoids parsing structured logs while still keeping the server address deterministic. The test should use bounded polling to wait for `GET /api/v1/state` to become available.

The child process must be killed and waited on in test cleanup, even on assertion failure. A small process guard type is enough.

## Assertions

After the server is reachable, the test polls public APIs until completion:

1. `GET /api/v1/state` becomes available.
2. `GET /api/v1/E2E-1` eventually returns `status: "completed_succeeded"`.
3. `GET /api/v1/history` returns at least one record for `E2E-1` with `outcome: "succeeded"` and step `implement`.
4. The workspace root contains persisted run timeline data under `.ensemble/runs/` or the history SQLite database contains run event rows for `E2E-1`.
5. `TODO.md` contains `[E2E-1] Exercise product workflow` under `## Done`.
6. The mock agent log file shows that the `prompt` command was invoked.

The current history API returns `HistoryRecord` values without a public `run_id`, while the timeline API requires a `run_id` query parameter. The first test should not add API contract scope just to assert timeline through HTTP. If a later change exposes `run_id` in history responses, this assertion can move to `GET /api/v1/E2E-1/timeline?run_id=<run-id>`.

Bound all polling with clear timeout errors so CI failures point at the missing observable state.

## Documentation

Update `docs/contributing.md` with a short E2E section:

```sh
cargo test -p ensemble-cli --test product_e2e
```

Mention that the test uses temp files, a mock `acpx`, and localhost only.

## Follow-Up Coverage

After this happy-path fixture is stable, add separate tests for:

- failed verdict followed by retry
- human interaction request and resume
- browser-level UI smoke for the web app

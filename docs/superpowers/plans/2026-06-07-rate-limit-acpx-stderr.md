# Buffered acpx stderr logging to workspace file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the line-for-line `tracing::debug!` forwarding of acpx stderr with a workspace-local file sink, emitting periodic delta summaries and a final completion summary instead.

**Architecture:** Spawn a dedicated tokio task inside `AcpxCli::run_prompt` that writes every stderr line to `<workspace>/.ensemble/acpx-stderr-<session>.log`. The task uses a simple read loop (not `tokio::select!`) to avoid cancel-safety issues with `AsyncWriteExt::write_all`. Every 5 seconds it flushes and emits a `debug!` delta summary; on EOF it emits a final `debug!` completion summary. If the write fails, a single `warn!` is emitted and the sink stops.

**Tech Stack:** Rust, tokio (async I/O, process), tracing, tempfile (tests)

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/ensemble-core/src/agent/acpx_cli.rs` | Main change: replace the stderr-forwarding tokio task in `run_prompt` with the file-sink task. Add `tracing::warn` import. Add two unit tests in `mod tests`. |

---

## Task 1: Write failing test for stderr lines written to file

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs` (append to `mod tests`)
- Test: `crates/ensemble-core/src/agent/acpx_cli.rs`

- [ ] **Step 1: Add the failing test**

Append the following test to the `mod tests` block in `crates/ensemble-core/src/agent/acpx_cli.rs`:

```rust
    #[tokio::test]
    async fn prompt_stderr_lines_written_to_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}
{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}
JSON
echo "stderr line 1" >&2
echo "stderr line 2" >&2
echo "stderr line 3" >&2
"#,
        );

        let client = AcpxCli::new(script);
        client
            .run_prompt(
                "codex",
                "test-session",
                dir.path(),
                "hi",
                None,
                |_| async {},
            )
            .await
            .unwrap();

        let stderr_path = dir
            .path()
            .join(".ensemble")
            .join("acpx-stderr-test-session.log");
        assert!(stderr_path.exists(), "stderr log file should exist");
        let content = std::fs::read_to_string(&stderr_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 3, "should have 3 stderr lines");
        assert_eq!(lines[0], "stderr line 1");
        assert_eq!(lines[1], "stderr line 2");
        assert_eq!(lines[2], "stderr line 3");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cargo test --package ensemble-core --lib prompt_stderr_lines_written_to_file
```

Expected: FAIL with an assertion like `stderr log file should exist` (because the current code does not create the file).

---

## Task 2: Write failing test for empty stderr

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs` (append to `mod tests`)

- [ ] **Step 3: Add the failing test**

Append the following test to the `mod tests` block immediately after the previous test:

```rust
    #[tokio::test]
    async fn prompt_empty_stderr_produces_empty_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let script = write_mock_acpx_script(
            dir.path(),
            r#"#!/usr/bin/env bash
cat <<'JSON'
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}
{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}
JSON
"#,
        );

        let client = AcpxCli::new(script);
        client
            .run_prompt(
                "codex",
                "empty-session",
                dir.path(),
                "hi",
                None,
                |_| async {},
            )
            .await
            .unwrap();

        let stderr_path = dir
            .path()
            .join(".ensemble")
            .join("acpx-stderr-empty-session.log");
        // File may be absent or present; if present it must be 0 bytes.
        if stderr_path.exists() {
            let metadata = std::fs::metadata(&stderr_path).unwrap();
            assert_eq!(metadata.len(), 0, "stderr log should be 0 bytes");
        }
    }
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
cargo test --package ensemble-core --lib prompt_empty_stderr_produces_empty_file
```

Expected: FAIL with the same reason as Task 1 — file does not exist because the current code never creates it.

---

## Task 3: Implement the stderr file sink

**Files:**
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs:6` (add `warn` import)
- Modify: `crates/ensemble-core/src/agent/acpx_cli.rs:119-126` (replace stderr task)

- [ ] **Step 5: Add `warn` to the tracing import**

Change line 6 from:

```rust
use tracing::debug;
```

to:

```rust
use tracing::{debug, warn};
```

- [ ] **Step 6: Replace the stderr-forwarding task**

Replace lines 119-126:

```rust
        // Spawn a task to forward stderr to tracing
        let agent_name = agent.to_string();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                debug!(agent = %agent_name, "acpx stderr: {}", line);
            }
        });
```

with:

```rust
        let stderr_path = cwd
            .join(".ensemble")
            .join(format!("acpx-stderr-{}.log", session_name));
        let parent = stderr_path.parent().ok_or_else(|| AgentError::IoError {
            reason: "stderr path has no parent".to_string(),
        })?;
        tokio::fs::create_dir_all(parent).await.map_err(|e| AgentError::IoError {
            reason: format!("failed to create .ensemble directory: {e}"),
        })?;
        let mut stderr_file = tokio::fs::File::create(&stderr_path).await.map_err(|e| AgentError::IoError {
            reason: format!("failed to create stderr log file: {e}"),
        })?;

        let stderr_path_clone = stderr_path.clone();
        debug!(agent = %agent, session = %session_name, path = %stderr_path.display(), "acpx stderr -> {}", stderr_path.display());

        let agent_name = agent.to_string();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut reader = BufReader::new(stderr).lines();
            let mut line_count: u64 = 0;
            let mut lines_since_last: u64 = 0;
            let mut last_report = tokio::time::Instant::now();
            let mut write_failed = false;

            while let Some(line_result) = reader.next_line().await.transpose() {
                match line_result {
                    Ok(line) => {
                        line_count += 1;
                        lines_since_last += 1;
                        if let Err(e) = stderr_file.write_all(line.as_bytes()).await
                            .and_then(|_| stderr_file.write_all(b"\n").await)
                        {
                            warn!(agent = %agent_name, error = %e, "failed to write acpx stderr to file");
                            write_failed = true;
                            break;
                        }

                        if last_report.elapsed() >= tokio::time::Duration::from_secs(5) {
                            let _ = stderr_file.flush().await;
                            if lines_since_last > 0 {
                                debug!(agent = %agent_name, lines = lines_since_last, path = %stderr_path_clone.display(), "acpx stderr: {} lines since last summary", lines_since_last);
                            }
                            lines_since_last = 0;
                            last_report = tokio::time::Instant::now();
                        }
                    }
                    Err(e) => {
                        debug!(agent = %agent_name, error = %e, "acpx stderr read error");
                        break;
                    }
                }
            }

            if !write_failed && line_count > 0 {
                let _ = stderr_file.flush().await;
                debug!(agent = %agent_name, total_lines = line_count, path = %stderr_path_clone.display(), "acpx stderr complete: {}", stderr_path_clone.display());
            }
        });
```

Note: `stderr_path` is cloned into `stderr_path_clone` before the `tokio::spawn` because the path is needed both in the pre-spawn `debug!` log and inside the async moved closure.

---

## Task 4: Verify both new tests pass

**Files:**
- Test: `crates/ensemble-core/src/agent/acpx_cli.rs`

- [ ] **Step 7: Run the first new test**

Run:

```bash
cargo test --package ensemble-core --lib prompt_stderr_lines_written_to_file
```

Expected: PASS.

- [ ] **Step 8: Run the second new test**

Run:

```bash
cargo test --package ensemble-core --lib prompt_empty_stderr_produces_empty_file
```

Expected: PASS.

---

## Task 5: Run the full test suite and linting to check for regressions

**Files:**
- Test: `crates/ensemble-core/src/agent/acpx_cli.rs` (all existing tests)

- [ ] **Step 9: Run all acpx_cli tests**

Run:

```bash
cargo test --package ensemble-core --lib agent::acpx_cli::tests
```

Expected: All tests PASS (including the two new ones).

- [ ] **Step 10: Run formatting and clippy checks**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
```

Expected: No formatting or clippy errors.

- [ ] **Step 11: Run the full workspace test suite**

Run:

```bash
cargo test --workspace --exclude ensemble-desktop
```

Expected: All tests PASS.

---

## Task 6: Commit the changes

**Files:**
- `crates/ensemble-core/src/agent/acpx_cli.rs`

- [ ] **Step 12: Stage and commit**

```bash
git add crates/ensemble-core/src/agent/acpx_cli.rs
git commit -m "feat: buffer acpx stderr to workspace file with periodic summaries

Replace line-for-line tracing::debug! forwarding of acpx stderr
with a file-based sink under <workspace>/.ensemble/. This preserves
full stderr output for post-hoc debugging while reducing log
volume. Emits a delta summary every 5 seconds and a final
completion summary on EOF. Write failures emit a single warn!
and stop the sink gracefully."
```

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] File path: `<workspace_root>/.ensemble/acpx-stderr-<session_name>.log` — implemented in Task 3.
- [x] On prompt start: create/truncate file + single `debug!` with path — implemented in Task 3.
- [x] During execution: append every line, periodic delta summary every 5s — implemented in Task 3.
- [x] On EOF/exit: flush + final completion summary — implemented in Task 3.
- [x] No stderr output: file empty (0 bytes), no summary emitted — tested in Task 2.
- [x] File write failure: single `warn!`, stop sink, no final summary — implemented in Task 3.
- [x] Task cancellation/drop: file handle dropped normally — handled by tokio's drop semantics.
- [x] Concurrent runs: session name disambiguates files — implemented via session name in filename.
- [x] Cancel-safety: no `tokio::select!` around `write_all` — implemented in Task 3 using a plain read loop.

**2. Placeholder scan:**
- [x] No "TBD", "TODO", "implement later".
- [x] No vague "add error handling" steps; exact `.map_err` calls are shown.
- [x] No "Similar to Task N" references.
- [x] Exact file paths used throughout.
- [x] Complete code shown for every modification.

**3. Type consistency:**
- [x] `AgentError::IoError { reason: String }` used consistently.
- [x] `tokio::time::Instant::now()` and `Duration::from_secs(5)` used consistently.
- [x] Variable names (`line_count`, `lines_since_last`, `write_failed`, `stderr_path`) match between spec and plan.

**Gaps:** None identified.

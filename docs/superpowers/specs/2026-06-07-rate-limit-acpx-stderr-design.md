# Buffered acpx stderr logging to workspace file

**Date:** 2026-06-07
**Issue:** [#51](https://github.com/chrisbanes/ensemble/issues/51)
**Status:** Design

## Context

`AcpxCli::run_prompt()` spawns a tokio task that reads every stderr line from the acpx child process and forwards it to `tracing::debug!`. A noisy agent can generate thousands or millions of stderr lines, producing excessive log volume, disk churn, and memory pressure.

## Problem

The line-for-line forwarding at `debug!` level:
- Amplifies log volume proportionally to acpx stderr output (disk churn)
- Produces unreadable log files when stderr is verbose
- Has no mechanism for operators to review stderr without enabling debug logging globally

## Goal

Preserve full stderr output in a workspace-local file for post-hoc debugging, while replacing the line-for-line `debug!` forwarding with a periodic summary at the tracing level.

## Non-Goals

- Changing the log level of acpx stderr events (stays at `debug`)
- Adding rate-limiting that drops lines (the file captures everything)
- Impacting acpx stdout path or JSON-RPC message parsing
- Changing workspace lifecycle or cleanup (`.ensemble/` directory is already removed with the workspace)

## Architecture

Replace the current tokio task (line-for-line `debug!`) with a file-based sink in the workspace:

```
┌──────────┐     stderr lines     ┌──────────────────┐     periodic summary     ┌──────────────┐
│  acpx    │─────────────────────▶│  tokio task      │─────────────────────────▶│  tracing     │
│  child   │                      │  (file sink)     │  debug!(path, count)     │              │
│  stderr  │                      │                  │                          │              │
└──────────┘                      │  writes →        │                          └──────────────┘
                                  │  .ensemble/      │
                                  │  acpx-stderr.log │
                                  └──────────────────┘
```

## Behavior

### File path
```
<workspace_root>/.ensemble/acpx-stderr-<session_name>.log
```
The `.ensemble/` directory already exists (used for verdict files, workspace metadata). The session name disambiguates stderr across multiple prompt runs within the same workspace.

### Lifecycle

1. **On prompt start**: Create/truncate the stderr file. Log one `debug!` entry with the file path:
   ```
   debug!(agent, session, path, "acpx stderr -> <path>")
   ```

2. **During execution**: Every stderr line is appended to the file. Every 5 seconds, if new lines were written since the last tick, flush the file and emit a summary:
   ```
   debug!(agent, session, lines_since_last, path, "acpx stderr: <count> lines")
   ```

3. **On EOF/exit**: Flush remaining bytes, emit a completion summary:
   ```
   debug!(agent, session, total_lines, path, "acpx stderr complete: <path>")
   ```

### Edge cases

- **No stderr output**: File is not created (or is empty). No summary emitted.
- **File write failure**: Emit a single `warn!` and stop the sink. Already-written lines are preserved.
- **Task cancellation/drop**: The file handle is dropped normally, flushing any remaining bytes. The prompt exit path handles cleanup.
- **Concurrent runs**: Session names are unique per run, so no file collisions.

## Implementation

### Files changed
- `crates/ensemble-core/src/agent/acpx_cli.rs` — Replace stderr task (lines 119-126)

### Key implementation sketch

```rust
// Replace the current tokio::spawn block (lines 119-126) with:

let stderr_path = cwd
    .join(".ensemble")
    .join(format!("acpx-stderr-{}.log", session_name));
std::fs::create_dir_all(stderr_path.parent().unwrap())?;
let mut stderr_file = tokio::fs::File::create(&stderr_path).await?;

debug!(agent = %agent, session = %session_name,
       path = %stderr_path.display(), "acpx stderr -> {}", stderr_path.display());

let agent_name = agent.to_string();
tokio::spawn(async move {
    use tokio::io::AsyncWriteExt;
    let mut reader = BufReader::new(stderr).lines();
    let mut line_count: u64 = 0;
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
    // Don't tick immediately on the first interval
    interval.tick().await;

    loop {
        tokio::select! {
            line_result = reader.next_line() => {
                match line_result {
                    Ok(Some(line)) => {
                        line_count += 1;
                        if let Err(e) = stderr_file.write_all(line.as_bytes()).await
                            .and_then(|_| stderr_file.write_all(b"\n").await)
                        {
                            warn!(agent = %agent_name, error = %e,
                                  "failed to write acpx stderr to file");
                            break;
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(e) => {
                        debug!(agent = %agent_name, error = %e, "acpx stderr read error");
                        break;
                    }
                }
            }
            _ = interval.tick() => {
                if line_count > 0 {
                    let _ = stderr_file.flush().await;
                    debug!(agent = %agent_name, lines = line_count,
                           path = %stderr_path.display(),
                           "acpx stderr: {} lines", line_count);
                }
            }
        }
    }

    // Final flush and summary
    let _ = stderr_file.flush().await;
    debug!(agent = %agent_name, total_lines = line_count,
           path = %stderr_path.display(),
           "acpx stderr complete: {}", stderr_path.display());
});
```

## Testing

Two tests using mock acpx scripts (existing pattern in `mod tests`):

1. **Lines written to file**: Mock acpx writes 3 lines to stderr. Verify the file at `.ensemble/acpx-stderr-<session>.log` exists and contains all 3 lines.

2. **Empty stderr produces no file**: Mock acpx writes nothing to stderr. Verify the file either doesn't exist or is empty (0 bytes).

## Compatibility

- No config changes required
- No tracker contract changes
- Workspace cleanup already removes `.ensemble/` directory tree
- Existing tests for stdout parsing, stop reasons, cancellation, etc. continue to pass unchanged

use crate::error::WorkspaceError;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{info, warn};

/// Run a shell hook script in the given workspace directory with a timeout.
///
/// The script is executed via `sh -lc <script>` with cwd set to `workspace_path`.
/// Returns Ok(()) on success, Err on failure or timeout.
pub async fn run_hook(
    hook_name: &str,
    script: &str,
    workspace_path: &Path,
    timeout_ms: u64,
) -> Result<(), WorkspaceError> {
    info!(hook = hook_name, cwd = %workspace_path.display(), "running hook");

    let duration = Duration::from_millis(timeout_ms);

    let result = timeout(duration, async {
        Command::new("sh")
            .arg("-lc")
            .arg(script)
            .current_dir(workspace_path)
            .output()
            .await
    })
    .await;

    match result {
        Ok(Ok(output)) => {
            if output.status.success() {
                info!(hook = hook_name, "hook completed successfully");
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let reason = if stderr.is_empty() {
                    format!("exit code: {}", output.status)
                } else {
                    // Truncate stderr for logging
                    let truncated: String = stderr.chars().take(500).collect();
                    format!("exit code: {} — {}", output.status, truncated)
                };
                warn!(hook = hook_name, %reason, "hook failed");
                Err(WorkspaceError::HookFailed {
                    hook: hook_name.to_string(),
                    reason,
                })
            }
        }
        Ok(Err(e)) => {
            let reason = format!("failed to execute: {e}");
            warn!(hook = hook_name, %reason, "hook execution error");
            Err(WorkspaceError::HookFailed {
                hook: hook_name.to_string(),
                reason,
            })
        }
        Err(_) => {
            warn!(hook = hook_name, timeout_ms, "hook timed out");
            Err(WorkspaceError::HookTimedOut {
                hook: hook_name.to_string(),
                timeout_ms,
            })
        }
    }
}

/// Run a hook if configured; swallow errors for non-fatal hooks.
/// Returns Ok(()) always — errors are logged but not propagated.
pub async fn run_hook_best_effort(
    hook_name: &str,
    script: &str,
    workspace_path: &Path,
    timeout_ms: u64,
) {
    if let Err(e) = run_hook(hook_name, script, workspace_path, timeout_ms).await {
        warn!(hook = hook_name, error = %e, "non-fatal hook error (ignored)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        TempDir::new().unwrap()
    }

    #[tokio::test]
    async fn test_hook_success() {
        let dir = setup();
        let result = run_hook("test_hook", "true", dir.path(), 5000).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_hook_failure() {
        let dir = setup();
        let result = run_hook("test_hook", "false", dir.path(), 5000).await;
        assert!(matches!(result, Err(WorkspaceError::HookFailed { .. })));
    }

    #[tokio::test]
    async fn test_hook_with_stderr() {
        let dir = setup();
        let result =
            run_hook("test_hook", "echo 'oh no' >&2; exit 1", dir.path(), 5000).await;
        match result {
            Err(WorkspaceError::HookFailed { reason, .. }) => {
                assert!(reason.contains("oh no"));
            }
            _ => panic!("expected HookFailed"),
        }
    }

    #[tokio::test]
    async fn test_hook_timeout() {
        let dir = setup();
        let result = run_hook("test_hook", "sleep 10", dir.path(), 100).await;
        assert!(matches!(result, Err(WorkspaceError::HookTimedOut { .. })));
    }

    #[tokio::test]
    async fn test_hook_uses_workspace_cwd() {
        let dir = setup();
        // Create a marker file, then verify hook can see it
        std::fs::write(dir.path().join("marker.txt"), "hello").unwrap();
        let result = run_hook("test_hook", "test -f marker.txt", dir.path(), 5000).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_hook_best_effort_swallows_errors() {
        let dir = setup();
        // This should not panic or return an error
        run_hook_best_effort("test_hook", "false", dir.path(), 5000).await;
    }

    #[tokio::test]
    async fn test_hook_multiline_script() {
        let dir = setup();
        let script = "echo 'line1'\necho 'line2'\ntrue";
        let result = run_hook("test_hook", script, dir.path(), 5000).await;
        assert!(result.is_ok());
    }
}

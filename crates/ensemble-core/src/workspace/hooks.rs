use crate::error::WorkspaceError;
use crate::observability::events_contract::{
    elapsed_ms, WORKSPACE_HOOK_FAILED, WORKSPACE_HOOK_FINISHED, WORKSPACE_HOOK_STARTED,
};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{info, warn};

/// Max chars of stderr to include in hook error messages. Prevents oversized error
/// strings from long-running hooks that dump large output on failure.
const STDERR_TRUNCATE_LIMIT: usize = 500;
static PREFERRED_SHELL: OnceLock<&'static str> = OnceLock::new();

/// Run a shell hook script in the given workspace directory with a timeout.
///
/// The script is executed via `bash -lc <script>` (falling back to `sh -lc` if
/// bash is unavailable) with cwd set to `workspace_path`.
/// Returns Ok(()) on success, Err on failure or timeout.
pub async fn run_hook(
    hook_name: &str,
    script: &str,
    workspace_path: &Path,
    timeout_ms: u64,
) -> Result<(), WorkspaceError> {
    let started_at = std::time::Instant::now();
    info!(
        event = WORKSPACE_HOOK_STARTED,
        hook = hook_name,
        cwd = %workspace_path.display(),
        "running hook"
    );

    let duration = Duration::from_millis(timeout_ms);

    // Try bash first, fall back to sh if unavailable
    let shell = preferred_shell();
    if shell.ends_with("/sh") || shell == "sh" {
        warn!(
            hook = hook_name,
            "bash not found, falling back to sh for hook execution"
        );
    }

    // kill_on_drop ensures the child is killed if we drop it (e.g. on timeout)
    let child = Command::new(shell)
        .arg("-lc")
        .arg(script)
        .current_dir(workspace_path)
        .kill_on_drop(true)
        .output();

    match timeout(duration, child).await {
        Ok(Ok(output)) => {
            if output.status.success() {
                info!(
                    event = WORKSPACE_HOOK_FINISHED,
                    hook = hook_name,
                    duration_ms = elapsed_ms(started_at),
                    "hook completed successfully"
                );
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let reason = if stderr.is_empty() {
                    format!("exit code: {}", output.status)
                } else {
                    let mut truncated: String =
                        stderr.chars().take(STDERR_TRUNCATE_LIMIT).collect();
                    if stderr.chars().count() > STDERR_TRUNCATE_LIMIT {
                        truncated.push('\u{2026}');
                    }
                    format!("exit code: {} — {}", output.status, truncated)
                };
                warn!(
                    event = WORKSPACE_HOOK_FAILED,
                    hook = hook_name,
                    duration_ms = elapsed_ms(started_at),
                    %reason,
                    "hook failed"
                );
                Err(WorkspaceError::HookFailed {
                    hook: hook_name.to_string(),
                    reason,
                })
            }
        }
        Ok(Err(e)) => {
            let reason = format!("failed to execute: {e}");
            warn!(
                event = WORKSPACE_HOOK_FAILED,
                hook = hook_name,
                duration_ms = elapsed_ms(started_at),
                %reason,
                "hook execution error"
            );
            Err(WorkspaceError::HookFailed {
                hook: hook_name.to_string(),
                reason,
            })
        }
        Err(_) => {
            // Child future is dropped here, which triggers kill_on_drop
            warn!(
                event = WORKSPACE_HOOK_FAILED,
                hook = hook_name,
                timeout_ms,
                duration_ms = elapsed_ms(started_at),
                "hook timed out, process killed"
            );
            Err(WorkspaceError::HookTimedOut {
                hook: hook_name.to_string(),
                timeout_ms,
            })
        }
    }
}

fn preferred_shell() -> &'static str {
    PREFERRED_SHELL.get_or_init(|| {
        for shell in ["/bin/bash", "/usr/bin/bash"] {
            if Path::new(shell).is_file() {
                return shell;
            }
        }

        for shell in ["/bin/sh", "/usr/bin/sh"] {
            if Path::new(shell).is_file() {
                return shell;
            }
        }

        "sh"
    })
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
    use std::sync::Mutex;
    use tempfile::TempDir;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn lock(vars: &[&'static str]) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let saved = vars
                .iter()
                .map(|&key| (key, std::env::var(key).ok()))
                .collect();
            for &key in vars {
                std::env::remove_var(key);
            }

            Self {
                _guard: guard,
                saved,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

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
        let result = run_hook("test_hook", "echo 'oh no' >&2; exit 1", dir.path(), 5000).await;
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
        let result = run_hook("test_hook", "while :; do :; done", dir.path(), 100).await;
        assert!(matches!(result, Err(WorkspaceError::HookTimedOut { .. })));
    }

    #[tokio::test]
    async fn test_hook_success_with_missing_path_still_uses_resolved_shell() {
        let _env = EnvGuard::lock(&["PATH"]);
        std::env::set_var("PATH", "/definitely/missing");

        let dir = setup();
        let result = run_hook("test_hook", "true", dir.path(), 5000).await;

        assert!(result.is_ok());
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

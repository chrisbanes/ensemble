use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::acceptance::{AcceptanceOutput, AcceptanceResult, AcceptanceStatus};
use crate::config::ensemble::AcceptanceCommandConfig;

const OUTPUT_TAIL_LIMIT: usize = 32 * 1024;

#[async_trait]
pub trait AcceptanceCommandRunner: Send + Sync {
    async fn run(
        &self,
        command: &AcceptanceCommandConfig,
        issue_workspace: &Path,
    ) -> AcceptanceResult;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ShellAcceptanceCommandRunner;

#[async_trait]
impl AcceptanceCommandRunner for ShellAcceptanceCommandRunner {
    async fn run(
        &self,
        command_config: &AcceptanceCommandConfig,
        issue_workspace: &Path,
    ) -> AcceptanceResult {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-lc")
            .arg(&command_config.run)
            .current_dir(issue_workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return unavailable_result(
                    &command_config.name,
                    format!("acceptance command unavailable: {error}"),
                );
            }
        };
        let child_id = child.id();
        let stdout = child
            .stdout
            .take()
            .map(|stream| tokio::spawn(read_tail(stream)));
        let stderr = child
            .stderr
            .take()
            .map(|stream| tokio::spawn(read_tail(stream)));

        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(command_config.timeout_ms);
        let status = match tokio::time::timeout_at(deadline, child.wait()).await {
            Ok(wait_result) => match wait_result {
                Ok(status) => Some(status),
                Err(error) => {
                    return unavailable_result(
                        &command_config.name,
                        format!("acceptance command unavailable while waiting: {error}"),
                    );
                }
            },
            Err(_) => None,
        };

        let mut output_collection = Box::pin(collect_outputs(stdout, stderr));
        if let Some(status) = status {
            match tokio::time::timeout_at(deadline, &mut output_collection).await {
                Ok(Ok((stdout, stderr))) => {
                    return finish_result(&command_config.name, status, stdout, stderr);
                }
                Ok(Err(error)) => {
                    return unavailable_result(
                        &command_config.name,
                        format!("acceptance command output unavailable: {error}"),
                    );
                }
                Err(_) => {}
            }
        }

        terminate_process_group(child_id);
        if status.is_none() {
            if let Err(error) = child.wait().await {
                return unavailable_result(
                    &command_config.name,
                    format!("acceptance command unavailable while reaping timeout: {error}"),
                );
            }
        }

        let (stdout, stderr) = match output_collection.await {
            Ok(outputs) => outputs,
            Err(error) => {
                return unavailable_result(
                    &command_config.name,
                    format!("acceptance command output unavailable: {error}"),
                );
            }
        };
        AcceptanceResult {
            name: command_config.name.clone(),
            status: AcceptanceStatus::TimedOut,
            exit_code: None,
            stdout,
            stderr,
            summary: format!(
                "acceptance command '{}' timed out after {}ms",
                command_config.name, command_config.timeout_ms
            ),
        }
    }
}

fn finish_result(
    name: &str,
    status: std::process::ExitStatus,
    stdout: AcceptanceOutput,
    stderr: AcceptanceOutput,
) -> AcceptanceResult {
    let acceptance_status = if status.success() {
        AcceptanceStatus::Passed
    } else {
        AcceptanceStatus::Failed
    };
    let summary = match status.code() {
        Some(0) => format!("acceptance command '{name}' passed"),
        Some(code) => format!("acceptance command '{name}' failed with exit code {code}"),
        None => format!("acceptance command '{name}' terminated by signal"),
    };
    AcceptanceResult {
        name: name.to_string(),
        status: acceptance_status,
        exit_code: status.code(),
        stdout,
        stderr,
        summary,
    }
}

async fn collect_outputs(
    stdout: Option<tokio::task::JoinHandle<std::io::Result<AcceptanceOutput>>>,
    stderr: Option<tokio::task::JoinHandle<std::io::Result<AcceptanceOutput>>>,
) -> std::io::Result<(AcceptanceOutput, AcceptanceOutput)> {
    let stdout = collect_output(stdout).await?;
    let stderr = collect_output(stderr).await?;
    Ok((stdout, stderr))
}

async fn collect_output(
    output: Option<tokio::task::JoinHandle<std::io::Result<AcceptanceOutput>>>,
) -> std::io::Result<AcceptanceOutput> {
    match output {
        Some(output) => output.await.map_err(std::io::Error::other)?,
        None => Ok(empty_output()),
    }
}

async fn read_tail(mut stream: impl AsyncRead + Unpin) -> std::io::Result<AcceptanceOutput> {
    let mut tail = Vec::with_capacity(OUTPUT_TAIL_LIMIT);
    let mut buffer = [0_u8; 8192];
    let mut total_bytes = 0_u64;
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        append_tail(&mut tail, &buffer[..read]);
    }
    Ok(AcceptanceOutput {
        tail: String::from_utf8_lossy(&tail).into_owned(),
        total_bytes,
        truncated: total_bytes > u64::try_from(OUTPUT_TAIL_LIMIT).unwrap_or(u64::MAX),
    })
}

fn append_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.len() >= OUTPUT_TAIL_LIMIT {
        tail.clear();
        tail.extend_from_slice(&chunk[chunk.len() - OUTPUT_TAIL_LIMIT..]);
        return;
    }
    let excess = tail
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(OUTPUT_TAIL_LIMIT);
    if excess > 0 {
        tail.drain(..excess);
    }
    tail.extend_from_slice(chunk);
}

fn unavailable_result(name: &str, summary: String) -> AcceptanceResult {
    AcceptanceResult {
        name: name.to_string(),
        status: AcceptanceStatus::Unavailable,
        exit_code: None,
        stdout: empty_output(),
        stderr: empty_output(),
        summary,
    }
}

fn empty_output() -> AcceptanceOutput {
    AcceptanceOutput {
        tail: String::new(),
        total_bytes: 0,
        truncated: false,
    }
}

#[cfg(unix)]
fn terminate_process_group(child_id: Option<u32>) {
    let Some(child_id) = child_id.and_then(|id| i32::try_from(id).ok()) else {
        return;
    };
    // SAFETY: a negative PID targets the process group created for this child.
    unsafe {
        libc::kill(-child_id, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_child_id: Option<u32>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acceptance::AcceptanceStatus;
    use crate::config::ensemble::AcceptanceCommandConfig;
    use crate::test_support::env::ENV_LOCK;

    fn command(name: &str, run: &str, timeout_ms: u64) -> AcceptanceCommandConfig {
        AcceptanceCommandConfig {
            name: name.to_string(),
            run: run.to_string(),
            timeout_ms,
        }
    }

    #[tokio::test]
    async fn shell_runner_inherits_environment_and_uses_issue_workspace() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let workspace = tempfile::tempdir().unwrap();
        let variable = "ENSEMBLE_ACCEPTANCE_RUNNER_TEST";
        std::env::set_var(variable, "inherited-value");
        let command = AcceptanceCommandConfig {
            name: "context".to_string(),
            run: format!("printf '%s\\n%s' \"${variable}\" \"$PWD\""),
            timeout_ms: 5_000,
        };

        let result = ShellAcceptanceCommandRunner
            .run(&command, workspace.path())
            .await;

        std::env::remove_var(variable);
        assert_eq!(result.status, AcceptanceStatus::Passed);
        assert_eq!(result.exit_code, Some(0));
        let expected_workspace = std::fs::canonicalize(workspace.path()).unwrap();
        assert_eq!(
            result.stdout.tail,
            format!("inherited-value\n{}", expected_workspace.display())
        );
        assert_eq!(result.stdout.total_bytes, result.stdout.tail.len() as u64);
        assert!(!result.stdout.truncated);
        assert_eq!(result.name, "context");
    }

    #[tokio::test]
    async fn shell_runner_maps_nonzero_and_signal_termination_to_failed() {
        let workspace = tempfile::tempdir().unwrap();

        let nonzero = ShellAcceptanceCommandRunner
            .run(
                &command("nonzero", "printf failure >&2; exit 23", 5_000),
                workspace.path(),
            )
            .await;
        let signal = ShellAcceptanceCommandRunner
            .run(&command("signal", "kill -TERM $$", 5_000), workspace.path())
            .await;

        assert_eq!(nonzero.status, AcceptanceStatus::Failed);
        assert_eq!(nonzero.exit_code, Some(23));
        assert!(nonzero.stderr.tail.ends_with("failure"));
        assert_eq!(signal.status, AcceptanceStatus::Failed);
        assert_eq!(signal.exit_code, None);
        assert!(signal.summary.contains("signal"));
    }

    #[tokio::test]
    async fn shell_runner_retains_independent_final_stream_tails_and_lossy_utf8() {
        let workspace = tempfile::tempdir().unwrap();
        let noisy = ShellAcceptanceCommandRunner
            .run(
                &command(
                    "noisy",
                    "yes o | head -c 40000; yes e | head -c 41000 >&2",
                    5_000,
                ),
                workspace.path(),
            )
            .await;
        let lossy = ShellAcceptanceCommandRunner
            .run(
                &command("lossy", "printf '\\377x'", 5_000),
                workspace.path(),
            )
            .await;

        assert_eq!(noisy.status, AcceptanceStatus::Passed);
        assert_eq!(noisy.stdout.total_bytes, 40_000);
        assert!(noisy.stderr.total_bytes >= 41_000);
        assert!(noisy.stdout.truncated);
        assert!(noisy.stderr.truncated);
        assert_eq!(noisy.stdout.tail.len(), OUTPUT_TAIL_LIMIT);
        assert_eq!(noisy.stderr.tail.len(), OUTPUT_TAIL_LIMIT);
        assert_eq!(lossy.stdout.total_bytes, 2);
        assert_eq!(lossy.stdout.tail, "�x");
    }

    #[tokio::test]
    async fn shell_runner_times_out_and_terminates_descendants() {
        let workspace = tempfile::tempdir().unwrap();
        let marker = workspace.path().join("descendant-survived");

        let result = ShellAcceptanceCommandRunner
            .run(
                &command(
                    "timeout",
                    "(sleep 0.3; touch descendant-survived) & wait",
                    50,
                ),
                workspace.path(),
            )
            .await;
        tokio::time::sleep(Duration::from_millis(500)).await;

        assert_eq!(result.status, AcceptanceStatus::TimedOut);
        assert_eq!(result.exit_code, None);
        assert!(
            !marker.exists(),
            "timed-out descendant escaped its process group"
        );
    }

    #[tokio::test]
    async fn shell_runner_keeps_timeout_active_while_draining_inherited_pipes() {
        let workspace = tempfile::tempdir().unwrap();
        let marker = workspace.path().join("background-survived");

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            ShellAcceptanceCommandRunner.run(
                &command(
                    "background-pipe",
                    "exec python3 -c 'import os,time; child=os.fork(); child and os._exit(0); time.sleep(1.2); open(\"background-survived\", \"w\").close()'",
                    700,
                ),
                workspace.path(),
            ),
        )
        .await
        .expect("runner must enforce its own deadline while draining output");
        tokio::time::sleep(Duration::from_secs(1)).await;

        assert_eq!(result.status, AcceptanceStatus::TimedOut);
        assert!(
            !marker.exists(),
            "background descendant escaped the timed-out output drain"
        );
    }

    #[tokio::test]
    async fn shell_runner_maps_invalid_workspace_to_unavailable_without_command_text() {
        let workspace = tempfile::tempdir().unwrap();
        let missing = workspace.path().join("missing");

        let result = ShellAcceptanceCommandRunner
            .run(
                &command("unavailable", "printf super-secret-command", 5_000),
                &missing,
            )
            .await;

        assert_eq!(result.status, AcceptanceStatus::Unavailable);
        assert_eq!(result.exit_code, None);
        assert!(!result.summary.contains("super-secret-command"));
        assert!(result.stdout.tail.is_empty());
        assert!(result.stderr.tail.is_empty());
    }
}

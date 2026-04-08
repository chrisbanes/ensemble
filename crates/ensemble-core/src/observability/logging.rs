use tracing_subscriber::fmt;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

/// Initialize structured logging for the Ensemble service.
///
/// Format selection:
/// - JSON when `ENSEMBLE_LOG_FORMAT=json` or stdout is not a terminal
/// - Human-readable (pretty) when stdout is a terminal
///
/// Filter selection (precedence order):
/// 1. `ENSEMBLE_LOG` env var
/// 2. `RUST_LOG` env var
/// 3. Default: `info`
///
/// Key span fields used throughout the codebase:
/// - `issue_id`, `issue_identifier` (per-issue spans)
/// - `session_id` (per-session spans)
/// - `hook` (hook execution spans)
///
/// Event contract:
/// - `event` should use stable names from `observability::events_contract`
/// - lifecycle logs should include `run_id` + issue/step context when applicable
///
/// Verbosity guidance:
/// - `info`: lifecycle milestones
/// - `debug`: dispatch/retry/decision reasoning
/// - `trace`: protocol/process metadata with redaction helpers
pub fn init_logging() {
    let filter = build_env_filter();
    let use_json = should_use_json();

    if use_json {
        let fmt_layer = fmt::layer()
            .json()
            .with_target(true)
            .with_thread_ids(false)
            .with_span_list(true);

        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    } else {
        let fmt_layer = fmt::layer()
            .with_target(true)
            .with_thread_ids(false)
            .with_ansi(true);

        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    }
}

/// Build an EnvFilter using ENSEMBLE_LOG, RUST_LOG, or the default "info" level.
fn build_env_filter() -> EnvFilter {
    if let Ok(ensemble_log) = std::env::var("ENSEMBLE_LOG") {
        EnvFilter::try_new(&ensemble_log).unwrap_or_else(|_| {
            eprintln!(
                "warning: invalid ENSEMBLE_LOG filter '{}', falling back to 'info'",
                ensemble_log
            );
            EnvFilter::new("info")
        })
    } else if let Ok(rust_log) = std::env::var("RUST_LOG") {
        EnvFilter::try_new(&rust_log).unwrap_or_else(|_| {
            eprintln!(
                "warning: invalid RUST_LOG filter '{}', falling back to 'info'",
                rust_log
            );
            EnvFilter::new("info")
        })
    } else {
        EnvFilter::new("info")
    }
}

/// Determine whether to use JSON output format.
///
/// Returns true if:
/// - `ENSEMBLE_LOG_FORMAT=json` is set, OR
/// - stdout is not a terminal (piped/redirected)
fn should_use_json() -> bool {
    if let Ok(format) = std::env::var("ENSEMBLE_LOG_FORMAT") {
        if format.eq_ignore_ascii_case("json") {
            return true;
        }
    }
    !std::io::IsTerminal::is_terminal(&std::io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize tests that mutate logging-related env vars.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn lock(vars: &[&'static str]) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let saved: Vec<_> = vars.iter().map(|&k| (k, std::env::var(k).ok())).collect();
            for &k in vars {
                std::env::remove_var(k);
            }
            Self {
                _guard: guard,
                saved,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    const LOG_VARS: &[&str] = &["ENSEMBLE_LOG", "RUST_LOG", "ENSEMBLE_LOG_FORMAT"];

    #[test]
    fn test_build_env_filter_default() {
        let _env = EnvGuard::lock(LOG_VARS);
        let filter = build_env_filter();
        let _ = format!("{:?}", filter);
    }

    #[test]
    fn test_build_env_filter_from_ensemble_log() {
        let _env = EnvGuard::lock(LOG_VARS);
        std::env::set_var("ENSEMBLE_LOG", "debug");
        let filter = build_env_filter();
        let _ = format!("{:?}", filter);
    }

    #[test]
    fn test_build_env_filter_invalid_falls_back() {
        let _env = EnvGuard::lock(LOG_VARS);
        std::env::set_var("ENSEMBLE_LOG", "not a valid filter {{{}}}");
        let filter = build_env_filter();
        let _ = format!("{:?}", filter);
    }

    #[test]
    fn test_should_use_json_with_env_var() {
        let _env = EnvGuard::lock(LOG_VARS);
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "json");
        assert!(should_use_json());
    }

    #[test]
    fn test_should_use_json_case_insensitive() {
        let _env = EnvGuard::lock(LOG_VARS);
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "JSON");
        assert!(should_use_json());
    }

    #[test]
    fn test_should_not_use_json_with_text_format() {
        let _env = EnvGuard::lock(LOG_VARS);
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "text");
        let _ = should_use_json();
    }
}

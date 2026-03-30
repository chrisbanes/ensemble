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

    #[test]
    fn test_build_env_filter_default() {
        // When neither ENSEMBLE_LOG nor RUST_LOG is set, default to info
        let saved_ensemble = std::env::var("ENSEMBLE_LOG").ok();
        let saved_rust = std::env::var("RUST_LOG").ok();
        std::env::remove_var("ENSEMBLE_LOG");
        std::env::remove_var("RUST_LOG");

        let filter = build_env_filter();
        let _ = format!("{:?}", filter);

        if let Some(val) = saved_ensemble {
            std::env::set_var("ENSEMBLE_LOG", val);
        }
        if let Some(val) = saved_rust {
            std::env::set_var("RUST_LOG", val);
        }
    }

    #[test]
    fn test_build_env_filter_from_ensemble_log() {
        let saved = std::env::var("ENSEMBLE_LOG").ok();
        std::env::set_var("ENSEMBLE_LOG", "debug");

        let filter = build_env_filter();
        let _ = format!("{:?}", filter);

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG");
        }
    }

    #[test]
    fn test_build_env_filter_invalid_falls_back() {
        let saved = std::env::var("ENSEMBLE_LOG").ok();
        std::env::set_var("ENSEMBLE_LOG", "not a valid filter {{{}}}");

        let filter = build_env_filter();
        // Should fall back to "info" without panicking
        let _ = format!("{:?}", filter);

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG");
        }
    }

    #[test]
    fn test_should_use_json_with_env_var() {
        let saved = std::env::var("ENSEMBLE_LOG_FORMAT").ok();
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "json");

        assert!(should_use_json());

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG_FORMAT", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG_FORMAT");
        }
    }

    #[test]
    fn test_should_use_json_case_insensitive() {
        let saved = std::env::var("ENSEMBLE_LOG_FORMAT").ok();
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "JSON");

        assert!(should_use_json());

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG_FORMAT", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG_FORMAT");
        }
    }

    #[test]
    fn test_should_not_use_json_with_text_format() {
        let saved = std::env::var("ENSEMBLE_LOG_FORMAT").ok();
        std::env::set_var("ENSEMBLE_LOG_FORMAT", "text");

        // When format is not "json", terminal detection applies.
        let _ = should_use_json();

        if let Some(val) = saved {
            std::env::set_var("ENSEMBLE_LOG_FORMAT", val);
        } else {
            std::env::remove_var("ENSEMBLE_LOG_FORMAT");
        }
    }
}

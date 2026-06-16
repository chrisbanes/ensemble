use tracing::{info, warn};

use crate::observability::events_contract::{ISSUE_RETRY_CANCELLED, ISSUE_RETRY_SCHEDULED};
use crate::tracker::model::RetryEntry;

use super::state::OrchestratorState;

/// Continuation retry delay in milliseconds (after clean worker exit).
pub const CONTINUATION_RETRY_DELAY_MS: u64 = 1000;

/// Base delay for failure-driven exponential backoff.
pub const FAILURE_BASE_DELAY_MS: u64 = 10000;

pub struct FailureRetryRequest<'a> {
    pub issue_id: &'a str,
    pub identifier: &'a str,
    pub attempt: u32,
    pub max_backoff_ms: u64,
    pub max_cycles: u32,
    pub error: &'a str,
    pub retry_from_step: Option<String>,
    pub with_fixup: bool,
}

/// Calculate exponential backoff delay for a failure retry.
/// Formula: min(10000 * 2^(attempt - 1), max_backoff_ms)
pub fn calculate_backoff(attempt: u32, max_backoff_ms: u64) -> u64 {
    if attempt == 0 {
        return FAILURE_BASE_DELAY_MS;
    }
    let exponent = (attempt - 1).min(31); // prevent overflow
    let delay = FAILURE_BASE_DELAY_MS.saturating_mul(1u64 << exponent);
    delay.min(max_backoff_ms)
}

/// Schedule a continuation retry (after normal worker exit).
/// Uses a short fixed delay of 1 second.
pub fn schedule_continuation_retry(
    state: &mut OrchestratorState,
    issue_id: &str,
    identifier: &str,
) -> u64 {
    let due_at_ms = current_time_ms() + CONTINUATION_RETRY_DELAY_MS;

    let entry = RetryEntry {
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        attempt: 1,
        due_at_ms,
        error: None,
        retry_from_step: None,
        with_fixup: false,
    };

    info!(
        event = ISSUE_RETRY_SCHEDULED,
        issue_id = issue_id,
        identifier = identifier,
        reason = "continuation",
        delay_ms = CONTINUATION_RETRY_DELAY_MS,
        "scheduling continuation retry"
    );

    state.add_retry(entry);
    due_at_ms
}

/// Schedule a failure retry with exponential backoff.
/// Returns `Some(due_at_ms)` if the retry was scheduled, or `None` if `max_cycles`
/// has been reached and the issue should not be retried.
pub fn schedule_failure_retry(
    state: &mut OrchestratorState,
    request: FailureRetryRequest<'_>,
) -> Option<u64> {
    let FailureRetryRequest {
        issue_id,
        identifier,
        attempt,
        max_backoff_ms,
        max_cycles,
        error,
        retry_from_step,
        with_fixup,
    } = request;

    if attempt >= max_cycles {
        warn!(
            event = ISSUE_RETRY_CANCELLED,
            issue_id = issue_id,
            identifier = identifier,
            attempt = attempt,
            max_cycles = max_cycles,
            reason = normalize_reason(error),
            "max retry cycles reached, not scheduling further retries"
        );
        return None;
    }

    let delay = calculate_backoff(attempt, max_backoff_ms);
    let due_at_ms = current_time_ms() + delay;

    let entry = RetryEntry {
        issue_id: issue_id.to_string(),
        identifier: identifier.to_string(),
        attempt,
        due_at_ms,
        error: Some(error.to_string()),
        retry_from_step,
        with_fixup,
    };

    info!(
        event = ISSUE_RETRY_SCHEDULED,
        issue_id = issue_id,
        identifier = identifier,
        attempt = attempt,
        delay_ms = delay,
        reason = normalize_reason(error),
        "scheduling failure retry"
    );

    state.add_retry(entry);
    Some(due_at_ms)
}

/// Identify deterministic agent/runtime configuration failures that another
/// retry cannot fix.
pub fn is_non_retryable_failure(reason: &str) -> bool {
    let reason = reason.to_ascii_lowercase();
    reason.contains("cannot apply --model") && reason.contains("did not advertise model support")
}

/// Determine the next attempt number from a running entry.
/// If the entry had a retry_attempt, increment it; otherwise start at 1.
pub fn next_attempt(current: Option<u32>) -> u32 {
    current.map(|a| a + 1).unwrap_or(1)
}

fn normalize_reason(reason: &str) -> &str {
    // Returns "unknown" for empty input, otherwise the input unchanged.
    if reason.trim().is_empty() {
        "unknown"
    } else {
        reason
    }
}

/// Get the current time in milliseconds (monotonic-ish for retry scheduling).
pub fn current_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Check if a retry entry is due (its due time has passed).
pub fn is_retry_due(entry: &RetryEntry) -> bool {
    current_time_ms() >= entry.due_at_ms
}

/// Get all due retries from the state, sorted by due time.
pub fn get_due_retries(state: &OrchestratorState) -> Vec<RetryEntry> {
    let now = current_time_ms();
    let mut due: Vec<RetryEntry> = state
        .retry_attempts
        .values()
        .filter(|e| now >= e.due_at_ms)
        .cloned()
        .collect();
    due.sort_by_key(|e| e.due_at_ms);
    due
}

/// Get the next retry fire time (earliest due_at_ms) if any retries exist.
pub fn next_retry_time(state: &OrchestratorState) -> Option<u64> {
    state.retry_attempts.values().map(|e| e.due_at_ms).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::ConcurrencyConfig;

    #[test]
    fn retry_reason_is_non_empty() {
        let reason = normalize_reason("");
        assert_eq!(reason, "unknown");
    }

    #[test]
    fn unsupported_acpx_model_capability_failure_is_not_retryable() {
        assert!(is_non_retryable_failure(
            "acpx command failed: sessions ensure — exit status: 1; stdout: {\"message\":\"Cannot apply --model \\\"opencode-go/kimi-k2.5\\\": the ACP agent did not advertise model support.\"}"
        ));
    }

    #[test]
    fn ordinary_agent_failure_is_retryable() {
        assert!(!is_non_retryable_failure("temporary agent crash"));
    }

    #[test]
    fn test_calculate_backoff_attempt_1() {
        let delay = calculate_backoff(1, 300_000);
        assert_eq!(delay, 10_000); // 10000 * 2^0 = 10000
    }

    #[test]
    fn test_calculate_backoff_attempt_2() {
        let delay = calculate_backoff(2, 300_000);
        assert_eq!(delay, 20_000); // 10000 * 2^1 = 20000
    }

    #[test]
    fn test_calculate_backoff_attempt_3() {
        let delay = calculate_backoff(3, 300_000);
        assert_eq!(delay, 40_000); // 10000 * 2^2 = 40000
    }

    #[test]
    fn test_calculate_backoff_attempt_4() {
        let delay = calculate_backoff(4, 300_000);
        assert_eq!(delay, 80_000); // 10000 * 2^3 = 80000
    }

    #[test]
    fn test_calculate_backoff_capped() {
        let delay = calculate_backoff(10, 300_000);
        assert_eq!(delay, 300_000); // capped at max
    }

    #[test]
    fn test_calculate_backoff_high_attempt_no_overflow() {
        let delay = calculate_backoff(100, 300_000);
        assert_eq!(delay, 300_000); // capped, no overflow
    }

    #[test]
    fn test_calculate_backoff_attempt_0() {
        let delay = calculate_backoff(0, 300_000);
        assert_eq!(delay, 10_000); // base delay
    }

    #[test]
    fn test_schedule_continuation_retry() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        let due = schedule_continuation_retry(&mut state, "issue-1", "repo#1");

        assert!(state.retry_attempts.contains_key("issue-1"));
        assert!(state.is_claimed("issue-1"));

        let entry = state.retry_attempts.get("issue-1").unwrap();
        assert_eq!(entry.attempt, 1);
        assert!(entry.error.is_none());
        assert!(due > 0);
    }

    #[test]
    fn test_schedule_failure_retry() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        let due = schedule_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                attempt: 2,
                max_backoff_ms: 300_000,
                max_cycles: 5,
                error: "agent crashed",
                retry_from_step: None,
                with_fixup: false,
            },
        );

        assert!(due.is_some());
        assert!(state.retry_attempts.contains_key("issue-1"));

        let entry = state.retry_attempts.get("issue-1").unwrap();
        assert_eq!(entry.attempt, 2);
        assert_eq!(entry.error.as_deref(), Some("agent crashed"));
        assert_eq!(entry.retry_from_step, None);
        assert!(!entry.with_fixup);
    }

    #[test]
    fn test_schedule_failure_retry_respects_max_cycles() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        // attempt 3, max_cycles 3 → should NOT schedule
        let due = schedule_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-1",
                identifier: "repo#1",
                attempt: 3,
                max_backoff_ms: 300_000,
                max_cycles: 3,
                error: "agent crashed",
                retry_from_step: None,
                with_fixup: false,
            },
        );
        assert!(due.is_none());
        assert!(!state.retry_attempts.contains_key("issue-1"));

        // attempt 2, max_cycles 3 → should schedule
        let due = schedule_failure_retry(
            &mut state,
            FailureRetryRequest {
                issue_id: "issue-2",
                identifier: "repo#2",
                attempt: 2,
                max_backoff_ms: 300_000,
                max_cycles: 3,
                error: "agent crashed",
                retry_from_step: None,
                with_fixup: false,
            },
        );
        assert!(due.is_some());
        assert!(state.retry_attempts.contains_key("issue-2"));
    }

    #[test]
    fn test_next_attempt() {
        assert_eq!(next_attempt(None), 1);
        assert_eq!(next_attempt(Some(1)), 2);
        assert_eq!(next_attempt(Some(5)), 6);
    }

    #[test]
    fn test_is_retry_due() {
        let past_entry = RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 0, // in the past
            error: None,
            retry_from_step: None,
            with_fixup: false,
        };
        assert!(is_retry_due(&past_entry));

        let future_entry = RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: current_time_ms() + 999_999_999,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        };
        assert!(!is_retry_due(&future_entry));
    }

    #[test]
    fn test_get_due_retries() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());

        // One due retry (in the past)
        state.add_retry(RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 0,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });

        // One future retry
        state.add_retry(RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: current_time_ms() + 999_999_999,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });

        let due = get_due_retries(&state);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].issue_id, "1");
    }

    #[test]
    fn test_next_retry_time() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        assert_eq!(next_retry_time(&state), None);

        state.add_retry(RetryEntry {
            issue_id: "1".to_string(),
            identifier: "repo#1".to_string(),
            attempt: 1,
            due_at_ms: 5000,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });
        state.add_retry(RetryEntry {
            issue_id: "2".to_string(),
            identifier: "repo#2".to_string(),
            attempt: 1,
            due_at_ms: 3000,
            error: None,
            retry_from_step: None,
            with_fixup: false,
        });

        assert_eq!(next_retry_time(&state), Some(3000));
    }

    #[test]
    fn test_backoff_progression() {
        let max = 300_000u64;
        let delays: Vec<u64> = (1..=8).map(|a| calculate_backoff(a, max)).collect();
        assert_eq!(
            delays,
            vec![10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]
        );
    }
}

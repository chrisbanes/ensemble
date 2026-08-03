use crate::tracker::model::Issue;

use super::state::OrchestratorState;

/// Check if an issue is eligible for dispatch.
/// Returns None if eligible, or Some(reason) explaining why not.
///
/// Compares state names case-insensitively without allocating normalized copies.
pub fn is_dispatch_eligible(
    issue: &Issue,
    state: &OrchestratorState,
    active_states: &[String],
    terminal_states: &[String],
) -> Option<String> {
    // Must have required fields
    if issue.id.is_empty() {
        return Some("missing issue id".to_string());
    }
    if issue.identifier.is_empty() {
        return Some("missing issue identifier".to_string());
    }
    if issue.title.is_empty() {
        return Some("missing issue title".to_string());
    }
    if issue.state.is_empty() {
        return Some("missing issue state".to_string());
    }

    // Must be in active states
    if !contains_state(active_states, &issue.state) {
        return Some(format!("state '{}' not in active states", issue.state));
    }

    // Must NOT be in terminal states
    if contains_state(terminal_states, &issue.state) {
        return Some(format!("state '{}' is terminal", issue.state));
    }

    // Must not already be running
    if state.is_running(&issue.id) {
        return Some("already running".to_string());
    }

    // Must not already be claimed
    if state.is_claimed(&issue.id) {
        return Some("already claimed".to_string());
    }

    // Must not already be completed (tracker may re-surface stale issues)
    if state.completed.contains_key(&issue.id) {
        return Some("already completed".to_string());
    }

    // Blocker rule: Todo issues with non-terminal blockers are not eligible
    if issue.state.eq_ignore_ascii_case("todo") && !issue.blocked_by.is_empty() {
        let has_non_terminal_blocker = issue.blocked_by.iter().any(|blocker| {
            if let Some(ref blocker_state) = blocker.state {
                !contains_state(terminal_states, blocker_state)
            } else {
                // Unknown state — treat as non-terminal (conservative)
                true
            }
        });
        if has_non_terminal_blocker {
            return Some("blocked by non-terminal issue".to_string());
        }
    }

    None
}

/// Check if an explicitly requested resume dispatch may proceed.
///
/// This bypasses the normal claimed-issue filter so resolved waiting issues can
/// be redispatched while still remaining claimed by the orchestrator.
pub fn is_resume_dispatch_eligible(
    issue: &Issue,
    state: &OrchestratorState,
    active_states: &[String],
    terminal_states: &[String],
) -> Option<String> {
    if !state.is_waiting_on_human(&issue.id) {
        return Some("issue is not waiting on human".to_string());
    }

    // Must have required fields.
    if issue.id.is_empty() {
        return Some("missing issue id".to_string());
    }
    if issue.identifier.is_empty() {
        return Some("missing issue identifier".to_string());
    }
    if issue.title.is_empty() {
        return Some("missing issue title".to_string());
    }
    if issue.state.is_empty() {
        return Some("missing issue state".to_string());
    }

    if !contains_state(active_states, &issue.state) {
        return Some(format!("state '{}' not in active states", issue.state));
    }
    if contains_state(terminal_states, &issue.state) {
        return Some(format!("state '{}' is terminal", issue.state));
    }
    if state.is_running(&issue.id) {
        return Some("already running".to_string());
    }
    if state.completed.contains_key(&issue.id) {
        return Some("already completed".to_string());
    }
    None
}

fn contains_state(states: &[String], needle: &str) -> bool {
    states
        .iter()
        .any(|state| state.eq_ignore_ascii_case(needle))
}

/// Sort issues for dispatch priority.
/// 1. priority ascending (lower number = higher priority; null sorts last)
/// 2. created_at oldest first (null sorts last)
/// 3. identifier lexicographic tiebreaker
pub fn sort_for_dispatch(issues: &mut [Issue]) {
    issues.sort_by(|a, b| {
        // Priority: ascending, None sorts last
        let pa = a.priority.unwrap_or(i32::MAX);
        let pb = b.priority.unwrap_or(i32::MAX);
        pa.cmp(&pb)
            .then_with(|| {
                // created_at: oldest first, None sorts last
                match (&a.created_at, &b.created_at) {
                    (Some(ca), Some(cb)) => ca.cmp(cb),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            })
            .then_with(|| a.identifier.cmp(&b.identifier))
    });
}

/// Calculate available global dispatch slots.
pub fn available_global_slots(state: &OrchestratorState) -> u32 {
    let running = state.running_count() as u32;
    state.max_concurrent_agents.saturating_sub(running)
}

/// Advisory check for admitting work that will reserve a live worker slot.
/// The cancellation registry's atomic reservation remains authoritative.
pub fn has_available_worker_slots(live_workers: u32, max_workers: u32) -> bool {
    live_workers < max_workers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::ConcurrencyConfig;
    use crate::tracker::model::BlockerRef;
    use chrono::{TimeZone, Utc};

    fn test_issue(id: &str, state: &str) -> Issue {
        crate::tracker::model::test_helpers::test_issue(id, state)
    }

    fn default_active() -> Vec<String> {
        vec!["todo".to_string(), "in progress".to_string()]
    }

    fn default_terminal() -> Vec<String> {
        vec!["done".to_string(), "closed".to_string()]
    }

    #[test]
    fn test_eligible_issue() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_none(), "expected eligible, got: {:?}", result);
    }

    #[test]
    fn resumed_waiting_issue_is_dispatch_eligible_even_while_claimed() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_waiting_on_human(crate::orchestrator::state::WaitingOnHumanEntry {
            issue_id: issue.id.clone(),
            identifier: issue.identifier.clone(),
            interaction_request_id: "interaction-1".to_string(),
            step_name: "build".to_string(),
            kind: crate::interaction::model::InteractionKind::BrainstormPrompt,
            prompt: "Need input".to_string(),
            agent_name: "builder".to_string(),
            retry_attempt: None,
            started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            run_id: None,
            issue: None,
        });

        let normal = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert_eq!(normal.as_deref(), Some("already claimed"));

        let resumed =
            is_resume_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(
            resumed.is_none(),
            "expected resume eligibility, got: {resumed:?}"
        );
    }

    #[test]
    fn test_ineligible_missing_id() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let mut issue = test_issue("", "Todo");
        issue.id = "".to_string();

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_some());
        assert!(result.unwrap().contains("missing issue id"));
    }

    #[test]
    fn test_ineligible_wrong_state() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Backlog");

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_some());
        assert!(result.unwrap().contains("not in active states"));
    }

    #[test]
    fn test_ineligible_terminal_state() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Done");

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_some());
    }

    #[test]
    fn test_ineligible_already_running() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        state.add_running(&issue, None);

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_some());
        assert!(result.unwrap().contains("already running"));
    }

    #[test]
    fn test_ineligible_already_claimed() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.add_claimed("1");

        let issue = test_issue("1", "Todo");

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_some());
        assert!(result.unwrap().contains("already claimed"));
    }

    #[test]
    fn test_ineligible_already_completed() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let issue = test_issue("1", "Todo");
        // Add to running first so complete_issue can find the issue data
        state.add_running(&issue, None);
        state.add_completed(
            "1".to_string(),
            "repo#1".to_string(),
            "completed_succeeded".to_string(),
        );
        // Remove from running and claimed so the "already completed" check is reached
        state.running.remove("1");
        state.claimed.remove("1");

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_some());
        assert!(result.unwrap().contains("already completed"));
    }

    #[test]
    fn test_live_worker_admission_uses_worker_count() {
        assert!(has_available_worker_slots(3, 4));
        assert!(!has_available_worker_slots(4, 4));
        assert!(!has_available_worker_slots(5, 4));
    }

    #[test]
    fn state_worker_caps_do_not_affect_issue_eligibility() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        state.add_running(&test_issue("existing", "Todo"), None);

        let issue = test_issue("new", "Todo");

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_none());
    }

    #[test]
    fn test_ineligible_todo_with_non_terminal_blocker() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let mut issue = test_issue("1", "Todo");
        issue.blocked_by = vec![BlockerRef {
            id: Some("blocker-1".to_string()),
            identifier: Some("repo#99".to_string()),
            state: Some("In Progress".to_string()),
        }];

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_some());
        assert!(result.unwrap().contains("blocked by non-terminal"));
    }

    #[test]
    fn test_eligible_todo_with_terminal_blocker() {
        let state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        let mut issue = test_issue("1", "Todo");
        issue.blocked_by = vec![BlockerRef {
            id: Some("blocker-1".to_string()),
            identifier: Some("repo#99".to_string()),
            state: Some("Done".to_string()),
        }];

        let result = is_dispatch_eligible(&issue, &state, &default_active(), &default_terminal());
        assert!(result.is_none(), "expected eligible with terminal blocker");
    }

    #[test]
    fn test_sort_by_priority_then_created_at() {
        let t1 = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let t2 = Utc.with_ymd_and_hms(2026, 1, 2, 0, 0, 0).unwrap();

        let mut issues = vec![
            Issue {
                id: "c".to_string(),
                identifier: "repo#c".to_string(),
                title: "C".to_string(),
                description: None,
                priority: Some(3),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(t1),
                updated_at: None,
            },
            Issue {
                id: "a".to_string(),
                identifier: "repo#a".to_string(),
                title: "A".to_string(),
                description: None,
                priority: Some(1),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(t2),
                updated_at: None,
            },
            Issue {
                id: "b".to_string(),
                identifier: "repo#b".to_string(),
                title: "B".to_string(),
                description: None,
                priority: Some(1),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(t1),
                updated_at: None,
            },
        ];

        sort_for_dispatch(&mut issues);

        // Priority 1 first, then oldest created_at, then identifier
        assert_eq!(issues[0].id, "b"); // priority 1, older
        assert_eq!(issues[1].id, "a"); // priority 1, newer
        assert_eq!(issues[2].id, "c"); // priority 3
    }

    #[test]
    fn test_sort_null_priority_last() {
        let mut issues = vec![
            Issue {
                id: "no-pri".to_string(),
                identifier: "repo#no-pri".to_string(),
                title: "No priority".to_string(),
                description: None,
                priority: None,
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(Utc::now()),
                updated_at: None,
            },
            Issue {
                id: "has-pri".to_string(),
                identifier: "repo#has-pri".to_string(),
                title: "Has priority".to_string(),
                description: None,
                priority: Some(4),
                state: "Todo".to_string(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: Some(Utc::now()),
                updated_at: None,
            },
        ];

        sort_for_dispatch(&mut issues);

        assert_eq!(issues[0].id, "has-pri");
        assert_eq!(issues[1].id, "no-pri");
    }

    #[test]
    fn test_available_global_slots() {
        let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
        assert_eq!(available_global_slots(&state), 4);

        state.add_running(&test_issue("1", "Todo"), None);
        assert_eq!(available_global_slots(&state), 3);

        state.add_running(&test_issue("2", "Todo"), None);
        state.add_running(&test_issue("3", "Todo"), None);
        state.add_running(&test_issue("4", "Todo"), None);
        assert_eq!(available_global_slots(&state), 0);
    }
}

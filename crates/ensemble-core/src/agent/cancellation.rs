use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio_util::sync::CancellationToken;

pub type CancellationRegistry = Arc<Mutex<HashMap<String, CancellationToken>>>;

pub fn new_cancellation_registry() -> CancellationRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn register_issue_cancellation(
    registry: &CancellationRegistry,
    issue_id: &str,
    token: CancellationToken,
) {
    registry_guard(registry).insert(issue_id.to_string(), token);
}

pub fn cancel_issue(registry: &CancellationRegistry, issue_id: &str) -> bool {
    if let Some(token) = registry_guard(registry).get(issue_id).cloned() {
        token.cancel();
        true
    } else {
        false
    }
}

pub fn clear_issue_cancellation(
    registry: &CancellationRegistry,
    issue_id: &str,
) -> Option<CancellationToken> {
    registry_guard(registry).remove(issue_id)
}

pub fn cancel_all(registry: &CancellationRegistry) -> usize {
    let tokens: Vec<CancellationToken> = registry_guard(registry).values().cloned().collect();
    let count = tokens.len();
    for token in tokens {
        token.cancel();
    }
    count
}

fn registry_guard(
    registry: &CancellationRegistry,
) -> MutexGuard<'_, HashMap<String, CancellationToken>> {
    registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_issue_marks_registered_token() {
        let registry = new_cancellation_registry();
        let token = CancellationToken::new();
        register_issue_cancellation(&registry, "issue-1", token.clone());

        assert!(cancel_issue(&registry, "issue-1"));
        assert!(token.is_cancelled());
    }
}

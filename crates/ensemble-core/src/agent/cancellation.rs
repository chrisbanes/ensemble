use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

#[cfg(test)]
use chrono::{TimeZone, Utc};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::agent::events::WorkerIdentity;

struct ActiveWorker {
    cancellation: CancellationToken,
    completion: watch::Receiver<bool>,
    reconciliation_owned: bool,
}

pub struct WorkerDrainHandle {
    identity: WorkerIdentity,
    completion: watch::Receiver<bool>,
}

#[derive(Clone, Default)]
pub struct CancellationRegistry(Arc<Mutex<HashMap<WorkerIdentity, ActiveWorker>>>);

pub fn new_cancellation_registry() -> CancellationRegistry {
    CancellationRegistry::default()
}

pub fn register_worker(
    registry: &CancellationRegistry,
    identity: WorkerIdentity,
    cancellation: CancellationToken,
    completion: watch::Receiver<bool>,
) {
    registry_guard(registry).insert(
        identity,
        ActiveWorker {
            cancellation,
            completion,
            reconciliation_owned: false,
        },
    );
}

#[cfg(test)]
pub fn register_issue_cancellation(
    registry: &CancellationRegistry,
    issue_id: &str,
    token: CancellationToken,
) {
    let (_, completion) = watch::channel(true);
    register_worker(
        registry,
        WorkerIdentity {
            issue_id: issue_id.to_string(),
            run_id: String::new(),
            cycle: 0,
            step_name: String::new(),
            started_at: Utc.timestamp_opt(0, 0).unwrap(),
        },
        token,
        completion,
    );
}

pub fn cancel_issue(registry: &CancellationRegistry, issue_id: &str) -> bool {
    let tokens = issue_tokens(registry, issue_id);
    for token in &tokens {
        token.cancel();
    }
    !tokens.is_empty()
}

pub fn clear_issue_cancellation(
    registry: &CancellationRegistry,
    issue_id: &str,
) -> Option<CancellationToken> {
    let mut registry = registry_guard(registry);
    let identities = registry
        .keys()
        .filter(|identity| identity.issue_id == issue_id)
        .cloned()
        .collect::<Vec<_>>();
    identities
        .into_iter()
        .filter_map(|identity| registry.remove(&identity))
        .map(|worker| worker.cancellation)
        .next()
}

pub fn cancel_all(registry: &CancellationRegistry) -> usize {
    let tokens: Vec<CancellationToken> = {
        // Clone the current handles inside a narrow scope so the mutex guard is
        // definitely released before we invoke `cancel()` on any token.
        registry_guard(registry)
            .values()
            .map(|worker| worker.cancellation.clone())
            .collect()
    };
    let count = tokens.len();
    for token in tokens {
        token.cancel();
    }
    count
}

pub fn mark_issue_for_drain(
    registry: &CancellationRegistry,
    issue_id: &str,
) -> Vec<WorkerDrainHandle> {
    mark_workers_for_drain(registry, |identity| identity.issue_id == issue_id)
}

pub fn mark_all_for_drain(registry: &CancellationRegistry) -> Vec<WorkerDrainHandle> {
    mark_workers_for_drain(registry, |_| true)
}

fn mark_workers_for_drain(
    registry: &CancellationRegistry,
    matches: impl Fn(&WorkerIdentity) -> bool,
) -> Vec<WorkerDrainHandle> {
    let (tokens, handles) = {
        let mut registry = registry_guard(registry);
        let mut tokens = Vec::new();
        let mut handles = Vec::new();
        for (identity, worker) in registry.iter_mut() {
            if !matches(identity) {
                continue;
            }
            worker.reconciliation_owned = true;
            tokens.push(worker.cancellation.clone());
            handles.push(WorkerDrainHandle {
                identity: identity.clone(),
                completion: worker.completion.clone(),
            });
        }
        (tokens, handles)
    };
    for token in tokens {
        token.cancel();
    }
    handles
}

pub async fn await_worker_drain(handles: &mut [WorkerDrainHandle], wait: Duration) -> bool {
    tokio::time::timeout(wait, async {
        for handle in handles {
            while !*handle.completion.borrow() {
                if handle.completion.changed().await.is_err() {
                    return false;
                }
            }
        }
        true
    })
    .await
    .unwrap_or_default()
}

pub fn is_reconciliation_owned(registry: &CancellationRegistry, identity: &WorkerIdentity) -> bool {
    registry_guard(registry)
        .get(identity)
        .is_some_and(|worker| worker.reconciliation_owned)
}

pub fn remove_completed_worker(registry: &CancellationRegistry, identity: &WorkerIdentity) -> bool {
    let mut registry = registry_guard(registry);
    let removable = registry
        .get(identity)
        .is_some_and(|worker| *worker.completion.borrow() && !worker.reconciliation_owned);
    if removable {
        registry.remove(identity);
    }
    removable
}

pub fn remove_drained_workers(registry: &CancellationRegistry, handles: &[WorkerDrainHandle]) {
    let mut registry = registry_guard(registry);
    for handle in handles {
        registry.remove(&handle.identity);
    }
}

#[cfg(test)]
pub fn contains_worker(registry: &CancellationRegistry, identity: &WorkerIdentity) -> bool {
    registry_guard(registry).contains_key(identity)
}

#[cfg(test)]
pub fn registry_is_empty(registry: &CancellationRegistry) -> bool {
    registry_guard(registry).is_empty()
}

fn issue_tokens(registry: &CancellationRegistry, issue_id: &str) -> Vec<CancellationToken> {
    registry_guard(registry)
        .iter()
        .filter(|(identity, _)| identity.issue_id == issue_id)
        .map(|(_, worker)| worker.cancellation.clone())
        .collect()
}

fn registry_guard(
    registry: &CancellationRegistry,
) -> MutexGuard<'_, HashMap<WorkerIdentity, ActiveWorker>> {
    registry
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::WorkerIdentity;
    use chrono::{TimeZone, Utc};
    use std::time::Duration;
    use tokio::sync::watch;

    fn identity(step_name: &str, started_at_second: i64) -> WorkerIdentity {
        WorkerIdentity {
            issue_id: "issue-1".to_string(),
            run_id: "run-1".to_string(),
            cycle: 1,
            step_name: step_name.to_string(),
            started_at: Utc.timestamp_opt(started_at_second, 0).unwrap(),
        }
    }

    #[test]
    fn cancel_issue_marks_registered_token() {
        let registry = new_cancellation_registry();
        let token = CancellationToken::new();
        register_issue_cancellation(&registry, "issue-1", token.clone());

        assert!(cancel_issue(&registry, "issue-1"));
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn worker_registry_cancels_and_awaits_every_identity_for_an_issue() {
        let registry = new_cancellation_registry();
        let first = identity("build", 1);
        let second = identity("review", 1);
        let first_token = CancellationToken::new();
        let second_token = CancellationToken::new();
        let (first_complete_tx, first_complete_rx) = watch::channel(false);
        let (second_complete_tx, second_complete_rx) = watch::channel(false);
        register_worker(
            &registry,
            first.clone(),
            first_token.clone(),
            first_complete_rx,
        );
        register_worker(
            &registry,
            second.clone(),
            second_token.clone(),
            second_complete_rx,
        );

        let mut drain = mark_issue_for_drain(&registry, "issue-1");
        assert_eq!(drain.len(), 2);
        assert!(first_token.is_cancelled());
        assert!(second_token.is_cancelled());
        assert!(is_reconciliation_owned(&registry, &first));
        assert!(is_reconciliation_owned(&registry, &second));

        first_complete_tx.send(true).unwrap();
        assert!(!await_worker_drain(&mut drain, Duration::from_millis(10)).await);
        second_complete_tx.send(true).unwrap();
        assert!(await_worker_drain(&mut drain, Duration::from_millis(10)).await);
    }

    #[test]
    fn worker_registry_conditional_removal_cannot_remove_a_replacement() {
        let registry = new_cancellation_registry();
        let first = identity("build", 1);
        let replacement = identity("build", 2);
        let (_, first_complete_rx) = watch::channel(true);
        let (_, replacement_complete_rx) = watch::channel(false);
        register_worker(
            &registry,
            first.clone(),
            CancellationToken::new(),
            first_complete_rx,
        );
        register_worker(
            &registry,
            replacement.clone(),
            CancellationToken::new(),
            replacement_complete_rx,
        );

        assert!(remove_completed_worker(&registry, &first));
        assert!(!remove_completed_worker(&registry, &first));
        assert!(contains_worker(&registry, &replacement));
    }

    #[test]
    fn worker_registry_completion_retirement_waits_for_quiescence_and_respects_drain_owner() {
        let registry = new_cancellation_registry();
        let completed = identity("build", 1);
        let (completed_tx, completed_rx) = watch::channel(false);
        register_worker(
            &registry,
            completed.clone(),
            CancellationToken::new(),
            completed_rx,
        );

        assert!(!remove_completed_worker(&registry, &completed));
        completed_tx.send(true).unwrap();
        assert!(remove_completed_worker(&registry, &completed));

        let drained = identity("review", 1);
        let (_drained_tx, drained_rx) = watch::channel(true);
        register_worker(
            &registry,
            drained.clone(),
            CancellationToken::new(),
            drained_rx,
        );
        mark_issue_for_drain(&registry, "issue-1");

        assert!(!remove_completed_worker(&registry, &drained));
        assert!(contains_worker(&registry, &drained));
    }

    #[tokio::test]
    async fn worker_registry_timeout_retains_marked_owner_for_retry() {
        let registry = new_cancellation_registry();
        let worker = identity("build", 1);
        let (_complete_tx, complete_rx) = watch::channel(false);
        register_worker(
            &registry,
            worker.clone(),
            CancellationToken::new(),
            complete_rx,
        );

        let mut drain = mark_issue_for_drain(&registry, "issue-1");
        assert!(!await_worker_drain(&mut drain, Duration::from_millis(1)).await);
        assert!(contains_worker(&registry, &worker));
        assert!(is_reconciliation_owned(&registry, &worker));
    }

    #[tokio::test]
    async fn worker_registry_closed_incomplete_signal_is_not_a_successful_drain() {
        let registry = new_cancellation_registry();
        let worker = identity("build", 1);
        let (complete_tx, complete_rx) = watch::channel(false);
        register_worker(
            &registry,
            worker.clone(),
            CancellationToken::new(),
            complete_rx,
        );
        drop(complete_tx);

        let mut drain = mark_issue_for_drain(&registry, "issue-1");
        assert!(!await_worker_drain(&mut drain, Duration::from_millis(10)).await);
        assert!(contains_worker(&registry, &worker));
    }
}

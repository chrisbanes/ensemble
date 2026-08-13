use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

#[cfg(test)]
use chrono::{TimeZone, Utc};
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

use crate::agent::events::WorkerIdentity;
use crate::config::ensemble::normalize_state_worker_cap_key;
use crate::orchestrator::resources::{paths_conflict, SchedulerReservation};

struct ActiveWorker {
    cancellation: CancellationToken,
    completion: watch::Receiver<bool>,
    capacity_bucket: String,
    scheduler_reservation: SchedulerReservation,
    exclusive_issue_workspace: bool,
    reconciliation_owned: bool,
    launched: bool,
}

pub struct WorkerDrainHandle {
    identity: WorkerIdentity,
    completion: watch::Receiver<bool>,
}

#[derive(Clone, Default)]
pub struct CancellationRegistry {
    state: Arc<Mutex<RegistryState>>,
    workspace_capture_released: Arc<Notify>,
}

#[derive(Default)]
struct RegistryState {
    workers: HashMap<WorkerIdentity, ActiveWorker>,
    workspace_captures: HashSet<String>,
}

impl Deref for RegistryState {
    type Target = HashMap<WorkerIdentity, ActiveWorker>;

    fn deref(&self) -> &Self::Target {
        &self.workers
    }
}

impl DerefMut for RegistryState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.workers
    }
}

pub(crate) struct IssueWorkspaceCaptureGuard {
    registry: CancellationRegistry,
    issue_id: String,
}

impl std::fmt::Debug for IssueWorkspaceCaptureGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IssueWorkspaceCaptureGuard")
            .field("issue_id", &self.issue_id)
            .finish_non_exhaustive()
    }
}

impl Drop for IssueWorkspaceCaptureGuard {
    fn drop(&mut self) {
        let mut state = registry_guard(&self.registry);
        state.workspace_captures.remove(&self.issue_id);
        drop(state);
        self.registry.workspace_capture_released.notify_waiters();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkerReservationError {
    DuplicateIdentity,
    GlobalCapacityExhausted,
    IssueCapacityExhausted,
    CapacityBucketExhausted,
    ResourceExhausted,
    PathConflict,
    IssueWorkspaceExclusive,
}

pub(crate) struct WorkerCapacity<'a> {
    source: CapacitySource<'a>,
}

enum CapacitySource<'a> {
    State {
        issue_state: &'a str,
        max_workers_by_state: &'a BTreeMap<String, u32>,
    },
    Lane {
        lane: &'a str,
        capacity: Option<u32>,
    },
}

impl<'a> WorkerCapacity<'a> {
    pub(crate) fn new(
        issue_state: &'a str,
        max_workers_by_state: &'a BTreeMap<String, u32>,
    ) -> Self {
        Self {
            source: CapacitySource::State {
                issue_state,
                max_workers_by_state,
            },
        }
    }

    pub(crate) fn lane(lane: &'a str, capacity: Option<u32>) -> Self {
        Self {
            source: CapacitySource::Lane { lane, capacity },
        }
    }

    fn bucket_and_limit(&self) -> (String, Option<u32>) {
        match self.source {
            CapacitySource::State {
                issue_state,
                max_workers_by_state,
            } => {
                let bucket = normalize_state_worker_cap_key(issue_state);
                let limit = max_workers_by_state.get(&bucket).copied();
                (format!("state:{bucket}"), limit)
            }
            CapacitySource::Lane { lane, capacity } => (format!("lane:{lane}"), capacity),
        }
    }
}

#[cfg(test)]
pub(crate) type StateWorkerCapacity<'a> = WorkerCapacity<'a>;

pub fn new_cancellation_registry() -> CancellationRegistry {
    CancellationRegistry::default()
}

/// Prevent new same-issue workers from starting while a producer captures a stable workspace.
/// Existing workers remain registered so the caller can drain them before observing the snapshot.
pub(crate) async fn acquire_issue_workspace_capture(
    registry: &CancellationRegistry,
    issue_id: &str,
) -> IssueWorkspaceCaptureGuard {
    loop {
        let notified = registry.workspace_capture_released.notified();
        tokio::pin!(notified);
        let acquired = {
            let mut state = registry_guard(registry);
            // Arm the waiter while the release path is excluded by the same lock.
            // A capture guard therefore cannot release after this check without
            // waking this waiter.
            notified.as_mut().enable();
            state.workspace_captures.insert(issue_id.to_string())
        };
        if acquired {
            return IssueWorkspaceCaptureGuard {
                registry: registry.clone(),
                issue_id: issue_id.to_string(),
            };
        }
        notified.await;
    }
}

pub(crate) fn worker_uses_exclusive_issue_workspace(
    registry: &CancellationRegistry,
    identity: &WorkerIdentity,
) -> bool {
    registry_guard(registry)
        .get(identity)
        .is_some_and(|worker| worker.exclusive_issue_workspace)
}

#[cfg(test)]
pub(crate) fn issue_workspace_capture_is_active(
    registry: &CancellationRegistry,
    issue_id: &str,
) -> bool {
    registry_guard(registry)
        .workspace_captures
        .contains(issue_id)
}

#[cfg(test)]
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
            capacity_bucket: String::new(),
            scheduler_reservation: SchedulerReservation::default(),
            exclusive_issue_workspace: false,
            reconciliation_owned: false,
            launched: true,
        },
    );
}

#[cfg(test)]
pub(crate) fn try_reserve_worker(
    registry: &CancellationRegistry,
    identity: WorkerIdentity,
    cancellation: CancellationToken,
    completion: watch::Receiver<bool>,
    max_global_workers: u32,
    max_issue_workers: u32,
    capacity: WorkerCapacity<'_>,
) -> Result<(), WorkerReservationError> {
    try_reserve_scheduler_worker_with_workspace_exclusivity(
        registry,
        identity,
        cancellation,
        completion,
        max_global_workers,
        max_issue_workers,
        capacity,
        &BTreeMap::new(),
        SchedulerReservation::default(),
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn try_reserve_scheduler_worker_with_workspace_exclusivity(
    registry: &CancellationRegistry,
    identity: WorkerIdentity,
    cancellation: CancellationToken,
    completion: watch::Receiver<bool>,
    max_global_workers: u32,
    max_issue_workers: u32,
    capacity: WorkerCapacity<'_>,
    resource_capacities: &BTreeMap<String, u32>,
    scheduler_reservation: SchedulerReservation,
    exclusive_issue_workspace: bool,
) -> Result<(), WorkerReservationError> {
    let mut workers = registry_guard(registry);
    if workers.workspace_captures.contains(&identity.issue_id) {
        return Err(WorkerReservationError::IssueWorkspaceExclusive);
    }
    if workers.contains_key(&identity) {
        return Err(WorkerReservationError::DuplicateIdentity);
    }
    if workers.len() >= max_global_workers as usize {
        return Err(WorkerReservationError::GlobalCapacityExhausted);
    }
    if workers
        .keys()
        .filter(|worker| worker.issue_id == identity.issue_id)
        .count()
        >= max_issue_workers as usize
    {
        return Err(WorkerReservationError::IssueCapacityExhausted);
    }
    if workers.iter().any(|(active, worker)| {
        active.issue_id == identity.issue_id
            && (worker.exclusive_issue_workspace || exclusive_issue_workspace)
    }) {
        return Err(WorkerReservationError::IssueWorkspaceExclusive);
    }
    let (capacity_bucket, limit) = capacity.bucket_and_limit();
    if !capacity_available(&workers, &capacity_bucket, limit) {
        return Err(WorkerReservationError::CapacityBucketExhausted);
    }
    for (resource, units) in &scheduler_reservation.resources {
        let used = workers
            .values()
            .filter_map(|worker| worker.scheduler_reservation.resources.get(resource))
            .sum::<u32>();
        if resource_capacities
            .get(resource)
            .copied()
            .unwrap_or_default()
            < used.saturating_add(*units)
        {
            return Err(WorkerReservationError::ResourceExhausted);
        }
    }
    if scheduler_reservation.paths.iter().any(|path| {
        workers.values().any(|worker| {
            worker
                .scheduler_reservation
                .paths
                .iter()
                .any(|active| paths_conflict(active, path))
        })
    }) {
        return Err(WorkerReservationError::PathConflict);
    }
    workers.insert(
        identity,
        ActiveWorker {
            cancellation,
            completion,
            capacity_bucket,
            scheduler_reservation,
            exclusive_issue_workspace,
            reconciliation_owned: false,
            launched: false,
        },
    );
    Ok(())
}

pub(crate) fn has_available_state_worker_capacity(
    registry: &CancellationRegistry,
    issue_state: &str,
    max_state_workers: &BTreeMap<String, u32>,
) -> bool {
    if max_state_workers.is_empty() {
        return true;
    }
    let state_bucket = normalize_state_worker_cap_key(issue_state);
    let bucket = format!("state:{state_bucket}");
    capacity_available(
        &registry_guard(registry),
        &bucket,
        max_state_workers.get(&state_bucket).copied(),
    )
}

pub(crate) fn has_available_lane_worker_capacity(
    registry: &CancellationRegistry,
    lane: &str,
    capacity: Option<u32>,
) -> bool {
    let bucket = format!("lane:{lane}");
    capacity_available(&registry_guard(registry), &bucket, capacity)
}

fn capacity_available(
    workers: &HashMap<WorkerIdentity, ActiveWorker>,
    capacity_bucket: &str,
    limit: Option<u32>,
) -> bool {
    limit.is_none_or(|limit| {
        workers
            .values()
            .filter(|worker| worker.capacity_bucket == capacity_bucket)
            .count()
            < limit as usize
    })
}

pub(crate) fn mark_worker_launched(
    registry: &CancellationRegistry,
    identity: &WorkerIdentity,
) -> bool {
    let mut workers = registry_guard(registry);
    let Some(worker) = workers.get_mut(identity) else {
        return false;
    };
    worker.launched = true;
    true
}

pub(crate) fn rollback_worker_reservation(
    registry: &CancellationRegistry,
    identity: &WorkerIdentity,
) -> bool {
    let mut workers = registry_guard(registry);
    let removable = workers.get(identity).is_some_and(|worker| !worker.launched);
    if removable {
        workers.remove(identity);
    }
    removable
}

pub(crate) fn live_worker_count(registry: &CancellationRegistry) -> u32 {
    registry_guard(registry).len() as u32
}

#[cfg(test)]
pub fn live_worker_count_for_issue(registry: &CancellationRegistry, issue_id: &str) -> u32 {
    registry_guard(registry)
        .keys()
        .filter(|identity| identity.issue_id == issue_id)
        .count() as u32
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

/// Completion watches for other active workers in one issue without changing their ownership or
/// cancellation state.
pub(crate) fn sibling_worker_completion_handles(
    registry: &CancellationRegistry,
    issue_id: &str,
    step_name: &str,
) -> Vec<WorkerDrainHandle> {
    registry_guard(registry)
        .iter()
        .filter(|(identity, _)| identity.issue_id == issue_id && identity.step_name != step_name)
        .map(|(identity, worker)| WorkerDrainHandle {
            identity: identity.clone(),
            completion: worker.completion.clone(),
        })
        .collect()
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
    tokio::time::timeout(wait, await_worker_quiescence(handles))
        .await
        .unwrap_or_default()
}

pub async fn await_worker_quiescence(handles: &mut [WorkerDrainHandle]) -> bool {
    for handle in handles {
        while !*handle.completion.borrow() {
            if handle.completion.changed().await.is_err() {
                return false;
            }
        }
    }
    true
}

pub fn is_reconciliation_owned(registry: &CancellationRegistry, identity: &WorkerIdentity) -> bool {
    registry_guard(registry)
        .get(identity)
        .is_some_and(|worker| worker.reconciliation_owned)
}

pub fn pending_reconciliation_issue_ids(registry: &CancellationRegistry) -> Vec<String> {
    let mut issue_ids = registry_guard(registry)
        .iter()
        .filter(|(_, worker)| worker.reconciliation_owned)
        .map(|(identity, _)| identity.issue_id.clone())
        .collect::<Vec<_>>();
    issue_ids.sort();
    issue_ids.dedup();
    issue_ids
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

fn registry_guard(registry: &CancellationRegistry) -> MutexGuard<'_, RegistryState> {
    registry
        .state
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

    #[test]
    fn sibling_completion_handles_leave_worker_ownership_unchanged() {
        let registry = new_cancellation_registry();
        let (first_complete_tx, first_complete_rx) = watch::channel(false);
        let (_, sibling_complete_rx) = watch::channel(false);
        let first = identity("build", 1);
        let sibling = identity("review", 1);
        register_worker(
            &registry,
            first.clone(),
            CancellationToken::new(),
            first_complete_rx,
        );
        register_worker(
            &registry,
            sibling.clone(),
            CancellationToken::new(),
            sibling_complete_rx,
        );

        let handles = sibling_worker_completion_handles(&registry, "issue-1", "build");

        assert_eq!(handles.len(), 1);
        assert!(contains_worker(&registry, &first));
        assert!(contains_worker(&registry, &sibling));
        first_complete_tx.send(true).unwrap();
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
        assert_eq!(
            pending_reconciliation_issue_ids(&registry),
            vec!["issue-1".to_string()]
        );
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

    #[test]
    fn worker_capacity_reservation_enforces_global_and_issue_limits_atomically() {
        let registry = new_cancellation_registry();
        let first = identity("build", 1);
        let second = identity("review", 1);
        let other_issue = WorkerIdentity {
            issue_id: "issue-2".to_string(),
            ..identity("build", 2)
        };
        let (_, first_completion) = watch::channel(false);
        let (_, second_completion) = watch::channel(false);
        let (_, other_completion) = watch::channel(false);

        assert_eq!(
            try_reserve_worker(
                &registry,
                first.clone(),
                CancellationToken::new(),
                first_completion,
                2,
                1,
                StateWorkerCapacity::new("", &BTreeMap::new()),
            ),
            Ok(())
        );
        assert_eq!(
            try_reserve_worker(
                &registry,
                second,
                CancellationToken::new(),
                second_completion,
                2,
                1,
                StateWorkerCapacity::new("", &BTreeMap::new()),
            ),
            Err(WorkerReservationError::IssueCapacityExhausted)
        );
        assert_eq!(
            try_reserve_worker(
                &registry,
                other_issue,
                CancellationToken::new(),
                other_completion,
                2,
                1,
                StateWorkerCapacity::new("", &BTreeMap::new()),
            ),
            Ok(())
        );
        assert_eq!(live_worker_count(&registry), 2);
        assert_eq!(live_worker_count_for_issue(&registry, "issue-1"), 1);

        let (_, global_completion) = watch::channel(false);
        assert_eq!(
            try_reserve_worker(
                &registry,
                WorkerIdentity {
                    issue_id: "issue-3".to_string(),
                    ..identity("build", 3)
                },
                CancellationToken::new(),
                global_completion,
                2,
                1,
                StateWorkerCapacity::new("", &BTreeMap::new()),
            ),
            Err(WorkerReservationError::GlobalCapacityExhausted)
        );

        let (_, duplicate_completion) = watch::channel(false);
        assert_eq!(
            try_reserve_worker(
                &registry,
                first,
                CancellationToken::new(),
                duplicate_completion,
                3,
                2,
                StateWorkerCapacity::new("", &BTreeMap::new()),
            ),
            Err(WorkerReservationError::DuplicateIdentity)
        );

        let racing_registry = new_cancellation_registry();
        let start = Arc::new(std::sync::Barrier::new(9));
        let contenders = (0..8)
            .map(|index| {
                let registry = racing_registry.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    let (_, completion) = watch::channel(false);
                    start.wait();
                    try_reserve_worker(
                        &registry,
                        WorkerIdentity {
                            issue_id: format!("issue-{index}"),
                            ..identity("build", index + 10)
                        },
                        CancellationToken::new(),
                        completion,
                        1,
                        1,
                        StateWorkerCapacity::new("", &BTreeMap::new()),
                    )
                })
            })
            .collect::<Vec<_>>();
        start.wait();
        let outcomes = contenders
            .into_iter()
            .map(|contender| contender.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert!(outcomes
            .iter()
            .filter(|outcome| outcome.is_err())
            .all(|outcome| *outcome == Err(WorkerReservationError::GlobalCapacityExhausted)));
        assert_eq!(live_worker_count(&racing_registry), 1);
    }

    #[test]
    fn issue_workspace_exclusive_reservation_defers_same_issue_workers_without_blocking_others() {
        let registry = new_cancellation_registry();
        let ordinary = identity("build", 1);
        let immutable = identity("review", 2);
        let other_issue = WorkerIdentity {
            issue_id: "issue-2".to_string(),
            ..identity("build", 3)
        };
        let (_, ordinary_completion) = watch::channel(false);
        let (_, immutable_completion) = watch::channel(false);
        let (_, other_completion) = watch::channel(false);

        try_reserve_scheduler_worker_with_workspace_exclusivity(
            &registry,
            ordinary.clone(),
            CancellationToken::new(),
            ordinary_completion,
            4,
            4,
            WorkerCapacity::lane("default", None),
            &BTreeMap::new(),
            SchedulerReservation::default(),
            false,
        )
        .unwrap();
        assert_eq!(
            try_reserve_scheduler_worker_with_workspace_exclusivity(
                &registry,
                immutable.clone(),
                CancellationToken::new(),
                immutable_completion,
                4,
                4,
                WorkerCapacity::lane("default", None),
                &BTreeMap::new(),
                SchedulerReservation::default(),
                true,
            ),
            Err(WorkerReservationError::IssueWorkspaceExclusive)
        );
        assert_eq!(
            try_reserve_scheduler_worker_with_workspace_exclusivity(
                &registry,
                other_issue,
                CancellationToken::new(),
                other_completion,
                4,
                4,
                WorkerCapacity::lane("default", None),
                &BTreeMap::new(),
                SchedulerReservation::default(),
                true,
            ),
            Ok(())
        );

        assert!(rollback_worker_reservation(&registry, &ordinary));
        let (_, immutable_completion) = watch::channel(false);
        try_reserve_scheduler_worker_with_workspace_exclusivity(
            &registry,
            immutable.clone(),
            CancellationToken::new(),
            immutable_completion,
            4,
            4,
            WorkerCapacity::lane("default", None),
            &BTreeMap::new(),
            SchedulerReservation::default(),
            true,
        )
        .unwrap();
        let (_, ordinary_completion) = watch::channel(false);
        assert_eq!(
            try_reserve_scheduler_worker_with_workspace_exclusivity(
                &registry,
                ordinary.clone(),
                CancellationToken::new(),
                ordinary_completion,
                4,
                4,
                WorkerCapacity::lane("default", None),
                &BTreeMap::new(),
                SchedulerReservation::default(),
                false,
            ),
            Err(WorkerReservationError::IssueWorkspaceExclusive)
        );

        assert!(rollback_worker_reservation(&registry, &immutable));
        let (_, restored_completion) = watch::channel(false);
        assert_eq!(
            try_reserve_scheduler_worker_with_workspace_exclusivity(
                &registry,
                ordinary,
                CancellationToken::new(),
                restored_completion,
                4,
                4,
                WorkerCapacity::lane("default", None),
                &BTreeMap::new(),
                SchedulerReservation::default(),
                false,
            ),
            Ok(())
        );
    }

    #[tokio::test]
    async fn producer_capture_excludes_new_same_issue_workers_until_released() {
        let registry = new_cancellation_registry();
        let capture = acquire_issue_workspace_capture(&registry, "issue-1").await;
        let same_issue = identity("writer", 1);
        let other_issue = WorkerIdentity {
            issue_id: "issue-2".to_string(),
            ..identity("writer", 2)
        };
        let (_, same_completion) = watch::channel(false);
        assert_eq!(
            try_reserve_scheduler_worker_with_workspace_exclusivity(
                &registry,
                same_issue.clone(),
                CancellationToken::new(),
                same_completion,
                4,
                4,
                WorkerCapacity::lane("default", None),
                &BTreeMap::new(),
                SchedulerReservation::default(),
                false,
            ),
            Err(WorkerReservationError::IssueWorkspaceExclusive)
        );
        let (_, other_completion) = watch::channel(false);
        assert!(try_reserve_scheduler_worker_with_workspace_exclusivity(
            &registry,
            other_issue.clone(),
            CancellationToken::new(),
            other_completion,
            4,
            4,
            WorkerCapacity::lane("default", None),
            &BTreeMap::new(),
            SchedulerReservation::default(),
            false,
        )
        .is_ok());

        drop(capture);
        let (_, same_completion) = watch::channel(false);
        assert!(try_reserve_scheduler_worker_with_workspace_exclusivity(
            &registry,
            same_issue,
            CancellationToken::new(),
            same_completion,
            4,
            4,
            WorkerCapacity::lane("default", None),
            &BTreeMap::new(),
            SchedulerReservation::default(),
            false,
        )
        .is_ok());
        assert!(rollback_worker_reservation(&registry, &other_issue));
    }

    #[tokio::test]
    async fn waiting_producer_capture_acquires_after_the_holder_releases() {
        let registry = new_cancellation_registry();
        let first_capture = acquire_issue_workspace_capture(&registry, "issue-1").await;
        let waiting_registry = registry.clone();
        let waiting_capture = tokio::spawn(async move {
            acquire_issue_workspace_capture(&waiting_registry, "issue-1").await
        });

        tokio::task::yield_now().await;
        drop(first_capture);

        let second_capture = tokio::time::timeout(Duration::from_secs(1), waiting_capture)
            .await
            .expect("the released capture wakes its armed waiter")
            .unwrap();
        drop(second_capture);
    }

    #[tokio::test]
    async fn worker_capacity_release_is_exact_and_waits_for_quiescence() {
        let registry = new_cancellation_registry();
        let running = identity("build", 1);
        let peer = identity("review", 1);
        let (running_complete_tx, running_complete_rx) = watch::channel(false);
        let (_, peer_complete_rx) = watch::channel(false);
        try_reserve_worker(
            &registry,
            running.clone(),
            CancellationToken::new(),
            running_complete_rx,
            2,
            2,
            StateWorkerCapacity::new("", &BTreeMap::new()),
        )
        .unwrap();
        try_reserve_worker(
            &registry,
            peer.clone(),
            CancellationToken::new(),
            peer_complete_rx,
            2,
            2,
            StateWorkerCapacity::new("", &BTreeMap::new()),
        )
        .unwrap();
        assert!(mark_worker_launched(&registry, &running));
        assert!(mark_worker_launched(&registry, &peer));

        assert!(!rollback_worker_reservation(&registry, &running));
        assert!(!remove_completed_worker(&registry, &running));
        assert_eq!(live_worker_count(&registry), 2);

        running_complete_tx.send(true).unwrap();
        assert!(remove_completed_worker(&registry, &running));
        assert_eq!(live_worker_count(&registry), 1);
        assert!(contains_worker(&registry, &peer));
        assert!(!remove_completed_worker(&registry, &running));
    }

    #[tokio::test]
    async fn rejected_unlaunched_reservation_releases_a_reconciliation_owner() {
        let registry = new_cancellation_registry();
        let rejected = identity("build", 1);
        let (completion_tx, completion_rx) = watch::channel(false);
        try_reserve_worker(
            &registry,
            rejected.clone(),
            CancellationToken::new(),
            completion_rx,
            1,
            1,
            StateWorkerCapacity::new("", &BTreeMap::new()),
        )
        .unwrap();

        let mut drain = mark_issue_for_drain(&registry, "issue-1");
        assert_eq!(drain.len(), 1);
        assert!(is_reconciliation_owned(&registry, &rejected));

        assert!(rollback_worker_reservation(&registry, &rejected));
        completion_tx.send(true).unwrap();
        assert!(await_worker_drain(&mut drain, Duration::from_millis(10)).await);
        assert!(!contains_worker(&registry, &rejected));
        assert_eq!(live_worker_count(&registry), 0);
    }

    #[test]
    fn state_worker_capacity_enforces_normalized_independent_atomic_buckets() {
        let registry = new_cancellation_registry();
        let caps = BTreeMap::from([("todo".to_string(), 1), ("review".to_string(), 1)]);
        let reserve = |identity: WorkerIdentity, state: &str, global, per_issue| {
            let (_, completion) = watch::channel(false);
            try_reserve_worker(
                &registry,
                identity,
                CancellationToken::new(),
                completion,
                global,
                per_issue,
                StateWorkerCapacity::new(state, &caps),
            )
        };

        assert_eq!(reserve(identity("build", 1), " Todo ", 3, 2), Ok(()));
        assert_eq!(
            reserve(
                WorkerIdentity {
                    issue_id: "issue-2".to_string(),
                    ..identity("build", 2)
                },
                "TODO",
                3,
                2
            ),
            Err(WorkerReservationError::CapacityBucketExhausted)
        );
        assert_eq!(
            reserve(
                WorkerIdentity {
                    issue_id: "issue-2".to_string(),
                    ..identity("review", 2)
                },
                "Review",
                3,
                2
            ),
            Ok(())
        );
        assert_eq!(live_worker_count(&registry), 2);

        assert_eq!(
            reserve(identity("review", 1), "other", 3, 1),
            Err(WorkerReservationError::IssueCapacityExhausted)
        );
        assert_eq!(
            reserve(
                WorkerIdentity {
                    issue_id: "issue-3".to_string(),
                    ..identity("build", 3)
                },
                "other",
                2,
                2
            ),
            Err(WorkerReservationError::GlobalCapacityExhausted)
        );
        assert_eq!(live_worker_count(&registry), 2);

        let racing_registry = new_cancellation_registry();
        let racing_caps = Arc::new(BTreeMap::from([("todo".to_string(), 1)]));
        let start = Arc::new(std::sync::Barrier::new(9));
        let contenders = (0..8)
            .map(|index| {
                let registry = racing_registry.clone();
                let caps = Arc::clone(&racing_caps);
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    let (_, completion) = watch::channel(false);
                    start.wait();
                    try_reserve_worker(
                        &registry,
                        WorkerIdentity {
                            issue_id: format!("issue-{index}"),
                            ..identity("build", index + 10)
                        },
                        CancellationToken::new(),
                        completion,
                        8,
                        1,
                        StateWorkerCapacity::new(" todo ", &caps),
                    )
                })
            })
            .collect::<Vec<_>>();
        start.wait();
        let outcomes = contenders
            .into_iter()
            .map(|contender| contender.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert!(outcomes
            .iter()
            .filter(|outcome| outcome.is_err())
            .all(|outcome| { *outcome == Err(WorkerReservationError::CapacityBucketExhausted) }));
        assert_eq!(live_worker_count(&racing_registry), 1);
    }

    #[tokio::test]
    async fn state_worker_capacity_releases_only_the_captured_worker_bucket() {
        let registry = new_cancellation_registry();
        let caps = BTreeMap::from([("todo".to_string(), 1), ("review".to_string(), 1)]);
        let first = identity("build", 1);
        let second = identity("review", 1);
        let (first_complete_tx, first_complete_rx) = watch::channel(false);
        let (_, second_complete_rx) = watch::channel(false);

        try_reserve_worker(
            &registry,
            first.clone(),
            CancellationToken::new(),
            first_complete_rx,
            3,
            2,
            StateWorkerCapacity::new("Todo", &caps),
        )
        .unwrap();
        assert!(mark_worker_launched(&registry, &first));
        try_reserve_worker(
            &registry,
            second.clone(),
            CancellationToken::new(),
            second_complete_rx,
            3,
            2,
            StateWorkerCapacity::new("Review", &caps),
        )
        .unwrap();

        assert!(rollback_worker_reservation(&registry, &second));
        let (_, replacement_complete_rx) = watch::channel(false);
        assert_eq!(
            try_reserve_worker(
                &registry,
                WorkerIdentity {
                    issue_id: "issue-2".to_string(),
                    ..identity("review", 2)
                },
                CancellationToken::new(),
                replacement_complete_rx,
                3,
                2,
                StateWorkerCapacity::new(" review ", &caps),
            ),
            Ok(())
        );

        let (_, todo_complete_rx) = watch::channel(false);
        assert_eq!(
            try_reserve_worker(
                &registry,
                WorkerIdentity {
                    issue_id: "issue-3".to_string(),
                    ..identity("build", 3)
                },
                CancellationToken::new(),
                todo_complete_rx,
                3,
                2,
                StateWorkerCapacity::new("todo", &caps),
            ),
            Err(WorkerReservationError::CapacityBucketExhausted)
        );

        first_complete_tx.send(true).unwrap();
        assert!(remove_completed_worker(&registry, &first));
        let (_, later_complete_rx) = watch::channel(false);
        assert_eq!(
            try_reserve_worker(
                &registry,
                WorkerIdentity {
                    issue_id: "issue-1".to_string(),
                    ..identity("build", 4)
                },
                CancellationToken::new(),
                later_complete_rx,
                3,
                2,
                StateWorkerCapacity::new("Todo", &caps),
            ),
            Ok(())
        );
    }

    #[test]
    fn selected_lane_capacity_is_namespaced_and_reserved_atomically() {
        let registry = new_cancellation_registry();
        let state_caps = BTreeMap::from([("delivery".to_string(), 1)]);
        let (_, first_completion) = watch::channel(false);
        try_reserve_worker(
            &registry,
            identity("state", 1),
            CancellationToken::new(),
            first_completion,
            4,
            1,
            WorkerCapacity::new("delivery", &state_caps),
        )
        .unwrap();

        let lane_identity = WorkerIdentity {
            issue_id: "issue-2".to_string(),
            ..identity("lane", 2)
        };
        let (_, lane_completion) = watch::channel(false);
        try_reserve_worker(
            &registry,
            lane_identity.clone(),
            CancellationToken::new(),
            lane_completion,
            4,
            1,
            WorkerCapacity::lane("delivery", Some(1)),
        )
        .unwrap();
        assert!(!has_available_lane_worker_capacity(
            &registry,
            "delivery",
            Some(1)
        ));

        let (_, blocked_completion) = watch::channel(false);
        assert_eq!(
            try_reserve_worker(
                &registry,
                WorkerIdentity {
                    issue_id: "issue-3".to_string(),
                    ..identity("blocked", 3)
                },
                CancellationToken::new(),
                blocked_completion,
                4,
                1,
                WorkerCapacity::lane("delivery", Some(1)),
            ),
            Err(WorkerReservationError::CapacityBucketExhausted)
        );

        assert!(rollback_worker_reservation(&registry, &lane_identity));
        assert!(has_available_lane_worker_capacity(
            &registry,
            "delivery",
            Some(1)
        ));
    }
}

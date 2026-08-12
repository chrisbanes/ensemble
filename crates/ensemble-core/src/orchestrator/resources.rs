use std::collections::{BTreeMap, HashMap, HashSet};

#[cfg(test)]
use crate::agent::events::WorkerIdentity;
use crate::config::ensemble::AffectedPathSource;
use crate::pipeline::verdict::StepOutput;

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct NormalizedPath {
    pub repository: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SchedulerReservation {
    #[serde(default)]
    pub resources: BTreeMap<String, u32>,
    #[serde(default)]
    pub paths: Vec<NormalizedPath>,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReservationConflict {
    Resource(String),
    Path(NormalizedPath),
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct ReservationBook {
    reservations: HashMap<WorkerIdentity, SchedulerReservation>,
}

#[cfg(test)]
impl ReservationBook {
    pub(crate) fn try_reserve(
        &mut self,
        worker: WorkerIdentity,
        capacities: &BTreeMap<String, u32>,
        reservation: SchedulerReservation,
    ) -> Result<(), ReservationConflict> {
        for (resource, units) in &reservation.resources {
            let used = self
                .reservations
                .values()
                .filter_map(|active| active.resources.get(resource))
                .sum::<u32>();
            if capacities.get(resource).copied().unwrap_or_default() < used.saturating_add(*units) {
                return Err(ReservationConflict::Resource(resource.clone()));
            }
        }
        for path in &reservation.paths {
            if self
                .reservations
                .values()
                .flat_map(|active| &active.paths)
                .any(|active| paths_conflict(active, path))
            {
                return Err(ReservationConflict::Path(path.clone()));
            }
        }
        self.reservations.insert(worker, reservation);
        Ok(())
    }

    pub(crate) fn release(&mut self, worker: &WorkerIdentity) -> bool {
        self.reservations.remove(worker).is_some()
    }
}

pub(crate) fn normalize_declared_path(
    value: &str,
    repositories: &HashSet<String>,
) -> Result<NormalizedPath, String> {
    let (repository, raw_path) = value
        .split_once(':')
        .ok_or_else(|| "path declaration must be '<repository>:<path>'".to_string())?;
    if !repositories.contains(repository) {
        return Err(format!("unknown repository key '{repository}'"));
    }
    if raw_path.is_empty()
        || raw_path.starts_with('/')
        || raw_path.contains('\\')
        || raw_path.chars().any(char::is_control)
    {
        return Err("path must be a non-empty repository-relative slash path".to_string());
    }
    let segments = raw_path.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
    {
        return Err("path must not contain empty, '.' or '..' segments".to_string());
    }
    Ok(NormalizedPath {
        repository: repository.to_string(),
        path: segments.join("/"),
    })
}

pub(crate) fn resolve_output_paths(
    source: &AffectedPathSource,
    outputs: &HashMap<String, StepOutput>,
    repositories: &HashSet<String>,
) -> Result<Vec<NormalizedPath>, String> {
    let output = outputs
        .get(&source.step)
        .and_then(|output| output.output.as_ref())
        .ok_or_else(|| format!("dependency '{}' has no output", source.step))?;
    let value = output.pointer(&source.pointer).ok_or_else(|| {
        format!(
            "dependency '{}' output has no '{}'",
            source.step, source.pointer
        )
    })?;
    let values = value
        .as_array()
        .ok_or_else(|| "affected path output must be a string array".to_string())?;
    let mut paths = values
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "affected path output must contain only strings".to_string())
                .and_then(|value| normalize_declared_path(value, repositories))
        })
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort_by(|left, right| {
        left.repository
            .cmp(&right.repository)
            .then_with(|| left.path.cmp(&right.path))
    });
    paths.dedup();
    Ok(paths)
}

pub(crate) fn paths_conflict(left: &NormalizedPath, right: &NormalizedPath) -> bool {
    left.repository == right.repository
        && (left.path == right.path
            || left.path.starts_with(&(right.path.clone() + "/"))
            || right.path.starts_with(&(left.path.clone() + "/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn worker(step: &str) -> WorkerIdentity {
        WorkerIdentity {
            issue_id: "issue-1".to_string(),
            run_id: "run-1".to_string(),
            cycle: 1,
            step_name: step.to_string(),
            started_at: Utc.timestamp_opt(0, 0).unwrap(),
        }
    }

    fn repos() -> HashSet<String> {
        HashSet::from(["app".to_string(), "docs".to_string()])
    }

    #[test]
    fn resource_units_are_atomic_and_release_by_exact_identity() {
        let mut book = ReservationBook::default();
        let capacities = BTreeMap::from([("db".to_string(), 2), ("cache".to_string(), 1)]);
        let first = SchedulerReservation {
            resources: BTreeMap::from([("db".to_string(), 2)]),
            paths: vec![],
        };
        book.try_reserve(worker("first"), &capacities, first)
            .unwrap();
        let rejected = SchedulerReservation {
            resources: BTreeMap::from([("cache".to_string(), 1), ("db".to_string(), 1)]),
            paths: vec![],
        };
        assert_eq!(
            book.try_reserve(worker("second"), &capacities, rejected),
            Err(ReservationConflict::Resource("db".to_string()))
        );
        assert!(book.release(&worker("first")));
        assert!(!book.release(&worker("first")));
        book.try_reserve(
            worker("second"),
            &capacities,
            SchedulerReservation {
                resources: BTreeMap::from([("db".to_string(), 1)]),
                paths: vec![],
            },
        )
        .unwrap();
    }

    #[test]
    fn path_conflicts_are_only_component_normalized_within_one_repository() {
        let source = normalize_declared_path("app:src", &repos()).unwrap();
        let descendant = normalize_declared_path("app:src/main.rs", &repos()).unwrap();
        let sibling = normalize_declared_path("app:src2/main.rs", &repos()).unwrap();
        let other_repo = normalize_declared_path("docs:src/main.rs", &repos()).unwrap();
        assert!(paths_conflict(&source, &descendant));
        assert!(!paths_conflict(&source, &sibling));
        assert!(!paths_conflict(&source, &other_repo));
    }

    #[test]
    fn declared_paths_reject_ambiguous_or_unsafe_values() {
        for value in [
            "src/main.rs",
            "missing:src/main.rs",
            "app:/src",
            "app:a//b",
            "app:a/../b",
            "app:a\\b",
        ] {
            assert!(normalize_declared_path(value, &repos()).is_err(), "{value}");
        }
    }
}

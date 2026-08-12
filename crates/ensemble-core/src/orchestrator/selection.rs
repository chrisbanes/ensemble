use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

use crate::config::ensemble::{SchedulerLaneConfig, WorkflowOrderKey, WorkflowSelectionRuleConfig};
use crate::error::PipelineError;
use crate::tracker::model::Issue;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedWorkflow {
    pub rule: String,
    pub pipeline: String,
    pub lane: String,
    pub lane_capacity: Option<u32>,
    pub lane_idle_only: bool,
    lane_precedence: u32,
    precedence: u32,
    order_by: Vec<WorkflowOrderKey>,
}

#[derive(Debug, Clone)]
struct CompiledRule {
    selected: SelectedWorkflow,
    states: Option<HashSet<String>>,
    labels_all: Option<HashSet<String>>,
    labels_any: Option<HashSet<String>>,
    labels_none: Option<HashSet<String>>,
    require_unblocked: bool,
}

#[derive(Debug, Clone)]
pub struct WorkflowSelector {
    rules: Vec<CompiledRule>,
}

impl WorkflowSelector {
    pub fn compile(
        rules: &[WorkflowSelectionRuleConfig],
        lanes: &BTreeMap<String, SchedulerLaneConfig>,
    ) -> Result<Self, PipelineError> {
        let mut compiled = Vec::with_capacity(rules.len());
        for rule in rules {
            let lane =
                lanes
                    .get(&rule.lane)
                    .ok_or_else(|| PipelineError::InvalidSchedulerLane {
                        lane: rule.lane.clone(),
                        reason: "referenced by a workflow-selection rule but not configured"
                            .to_string(),
                    })?;
            let mut order_by = rule.order_by.clone();
            if !order_by.contains(&WorkflowOrderKey::Identifier) {
                order_by.push(WorkflowOrderKey::Identifier);
            }
            compiled.push(CompiledRule {
                selected: SelectedWorkflow {
                    rule: rule.name.clone(),
                    pipeline: rule.pipeline.clone(),
                    lane: rule.lane.clone(),
                    lane_capacity: lane.capacity,
                    lane_idle_only: lane.idle_only,
                    lane_precedence: lane.precedence,
                    precedence: rule.precedence,
                    order_by,
                },
                states: normalize_set(rule.states.as_ref()),
                labels_all: normalize_set(rule.labels_all.as_ref()),
                labels_any: normalize_set(rule.labels_any.as_ref()),
                labels_none: normalize_set(rule.labels_none.as_ref()),
                require_unblocked: rule.require_unblocked,
            });
        }
        compiled.sort_by_key(|rule| rule.selected.precedence);
        Ok(Self { rules: compiled })
    }

    pub fn select(&self, issue: &Issue, terminal_states: &[String]) -> Option<SelectedWorkflow> {
        let state = normalize(&issue.state);
        let labels = issue
            .labels
            .iter()
            .map(|label| normalize(label))
            .collect::<HashSet<_>>();
        self.rules
            .iter()
            .find(|rule| {
                rule.states
                    .as_ref()
                    .is_none_or(|states| states.contains(&state))
                    && rule
                        .labels_all
                        .as_ref()
                        .is_none_or(|required| required.is_subset(&labels))
                    && rule
                        .labels_any
                        .as_ref()
                        .is_none_or(|required| !required.is_disjoint(&labels))
                    && rule
                        .labels_none
                        .as_ref()
                        .is_none_or(|excluded| excluded.is_disjoint(&labels))
                    && (!rule.require_unblocked
                        || issue.blocked_by.iter().all(|blocker| {
                            blocker.state.as_deref().is_some_and(|state| {
                                terminal_states
                                    .iter()
                                    .any(|terminal| terminal.eq_ignore_ascii_case(state))
                            })
                        }))
            })
            .map(|rule| rule.selected.clone())
    }
}

fn normalize_set(values: Option<&Vec<String>>) -> Option<HashSet<String>> {
    values.map(|values| values.iter().map(|value| normalize(value)).collect())
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn sort_selected_candidates(candidates: &mut [(Issue, SelectedWorkflow)]) {
    candidates.sort_by(|(left_issue, left), (right_issue, right)| {
        left.lane_precedence
            .cmp(&right.lane_precedence)
            .then_with(|| left.precedence.cmp(&right.precedence))
            .then_with(|| {
                if left.rule == right.rule {
                    compare_by_rule(left_issue, right_issue, &left.order_by)
                } else {
                    left.rule.cmp(&right.rule)
                }
            })
            .then_with(|| left_issue.identifier.cmp(&right_issue.identifier))
    });
}

fn compare_by_rule(left: &Issue, right: &Issue, order_by: &[WorkflowOrderKey]) -> Ordering {
    for key in order_by {
        let ordering = match key {
            WorkflowOrderKey::Priority => cmp_optional(left.priority, right.priority),
            WorkflowOrderKey::TrackerPosition => {
                cmp_optional(left.tracker_position, right.tracker_position)
            }
            WorkflowOrderKey::CreatedAt => cmp_optional(left.created_at, right.created_at),
            WorkflowOrderKey::Identifier => left.identifier.cmp(&right.identifier),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

fn cmp_optional<T: Ord>(left: Option<T>, right: Option<T>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::{WorkflowOrderKey, WorkflowSelectionRuleConfig};
    use crate::tracker::model::{test_helpers::test_issue, BlockerRef};

    fn rule(name: &str, precedence: u32) -> WorkflowSelectionRuleConfig {
        WorkflowSelectionRuleConfig {
            name: name.to_string(),
            precedence,
            pipeline: format!("{name}-pipeline"),
            lane: format!("{name}-lane"),
            states: Some(vec![" READY ".to_string()]),
            labels_all: None,
            labels_any: None,
            labels_none: None,
            require_unblocked: false,
            order_by: vec![WorkflowOrderKey::TrackerPosition],
        }
    }

    #[test]
    fn selector_matches_normalized_predicates_and_lowest_precedence() {
        let mut lower = rule("lower", 20);
        lower.labels_all = Some(vec![" Agent ".to_string()]);
        let mut higher = rule("higher", 10);
        higher.labels_any = Some(vec!["UI".to_string(), "API".to_string()]);
        higher.labels_none = Some(vec!["hold".to_string()]);
        let selector = WorkflowSelector::compile(&[lower, higher], &lanes()).unwrap();
        let mut issue = test_issue("1", "ready");
        issue.labels = vec!["agent".to_string(), "api".to_string()];

        let selected = selector.select(&issue, &["done".to_string()]).unwrap();

        assert_eq!(selected.rule, "higher");
        assert_eq!(selected.pipeline, "higher-pipeline");
        assert_eq!(selected.lane, "higher-lane");
    }

    #[test]
    fn candidate_order_uses_lane_precedence_before_rule_ordering() {
        let mut candidates = vec![
            (
                test_issue("lower", "ready"),
                SelectedWorkflow {
                    rule: "lower".to_string(),
                    pipeline: "main".to_string(),
                    lane: "lower-lane".to_string(),
                    lane_capacity: Some(1),
                    lane_idle_only: false,
                    lane_precedence: 20,
                    precedence: 1,
                    order_by: vec![WorkflowOrderKey::Identifier],
                },
            ),
            (
                test_issue("higher", "ready"),
                SelectedWorkflow {
                    rule: "higher".to_string(),
                    pipeline: "main".to_string(),
                    lane: "higher-lane".to_string(),
                    lane_capacity: Some(1),
                    lane_idle_only: false,
                    lane_precedence: 10,
                    precedence: 99,
                    order_by: vec![WorkflowOrderKey::Identifier],
                },
            ),
        ];

        sort_selected_candidates(&mut candidates);

        assert_eq!(candidates[0].1.lane, "higher-lane");
    }

    #[test]
    fn unblocked_predicate_treats_unknown_and_nonterminal_blockers_as_blocking() {
        let mut required = rule("required", 1);
        required.require_unblocked = true;
        let selector = WorkflowSelector::compile(&[required], &lanes()).unwrap();
        let mut issue = test_issue("1", "Ready");
        issue.blocked_by = vec![BlockerRef {
            id: Some("B".to_string()),
            identifier: Some("repo#2".to_string()),
            state: None,
        }];
        assert!(selector.select(&issue, &["done".to_string()]).is_none());

        issue.blocked_by[0].state = Some("Done".to_string());
        assert!(selector.select(&issue, &["done".to_string()]).is_some());
    }

    #[test]
    fn selected_candidates_sort_by_rule_then_declared_nulls_last_keys_and_identifier() {
        let selector = WorkflowSelector::compile(&[rule("ready", 1)], &lanes()).unwrap();
        let mut later = test_issue("later", "Ready");
        later.tracker_position = Some(9);
        later.identifier = "repo#9".to_string();
        let mut first = test_issue("first", "Ready");
        first.tracker_position = Some(1);
        first.identifier = "repo#2".to_string();
        let mut missing = test_issue("missing", "Ready");
        missing.tracker_position = None;
        missing.identifier = "repo#1".to_string();
        let terminal = vec!["done".to_string()];
        let mut candidates = vec![later, missing, first]
            .into_iter()
            .map(|issue| {
                let selected = selector.select(&issue, &terminal).unwrap();
                (issue, selected)
            })
            .collect::<Vec<_>>();

        sort_selected_candidates(&mut candidates);

        assert_eq!(
            candidates
                .iter()
                .map(|(issue, _)| issue.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "later", "missing"]
        );
    }

    #[test]
    fn selector_supports_catch_all_and_labels_only_gate_eligibility() {
        let mut labelled = rule("labelled", 1);
        labelled.states = None;
        labelled.labels_all = Some(vec!["agent".to_string()]);
        labelled.labels_any = Some(vec!["ui".to_string(), "api".to_string()]);
        labelled.labels_none = Some(vec!["hold".to_string()]);
        labelled.order_by = vec![WorkflowOrderKey::Priority];
        let mut tail = rule("tail", 2);
        tail.states = None;
        let selector = WorkflowSelector::compile(&[labelled, tail], &lanes()).unwrap();

        let mut preferred = test_issue("2", "Ausstehend");
        preferred.priority = Some(1);
        preferred.labels = vec!["agent".to_string(), "api".to_string()];
        let mut later = test_issue("1", "Ausstehend");
        later.priority = Some(2);
        later.labels = vec!["agent".to_string(), "ui".to_string(), "extra".to_string()];
        let mut held = test_issue("3", "Ausstehend");
        held.labels = vec!["agent".to_string(), "api".to_string(), "hold".to_string()];

        let terminal = vec!["done".to_string()];
        let mut selected = vec![later, held, preferred]
            .into_iter()
            .map(|issue| {
                let workflow = selector.select(&issue, &terminal).unwrap();
                (issue, workflow)
            })
            .collect::<Vec<_>>();
        sort_selected_candidates(&mut selected);

        assert_eq!(selected[0].0.id, "2");
        assert_eq!(selected[1].0.id, "1");
        assert_eq!(selected[2].1.rule, "tail");
    }

    #[test]
    fn comparator_applies_every_key_with_nulls_last_and_rule_precedence_first() {
        let mut primary = rule("ready", 2);
        primary.order_by = vec![
            WorkflowOrderKey::Priority,
            WorkflowOrderKey::TrackerPosition,
            WorkflowOrderKey::CreatedAt,
            WorkflowOrderKey::Identifier,
        ];
        let mut earlier_rule = rule("urgent", 1);
        earlier_rule.states = Some(vec!["urgent".to_string()]);
        let selector = WorkflowSelector::compile(&[primary, earlier_rule], &lanes()).unwrap();
        let now = chrono::Utc::now();

        let mut urgent = test_issue("urgent", "urgent");
        urgent.priority = None;
        let mut first = test_issue("first", "ready");
        first.priority = Some(1);
        first.tracker_position = Some(2);
        first.created_at = Some(now);
        let mut older = test_issue("older", "ready");
        older.priority = Some(1);
        older.tracker_position = Some(2);
        older.created_at = Some(now - chrono::Duration::seconds(1));
        let mut missing = test_issue("missing", "ready");
        missing.priority = None;
        missing.tracker_position = None;
        missing.created_at = None;

        let terminal = vec!["done".to_string()];
        let mut selected = vec![first, missing, older, urgent]
            .into_iter()
            .map(|issue| {
                let workflow = selector.select(&issue, &terminal).unwrap();
                (issue, workflow)
            })
            .collect::<Vec<_>>();
        sort_selected_candidates(&mut selected);

        assert_eq!(
            selected
                .iter()
                .map(|(issue, _)| issue.id.as_str())
                .collect::<Vec<_>>(),
            vec!["urgent", "older", "first", "missing"]
        );
    }

    fn lanes() -> std::collections::BTreeMap<String, SchedulerLaneConfig> {
        [
            ("lower-lane".to_string(), 1),
            ("higher-lane".to_string(), 1),
            ("required-lane".to_string(), 1),
            ("ready-lane".to_string(), 1),
            ("labelled-lane".to_string(), 1),
            ("tail-lane".to_string(), 1),
            ("urgent-lane".to_string(), 1),
        ]
        .into_iter()
        .map(|(name, capacity)| {
            (
                name,
                SchedulerLaneConfig {
                    precedence: 1,
                    idle_only: false,
                    capacity: Some(capacity),
                },
            )
        })
        .collect()
    }
}

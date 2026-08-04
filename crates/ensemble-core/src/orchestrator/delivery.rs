use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;
use tracing::warn;

use super::pipeline_journal::{PipelineTransitionInput, PipelineTransitionKind, TerminalOutcome};
use super::state::{FinalizeStatus, IssueFinalizeState, RepoFinalizeState};
use super::Orchestrator;
use crate::pipeline::engine::{PipelineRun, PipelineRunSnapshot};
use crate::workspace::finalize::FinalizeMode;

const DELIVERY_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const PULL_REQUEST_DISCOVERY_LIMIT: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryMode {
    Push,
    PushAndPr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryPhase {
    Prepared,
    PushInFlight,
    ReconcilingPush,
    PrCreateInFlight,
    ReconcilingPr,
    Waiting,
    Published,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliveryRepository {
    pub mode: DeliveryMode,
    pub phase: DeliveryPhase,
    pub remote: String,
    pub base_branch: String,
    pub head_branch: String,
    pub local_sha: String,
    pub observed_remote_sha: Option<String>,
    pub marker: String,
    pub pr_number: Option<u64>,
    pub pr_url: Option<String>,
    pub last_error: Option<String>,
    pub retry_from: Option<DeliveryPhase>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliveryRecord {
    pub issue_id: String,
    pub identifier: String,
    pub run_id: String,
    pub repositories: BTreeMap<String, DeliveryRepository>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeliveryAggregate {
    Active,
    Waiting,
    Published,
    Blocked,
}

impl DeliveryRecord {
    pub(crate) fn aggregate(&self) -> DeliveryAggregate {
        if self
            .repositories
            .values()
            .any(|repo| repo.phase == DeliveryPhase::Blocked)
        {
            DeliveryAggregate::Blocked
        } else if self
            .repositories
            .values()
            .all(|repo| repo.phase == DeliveryPhase::Published)
        {
            DeliveryAggregate::Published
        } else if self.repositories.values().all(|repo| {
            matches!(
                repo.phase,
                DeliveryPhase::Waiting | DeliveryPhase::Published
            )
        }) {
            DeliveryAggregate::Waiting
        } else {
            DeliveryAggregate::Active
        }
    }
}

pub(crate) fn canonical_marker(run_id: &str, issue_id: &str, repository_key: &str) -> String {
    fn hex(value: &str) -> String {
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    format!(
        "<!-- ensemble:delivery:v1 run={} issue={} repository={} -->",
        hex(run_id),
        hex(issue_id),
        hex(repository_key)
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemotePullRequest {
    pub repository_key: String,
    pub head_branch: String,
    pub base_branch: String,
    pub head_sha: String,
    pub body: String,
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalRepositoryIdentity {
    pub head_branch: String,
    pub local_sha: String,
}

#[async_trait]
pub(crate) trait DeliveryRemote: Send + Sync {
    async fn local_identity(
        &self,
        repository_path: &Path,
    ) -> Result<LocalRepositoryIdentity, String>;

    async fn remote_head(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
    ) -> Result<Option<String>, String>;

    async fn push(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
        local_sha: &str,
    ) -> Result<(), String>;

    async fn list_pull_requests(
        &self,
        repository_path: &Path,
        repository_key: &str,
    ) -> Result<Vec<RemotePullRequest>, String>;

    async fn create_pull_request(
        &self,
        repository_path: &Path,
        base_branch: &str,
        head_branch: &str,
        marker: &str,
    ) -> Result<(), String>;
}

pub(crate) struct CliDeliveryRemote;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    url: String,
    body: String,
    head_ref_name: String,
    base_ref_name: String,
    head_ref_oid: String,
}

#[async_trait]
impl DeliveryRemote for CliDeliveryRemote {
    async fn local_identity(
        &self,
        repository_path: &Path,
    ) -> Result<LocalRepositoryIdentity, String> {
        Ok(LocalRepositoryIdentity {
            head_branch: command_stdout(
                repository_path,
                "git",
                &["rev-parse", "--abbrev-ref", "HEAD"],
            )
            .await?,
            local_sha: command_stdout(repository_path, "git", &["rev-parse", "HEAD"]).await?,
        })
    }

    async fn remote_head(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
    ) -> Result<Option<String>, String> {
        let reference = format!("refs/heads/{head_branch}");
        let stdout = command_stdout(
            repository_path,
            "git",
            &["ls-remote", "--heads", remote, &reference],
        )
        .await?;
        if stdout.is_empty() {
            return Ok(None);
        }
        let mut lines = stdout.lines();
        let line = lines.next().expect("non-empty output has one line");
        if lines.next().is_some() {
            return Err(format!(
                "remote '{remote}' returned multiple heads for '{reference}'"
            ));
        }
        let (sha, observed_reference) = line
            .split_once(char::is_whitespace)
            .ok_or_else(|| "git ls-remote returned malformed output".to_string())?;
        if observed_reference.trim() != reference {
            return Err(format!(
                "git ls-remote returned unexpected reference '{}'",
                observed_reference.trim()
            ));
        }
        Ok(Some(sha.to_string()))
    }

    async fn push(
        &self,
        repository_path: &Path,
        remote: &str,
        head_branch: &str,
        local_sha: &str,
    ) -> Result<(), String> {
        let refspec = format!("{local_sha}:refs/heads/{head_branch}");
        command_stdout(repository_path, "git", &["push", remote, &refspec])
            .await
            .map(|_| ())
    }

    async fn list_pull_requests(
        &self,
        repository_path: &Path,
        repository_key: &str,
    ) -> Result<Vec<RemotePullRequest>, String> {
        let stdout = command_stdout(
            repository_path,
            "gh",
            &[
                "pr",
                "list",
                "--state",
                "all",
                "--limit",
                "1000",
                "--json",
                "number,url,body,headRefName,baseRefName,headRefOid",
            ],
        )
        .await?;
        let pull_requests: Vec<GhPullRequest> = serde_json::from_str(&stdout)
            .map_err(|error| format!("invalid gh pr list output: {error}"))?;
        if pull_requests.len() == PULL_REQUEST_DISCOVERY_LIMIT {
            return Err(format!(
                "pull request discovery reached its {PULL_REQUEST_DISCOVERY_LIMIT}-item limit"
            ));
        }
        Ok(pull_requests
            .into_iter()
            .map(|pull_request| RemotePullRequest {
                repository_key: repository_key.to_string(),
                head_branch: pull_request.head_ref_name,
                base_branch: pull_request.base_ref_name,
                head_sha: pull_request.head_ref_oid,
                body: pull_request.body,
                number: pull_request.number,
                url: pull_request.url,
            })
            .collect())
    }

    async fn create_pull_request(
        &self,
        repository_path: &Path,
        base_branch: &str,
        head_branch: &str,
        marker: &str,
    ) -> Result<(), String> {
        command_stdout(
            repository_path,
            "gh",
            &[
                "pr",
                "create",
                "--fill",
                "--head",
                head_branch,
                "--base",
                base_branch,
                "--body",
                marker,
            ],
        )
        .await
        .map(|_| ())
    }
}

async fn command_stdout(
    repository_path: &Path,
    program: &str,
    arguments: &[&str],
) -> Result<String, String> {
    let output = timeout(
        DELIVERY_COMMAND_TIMEOUT,
        tokio::process::Command::new(program)
            .args(arguments)
            .current_dir(repository_path)
            .output(),
    )
    .await
    .map_err(|_| {
        format!(
            "{program} command timed out after {}s",
            DELIVERY_COMMAND_TIMEOUT.as_secs()
        )
    })?
    .map_err(|error| format!("failed to run {program}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PushReconciliation {
    Push,
    Advance,
    Blocked { error: String },
}

pub(crate) fn reconcile_push(
    repository: &DeliveryRepository,
    remote_sha: Option<String>,
) -> PushReconciliation {
    match remote_sha {
        None => PushReconciliation::Push,
        Some(remote_sha) if remote_sha == repository.local_sha => PushReconciliation::Advance,
        Some(remote_sha) => PushReconciliation::Blocked {
            error: format!(
                "remote head is {remote_sha}, expected {}",
                repository.local_sha
            ),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PullRequestReconciliation {
    Create,
    Adopted { number: u64, url: String },
    Blocked { error: String },
}

pub(crate) fn reconcile_pull_requests(
    repository_key: &str,
    repository: &DeliveryRepository,
    pull_requests: &[RemotePullRequest],
) -> PullRequestReconciliation {
    if repository.observed_remote_sha.as_deref() != Some(repository.local_sha.as_str()) {
        return PullRequestReconciliation::Blocked {
            error: "remote head was not confirmed at the intended SHA".to_string(),
        };
    }

    let same_identity = |pull_request: &&RemotePullRequest| {
        pull_request.repository_key == repository_key
            && pull_request.head_branch == repository.head_branch
            && pull_request.base_branch == repository.base_branch
    };
    let marker_matches =
        |pull_request: &&RemotePullRequest| pull_request.body.contains(repository.marker.as_str());

    if pull_requests
        .iter()
        .filter(same_identity)
        .any(|pull_request| !marker_matches(&pull_request))
    {
        return PullRequestReconciliation::Blocked {
            error: "pull request identity matched but its delivery marker did not".to_string(),
        };
    }
    if pull_requests
        .iter()
        .filter(marker_matches)
        .any(|pull_request| !same_identity(&pull_request))
    {
        return PullRequestReconciliation::Blocked {
            error: "delivery marker matched a different repository or branch identity".to_string(),
        };
    }

    let matches: Vec<&RemotePullRequest> = pull_requests
        .iter()
        .filter(same_identity)
        .filter(marker_matches)
        .collect();
    match matches.as_slice() {
        [] => PullRequestReconciliation::Create,
        [pull_request] if pull_request.head_sha == repository.local_sha => {
            PullRequestReconciliation::Adopted {
                number: pull_request.number,
                url: pull_request.url.clone(),
            }
        }
        [pull_request] => PullRequestReconciliation::Blocked {
            error: format!(
                "pull request head is {}, expected {}",
                pull_request.head_sha, repository.local_sha
            ),
        },
        _ => PullRequestReconciliation::Blocked {
            error: "multiple pull requests match the delivery identity".to_string(),
        },
    }
}

fn pull_request_delivery_phase(
    phase: DeliveryPhase,
) -> crate::acceptance::PullRequestDeliveryPhase {
    use crate::acceptance::PullRequestDeliveryPhase as EvidencePhase;
    match phase {
        DeliveryPhase::Prepared => EvidencePhase::Prepared,
        DeliveryPhase::PushInFlight => EvidencePhase::PushInFlight,
        DeliveryPhase::ReconcilingPush => EvidencePhase::ReconcilingPush,
        DeliveryPhase::PrCreateInFlight => EvidencePhase::PrCreateInFlight,
        DeliveryPhase::ReconcilingPr => EvidencePhase::ReconcilingPr,
        DeliveryPhase::Waiting => EvidencePhase::Waiting,
        DeliveryPhase::Published => EvidencePhase::Published,
        DeliveryPhase::Blocked => EvidencePhase::Blocked,
    }
}

fn evaluate_pull_request_requirement(
    rule: &crate::config::ensemble::AcceptancePullRequestConfig,
    repository: &DeliveryRepository,
) -> crate::acceptance::AcceptanceResult {
    let timer = crate::acceptance::AcceptanceTimer::start();
    let mut failures = Vec::new();
    if !matches!(
        repository.phase,
        DeliveryPhase::Waiting | DeliveryPhase::Published
    ) {
        failures.push(format!(
            "delivery phase is {:?}, expected waiting or published",
            repository.phase
        ));
    }
    if repository.pr_number.is_none() {
        failures.push("durable pull request number is missing".to_string());
    }
    if repository.pr_url.is_none() {
        failures.push("durable pull request URL is missing".to_string());
    }
    let complete_identity = if failures.is_empty() {
        repository.pr_number.zip(repository.pr_url.as_deref())
    } else {
        None
    };
    let (status, summary) = if let Some((number, url)) = complete_identity {
        (
            crate::acceptance::AcceptanceStatus::Passed,
            format!(
                "required pull request '{}' has durable identity #{} at {}",
                rule.name, number, url
            ),
        )
    } else {
        (
            crate::acceptance::AcceptanceStatus::Failed,
            format!(
                "required pull request '{}' failed: {}",
                rule.name,
                failures.join(", ")
            ),
        )
    };
    timer.finish(crate::acceptance::AcceptanceResult::new(
        rule.name.clone(),
        status,
        summary,
        crate::acceptance::AcceptanceEvidence::PullRequest {
            repo: rule.repo.clone(),
            delivery_phase: pull_request_delivery_phase(repository.phase),
            base_branch: Some(repository.base_branch.clone()),
            head_branch: Some(repository.head_branch.clone()),
            head_sha: Some(repository.local_sha.clone()),
            pr_number: repository.pr_number,
            pr_url: repository.pr_url.clone(),
        },
    ))
}

impl Orchestrator {
    pub(super) async fn load_delivery_snapshot(
        &self,
        delivery: &DeliveryRecord,
    ) -> Result<Option<PipelineRunSnapshot>, String> {
        let record = self
            .pipeline_journal
            .latest_live_record_for_issue(&delivery.issue_id)
            .await
            .map_err(|error| format!("failed to read durable delivery owner: {error}"))?
            .ok_or_else(|| {
                format!(
                    "missing durable delivery owner for issue '{}'",
                    delivery.issue_id
                )
            })?;
        if record.run_id.as_deref() != Some(delivery.run_id.as_str()) {
            return Err(format!(
                "durable delivery owner for issue '{}' belongs to a different run",
                delivery.issue_id
            ));
        }
        Ok(record.snapshot)
    }

    pub(super) async fn process_delivery_recovery(&self) {
        let deliveries = {
            let state = self.state.read().await;
            state
                .delivery
                .values()
                .filter(|delivery| {
                    matches!(
                        delivery.aggregate(),
                        DeliveryAggregate::Active
                            | DeliveryAggregate::Waiting
                            | DeliveryAggregate::Published
                    )
                })
                .cloned()
                .collect::<Vec<_>>()
        };

        for delivery in deliveries {
            let snapshot = match self.load_delivery_snapshot(&delivery).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    warn!(
                        issue_id = %delivery.issue_id,
                        error = %error,
                        "delivery recovery could not load its durable snapshot"
                    );
                    continue;
                }
            };
            let delivery = self
                .evaluate_post_final_acceptance(delivery, snapshot.as_ref())
                .await;
            if delivery.aggregate() == DeliveryAggregate::Published {
                self.complete_published_delivery(&delivery).await;
                continue;
            }
            if delivery.aggregate() == DeliveryAggregate::Waiting {
                self.project_delivery_artifacts(&delivery.issue_id, &delivery)
                    .await;
                let finalize = Self::finalize_state_from_delivery(&delivery);
                self.state
                    .write()
                    .await
                    .set_finalize_state(&delivery.issue_id, finalize);
                continue;
            }
            let workspace = match self
                .workspace_mgr
                .prepare_workspace(&delivery.issue_id, &delivery.identifier)
                .await
            {
                Ok(workspace) => workspace,
                Err(error) => {
                    let mut blocked = delivery.clone();
                    for repository in blocked.repositories.values_mut().filter(|repository| {
                        !matches!(
                            repository.phase,
                            DeliveryPhase::Waiting
                                | DeliveryPhase::Published
                                | DeliveryPhase::Blocked
                        )
                    }) {
                        repository.retry_from = Some(repository.phase);
                        repository.phase = DeliveryPhase::Blocked;
                        repository.last_error = Some(error.to_string());
                    }
                    let _ = self.persist_delivery_record(&blocked, None).await;
                    continue;
                }
            };
            let delivery = self
                .advance_delivery_record(delivery, &workspace, snapshot.as_ref())
                .await;
            self.project_delivery_artifacts(&delivery.issue_id, &delivery)
                .await;
            if delivery.aggregate() == DeliveryAggregate::Published {
                self.complete_published_delivery(&delivery).await;
                continue;
            }
            let finalize = Self::finalize_state_from_delivery(&delivery);
            self.state
                .write()
                .await
                .set_finalize_state(&delivery.issue_id, finalize);
        }
    }

    async fn complete_published_delivery(&self, delivery: &DeliveryRecord) {
        let config = self.config.read().await.clone();
        let finalize = Self::finalize_state_from_delivery(delivery);
        self.state
            .write()
            .await
            .set_finalize_state(&delivery.issue_id, finalize.clone());
        let issue = self
            .tracker
            .fetch_issue_states_by_ids(std::slice::from_ref(&delivery.issue_id))
            .await
            .ok()
            .and_then(|issues| issues.into_iter().next());
        self.begin_terminal_transition_for_identity(
            &delivery.issue_id,
            &delivery.identifier,
            issue,
            TerminalOutcome::Succeeded,
            config.on_success,
            None,
        )
        .await;
    }
    pub(super) async fn project_delivery_artifacts(
        &self,
        issue_id: &str,
        delivery: &DeliveryRecord,
    ) {
        let mut state = self.state.write().await;
        let Some(artifacts) = state.artifacts.get_mut(issue_id) else {
            return;
        };
        for artifact in &mut artifacts.repos {
            let Some(repository) = delivery.repositories.get(&artifact.repo) else {
                continue;
            };
            artifact.finalize_status = match repository.phase {
                DeliveryPhase::Waiting => "waiting",
                DeliveryPhase::Published => "succeeded",
                DeliveryPhase::Blocked => "failed",
                _ => "in_progress",
            }
            .to_string();
            artifact.pushed_ref = repository
                .observed_remote_sha
                .as_ref()
                .map(|_| format!("{}/{}", repository.remote, repository.head_branch));
            artifact.pr_url = repository.pr_url.clone();
            artifact.last_error = repository.last_error.clone();
        }
    }
    pub(super) fn finalize_state_from_delivery(delivery: &DeliveryRecord) -> IssueFinalizeState {
        IssueFinalizeState {
            issue_identifier: delivery.identifier.clone(),
            status: match delivery.aggregate() {
                DeliveryAggregate::Published => FinalizeStatus::Succeeded,
                DeliveryAggregate::Blocked => FinalizeStatus::Failed,
                DeliveryAggregate::Active | DeliveryAggregate::Waiting => {
                    FinalizeStatus::InProgress
                }
            },
            repos: Self::finalize_repositories_from_delivery(delivery),
        }
    }
    pub(super) fn finalize_repositories_from_delivery(
        delivery: &DeliveryRecord,
    ) -> Vec<RepoFinalizeState> {
        delivery
            .repositories
            .iter()
            .map(|(repository_key, repository)| RepoFinalizeState {
                repo: repository_key.clone(),
                mode: match repository.mode {
                    DeliveryMode::Push => "push",
                    DeliveryMode::PushAndPr => "push_and_pr",
                }
                .to_string(),
                approval_required: false,
                status: match repository.phase {
                    DeliveryPhase::Published => FinalizeStatus::Succeeded,
                    DeliveryPhase::Blocked => FinalizeStatus::Failed,
                    _ => FinalizeStatus::InProgress,
                },
                last_error: repository.last_error.clone(),
            })
            .collect()
    }
    pub(super) async fn advance_delivery_record(
        &self,
        mut delivery: DeliveryRecord,
        workspace: &crate::workspace::manager::WorkspaceResult,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let repository_keys = delivery.repositories.keys().cloned().collect::<Vec<_>>();
        for repository_key in repository_keys {
            let Some(repository_path) = workspace
                .worktrees
                .get(&repository_key)
                .map(|worktree| worktree.path.clone())
            else {
                delivery = self
                    .block_delivery_repository(
                        &delivery,
                        &repository_key,
                        DeliveryPhase::Prepared,
                        "delivery worktree is missing".to_string(),
                        snapshot,
                    )
                    .await;
                continue;
            };
            let mut created_pull_request = false;
            for _ in 0..16 {
                let before = delivery.clone();
                let mut created_this_iteration = false;
                let phase = delivery.repositories[&repository_key].phase;
                delivery = match phase {
                    DeliveryPhase::Prepared
                    | DeliveryPhase::PushInFlight
                    | DeliveryPhase::ReconcilingPush => {
                        self.advance_delivery_push(
                            delivery,
                            &repository_key,
                            &repository_path,
                            snapshot,
                        )
                        .await
                    }
                    DeliveryPhase::PrCreateInFlight | DeliveryPhase::ReconcilingPr => {
                        let (next, created) = self
                            .advance_delivery_pull_request(
                                delivery,
                                &repository_key,
                                &repository_path,
                                snapshot,
                                !created_pull_request,
                            )
                            .await;
                        created_this_iteration = created;
                        created_pull_request |= created;
                        next
                    }
                    DeliveryPhase::Waiting | DeliveryPhase::Published | DeliveryPhase::Blocked => {
                        break
                    }
                };
                let entry = &delivery.repositories[&repository_key];
                if (delivery == before && !created_this_iteration)
                    || (matches!(
                        entry.phase,
                        DeliveryPhase::PushInFlight | DeliveryPhase::PrCreateInFlight
                    ) && entry.last_error.is_some())
                {
                    break;
                }
            }
        }
        self.evaluate_post_final_acceptance(delivery, snapshot)
            .await
    }

    pub(super) async fn evaluate_post_final_acceptance(
        &self,
        delivery: DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let Some(mut candidate_snapshot) = snapshot.cloned() else {
            return delivery;
        };
        let Some(plan) = candidate_snapshot.resolved_acceptance_plan.clone() else {
            return delivery;
        };
        let rules = &plan.required_pull_requests;
        if rules.is_empty()
            || rules.iter().any(|rule| {
                delivery
                    .repositories
                    .get(&rule.repo)
                    .is_none_or(|repository| {
                        !matches!(
                            repository.phase,
                            DeliveryPhase::Waiting | DeliveryPhase::Published
                        )
                    })
            })
        {
            return delivery;
        }
        let Some(attempt_index) = candidate_snapshot
            .acceptance_attempts
            .iter()
            .position(|attempt| attempt.cycle == candidate_snapshot.cycle)
        else {
            return delivery;
        };
        let pre_final_len = plan.pre_final_len();
        let result_len = candidate_snapshot.acceptance_attempts[attempt_index]
            .results
            .len();
        if result_len < pre_final_len {
            return delivery;
        }
        let suffix_len = result_len - pre_final_len;
        let retry_requested = rules.iter().any(|rule| {
            delivery
                .repositories
                .get(&rule.repo)
                .is_some_and(|repository| repository.retry_from == Some(DeliveryPhase::Waiting))
        });
        if suffix_len > 0 && suffix_len % rules.len() == 0 && !retry_requested {
            let latest = &candidate_snapshot.acceptance_attempts[attempt_index].results
                [result_len - rules.len()..result_len];
            if latest
                .iter()
                .all(|result| result.status == crate::acceptance::AcceptanceStatus::Passed)
            {
                return delivery;
            }
            return self
                .apply_post_final_acceptance_outcome(delivery, &candidate_snapshot, rules, latest)
                .await;
        }

        let resume_index = suffix_len % rules.len();
        let current = delivery;
        for rule in rules.iter().skip(resume_index) {
            let Some(repository) = current.repositories.get(&rule.repo) else {
                return current;
            };
            let result = evaluate_pull_request_requirement(rule, repository);
            candidate_snapshot.acceptance_attempts[attempt_index]
                .results
                .push(result);
            if let Err(error) = self
                .persist_delivery_record(&current, Some(&candidate_snapshot))
                .await
            {
                warn!(
                    issue_id = %current.issue_id,
                    error = %error,
                    "failed to persist post-final acceptance result"
                );
                return current;
            }
        }

        let results = &candidate_snapshot.acceptance_attempts[attempt_index].results;
        let latest = &results[results.len() - rules.len()..];
        self.apply_post_final_acceptance_outcome(current, &candidate_snapshot, rules, latest)
            .await
    }

    async fn apply_post_final_acceptance_outcome(
        &self,
        current: DeliveryRecord,
        snapshot: &PipelineRunSnapshot,
        rules: &[crate::config::ensemble::AcceptancePullRequestConfig],
        latest: &[crate::acceptance::AcceptanceResult],
    ) -> DeliveryRecord {
        let mut candidate = current.clone();
        for (rule, result) in rules.iter().zip(latest) {
            let Some(repository) = candidate.repositories.get_mut(&rule.repo) else {
                continue;
            };
            if result.status == crate::acceptance::AcceptanceStatus::Passed {
                if repository.retry_from == Some(DeliveryPhase::Waiting) {
                    repository.phase = DeliveryPhase::Waiting;
                    repository.retry_from = None;
                    repository.last_error = None;
                }
            } else {
                repository.phase = DeliveryPhase::Blocked;
                repository.retry_from = Some(DeliveryPhase::Waiting);
                repository.last_error = Some(result.summary.clone());
            }
        }
        if candidate == current {
            return current;
        }
        self.persist_delivery_candidate(&current, candidate, Some(snapshot))
            .await
            .unwrap_or_else(|authoritative| authoritative)
    }
    async fn advance_delivery_pull_request(
        &self,
        mut delivery: DeliveryRecord,
        repository_key: &str,
        repository_path: &Path,
        snapshot: Option<&PipelineRunSnapshot>,
        allow_create: bool,
    ) -> (DeliveryRecord, bool) {
        if delivery.repositories[repository_key].phase == DeliveryPhase::PrCreateInFlight {
            let mut reconciling = delivery.clone();
            let entry = reconciling.repositories.get_mut(repository_key).unwrap();
            entry.phase = DeliveryPhase::ReconcilingPr;
            entry.last_error = None;
            delivery = match self
                .persist_delivery_candidate(&delivery, reconciling, snapshot)
                .await
            {
                Ok(persisted) => persisted,
                Err(authoritative) => return (authoritative, false),
            };
        }
        let repository = delivery.repositories[repository_key].clone();
        if repository.phase != DeliveryPhase::ReconcilingPr {
            return (delivery, false);
        }
        let pull_requests = match self
            .delivery_remote
            .list_pull_requests(repository_path, repository_key)
            .await
        {
            Ok(pull_requests) => pull_requests,
            Err(error) => {
                return (
                    self.block_delivery_repository(
                        &delivery,
                        repository_key,
                        DeliveryPhase::ReconcilingPr,
                        error,
                        snapshot,
                    )
                    .await,
                    false,
                )
            }
        };
        match reconcile_pull_requests(repository_key, &repository, &pull_requests) {
            PullRequestReconciliation::Adopted { number, url } => {
                let mut waiting = delivery.clone();
                let entry = waiting.repositories.get_mut(repository_key).unwrap();
                entry.phase = DeliveryPhase::Waiting;
                entry.pr_number = Some(number);
                entry.pr_url = Some(url);
                entry.last_error = None;
                entry.retry_from = None;
                (
                    self.persist_delivery_candidate(&delivery, waiting, snapshot)
                        .await
                        .unwrap_or_else(|authoritative| authoritative),
                    false,
                )
            }
            PullRequestReconciliation::Create if !allow_create => (delivery, false),
            PullRequestReconciliation::Create => {
                let mut in_flight = delivery.clone();
                let entry = in_flight.repositories.get_mut(repository_key).unwrap();
                entry.phase = DeliveryPhase::PrCreateInFlight;
                entry.last_error = None;
                delivery = match self
                    .persist_delivery_candidate(&delivery, in_flight, snapshot)
                    .await
                {
                    Ok(persisted) => persisted,
                    Err(authoritative) => return (authoritative, false),
                };
                let result = self
                    .delivery_remote
                    .create_pull_request(
                        repository_path,
                        &repository.base_branch,
                        &repository.head_branch,
                        &repository.marker,
                    )
                    .await;
                let mut after_create = delivery.clone();
                let entry = after_create.repositories.get_mut(repository_key).unwrap();
                match result {
                    Ok(_) => {
                        entry.phase = DeliveryPhase::ReconcilingPr;
                        entry.last_error = None;
                    }
                    Err(error) => entry.last_error = Some(error),
                }
                let persisted = self
                    .persist_delivery_candidate(&delivery, after_create, snapshot)
                    .await
                    .unwrap_or_else(|authoritative| authoritative);
                let created =
                    persisted.repositories[repository_key].phase == DeliveryPhase::ReconcilingPr;
                (persisted, created)
            }
            PullRequestReconciliation::Blocked { error } => (
                self.block_delivery_repository(
                    &delivery,
                    repository_key,
                    DeliveryPhase::ReconcilingPr,
                    error,
                    snapshot,
                )
                .await,
                false,
            ),
        }
    }
    async fn advance_delivery_push(
        &self,
        mut delivery: DeliveryRecord,
        repository_key: &str,
        repository_path: &Path,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let phase = delivery.repositories[repository_key].phase;
        if matches!(phase, DeliveryPhase::Prepared | DeliveryPhase::PushInFlight) {
            let mut reconciling = delivery.clone();
            let entry = reconciling.repositories.get_mut(repository_key).unwrap();
            entry.phase = DeliveryPhase::ReconcilingPush;
            entry.last_error = None;
            entry.retry_from = None;
            delivery = match self
                .persist_delivery_candidate(&delivery, reconciling, snapshot)
                .await
            {
                Ok(persisted) => persisted,
                Err(authoritative) => return authoritative,
            };
        }
        let repository = delivery.repositories[repository_key].clone();
        if repository.phase != DeliveryPhase::ReconcilingPush {
            return delivery;
        }
        let observed = match self
            .delivery_remote
            .remote_head(repository_path, &repository.remote, &repository.head_branch)
            .await
        {
            Ok(observed) => observed,
            Err(error) => {
                return self
                    .block_delivery_repository(
                        &delivery,
                        repository_key,
                        DeliveryPhase::ReconcilingPush,
                        error,
                        snapshot,
                    )
                    .await
            }
        };
        match reconcile_push(&repository, observed.clone()) {
            PushReconciliation::Push => {
                let mut in_flight = delivery.clone();
                let entry = in_flight.repositories.get_mut(repository_key).unwrap();
                entry.phase = DeliveryPhase::PushInFlight;
                entry.last_error = None;
                delivery = match self
                    .persist_delivery_candidate(&delivery, in_flight, snapshot)
                    .await
                {
                    Ok(persisted) => persisted,
                    Err(authoritative) => return authoritative,
                };
                let result = self
                    .delivery_remote
                    .push(
                        repository_path,
                        &repository.remote,
                        &repository.head_branch,
                        &repository.local_sha,
                    )
                    .await;
                let mut after_push = delivery.clone();
                let entry = after_push.repositories.get_mut(repository_key).unwrap();
                match result {
                    Ok(_) => {
                        entry.phase = DeliveryPhase::ReconcilingPush;
                        entry.last_error = None;
                    }
                    Err(error) => entry.last_error = Some(error),
                }
                self.persist_delivery_candidate(&delivery, after_push, snapshot)
                    .await
                    .unwrap_or_else(|authoritative| authoritative)
            }
            PushReconciliation::Advance => {
                let mut advanced = delivery.clone();
                let entry = advanced.repositories.get_mut(repository_key).unwrap();
                entry.observed_remote_sha = observed;
                entry.last_error = None;
                entry.retry_from = None;
                entry.phase = match entry.mode {
                    DeliveryMode::Push => DeliveryPhase::Published,
                    DeliveryMode::PushAndPr => DeliveryPhase::ReconcilingPr,
                };
                self.persist_delivery_candidate(&delivery, advanced, snapshot)
                    .await
                    .unwrap_or_else(|authoritative| authoritative)
            }
            PushReconciliation::Blocked { error } => {
                self.block_delivery_repository(
                    &delivery,
                    repository_key,
                    DeliveryPhase::ReconcilingPush,
                    error,
                    snapshot,
                )
                .await
            }
        }
    }
    async fn block_delivery_repository(
        &self,
        current: &DeliveryRecord,
        repository_key: &str,
        retry_from: DeliveryPhase,
        error: String,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> DeliveryRecord {
        let mut blocked = current.clone();
        if let Some(repository) = blocked.repositories.get_mut(repository_key) {
            repository.phase = DeliveryPhase::Blocked;
            repository.last_error = Some(error);
            repository.retry_from = Some(retry_from);
        }
        self.persist_delivery_candidate(current, blocked, snapshot)
            .await
            .unwrap_or_else(|authoritative| authoritative)
    }
    async fn persist_delivery_candidate(
        &self,
        current: &DeliveryRecord,
        candidate: DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> Result<DeliveryRecord, DeliveryRecord> {
        match self.persist_delivery_record(&candidate, snapshot).await {
            Ok(()) => Ok(candidate),
            Err(error) => {
                warn!(
                    issue_id = %candidate.issue_id,
                    error = %error,
                    "failed to persist delivery transition; retaining the prior durable owner"
                );
                Err(current.clone())
            }
        }
    }
    pub(super) async fn persist_delivery_record(
        &self,
        delivery: &DeliveryRecord,
        snapshot: Option<&PipelineRunSnapshot>,
    ) -> Result<(), String> {
        let snapshot = match snapshot {
            Some(snapshot) => Some(snapshot.clone()),
            None => self
                .pipeline_journal
                .latest_live_record_for_issue(&delivery.issue_id)
                .await
                .map_err(|error| {
                    format!("failed to carry the pipeline snapshot into delivery: {error}")
                })?
                .filter(|record| record.run_id.as_deref() == Some(delivery.run_id.as_str()))
                .and_then(|record| record.snapshot),
        };
        let persisted_snapshot = snapshot.clone();
        let input = PipelineTransitionInput {
            kind: PipelineTransitionKind::DeliveryOwned,
            issue_id: delivery.issue_id.clone(),
            identifier: delivery.identifier.clone(),
            run_id: Some(delivery.run_id.clone()),
            cycle: snapshot.as_ref().map_or(0, |snapshot| snapshot.cycle),
            step: None,
            reason: None,
            retry: None,
            snapshot,
            terminal_transition: None,
            delivery: Some(delivery.clone()),
        };
        let transaction = self
            .pipeline_journal
            .begin_issue_transition(&delivery.issue_id)
            .await;
        if let Err(append_error) = transaction.append(input.clone()).await {
            match transaction.latest_record_matches(&input).await {
                Ok(true) => {}
                Ok(false) => {
                    return Err(format!(
                        "delivery transition was not persisted: {append_error}"
                    ));
                }
                Err(read_error) => {
                    return Err(format!(
                        "delivery transition append was ambiguous: {append_error}; reconciliation read failed: {read_error}"
                    ));
                }
            }
        }
        drop(transaction);

        let mut state = self.state.write().await;
        state.add_claimed(&delivery.issue_id);
        state
            .delivery
            .insert(delivery.issue_id.clone(), delivery.clone());
        if let Some(snapshot) = persisted_snapshot
            .as_ref()
            .filter(|snapshot| snapshot.issue_id == delivery.issue_id)
        {
            if let Some(run) = state.get_pipeline_run_mut(&delivery.issue_id) {
                run.acceptance_attempts = snapshot.acceptance_attempts.clone();
                run.resolved_acceptance_plan = snapshot.resolved_acceptance_plan.clone();
            }
        }
        Ok(())
    }
    pub(super) async fn prepare_delivery_record(
        &self,
        issue_id: &str,
        issue_identifier: &str,
        workspace: &crate::workspace::manager::WorkspaceResult,
        repository_keys: &[String],
    ) -> Result<(DeliveryRecord, Option<PipelineRunSnapshot>), String> {
        let (run_id, snapshot) = {
            let state = self.state.read().await;
            let run_id = state
                .running
                .get(issue_id)
                .and_then(|entry| entry.run_id.clone())
                .or_else(|| state.issue_run_ids.get(issue_id).cloned())
                .ok_or_else(|| "delivery requires a stable run ID".to_string())?;
            let snapshot = state
                .get_pipeline_run(issue_id)
                .map(PipelineRun::to_snapshot);
            (run_id, snapshot)
        };
        let configured_repositories = self.workspace_mgr.repos();
        let mut repositories = std::collections::BTreeMap::new();
        for repository_key in repository_keys {
            let config = configured_repositories
                .get(repository_key)
                .ok_or_else(|| format!("repository '{repository_key}' is no longer configured"))?;
            let worktree = workspace.worktrees.get(repository_key).ok_or_else(|| {
                format!("worktree for repository '{repository_key}' was not prepared")
            })?;
            let identity = self.delivery_remote.local_identity(&worktree.path).await?;
            let mode = match config.finalize.mode {
                FinalizeMode::Push => DeliveryMode::Push,
                FinalizeMode::PushAndPr => DeliveryMode::PushAndPr,
                FinalizeMode::None => continue,
            };
            repositories.insert(
                repository_key.clone(),
                DeliveryRepository {
                    mode,
                    phase: DeliveryPhase::Prepared,
                    remote: config.git_remote.clone(),
                    base_branch: config.branch.clone(),
                    head_branch: identity.head_branch,
                    local_sha: identity.local_sha,
                    observed_remote_sha: None,
                    marker: canonical_marker(&run_id, issue_id, repository_key),
                    pr_number: None,
                    pr_url: None,
                    last_error: None,
                    retry_from: None,
                },
            );
        }
        Ok((
            DeliveryRecord {
                issue_id: issue_id.to_string(),
                identifier: issue_identifier.to_string(),
                run_id,
                repositories,
            },
            snapshot,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(phase: DeliveryPhase) -> DeliveryRepository {
        DeliveryRepository {
            mode: DeliveryMode::PushAndPr,
            phase,
            remote: "origin".to_string(),
            base_branch: "main".to_string(),
            head_branch: "ensemble/issue-420".to_string(),
            local_sha: "0123456789abcdef".to_string(),
            observed_remote_sha: None,
            marker: "<!-- ensemble:delivery:v1 -->".to_string(),
            pr_number: None,
            pr_url: None,
            last_error: None,
            retry_from: None,
        }
    }

    fn pull_request(marker: &str, head_sha: &str) -> RemotePullRequest {
        RemotePullRequest {
            repository_key: "primary".to_string(),
            head_branch: "ensemble/issue-420".to_string(),
            base_branch: "main".to_string(),
            head_sha: head_sha.to_string(),
            body: marker.to_string(),
            number: 420,
            url: "https://github.com/example/project/pull/420".to_string(),
        }
    }

    #[test]
    fn delivery_record_derives_aggregate_without_serializing_it() {
        let mut repositories = BTreeMap::new();
        repositories.insert("zeta".to_string(), repository(DeliveryPhase::Published));
        repositories.insert("alpha".to_string(), repository(DeliveryPhase::Waiting));
        let record = DeliveryRecord {
            issue_id: "issue-420".to_string(),
            identifier: "ensemble#420".to_string(),
            run_id: "run-420".to_string(),
            repositories,
        };

        assert_eq!(record.aggregate(), DeliveryAggregate::Waiting);
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.find("alpha").unwrap() < json.find("zeta").unwrap());
        assert!(!json.contains("aggregate"));
    }

    #[test]
    fn push_reconciliation_blocks_a_divergent_remote() {
        let repo = repository(DeliveryPhase::ReconcilingPush);

        assert_eq!(
            reconcile_push(&repo, Some("fedcba9876543210".to_string())),
            PushReconciliation::Blocked {
                error: "remote head is fedcba9876543210, expected 0123456789abcdef".to_string(),
            }
        );
    }

    #[test]
    fn pr_reconciliation_requires_one_exact_identity_at_the_intended_sha() {
        let mut repo = repository(DeliveryPhase::ReconcilingPr);
        repo.observed_remote_sha = Some(repo.local_sha.clone());
        let exact = pull_request(&repo.marker, &repo.local_sha);

        assert_eq!(
            reconcile_pull_requests("primary", &repo, std::slice::from_ref(&exact)),
            PullRequestReconciliation::Adopted {
                number: exact.number,
                url: exact.url.clone(),
            }
        );

        let wrong_head = pull_request(&repo.marker, "aaaaaaaaaaaaaaaa");
        assert!(matches!(
            reconcile_pull_requests("primary", &repo, &[wrong_head]),
            PullRequestReconciliation::Blocked { .. }
        ));
        assert!(matches!(
            reconcile_pull_requests("primary", &repo, &[exact.clone(), exact]),
            PullRequestReconciliation::Blocked { .. }
        ));
    }

    #[test]
    fn zero_pr_matches_after_confirmed_push_allows_one_create_retry() {
        let mut repo = repository(DeliveryPhase::ReconcilingPr);
        repo.observed_remote_sha = Some(repo.local_sha.clone());

        assert_eq!(
            reconcile_pull_requests("primary", &repo, &[]),
            PullRequestReconciliation::Create
        );
    }

    #[test]
    fn post_finalize_acceptance_projects_only_retained_delivery_identity() {
        let rule = crate::config::ensemble::AcceptancePullRequestConfig {
            name: "primary-pr".into(),
            repo: "primary".into(),
        };
        let mut repo = repository(DeliveryPhase::Waiting);
        repo.pr_number = Some(420);
        repo.pr_url = Some("https://github.com/example/project/pull/420".into());

        let passed = evaluate_pull_request_requirement(&rule, &repo);
        repo.pr_url = None;
        let failed = evaluate_pull_request_requirement(&rule, &repo);

        assert_eq!(passed.status, crate::acceptance::AcceptanceStatus::Passed);
        assert_eq!(failed.status, crate::acceptance::AcceptanceStatus::Failed);
        assert!(matches!(
            passed.evidence,
            crate::acceptance::AcceptanceEvidence::PullRequest {
                pr_number: Some(420),
                ref pr_url,
                ..
            } if pr_url.as_deref() == Some("https://github.com/example/project/pull/420")
        ));
        assert!(failed.summary.contains("URL"));
    }
}

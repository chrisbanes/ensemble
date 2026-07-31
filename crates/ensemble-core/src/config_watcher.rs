use crate::api::router::AppState;
use crate::config::draft::{load_config_state, ConfigDocumentState};
use crate::error::EnsembleError;
#[cfg(test)]
use notify::PollWatcher as EnsembleWatcher;
#[cfg(not(test))]
use notify::RecommendedWatcher as EnsembleWatcher;
use notify::{Config, EventKind, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{info, warn};

const CONFIG_RELOAD_DEBOUNCE: Duration = Duration::from_millis(100);
const CONFIG_WATCHER_CHANNEL_CAPACITY: usize = 256;

pub struct ConfigWatcherHandle {
    task: Option<JoinHandle<()>>,
}

impl ConfigWatcherHandle {
    pub fn abort(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Drop for ConfigWatcherHandle {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReloadOutcome {
    Applied,
    Rejected,
    RestartRequired,
    Unchanged,
}

pub async fn reload_config_from_disk(app_state: &AppState) -> Result<ReloadOutcome, EnsembleError> {
    let _reload = app_state.config_runtime.reload_coordinator.lock().await;
    apply_config_from_disk_locked(app_state, true).await
}

pub(crate) async fn apply_config_from_disk_locked(
    app_state: &AppState,
    skip_matching_mtime: bool,
) -> Result<ReloadOutcome, EnsembleError> {
    let file_mtime = std::fs::metadata(&app_state.config_runtime.config_path)
        .and_then(|m| m.modified())
        .ok();

    let had_pending_setup = crate::config::setup_transaction::has_pending_setup_generation(
        &app_state.config_runtime.config_path,
    )?;
    let mut loaded = load_config_state(&app_state.config_runtime.config_path)?;
    let setup_generation = match loaded.raw_yaml.as_deref() {
        Some(raw_yaml) => crate::config::setup_transaction::matching_setup_generation(
            &app_state.config_runtime.config_path,
            raw_yaml,
        )?,
        None => None,
    };
    if had_pending_setup && setup_generation.is_none() {
        loaded = load_config_state(&app_state.config_runtime.config_path)?;
    }
    {
        let last = app_state.config_runtime.last_loaded_mtime.read().await;
        if setup_generation.is_none()
            && skip_matching_mtime
            && last.is_some()
            && *last == file_mtime
        {
            return Ok(ReloadOutcome::Unchanged);
        }
    }
    let candidate = match (&setup_generation, loaded.raw_yaml.as_deref()) {
        (Some(generation), Some(raw_yaml)) => generation.prepare_candidate(raw_yaml)?,
        _ => loaded,
    };
    let raw_yaml = candidate.raw_yaml.clone();
    let generation_for_publish = setup_generation.clone();
    let accept_unchanged = setup_generation.is_none();
    let generation_for_finish = setup_generation;
    let config_path = app_state.config_runtime.config_path.clone();
    apply_config_candidate_locked_with_hooks(
        app_state,
        candidate,
        file_mtime,
        accept_unchanged,
        move || {
            if let (Some(generation), Some(raw_yaml)) =
                (generation_for_publish, raw_yaml.as_deref())
            {
                generation.publish(raw_yaml)?;
            }
            Ok(())
        },
        move || {
            if let Some(generation) = generation_for_finish {
                if let Err(error) = generation.finish_activation() {
                    warn!(
                        error = %error,
                        path = %config_path.display(),
                        "setup generation activated but journal cleanup remains pending"
                    );
                }
            }
        },
    )
    .await
}

pub(crate) async fn apply_config_candidate_locked_with_hooks<Commit, AfterCommit>(
    app_state: &AppState,
    candidate: ConfigDocumentState,
    file_mtime: Option<std::time::SystemTime>,
    accept_unchanged: bool,
    before_commit: Commit,
    after_commit: AfterCommit,
) -> Result<ReloadOutcome, EnsembleError>
where
    Commit: FnOnce() -> Result<(), EnsembleError>,
    AfterCommit: FnOnce(),
{
    if candidate.raw_yaml.is_some() && file_mtime.is_none() {
        return Err(EnsembleError::RuntimeBusy);
    }
    let same_document = {
        candidate.raw_yaml
            == app_state
                .config_runtime
                .document_state
                .read()
                .await
                .raw_yaml
    };
    if same_document && accept_unchanged {
        *app_state.config_runtime.last_loaded_mtime.write().await = file_mtime;
        return Ok(ReloadOutcome::Unchanged);
    }
    let has_valid_config = candidate.active_config.is_some();

    if has_valid_config {
        let current = app_state.config_runtime.document_state.read().await;
        if candidate_requires_restart(app_state, &current, &candidate)? {
            warn!(
                path = %app_state.config_runtime.config_path.display(),
                reason = "workspace_or_repository_generation_changed",
                "config reload requires a process restart; keeping last known good config"
            );
            return Ok(ReloadOutcome::RestartRequired);
        }
        drop(current);

        crate::api::bootstrap::apply_prepared_config_candidate_with_hooks(
            app_state,
            candidate,
            file_mtime,
            before_commit,
            after_commit,
        )
        .await?;
        app_state.refresh_requested.notify_one();
        info!(
            path = %app_state.config_runtime.config_path.display(),
            "config reload applied"
        );
        return Ok(ReloadOutcome::Applied);
    }

    let had_last_good = {
        app_state
            .config_runtime
            .document_state
            .read()
            .await
            .active_config
            .is_some()
    };

    if had_last_good {
        warn!(
            path = %app_state.config_runtime.config_path.display(),
            issue_count = candidate.validation.issues.len(),
            "config reload rejected; keeping last known good config"
        );
    } else {
        warn!(
            path = %app_state.config_runtime.config_path.display(),
            "config reload rejected; no last known good config is available"
        );
    }

    Ok(ReloadOutcome::Rejected)
}

fn candidate_requires_restart(
    app_state: &AppState,
    current: &ConfigDocumentState,
    candidate: &ConfigDocumentState,
) -> Result<bool, EnsembleError> {
    let Some(candidate_config) = candidate.active_config.as_ref() else {
        return Ok(false);
    };

    let current_root =
        crate::workspace::manager::resolve_workspace_root(Path::new(&app_state.workspace_root))?;
    let candidate_root = crate::workspace::manager::resolve_workspace_root(Path::new(
        &crate::api::bootstrap::workspace_root_from_document(candidate),
    ))?;
    let current_repos = current
        .active_config
        .as_ref()
        .map(|config| &config.repos)
        .unwrap_or(&candidate_config.repos);
    Ok(current_root != candidate_root || current_repos != &candidate_config.repos)
}

pub fn start_config_watcher(app_state: AppState) -> ConfigWatcherHandle {
    let config_path = std::fs::canonicalize(&app_state.config_runtime.config_path)
        .unwrap_or_else(|_| app_state.config_runtime.config_path.clone());
    let watch_dir = config_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let (event_tx, mut event_rx) = mpsc::channel(CONFIG_WATCHER_CHANNEL_CAPACITY);
    let dropped_warned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dropped_warned_for_cb = Arc::clone(&dropped_warned);
    let watcher_config = Config::default();
    #[cfg(test)]
    let watcher_config = watcher_config
        .with_poll_interval(Duration::from_millis(50))
        .with_compare_contents(true);
    let mut watcher = match EnsembleWatcher::new(
        move |result| {
            if event_tx.try_send(result).is_err() {
                if !dropped_warned_for_cb.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    warn!("config watcher event dropped; receiver is unavailable or lagging");
                }
            } else {
                dropped_warned_for_cb.store(false, std::sync::atomic::Ordering::Relaxed);
            }
        },
        watcher_config,
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            warn!(
                error = %error,
                path = %watch_dir.display(),
                "failed to create config watcher"
            );
            return ConfigWatcherHandle { task: None };
        }
    };

    if let Err(error) = watcher.watch(&watch_dir, RecursiveMode::NonRecursive) {
        warn!(
            error = %error,
            path = %watch_dir.display(),
            "failed to watch config directory"
        );
        return ConfigWatcherHandle { task: None };
    }

    let task = tokio::spawn(async move {
        let _watcher = watcher;
        info!(
            config_path = %config_path.display(),
            watch_dir = %watch_dir.display(),
            "config watcher started"
        );

        while let Some(result) = event_rx.recv().await {
            let event = match result {
                Ok(event) => event,
                Err(error) => {
                    warn!(error = %error, "config watcher event error");
                    continue;
                }
            };

            if !is_config_change_event(&event, &config_path) {
                continue;
            }

            tokio::time::sleep(CONFIG_RELOAD_DEBOUNCE).await;

            while let Ok(result) = event_rx.try_recv() {
                if let Err(error) = result {
                    warn!(error = %error, "config watcher event error");
                }
            }

            if let Err(error) = reload_config_from_disk(&app_state).await {
                let reason = if matches!(error, EnsembleError::RuntimeBusy) {
                    "runtime_busy"
                } else {
                    "candidate_prepare_or_commit_failed"
                };
                warn!(
                    reason,
                    path = %config_path.display(),
                    "config reload failed"
                );
            }
        }
    });

    ConfigWatcherHandle { task: Some(task) }
}

fn is_config_change_event(event: &notify::Event, config_path: &Path) -> bool {
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return false;
    }

    event
        .paths
        .iter()
        .any(|event_path| paths_match(event_path, config_path))
}

fn paths_match(event_path: &Path, config_path: &Path) -> bool {
    let event_path = std::fs::canonicalize(event_path).unwrap_or_else(|_| event_path.to_path_buf());
    let config_path =
        std::fs::canonicalize(config_path).unwrap_or_else(|_| config_path.to_path_buf());
    event_path == config_path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::bootstrap::{
        build_app_state, clear_registered_orchestrator, start_or_replace_registered_orchestrator,
        take_registered_orchestrator,
    };
    use crate::config::draft::parse_raw_yaml;
    use crate::observability::events::EventBus;
    use tempfile::TempDir;

    fn valid_yaml(interval_ms: u64) -> String {
        format!(
            "tracker:\n  kind: todo_file\n  path: TODO.md\npolling:\n  interval_ms: {interval_ms}\nconcurrency:\n  max_concurrent_agents: 2\nagents:\n  builder:\n    acpx_agent: claude\n    prompt: Build it.\nsteps:\n  - name: build\n    agent: builder\non_success: Done\non_failure: Failed\n"
        )
    }

    #[tokio::test]
    async fn external_reload_replaces_valid_config_document() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        std::fs::write(&config_path, valid_yaml(1000)).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), valid_yaml(1000));
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());

        std::fs::write(&config_path, valid_yaml(2500)).unwrap();

        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::Applied);
        let doc = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        assert_eq!(
            doc.active_config.as_ref().unwrap().polling.interval_ms,
            2500
        );

        let runtime = take_registered_orchestrator(&prepared.app_state)
            .expect("valid reload should register an orchestrator runtime");
        drop(doc);
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn external_reload_keeps_last_good_document_when_invalid_after_valid() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        std::fs::write(&config_path, valid_yaml(1000)).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), valid_yaml(1000));
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();
        assert!(prepared.app_state.orchestrator_runtime.is_registered());

        std::fs::write(&config_path, "tracker: [").unwrap();

        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::Rejected);
        let doc = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        assert_eq!(
            doc.active_config.as_ref().unwrap().polling.interval_ms,
            1000
        );
        assert!(prepared.app_state.orchestrator_runtime.is_registered());
        drop(doc);

        let runtime = take_registered_orchestrator(&prepared.app_state)
            .expect("invalid reload should preserve the existing runtime");
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn external_reload_skips_when_file_mtime_is_unchanged() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        std::fs::write(&config_path, valid_yaml(1000)).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), valid_yaml(1000));
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();

        let mtime = std::fs::metadata(&config_path)
            .and_then(|m| m.modified())
            .unwrap();
        *prepared
            .app_state
            .config_runtime
            .last_loaded_mtime
            .write()
            .await = Some(mtime);

        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::Unchanged);
        assert_eq!(
            *prepared
                .app_state
                .config_runtime
                .last_loaded_mtime
                .read()
                .await,
            Some(mtime),
            "unchanged mtime reload must not update last_loaded_mtime"
        );

        if let Some(runtime) = take_registered_orchestrator(&prepared.app_state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn external_reload_keeps_missing_state_when_invalid_candidate_has_no_last_good() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        let initial = crate::config::draft::missing_config_state(config_path.clone());
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());

        std::fs::write(&config_path, "tracker: [").unwrap();

        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::Rejected);
        let doc = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        assert!(doc.active_config.is_none());
        assert_eq!(doc.kind, crate::config::draft::ConfigStateKind::Missing);
    }

    #[tokio::test]
    async fn setup_generation_entrypoint_watcher_publishes_matching_generation() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        let initial_yaml = valid_yaml(1000);
        std::fs::write(&config_path, &initial_yaml).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), initial_yaml);
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();
        let todo_path = temp.path().join("nested/TODO.md");
        let request = crate::config::setup::SetupRequest {
            tracker: crate::config::setup::SetupTracker::TodoFile {
                path: todo_path.clone(),
            },
            repos: vec![],
            agents: vec![crate::config::setup::SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "codex".to_string(),
                model: None,
                reasoning_level: None,
                permission_mode: None,
                prompt: None,
                prompt_file: Some("templates/build.liquid".to_string()),
            }],
            steps: vec![crate::config::setup::SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                kind: None,
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        crate::config::setup_transaction::stage_setup_generation(
            &config_path,
            &request,
            &artifacts,
        )
        .unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();
        *prepared
            .app_state
            .config_runtime
            .last_loaded_mtime
            .write()
            .await = std::fs::metadata(&config_path)
            .and_then(|metadata| metadata.modified())
            .ok();
        assert!(!todo_path.exists());
        assert!(!temp.path().join("templates/build.liquid").exists());

        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::Applied);
        assert!(todo_path.exists());
        assert!(temp.path().join("templates/build.liquid").exists());
        assert!(crate::config::setup_transaction::matching_setup_generation(
            &config_path,
            &artifacts.raw_yaml,
        )
        .unwrap()
        .is_none());
        clear_registered_orchestrator(&prepared.app_state).await;
    }

    #[tokio::test]
    async fn setup_generation_entrypoint_watcher_accepts_staged_dotenv_candidate() {
        use crate::config::secrets::{SecretDisplay, SecretEdit, SecretValue};

        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        let workspace_root = temp.path().join("secret-value");
        let initial_yaml = format!(
            "{}workspace:\n  root: {}\n",
            valid_yaml(1000),
            workspace_root.display()
        );
        std::fs::write(&config_path, &initial_yaml).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), initial_yaml);
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();
        let request = crate::config::setup::SetupRequest {
            tracker: crate::config::setup::SetupTracker::GitHub {
                repository: "owner/repo".to_string(),
                project_number: Some(1),
                api_key: SecretDisplay::Unset,
                api_key_edit: SecretEdit::SetEnvironment {
                    variable: "NEW_GITHUB_TOKEN".to_string(),
                },
                api_token: Some(SecretValue::new("secret-value")),
                active_states: vec!["Ready".to_string()],
                terminal_states: vec!["Done".to_string()],
            },
            repos: vec![],
            agents: vec![crate::config::setup::SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "codex".to_string(),
                model: None,
                reasoning_level: None,
                permission_mode: None,
                prompt: None,
                prompt_file: Some("templates/build.liquid".to_string()),
            }],
            steps: vec![crate::config::setup::SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                kind: None,
                depends: vec![],
                tracker_state: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        let mut artifacts = crate::config::setup::build_setup_artifacts(&request);
        artifacts
            .raw_yaml
            .push_str("workspace:\n  root: $NEW_GITHUB_TOKEN\n");
        crate::config::setup_transaction::stage_setup_generation(
            &config_path,
            &request,
            &artifacts,
        )
        .unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();

        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::Applied);
        let document = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        assert_eq!(
            document
                .active_config
                .as_ref()
                .unwrap()
                .tracker
                .api_key
                .as_deref(),
            Some("secret-value")
        );
        drop(document);
        clear_registered_orchestrator(&prepared.app_state).await;
    }

    #[tokio::test]
    async fn restart_required_reload_workspace_root_keeps_active_generation() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        let initial_root = temp.path().join("workspaces-a");
        let candidate_root = temp.path().join("workspaces-b");
        let initial_yaml = format!(
            "{}workspace:\n  root: {}\n",
            valid_yaml(1000),
            initial_root.display()
        );
        let candidate_yaml = format!(
            "{}workspace:\n  root: {}\n",
            valid_yaml(2500),
            candidate_root.display()
        );
        std::fs::write(&config_path, &initial_yaml).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), initial_yaml);
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();
        let initial_mtime = *prepared
            .app_state
            .config_runtime
            .last_loaded_mtime
            .read()
            .await;

        std::fs::write(&config_path, candidate_yaml).unwrap();
        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::RestartRequired);
        let document = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        assert_eq!(
            document.active_config.as_ref().unwrap().polling.interval_ms,
            1000
        );
        assert_eq!(
            prepared.app_state.workspace_root,
            initial_root.display().to_string()
        );
        drop(document);
        assert_eq!(
            *prepared
                .app_state
                .config_runtime
                .last_loaded_mtime
                .read()
                .await,
            initial_mtime,
            "restart-required candidates remain retryable"
        );

        clear_registered_orchestrator(&prepared.app_state).await;
    }

    #[tokio::test]
    async fn restart_required_reload_repositories_keeps_active_generation() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        let repo_a = temp.path().join("repo-a");
        let repo_b = temp.path().join("repo-b");
        let initial_yaml = format!(
            "{}repos:\n  - path: {}\n    branch: main\n",
            valid_yaml(1000),
            repo_a.display()
        );
        let candidate_yaml = format!(
            "{}repos:\n  - path: {}\n    branch: main\n",
            valid_yaml(2500),
            repo_b.display()
        );
        std::fs::write(&config_path, &initial_yaml).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), initial_yaml);
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();

        std::fs::write(&config_path, candidate_yaml).unwrap();
        let outcome = reload_config_from_disk(&prepared.app_state).await.unwrap();

        assert_eq!(outcome, ReloadOutcome::RestartRequired);
        let document = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        assert_eq!(
            document.active_config.as_ref().unwrap().repos[0].path,
            repo_a.display().to_string()
        );
        assert_eq!(
            document.active_config.as_ref().unwrap().polling.interval_ms,
            1000
        );
        drop(document);

        clear_registered_orchestrator(&prepared.app_state).await;
    }

    #[tokio::test]
    async fn transactional_reload_preparation_failure_is_retryable_without_rewrite() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        let initial_yaml = valid_yaml(1000);
        std::fs::write(&config_path, &initial_yaml).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), initial_yaml);
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();
        let last_good_mtime = *prepared
            .app_state
            .config_runtime
            .last_loaded_mtime
            .read()
            .await;
        let missing_parent = temp.path().join("not-created-yet");
        let candidate_yaml = valid_yaml(2500).replace(
            "path: TODO.md",
            &format!("path: {}/TODO.md", missing_parent.display()),
        );
        std::fs::write(&config_path, candidate_yaml).unwrap();
        let candidate_mtime = std::fs::metadata(&config_path).unwrap().modified().unwrap();

        assert!(reload_config_from_disk(&prepared.app_state).await.is_err());
        assert_eq!(
            prepared
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .polling
                .interval_ms,
            1000
        );
        assert_eq!(
            prepared
                .app_state
                .orchestrator_state
                .read()
                .await
                .poll_interval_ms,
            1000
        );
        assert_eq!(
            *prepared
                .app_state
                .config_runtime
                .last_loaded_mtime
                .read()
                .await,
            last_good_mtime
        );
        assert!(prepared.app_state.orchestrator_runtime.is_registered());

        std::fs::create_dir_all(&missing_parent).unwrap();
        assert_eq!(
            std::fs::metadata(&config_path).unwrap().modified().unwrap(),
            candidate_mtime,
            "repair must not rewrite the candidate"
        );
        assert_eq!(
            reload_config_from_disk(&prepared.app_state).await.unwrap(),
            ReloadOutcome::Applied
        );
        assert_eq!(
            prepared
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .polling
                .interval_ms,
            2500
        );

        clear_registered_orchestrator(&prepared.app_state).await;
    }

    #[tokio::test]
    async fn serialized_reload_generation_commits_only_the_latest_waiting_candidate() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        let initial_yaml = valid_yaml(1000);
        std::fs::write(&config_path, &initial_yaml).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), initial_yaml);
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();

        let reload_guard = prepared
            .app_state
            .config_runtime
            .reload_coordinator
            .lock()
            .await;
        std::fs::write(&config_path, valid_yaml(2500)).unwrap();
        let mut waiting_reload = tokio::spawn({
            let app_state = prepared.app_state.clone();
            async move { reload_config_from_disk(&app_state).await }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting_reload)
                .await
                .is_err(),
            "reload must wait for the active generation transaction"
        );

        std::fs::write(&config_path, valid_yaml(3500)).unwrap();
        drop(reload_guard);
        assert_eq!(
            waiting_reload.await.unwrap().unwrap(),
            ReloadOutcome::Applied
        );
        assert_eq!(
            prepared
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .active_config
                .as_ref()
                .unwrap()
                .polling
                .interval_ms,
            3500,
            "the superseded candidate must never become observable"
        );

        clear_registered_orchestrator(&prepared.app_state).await;
    }

    #[test]
    fn detects_config_yaml_modify_event() {
        let config_path = std::path::PathBuf::from("/tmp/ensemble/config.yaml");
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![config_path.clone()],
            attrs: notify::event::EventAttributes::new(),
        };

        assert!(is_config_change_event(&event, &config_path));
    }

    #[test]
    fn ignores_unrelated_files() {
        let config_path = std::path::PathBuf::from("/tmp/ensemble/config.yaml");
        let event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![std::path::PathBuf::from("/tmp/ensemble/notes.md")],
            attrs: notify::event::EventAttributes::new(),
        };

        assert!(!is_config_change_event(&event, &config_path));
    }

    #[tokio::test]
    async fn watcher_skips_generation_already_committed_by_a_reload_transaction() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        std::fs::write(&config_path, valid_yaml(1000)).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), valid_yaml(1000));
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        start_or_replace_registered_orchestrator(&prepared.app_state)
            .await
            .unwrap();
        let watcher = start_config_watcher(prepared.app_state.clone());
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        std::fs::write(&config_path, valid_yaml(5500)).unwrap();
        assert_eq!(
            reload_config_from_disk(&prepared.app_state).await.unwrap(),
            ReloadOutcome::Applied
        );

        // The watcher will fire after the debounce, but the committed mtime
        // makes it return Unchanged instead of replacing the runtime twice.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let interval = {
            let doc = prepared
                .app_state
                .config_runtime
                .document_state
                .read()
                .await;
            doc.active_config
                .as_ref()
                .map(|config| config.polling.interval_ms)
        };
        assert_eq!(
            interval,
            Some(5500),
            "watcher must preserve the generation already committed by the transaction"
        );

        watcher.abort();
        if let Some(runtime) = take_registered_orchestrator(&prepared.app_state) {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn watcher_applies_external_config_change() {
        let temp = TempDir::new().unwrap();
        let config_path = temp.path().join("config.yaml");
        std::fs::write(&config_path, valid_yaml(1000)).unwrap();
        let initial = parse_raw_yaml(config_path.clone(), valid_yaml(1000));
        let prepared = build_app_state(config_path.clone(), initial, EventBus::new());
        let watcher = start_config_watcher(prepared.app_state.clone());
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        std::fs::write(&config_path, valid_yaml(35_000)).unwrap();

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let interval = {
                let doc = prepared
                    .app_state
                    .config_runtime
                    .document_state
                    .read()
                    .await;
                doc.active_config
                    .as_ref()
                    .map(|config| config.polling.interval_ms)
            };
            if interval == Some(35_000) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "watcher did not reload config"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        watcher.abort();
        if let Some(runtime) = take_registered_orchestrator(&prepared.app_state) {
            runtime.shutdown().await;
        }
    }
}

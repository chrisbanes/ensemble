use crate::api::bootstrap::start_or_replace_registered_orchestrator;
use crate::api::router::AppState;
use crate::config::draft::load_config_state;
use crate::error::EnsembleError;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
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
    Unchanged,
}

pub async fn reload_config_from_disk(app_state: &AppState) -> Result<ReloadOutcome, EnsembleError> {
    let file_mtime = std::fs::metadata(&app_state.config_runtime.config_path)
        .and_then(|m| m.modified())
        .ok();

    {
        let last = app_state.config_runtime.last_loaded_mtime.read().await;
        if last.is_some() && *last == file_mtime {
            return Ok(ReloadOutcome::Unchanged);
        }
    }

    let loaded = load_config_state(&app_state.config_runtime.config_path)?;
    let has_valid_config = loaded.active_config.is_some();

    if has_valid_config {
        {
            let mut current = app_state.config_runtime.document_state.write().await;
            *current = loaded;
        }
        *app_state.config_runtime.last_loaded_mtime.write().await = file_mtime;

        start_or_replace_registered_orchestrator(app_state).await?;
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
            issues = ?loaded.validation.issues,
            "config reload rejected; keeping last known good config"
        );
    } else {
        let mut current = app_state.config_runtime.document_state.write().await;
        *current = loaded;
        *app_state.config_runtime.last_loaded_mtime.write().await = file_mtime;
        warn!(
            path = %app_state.config_runtime.config_path.display(),
            "config reload rejected; no last known good config is available"
        );
    }

    Ok(ReloadOutcome::Rejected)
}

/// Record that `config_path` was just written by Ensemble itself, so the watcher
/// will skip the next reload that the write triggers.
pub async fn record_self_write(app_state: &AppState) {
    let mtime = std::fs::metadata(&app_state.config_runtime.config_path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::now());
    *app_state.config_runtime.last_loaded_mtime.write().await = Some(mtime);
}

pub fn start_config_watcher(app_state: AppState) -> ConfigWatcherHandle {
    let task = tokio::spawn(async move {
        let config_path = std::fs::canonicalize(&app_state.config_runtime.config_path)
            .unwrap_or_else(|_| app_state.config_runtime.config_path.clone());
        let watch_dir = config_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));

        if let Ok(initial_mtime) =
            std::fs::metadata(&app_state.config_runtime.config_path).and_then(|m| m.modified())
        {
            *app_state.config_runtime.last_loaded_mtime.write().await = Some(initial_mtime);
        }

        let (event_tx, mut event_rx) = mpsc::channel(CONFIG_WATCHER_CHANNEL_CAPACITY);
        let dropped_warned = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let dropped_warned_for_cb = Arc::clone(&dropped_warned);
        let mut watcher = match RecommendedWatcher::new(
            move |result| {
                if event_tx.try_send(result).is_err() {
                    if !dropped_warned_for_cb.swap(true, std::sync::atomic::Ordering::Relaxed) {
                        warn!("config watcher event dropped; receiver is unavailable or lagging");
                    }
                } else {
                    dropped_warned_for_cb.store(false, std::sync::atomic::Ordering::Relaxed);
                }
            },
            Config::default(),
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                warn!(
                    error = %error,
                    path = %watch_dir.display(),
                    "failed to create config watcher"
                );
                return;
            }
        };

        if let Err(error) = watcher.watch(&watch_dir, RecursiveMode::NonRecursive) {
            warn!(
                error = %error,
                path = %watch_dir.display(),
                "failed to watch config directory"
            );
            return;
        }

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
                warn!(
                    error = %error,
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
    use crate::api::bootstrap::{build_app_state, take_registered_orchestrator};
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
    async fn external_reload_records_invalid_document_when_no_last_good_exists() {
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
        assert_eq!(doc.kind, crate::config::draft::ConfigStateKind::SyntaxError);
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
    async fn watcher_does_not_reload_after_record_self_write() {
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
        record_self_write(&prepared.app_state).await;

        // The watcher will fire after the debounce, but the mtime check should
        // make it return Unchanged and leave the document state alone.
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
            Some(1000),
            "watcher should not apply a self-write because record_self_write pins last_loaded_mtime"
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

        std::fs::write(&config_path, valid_yaml(3500)).unwrap();

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
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
            if interval == Some(3500) {
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

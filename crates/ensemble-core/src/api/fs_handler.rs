use crate::api::handlers::ApiError;
use crate::api::router::AppState;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Query parameters for the directory listing endpoint.
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub path: Option<String>,
}

/// A single entry in a directory listing response.
#[derive(Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub path: String,
}

/// Response body for GET /api/v1/fs/list.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ListResponse {
    pub entries: Vec<FsEntry>,
    pub truncated: bool,
}

const MAX_ENTRIES: usize = 500;

/// GET /api/v1/fs/list
///
/// Lists directory contents restricted to the user's home directory.
/// Returns entries sorted with directories first, then files, alphabetically within each group.
#[utoipa::path(
    get,
    path = "/api/v1/fs/list",
    operation_id = "listDirectory",
    params(
        ("path" = String, Query, description = "Directory path to list")
    ),
    responses(
        (status = 200, description = "Directory listing", body = ListResponse),
        (status = 400, description = "Missing path parameter", body = ApiError),
        (status = 403, description = "Path outside home directory", body = ApiError),
        (status = 404, description = "Path does not exist", body = ApiError),
        (status = 500, description = "I/O error", body = ApiError)
    ),
    tag = "filesystem"
)]
pub async fn list_directory(
    State(_state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> impl IntoResponse {
    let path_str = match query.path {
        Some(p) => p,
        None => {
            let error = ApiError::new("missing_parameter", "path parameter is required");
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::to_value(error).unwrap()),
            )
                .into_response();
        }
    };

    let home_dir = match dirs::home_dir() {
        Some(h) => h,
        None => {
            let error = ApiError::new("internal_error", "could not determine home directory");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::to_value(error).unwrap()),
            )
                .into_response();
        }
    };

    let target = PathBuf::from(&path_str);

    // Wrap all blocking I/O in spawn_blocking
    let result =
        tokio::task::spawn_blocking(move || -> Result<Vec<FsEntry>, (StatusCode, ApiError)> {
            // Resolve symlinks for the target path itself
            let canonical_target = if target.exists() {
                match std::fs::canonicalize(&target) {
                    Ok(c) => c,
                    Err(e) => {
                        return Err((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            ApiError::new("io_error", &format!("failed to resolve path: {e}")),
                        ));
                    }
                }
            } else {
                return Err((
                    StatusCode::NOT_FOUND,
                    ApiError::new("not_found", "path does not exist"),
                ));
            };

            // Check that the canonical target is within home directory
            let canonical_home = match std::fs::canonicalize(&home_dir) {
                Ok(c) => c,
                Err(e) => {
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        ApiError::new(
                            "internal_error",
                            &format!("failed to resolve home directory: {e}"),
                        ),
                    ));
                }
            };

            if !canonical_target.starts_with(&canonical_home) {
                return Err((
                    StatusCode::FORBIDDEN,
                    ApiError::new("forbidden", "path is outside the home directory"),
                ));
            }

            if !canonical_target.is_dir() {
                return Err((
                    StatusCode::NOT_FOUND,
                    ApiError::new("not_found", "path is not a directory"),
                ));
            }

            // Read directory contents
            let entries = match std::fs::read_dir(&canonical_target) {
                Ok(rd) => rd,
                Err(e) => {
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        ApiError::new("io_error", &format!("failed to read directory: {e}")),
                    ));
                }
            };

            let mut dirs: Vec<FsEntry> = Vec::new();
            let mut files: Vec<FsEntry> = Vec::new();

            for entry_result in entries {
                let entry = match entry_result {
                    Ok(e) => e,
                    Err(e) => {
                        return Err((
                            StatusCode::INTERNAL_SERVER_ERROR,
                            ApiError::new(
                                "io_error",
                                &format!("failed to read directory entry: {e}"),
                            ),
                        ));
                    }
                };

                let entry_path = entry.path();

                // Resolve symlinks and check if the resolved path is within home
                let canonical_entry = match std::fs::canonicalize(&entry_path) {
                    Ok(c) => c,
                    Err(_) => continue, // Skip entries we can't canonicalize
                };

                if !canonical_entry.starts_with(&canonical_home) {
                    // Symlink escapes home — exclude from results
                    continue;
                }

                let is_dir = canonical_entry.is_dir();
                let name = entry.file_name().to_string_lossy().to_string();
                let path = entry_path.to_string_lossy().to_string();

                let fs_entry = FsEntry { name, is_dir, path };

                if is_dir {
                    dirs.push(fs_entry);
                } else {
                    files.push(fs_entry);
                }
            }

            // Sort alphabetically within each group
            dirs.sort_by(|a, b| a.name.cmp(&b.name));
            files.sort_by(|a, b| a.name.cmp(&b.name));

            let mut all_entries = dirs;
            all_entries.extend(files);

            Ok(all_entries)
        })
        .await;

    let mut all_entries = match result {
        Ok(Ok(entries)) => entries,
        Ok(Err((status, error))) => {
            return (status, Json(serde_json::to_value(error).unwrap())).into_response();
        }
        Err(e) => {
            let error = ApiError::new("internal_error", &format!("task join error: {e}"));
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::to_value(error).unwrap()),
            )
                .into_response();
        }
    };

    let truncated = all_entries.len() > MAX_ENTRIES;
    all_entries.truncate(MAX_ENTRIES);

    let response = ListResponse {
        entries: all_entries,
        truncated,
    };

    (StatusCode::OK, Json(response)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::router::{AppState, ConfigRuntime};
    use crate::config::draft::{ConfigDocumentState, ConfigStateKind, DraftValidationReport};
    use crate::observability::events::EventBus;
    use crate::orchestrator::state::OrchestratorState;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn test_app_state() -> AppState {
        let state = OrchestratorState::new(30000, 10);
        let config_path = PathBuf::from("ensemble.yaml");
        let document_state = Arc::new(RwLock::new(ConfigDocumentState {
            path: config_path.clone(),
            kind: ConfigStateKind::Parsed,
            raw_yaml: None,
            document: None,
            active_config: None,
            validation: DraftValidationReport::default(),
        }));

        AppState {
            orchestrator_state: Arc::new(RwLock::new(state)),
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            workspace_root: "/tmp/workspaces".to_string(),
            history_path: PathBuf::from("/tmp/history.jsonl"),
            event_bus: EventBus::new(),
            config_runtime: ConfigRuntime {
                config_path,
                document_state,
            },
        }
    }

    async fn call_and_extract(response: impl IntoResponse) -> (StatusCode, serde_json::Value) {
        let response = response.into_response();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        (status, json)
    }

    fn test_home_base() -> PathBuf {
        let home = dirs::home_dir().expect("home dir required");
        home.join(".ensemble_fs_test")
    }

    struct TestHomeCleanup(PathBuf);

    impl Drop for TestHomeCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn setup_test_home(name: &str) -> (PathBuf, TestHomeCleanup) {
        let base = test_home_base();
        let dir = base.join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cleanup = TestHomeCleanup(dir.clone());
        (dir, cleanup)
    }

    #[tokio::test]
    async fn test_list_directory_valid_path() {
        let (home_dir, _cleanup) = setup_test_home("valid_path");
        std::fs::create_dir_all(home_dir.join("subdir_a")).unwrap();
        std::fs::create_dir_all(home_dir.join("subdir_b")).unwrap();
        std::fs::write(home_dir.join("file_b.txt"), "content").unwrap();
        std::fs::write(home_dir.join("file_a.txt"), "content").unwrap();

        let app_state = test_app_state();
        let query = ListQuery {
            path: Some(home_dir.to_string_lossy().to_string()),
        };

        let response = list_directory(State(app_state), Query(query)).await;
        let (status, body) = call_and_extract(response).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.get("entries").is_some());
        assert!(!body["truncated"].as_bool().unwrap());

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        assert_eq!(entries.len(), 4);

        assert_eq!(entries[0].name, "subdir_a");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].name, "subdir_b");
        assert!(entries[1].is_dir);
        assert_eq!(entries[2].name, "file_a.txt");
        assert!(!entries[2].is_dir);
        assert_eq!(entries[3].name, "file_b.txt");
        assert!(!entries[3].is_dir);
    }

    #[tokio::test]
    async fn test_list_directory_path_outside_home() {
        let app_state = test_app_state();
        let query = ListQuery {
            path: Some("/usr/bin".to_string()),
        };

        let response = list_directory(State(app_state), Query(query)).await;
        let (status, body) = call_and_extract(response).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "forbidden");
    }

    #[tokio::test]
    async fn test_list_directory_nonexistent_path() {
        let (home_dir, _cleanup) = setup_test_home("nonexistent");

        let app_state = test_app_state();
        let query = ListQuery {
            path: Some(
                home_dir
                    .join("does_not_exist")
                    .to_string_lossy()
                    .to_string(),
            ),
        };

        let response = list_directory(State(app_state), Query(query)).await;
        let (status, body) = call_and_extract(response).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn test_list_directory_missing_path() {
        let app_state = test_app_state();
        let query = ListQuery { path: None };

        let response = list_directory(State(app_state), Query(query)).await;
        let (status, body) = call_and_extract(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "missing_parameter");
    }

    #[tokio::test]
    async fn test_list_directory_symlink_escape() {
        let (home_dir, _cleanup) = setup_test_home("symlink_escape");

        let outside = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(outside.path().join("outside_dir")).unwrap();

        std::os::unix::fs::symlink(
            outside.path().join("outside_dir"),
            home_dir.join("escape_link"),
        )
        .unwrap();

        std::fs::create_dir_all(home_dir.join("normal_dir")).unwrap();

        let app_state = test_app_state();
        let query = ListQuery {
            path: Some(home_dir.to_string_lossy().to_string()),
        };

        let response = list_directory(State(app_state), Query(query)).await;
        let (status, body) = call_and_extract(response).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "normal_dir");
    }

    #[tokio::test]
    async fn test_list_directory_truncation() {
        let (home_dir, _cleanup) = setup_test_home("truncation");

        for i in 0..600 {
            std::fs::write(home_dir.join(format!("file_{i:04}.txt")), "content").unwrap();
        }

        let app_state = test_app_state();
        let query = ListQuery {
            path: Some(home_dir.to_string_lossy().to_string()),
        };

        let response = list_directory(State(app_state), Query(query)).await;
        let (status, body) = call_and_extract(response).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        let truncated = body["truncated"].as_bool().unwrap();

        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(truncated);
    }

    #[tokio::test]
    async fn test_list_directory_empty() {
        let (home_dir, _cleanup) = setup_test_home("empty");

        let app_state = test_app_state();
        let query = ListQuery {
            path: Some(home_dir.to_string_lossy().to_string()),
        };

        let response = list_directory(State(app_state), Query(query)).await;
        let (status, body) = call_and_extract(response).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        let truncated = body["truncated"].as_bool().unwrap();

        assert!(entries.is_empty());
        assert!(!truncated);
    }
}

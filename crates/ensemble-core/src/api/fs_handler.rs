use crate::api::handlers::{api_error, ApiError};
use crate::api::router::AppState;
use axum::response::Response;
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
            return (
                StatusCode::BAD_REQUEST,
                api_error("missing_parameter", "path parameter is required"),
            )
                .into_response();
        }
    };

    let home_dir = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                api_error("internal_error", "could not determine home directory"),
            )
                .into_response();
        }
    };

    let response = list_directory_inner(path_str, home_dir).await;
    response.into_response()
}

async fn list_directory_inner(
    path_str: String,
    home_dir: PathBuf,
) -> Response {
    let result =
        tokio::task::spawn_blocking(move || -> Result<Vec<FsEntry>, (StatusCode, ApiError)> {
            // Expand ~ to home directory
            let expanded = shellexpand::tilde(&path_str);
            let target = PathBuf::from(expanded.as_ref());

            // Resolve symlinks — canonicalize returns Err if path doesn't exist
            let canonical_target = match std::fs::canonicalize(&target) {
                Ok(c) => c,
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        return Err((
                            StatusCode::NOT_FOUND,
                            ApiError::new("not_found", "path does not exist"),
                        ));
                    }
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        ApiError::new("io_error", &format!("failed to resolve path: {e}")),
                    ));
                }
            };

            // If target resolved to a file, use its parent directory
            let canonical_target = if canonical_target.is_file() {
                match canonical_target.parent() {
                    Some(parent) => parent.to_path_buf(),
                    None => {
                        return Err((
                            StatusCode::BAD_REQUEST,
                            ApiError::new("bad_request", "file path has no parent directory"),
                        ));
                    }
                }
            } else {
                canonical_target
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
            return (status, Json(error)).into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                api_error("internal_error", format!("task join error: {e}")),
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
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use axum::response::Response;

    async fn response_json(response: Response) -> serde_json::Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn call_list(path: Option<&str>, home: &PathBuf) -> (StatusCode, serde_json::Value) {
        let path_str = path.unwrap_or("").to_string();
        let response = list_directory_inner(path_str, home.clone()).await;
        let status = response.status();
        let body = response_json(response).await;
        (status, body)
    }

    #[test]
    fn list_response_serializes_entries_and_truncated() {
        let response = ListResponse {
            entries: vec![FsEntry {
                name: "visible.txt".to_string(),
                is_dir: false,
                path: "/tmp/visible.txt".to_string(),
            }],
            truncated: false,
        };

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["entries"][0]["name"], "visible.txt");
        assert_eq!(json["truncated"], false);
    }

    #[tokio::test]
    async fn test_list_directory_valid_path() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        std::fs::create_dir_all(home.join("subdir_a")).unwrap();
        std::fs::create_dir_all(home.join("subdir_b")).unwrap();
        std::fs::write(home.join("file_b.txt"), "content").unwrap();
        std::fs::write(home.join("file_a.txt"), "content").unwrap();

        let (status, body) = call_list(Some(home.to_str().unwrap()), &home).await;
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
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();

        let (status, body) = call_list(Some("/usr/bin"), &home).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "forbidden");
    }

    #[tokio::test]
    async fn test_list_directory_nonexistent_path() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();

        let nonexistent = home.join("does_not_exist");
        let (status, body) = call_list(nonexistent.to_str(), &home).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn test_list_directory_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();

        let outside = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(outside.path().join("outside_dir")).unwrap();

        std::os::unix::fs::symlink(outside.path().join("outside_dir"), home.join("escape_link"))
            .unwrap();

        std::fs::create_dir_all(home.join("normal_dir")).unwrap();

        let (status, body) = call_list(Some(home.to_str().unwrap()), &home).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "normal_dir");
    }

    #[tokio::test]
    async fn test_list_directory_truncation() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();

        for i in 0..600 {
            std::fs::write(home.join(format!("file_{i:04}.txt")), "content").unwrap();
        }

        let (status, body) = call_list(Some(home.to_str().unwrap()), &home).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        let truncated = body["truncated"].as_bool().unwrap();

        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(truncated);
    }

    #[tokio::test]
    async fn test_list_directory_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();

        let (status, body) = call_list(Some(home.to_str().unwrap()), &home).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        let truncated = body["truncated"].as_bool().unwrap();

        assert!(entries.is_empty());
        assert!(!truncated);
    }

    #[tokio::test]
    async fn test_list_directory_lists_visible_files() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        std::fs::write(home.join("visible.txt"), "content").unwrap();

        let (status, body) = call_list(Some(home.to_str().unwrap()), &home).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "visible.txt");
    }

    #[tokio::test]
    async fn test_list_directory_uses_parent_for_file_path() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        std::fs::write(home.join("target_file.txt"), "content").unwrap();
        std::fs::write(home.join("sibling.txt"), "content").unwrap();

        let file_path = home.join("target_file.txt");
        let (status, body) = call_list(file_path.to_str(), &home).await;
        assert_eq!(status, StatusCode::OK);

        let entries: Vec<FsEntry> = serde_json::from_value(body["entries"].clone()).unwrap();
        assert_eq!(entries.len(), 2);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"target_file.txt"));
        assert!(names.contains(&"sibling.txt"));
    }
}

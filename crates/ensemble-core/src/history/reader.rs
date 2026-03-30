use std::path::Path;

use serde::{Deserialize, Serialize};

use super::model::HistoryRecord;

/// Query parameters for filtering and paginating history records.
#[derive(Debug, Default, Deserialize)]
pub struct HistoryQuery {
    /// Filter to records with this outcome (e.g. "succeeded", "failed").
    pub outcome: Option<String>,
    /// Filter to records that traversed a specific step name.
    pub step: Option<String>,
    /// Cursor-based pagination: skip records before this 0-based index.
    pub cursor: Option<usize>,
    /// Maximum number of records to return (default: 50).
    pub limit: Option<usize>,
}

/// Response envelope for history queries.
#[derive(Debug, Serialize)]
pub struct HistoryResponse {
    pub records: Vec<HistoryRecord>,
    pub total: usize,
    pub next_cursor: Option<usize>,
}

/// Read history records from a JSONL file with optional filtering and pagination.
///
/// Returns an empty response if the file does not exist.
/// Malformed lines are silently skipped.
pub async fn read_history(
    path: &Path,
    query: &HistoryQuery,
) -> Result<HistoryResponse, std::io::Error> {
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryResponse {
                records: vec![],
                total: 0,
                next_cursor: None,
            });
        }
        Err(e) => return Err(e),
    };

    let all_records: Vec<HistoryRecord> = contents
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();

    // Apply filters
    let filtered: Vec<HistoryRecord> = all_records
        .into_iter()
        .filter(|r| {
            if let Some(ref outcome) = query.outcome {
                if r.outcome != *outcome {
                    return false;
                }
            }
            if let Some(ref step) = query.step {
                if !r.steps_traversed.contains(step) {
                    return false;
                }
            }
            true
        })
        .collect();

    let total = filtered.len();
    let cursor = query.cursor.unwrap_or(0);
    let limit = query.limit.unwrap_or(50);

    let page: Vec<HistoryRecord> = filtered.into_iter().skip(cursor).take(limit).collect();

    let next_cursor = if cursor + page.len() < total {
        Some(cursor + page.len())
    } else {
        None
    };

    Ok(HistoryResponse {
        records: page,
        total,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::model::TokenTotals;
    use crate::history::writer::HistoryWriter;
    use chrono::Utc;
    use tempfile::NamedTempFile;

    fn sample_record(identifier: &str, outcome: &str, steps: &[&str]) -> HistoryRecord {
        HistoryRecord {
            issue_identifier: identifier.into(),
            issue_id: format!("id-{}", identifier),
            outcome: outcome.into(),
            steps_traversed: steps.iter().map(|s| s.to_string()).collect(),
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 1000,
                output_tokens: 500,
                total_tokens: 1500,
            },
            duration_seconds: 60,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: None,
            workspace_path: format!("/tmp/{}", identifier),
        }
    }

    async fn write_test_records(path: &std::path::Path) {
        let writer = HistoryWriter::new(path.to_path_buf());
        writer
            .append(&sample_record("MT-1", "succeeded", &["build", "review"]))
            .await
            .unwrap();
        writer
            .append(&sample_record("MT-2", "failed", &["build"]))
            .await
            .unwrap();
        writer
            .append(&sample_record("MT-3", "succeeded", &["build", "review"]))
            .await
            .unwrap();
        writer
            .append(&sample_record("MT-4", "failed", &["build", "review"]))
            .await
            .unwrap();
        writer
            .append(&sample_record("MT-5", "succeeded", &["build"]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn read_all() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_records(&path).await;

        let response = read_history(&path, &HistoryQuery::default()).await.unwrap();
        assert_eq!(response.total, 5);
        assert_eq!(response.records.len(), 5);
        assert!(response.next_cursor.is_none());
    }

    #[tokio::test]
    async fn filter_by_outcome() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_records(&path).await;

        let query = HistoryQuery {
            outcome: Some("succeeded".into()),
            ..Default::default()
        };
        let response = read_history(&path, &query).await.unwrap();
        assert_eq!(response.total, 3);
        assert!(response.records.iter().all(|r| r.outcome == "succeeded"));
    }

    #[tokio::test]
    async fn filter_by_step() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_records(&path).await;

        let query = HistoryQuery {
            step: Some("review".into()),
            ..Default::default()
        };
        let response = read_history(&path, &query).await.unwrap();
        assert_eq!(response.total, 3);
        assert!(response
            .records
            .iter()
            .all(|r| r.steps_traversed.contains(&"review".to_string())));
    }

    #[tokio::test]
    async fn pagination() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        std::fs::remove_file(&path).ok();
        write_test_records(&path).await;

        let query = HistoryQuery {
            limit: Some(2),
            ..Default::default()
        };
        let response = read_history(&path, &query).await.unwrap();
        assert_eq!(response.total, 5);
        assert_eq!(response.records.len(), 2);
        assert_eq!(response.next_cursor, Some(2));

        // Fetch next page
        let query2 = HistoryQuery {
            cursor: Some(2),
            limit: Some(2),
            ..Default::default()
        };
        let response2 = read_history(&path, &query2).await.unwrap();
        assert_eq!(response2.records.len(), 2);
        assert_eq!(response2.next_cursor, Some(4));

        // Last page
        let query3 = HistoryQuery {
            cursor: Some(4),
            limit: Some(2),
            ..Default::default()
        };
        let response3 = read_history(&path, &query3).await.unwrap();
        assert_eq!(response3.records.len(), 1);
        assert!(response3.next_cursor.is_none());
    }

    #[tokio::test]
    async fn missing_file_returns_empty() {
        let path = std::path::PathBuf::from("/tmp/nonexistent_history_file.jsonl");
        let response = read_history(&path, &HistoryQuery::default()).await.unwrap();
        assert_eq!(response.total, 0);
        assert!(response.records.is_empty());
        assert!(response.next_cursor.is_none());
    }
}

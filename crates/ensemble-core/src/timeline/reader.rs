use std::path::Path;

use serde::{Deserialize, Serialize};

use super::model::TimelineEventRecord;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct TimelineQuery {
    pub run_id: String,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct TimelineResponse {
    pub events: Vec<TimelineEventRecord>,
    pub total: usize,
    pub next_cursor: Option<usize>,
}

pub async fn read_timeline(
    path: &Path,
    query: &TimelineQuery,
) -> Result<TimelineResponse, std::io::Error> {
    let contents = match tokio::fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TimelineResponse {
                events: vec![],
                total: 0,
                next_cursor: None,
            });
        }
        Err(error) => return Err(error),
    };

    let mut events: Vec<TimelineEventRecord> = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<TimelineEventRecord>(line).ok())
        .filter(|event| event.run_id == query.run_id)
        .collect();
    events.sort_by_key(|event| event.sequence);

    let total = events.len();
    let cursor = query.cursor.unwrap_or(0);
    let limit = query.limit.unwrap_or(50).min(200);
    let page: Vec<TimelineEventRecord> = events.into_iter().skip(cursor).take(limit).collect();
    let next_cursor = if cursor + page.len() < total {
        Some(cursor + page.len())
    } else {
        None
    };

    Ok(TimelineResponse {
        events: page,
        total,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use tempfile::NamedTempFile;

    fn sample_event(run_id: &str, sequence: u64) -> TimelineEventRecord {
        TimelineEventRecord {
            run_id: run_id.to_string(),
            issue_identifier: "repo#1".to_string(),
            sequence,
            timestamp: Utc::now(),
            event_type: "step_started".to_string(),
            step_name: Some("build".to_string()),
            attempt: 1,
            detail: "started build".to_string(),
            verdict: None,
            tool_name: None,
        }
    }

    async fn write_events(path: &Path, events: &[TimelineEventRecord]) {
        let mut body = String::new();
        for event in events {
            body.push_str(&serde_json::to_string(event).unwrap());
            body.push('\n');
        }
        tokio::fs::write(path, body).await.unwrap();
    }

    #[tokio::test]
    async fn read_timeline_returns_paginated_events_in_sequence_order() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        write_events(
            &path,
            &[sample_event("run-1", 2), sample_event("run-1", 1)],
        )
        .await;

        let response = read_timeline(
            &path,
            &TimelineQuery {
                run_id: "run-1".to_string(),
                cursor: Some(0),
                limit: Some(1),
            },
        )
        .await
        .unwrap();

        assert_eq!(response.events.len(), 1);
        assert_eq!(response.events[0].sequence, 1);
        assert_eq!(response.next_cursor, Some(1));
    }

    #[tokio::test]
    async fn read_timeline_skips_malformed_lines() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        let valid = serde_json::to_string(&sample_event("run-1", 1)).unwrap();
        tokio::fs::write(&path, format!("{{bad\n{}\n", valid))
            .await
            .unwrap();

        let response = read_timeline(
            &path,
            &TimelineQuery {
                run_id: "run-1".to_string(),
                cursor: Some(0),
                limit: Some(50),
            },
        )
        .await
        .unwrap();

        assert_eq!(response.events.len(), 1);
        assert_eq!(response.events[0].sequence, 1);
    }
}

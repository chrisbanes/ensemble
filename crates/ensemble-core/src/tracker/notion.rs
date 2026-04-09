use super::{IssueTracker, TrackerError};
use crate::config::ensemble::TrackerConfig;
use crate::tracker::model::Issue;
use async_trait::async_trait;

/// Notion issue tracker adapter.
pub struct NotionTracker {
    _token: String,
    _database_id: String,
    _status_property: String,
    _title_property: String,
    _enabled_property: String,
    _enabled_value_bool: bool,
    _notion_version: String,
}

impl NotionTracker {
    pub fn new(token: String, database_id: String, config: &TrackerConfig) -> Self {
        Self {
            _token: token,
            _database_id: database_id,
            _status_property: config.status_property.clone(),
            _title_property: config.title_property.clone(),
            _enabled_property: config.enabled_property.clone(),
            _enabled_value_bool: config.enabled_value_bool,
            _notion_version: config.notion_version.clone(),
        }
    }
}

#[async_trait]
impl IssueTracker for NotionTracker {
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        Ok(vec![])
    }

    async fn fetch_issues_by_states(&self, _states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        Ok(vec![])
    }

    async fn fetch_issue_states_by_ids(&self, _ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        Ok(vec![])
    }

    fn supports_writes(&self) -> bool {
        true
    }
}

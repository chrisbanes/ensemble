use chrono::Utc;
use std::path::{Path, PathBuf};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::config::location::interactions_state_dir;
use crate::interaction::error::InteractionError;
use crate::interaction::model::{
    InteractionKind, InteractionRequest, InteractionResponse, InteractionStatus,
};

#[derive(Debug, Clone)]
pub struct InteractionStore {
    config_dir: PathBuf,
    create_mutex: std::sync::Arc<Mutex<()>>,
}

impl InteractionStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            create_mutex: std::sync::Arc::new(Mutex::new(())),
        }
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    pub fn interactions_dir(&self) -> PathBuf {
        interactions_state_dir(&self.config_dir)
    }

    pub async fn create(
        &self,
        interaction: InteractionRequest,
    ) -> Result<InteractionRequest, InteractionError> {
        let _guard = self.create_mutex.lock().await;

        if interaction.blocking
            && interaction.status == InteractionStatus::Open
            && self
                .current_open_blocking_for_issue(&interaction.issue_id)
                .await?
                .is_some_and(|existing| existing.id != interaction.id)
        {
            return Err(InteractionError::OpenBlockingInteractionExists {
                issue_id: interaction.issue_id.clone(),
            });
        }

        self.write_new_interaction(&interaction).await?;
        Ok(interaction)
    }

    pub async fn get(&self, id: &str) -> Result<Option<InteractionRequest>, InteractionError> {
        let path = self.path_for_id(id);
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn list_open(&self) -> Result<Vec<InteractionRequest>, InteractionError> {
        let mut interactions = self.list_all().await?;
        interactions.retain(|interaction| interaction.status == InteractionStatus::Open);
        interactions.sort_by(|left, right| left.requested_at.cmp(&right.requested_at));
        Ok(interactions)
    }

    pub async fn latest_blocking_for_issue(
        &self,
        issue_id: &str,
    ) -> Result<Option<InteractionRequest>, InteractionError> {
        let mut interactions = self.list_all().await?;
        interactions.retain(|interaction| {
            interaction.blocking && interaction.awaiting_resume && interaction.issue_id == issue_id
        });
        interactions.sort_by(|left, right| left.requested_at.cmp(&right.requested_at));
        Ok(interactions.pop())
    }

    pub async fn list_awaiting_resume(&self) -> Result<Vec<InteractionRequest>, InteractionError> {
        let mut interactions = self.list_all().await?;
        interactions.retain(|interaction| interaction.blocking && interaction.awaiting_resume);
        interactions.sort_by(|left, right| left.requested_at.cmp(&right.requested_at));
        Ok(interactions)
    }

    pub async fn resolve(
        &self,
        id: &str,
        response: InteractionResponse,
    ) -> Result<InteractionRequest, InteractionError> {
        let mut interaction = self
            .get(id)
            .await?
            .ok_or_else(|| InteractionError::NotFound { id: id.to_string() })?;

        match interaction.status {
            InteractionStatus::Resolved => {
                return Err(InteractionError::AlreadyResolved { id: id.to_string() });
            }
            InteractionStatus::Cancelled => {
                return Err(InteractionError::AlreadyCancelled { id: id.to_string() });
            }
            InteractionStatus::Open => {}
        }

        validate_response_kind(&interaction.kind, &response)?;

        interaction.status = InteractionStatus::Resolved;
        interaction.awaiting_resume = true;
        interaction.response = Some(response);
        interaction.resolved_at = Some(Utc::now());
        self.write_interaction(&interaction).await?;
        Ok(interaction)
    }

    pub async fn cancel(&self, id: &str) -> Result<InteractionRequest, InteractionError> {
        let mut interaction = self
            .get(id)
            .await?
            .ok_or_else(|| InteractionError::NotFound { id: id.to_string() })?;

        match interaction.status {
            InteractionStatus::Resolved => {
                return Err(InteractionError::AlreadyResolved { id: id.to_string() });
            }
            InteractionStatus::Cancelled => {
                return Err(InteractionError::AlreadyCancelled { id: id.to_string() });
            }
            InteractionStatus::Open => {}
        }

        interaction.status = InteractionStatus::Cancelled;
        interaction.awaiting_resume = false;
        interaction.resolved_at = Some(Utc::now());
        self.write_interaction(&interaction).await?;
        Ok(interaction)
    }

    pub async fn mark_resumed(&self, id: &str) -> Result<InteractionRequest, InteractionError> {
        let mut interaction = self
            .get(id)
            .await?
            .ok_or_else(|| InteractionError::NotFound { id: id.to_string() })?;

        interaction.awaiting_resume = false;
        self.write_interaction(&interaction).await?;
        Ok(interaction)
    }

    pub async fn clear_waiting_state(
        &self,
        id: &str,
    ) -> Result<InteractionRequest, InteractionError> {
        let interaction = self
            .get(id)
            .await?
            .ok_or_else(|| InteractionError::NotFound { id: id.to_string() })?;

        match interaction.status {
            InteractionStatus::Open => self.cancel(id).await,
            InteractionStatus::Resolved | InteractionStatus::Cancelled => {
                self.mark_resumed(id).await
            }
        }
    }

    async fn list_all(&self) -> Result<Vec<InteractionRequest>, InteractionError> {
        let dir = self.interactions_dir();
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };

        let mut interactions = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }

            let bytes = tokio::fs::read(path).await?;
            interactions.push(serde_json::from_slice(&bytes)?);
        }

        Ok(interactions)
    }

    fn path_for_id(&self, id: &str) -> PathBuf {
        self.interactions_dir().join(format!("{id}.json"))
    }

    async fn current_open_blocking_for_issue(
        &self,
        issue_id: &str,
    ) -> Result<Option<InteractionRequest>, InteractionError> {
        let existing = self.list_open().await?;
        Ok(existing
            .into_iter()
            .find(|candidate| candidate.blocking && candidate.issue_id == issue_id))
    }

    async fn write_interaction(
        &self,
        interaction: &InteractionRequest,
    ) -> Result<(), InteractionError> {
        let dir = self.interactions_dir();
        tokio::fs::create_dir_all(&dir).await?;
        let path = self.path_for_id(&interaction.id);
        let temp_path = unique_temp_path(&dir, &interaction.id);
        let bytes = serde_json::to_vec_pretty(interaction)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&temp_path, &path).await?;
        Ok(())
    }

    async fn write_new_interaction(
        &self,
        interaction: &InteractionRequest,
    ) -> Result<(), InteractionError> {
        let dir = self.interactions_dir();
        tokio::fs::create_dir_all(&dir).await?;

        let final_path = self.path_for_id(&interaction.id);
        let temp_path = unique_temp_path(&dir, &interaction.id);
        let bytes = serde_json::to_vec_pretty(interaction)?;

        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        drop(file);

        match tokio::fs::hard_link(&temp_path, &final_path).await {
            Ok(()) => {
                tokio::fs::remove_file(&temp_path).await?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                tokio::fs::remove_file(&temp_path).await?;
                Err(InteractionError::ConcurrentModification {
                    id: interaction.id.clone(),
                })
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                Err(error.into())
            }
        }
    }
}

fn validate_response_kind(
    kind: &InteractionKind,
    response: &InteractionResponse,
) -> Result<(), InteractionError> {
    let valid = matches!(
        (kind, response),
        (
            InteractionKind::Question,
            InteractionResponse::Question { .. }
        ) | (
            InteractionKind::Approval,
            InteractionResponse::Approval { .. }
        ) | (
            InteractionKind::Handoff,
            InteractionResponse::Handoff { .. }
        )
    );

    if valid {
        Ok(())
    } else {
        Err(InteractionError::InvalidResponse {
            expected: interaction_kind_name(kind).to_string(),
            actual: response_kind_name(response).to_string(),
        })
    }
}

fn interaction_kind_name(kind: &InteractionKind) -> &'static str {
    match kind {
        InteractionKind::Question => "question",
        InteractionKind::Approval => "approval",
        InteractionKind::Handoff => "handoff",
    }
}

fn response_kind_name(response: &InteractionResponse) -> &'static str {
    match response {
        InteractionResponse::Question { .. } => "question",
        InteractionResponse::Approval { .. } => "approval",
        InteractionResponse::Handoff { .. } => "handoff",
    }
}

fn unique_temp_path(dir: &Path, id: &str) -> PathBuf {
    let unique = format!(
        "{}.{}.{}.tmp",
        id,
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    dir.join(unique)
}

#[cfg(test)]
mod tests {
    use super::InteractionStore;
    use crate::interaction::error::InteractionError;
    use crate::interaction::model::{
        InteractionKind, InteractionRequest, InteractionResponse, InteractionStatus,
    };
    use chrono::Utc;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::Barrier;

    fn sample_question(id: &str, issue_id: &str, issue_identifier: &str) -> InteractionRequest {
        InteractionRequest {
            id: id.to_string(),
            schema_version: 1,
            issue_id: issue_id.to_string(),
            issue_identifier: issue_identifier.to_string(),
            pipeline_cycle: 1,
            completed_steps: vec![],
            step_name: "review".to_string(),
            agent_name: "reviewer".to_string(),
            step_depends: vec![],
            step_tracker_state: None,
            kind: InteractionKind::Question,
            status: InteractionStatus::Open,
            blocking: true,
            awaiting_resume: true,
            title: "Need clarification".to_string(),
            body: "Pick the target environment".to_string(),
            options: vec!["staging".to_string(), "production".to_string()],
            artifacts: vec!["docs/spec.md".to_string()],
            response: None,
            requested_at: Utc::now(),
            resolved_at: None,
        }
    }

    #[tokio::test]
    async fn saves_and_loads_interaction_request() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());
        let interaction = sample_question("int_123", "issue-1", "ACME-1");

        store.create(interaction.clone()).await.unwrap();

        let saved_path = dir
            .path()
            .join("state")
            .join("interactions")
            .join("int_123.json");
        assert!(saved_path.exists());

        let loaded = store.get("int_123").await.unwrap().unwrap();
        assert_eq!(loaded.id, interaction.id);
        assert_eq!(loaded.issue_id, interaction.issue_id);
        assert_eq!(loaded.status, InteractionStatus::Open);
    }

    #[tokio::test]
    async fn lists_only_open_interactions() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());

        store
            .create(sample_question("int_open", "issue-1", "ACME-1"))
            .await
            .unwrap();

        let resolved = store
            .resolve(
                "int_open",
                InteractionResponse::Question {
                    response_schema_version: 1,
                    text: "Use staging".to_string(),
                    selected_option: Some("staging".to_string()),
                },
            )
            .await
            .unwrap();
        assert_eq!(resolved.status, InteractionStatus::Resolved);

        let second = sample_question("int_open_2", "issue-2", "ACME-2");
        store.create(second.clone()).await.unwrap();

        let open = store.list_open().await.unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, second.id);
    }

    #[tokio::test]
    async fn rejects_invalid_response_for_kind() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());

        store
            .create(sample_question("int_invalid", "issue-1", "ACME-1"))
            .await
            .unwrap();

        let err = store
            .resolve(
                "int_invalid",
                InteractionResponse::Approval {
                    response_schema_version: 1,
                    approved: true,
                    reason: None,
                },
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("invalid"));
    }

    #[tokio::test]
    async fn cancels_existing_interaction() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());

        store
            .create(sample_question("int_cancel", "issue-1", "ACME-1"))
            .await
            .unwrap();

        let cancelled = store.cancel("int_cancel").await.unwrap();
        assert_eq!(cancelled.status, InteractionStatus::Cancelled);
        assert!(cancelled.resolved_at.is_some());

        let loaded = store.get("int_cancel").await.unwrap().unwrap();
        assert_eq!(loaded.status, InteractionStatus::Cancelled);
    }

    #[tokio::test]
    async fn rejects_second_open_blocking_interaction_for_same_issue() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());

        store
            .create(sample_question("int_one", "issue-1", "ACME-1"))
            .await
            .unwrap();

        let err = store
            .create(sample_question("int_two", "issue-1", "ACME-1"))
            .await
            .unwrap_err();

        assert!(err.to_string().contains("open blocking interaction"));
    }

    #[tokio::test]
    async fn create_rejects_second_open_blocking_interaction_for_same_issue_under_concurrency() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());
        let barrier = Arc::new(Barrier::new(2));
        let first_store = store.clone();
        let second_store = store.clone();
        let first_barrier = Arc::clone(&barrier);
        let second_barrier = Arc::clone(&barrier);

        let first = tokio::spawn(async move {
            first_barrier.wait().await;
            first_store
                .create(sample_question("int_one", "issue-1", "ACME-1"))
                .await
        });

        let second = tokio::spawn(async move {
            second_barrier.wait().await;
            second_store
                .create(sample_question("int_two", "issue-1", "ACME-1"))
                .await
        });

        let first = first.await.unwrap();
        let second = second.await.unwrap();

        assert!(first.is_ok() ^ second.is_ok());

        let error = if let Err(err) = first {
            err
        } else {
            second.unwrap_err()
        };

        assert!(matches!(
            error,
            InteractionError::OpenBlockingInteractionExists { .. }
        ));
    }

    #[tokio::test]
    async fn atomic_write_replaces_file_without_leaving_temp_file() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());
        let interaction = sample_question("int_atomic", "issue-1", "ACME-1");
        let shared_temp_path = store.interactions_dir().join("int_atomic.json.tmp");

        store.write_interaction(&interaction).await.unwrap();

        assert!(!tokio::fs::try_exists(&shared_temp_path).await.unwrap());

        let mut updated = interaction.clone();
        updated.title = "Updated title".to_string();
        store.write_interaction(&updated).await.unwrap();

        let loaded = store.get("int_atomic").await.unwrap().unwrap();
        assert_eq!(loaded.title, "Updated title");
        assert!(!tokio::fs::try_exists(&shared_temp_path).await.unwrap());
    }

    #[tokio::test]
    async fn duplicate_interaction_id_is_rejected() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());

        store
            .create(sample_question("int_dup", "issue-1", "ACME-1"))
            .await
            .unwrap();

        let err = store
            .create(sample_question("int_dup", "issue-2", "ACME-2"))
            .await
            .unwrap_err();

        assert!(matches!(
            err,
            InteractionError::ConcurrentModification { .. }
        ));
    }

    #[tokio::test]
    async fn write_interaction_ignores_stale_shared_temp_name() {
        let dir = tempdir().unwrap();
        let store = InteractionStore::new(dir.path().to_path_buf());
        let interaction = sample_question("int_tmp", "issue-1", "ACME-1");
        let stale_path = store.interactions_dir().join("int_tmp.json.tmp");

        tokio::fs::create_dir_all(store.interactions_dir())
            .await
            .unwrap();
        tokio::fs::write(&stale_path, b"stale-temp-file")
            .await
            .unwrap();

        store.write_interaction(&interaction).await.unwrap();

        let loaded = store.get("int_tmp").await.unwrap().unwrap();
        assert_eq!(loaded.id, "int_tmp");
        assert!(tokio::fs::try_exists(&stale_path).await.unwrap());
    }
}

use crate::history_store::store::HistoryStore;

use super::{
    AttentionClose, AttentionError, AttentionHistoryResponse, AttentionIdentity, AttentionItem,
    AttentionLifecycleState, AttentionSupersede, AttentionUpsert,
};

/// Bounded, non-authoritative access to durable operator-attention records.
#[derive(Debug, Clone)]
pub struct AttentionReporter {
    store: HistoryStore,
}

impl AttentionReporter {
    pub fn new(store: HistoryStore) -> Self {
        Self { store }
    }

    pub async fn upsert_open(
        &self,
        observation: AttentionUpsert,
    ) -> Result<AttentionItem, AttentionError> {
        observation.validate()?;
        self.store
            .upsert_attention_open(observation)
            .await
            .map_err(Into::into)
    }

    pub async fn resolve(
        &self,
        request: AttentionClose,
    ) -> Result<Option<AttentionItem>, AttentionError> {
        request.validate()?;
        self.store
            .resolve_attention(request)
            .await
            .map_err(Into::into)
    }

    pub async fn supersede(
        &self,
        request: AttentionSupersede,
    ) -> Result<Option<AttentionItem>, AttentionError> {
        request.close.validate()?;
        request.superseding_identity.validate()?;
        self.store
            .supersede_attention(request)
            .await
            .map_err(Into::into)
    }

    pub async fn open_items(&self) -> Result<Vec<AttentionItem>, AttentionError> {
        self.store.read_open_attention().await.map_err(Into::into)
    }

    pub async fn items_for_subject(
        &self,
        subject_ref: &str,
    ) -> Result<Vec<AttentionItem>, AttentionError> {
        self.store
            .read_open_attention_for_subject(subject_ref)
            .await
            .map_err(Into::into)
    }

    pub async fn open_item(
        &self,
        identity: &AttentionIdentity,
    ) -> Result<Option<AttentionItem>, AttentionError> {
        self.store
            .read_open_attention_item(identity)
            .await
            .map_err(Into::into)
    }

    pub async fn history(
        &self,
        subject_ref: Option<String>,
        state: Option<AttentionLifecycleState>,
        cursor: Option<usize>,
        limit: Option<usize>,
    ) -> Result<AttentionHistoryResponse, AttentionError> {
        self.store
            .read_attention_history(subject_ref, state, cursor, limit)
            .await
            .map_err(Into::into)
    }
}

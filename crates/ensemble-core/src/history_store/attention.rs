use std::io;

use chrono::{DateTime, Utc};
use rusqlite::types::Value;
use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};

use crate::attention::{
    AttentionClose, AttentionHistoryResponse, AttentionIdentity, AttentionItem,
    AttentionLifecycleState, AttentionSupersede, AttentionUpsert,
};

use super::store::HistoryStore;

impl HistoryStore {
    pub async fn upsert_attention_open(
        &self,
        observation: AttentionUpsert,
    ) -> Result<AttentionItem, io::Error> {
        let path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = Connection::open(path).map_err(io::Error::other)?;
            super::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(io::Error::other)?;
            let current = select_item(&tx, &observation.identity)?;
            let unchanged = current.as_ref().is_some_and(|item| {
                item.state == AttentionLifecycleState::Open
                    && item.presentation == observation.presentation
                    && item.evidence == observation.evidence
            });
            if !unchanged {
                let now = Utc::now();
                tx.execute(
                    r#"
                    INSERT INTO attention_items (
                        producer_key, subject_ref, kind, summary, remedy, references_json,
                        fingerprint, state, opened_at, updated_at, closed_at, superseding_identity_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?8, NULL, NULL)
                    ON CONFLICT(producer_key, subject_ref, kind) DO UPDATE SET
                        summary = excluded.summary,
                        remedy = excluded.remedy,
                        references_json = excluded.references_json,
                        fingerprint = excluded.fingerprint,
                        state = 'open',
                        updated_at = excluded.updated_at,
                        closed_at = NULL,
                        superseding_identity_json = NULL
                    "#,
                    params![
                        observation.identity.producer_key,
                        observation.identity.subject_ref,
                        observation.identity.kind,
                        observation.presentation.summary,
                        observation.presentation.remedy,
                        serde_json::to_string(&observation.presentation.references)
                            .map_err(io::Error::other)?,
                        observation.evidence.fingerprint,
                        now.to_rfc3339(),
                    ],
                )
                .map_err(io::Error::other)?;
                insert_event(
                    &tx,
                    &observation.identity,
                    AttentionLifecycleState::Open,
                    &observation.evidence.fingerprint,
                    now,
                    None,
                )?;
            }
            let item = select_item(&tx, &observation.identity)?.ok_or_else(|| {
                io::Error::other("attention upsert did not retain its item")
            })?;
            tx.commit().map_err(io::Error::other)?;
            Ok(item)
        })
        .await
        .map_err(io::Error::other)?
    }

    pub async fn resolve_attention(
        &self,
        request: AttentionClose,
    ) -> Result<Option<AttentionItem>, io::Error> {
        self.close_attention(request, None).await
    }

    pub async fn supersede_attention(
        &self,
        request: AttentionSupersede,
    ) -> Result<Option<AttentionItem>, io::Error> {
        self.close_attention(request.close, Some(request.superseding_identity))
            .await
    }

    async fn close_attention(
        &self,
        request: AttentionClose,
        superseding_identity: Option<AttentionIdentity>,
    ) -> Result<Option<AttentionItem>, io::Error> {
        let path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = Connection::open(path).map_err(io::Error::other)?;
            super::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(io::Error::other)?;
            let Some(current) = select_item(&tx, &request.identity)? else {
                return Ok(None);
            };
            if current.state != AttentionLifecycleState::Open
                || current.evidence.fingerprint != request.expected_fingerprint
            {
                return Ok(None);
            }
            let now = Utc::now();
            let state = if superseding_identity.is_some() {
                AttentionLifecycleState::Superseded
            } else {
                AttentionLifecycleState::Resolved
            };
            let superseding_identity_json = superseding_identity
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(io::Error::other)?;
            tx.execute(
                "UPDATE attention_items SET fingerprint = ?1, state = ?2, updated_at = ?3, closed_at = ?3, superseding_identity_json = ?4 WHERE producer_key = ?5 AND subject_ref = ?6 AND kind = ?7",
                params![
                    request.closing_evidence.fingerprint,
                    state.as_str(),
                    now.to_rfc3339(),
                    superseding_identity_json,
                    request.identity.producer_key,
                    request.identity.subject_ref,
                    request.identity.kind,
                ],
            )
            .map_err(io::Error::other)?;
            insert_event(
                &tx,
                &request.identity,
                state,
                &request.closing_evidence.fingerprint,
                now,
                superseding_identity.as_ref(),
            )?;
            let item = select_item(&tx, &request.identity)?;
            tx.commit().map_err(io::Error::other)?;
            Ok(item)
        })
        .await
        .map_err(io::Error::other)?
    }

    pub async fn read_open_attention(&self) -> Result<Vec<AttentionItem>, io::Error> {
        self.list_open_attention(None).await
    }

    pub async fn read_open_attention_for_subject(
        &self,
        subject_ref: &str,
    ) -> Result<Vec<AttentionItem>, io::Error> {
        self.list_open_attention(Some(subject_ref.to_string()))
            .await
    }

    pub async fn read_open_attention_item(
        &self,
        identity: &AttentionIdentity,
    ) -> Result<Option<AttentionItem>, io::Error> {
        let path = self.db_path.clone();
        let identity = identity.clone();
        tokio::task::spawn_blocking(move || {
            let conn = Connection::open(path).map_err(io::Error::other)?;
            super::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            conn.query_row(
                "SELECT * FROM attention_items WHERE producer_key = ?1 AND subject_ref = ?2 AND kind = ?3 AND state = 'open'",
                params![identity.producer_key, identity.subject_ref, identity.kind],
                super::model::row_to_attention_item,
            )
            .optional()
            .map_err(io::Error::other)
        })
        .await
        .map_err(io::Error::other)?
    }

    async fn list_open_attention(
        &self,
        subject_ref: Option<String>,
    ) -> Result<Vec<AttentionItem>, io::Error> {
        let path = self.db_path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = Connection::open(path).map_err(io::Error::other)?;
            super::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let sql = if subject_ref.is_some() {
                "SELECT * FROM attention_items WHERE state = 'open' AND subject_ref = ?1 ORDER BY updated_at DESC, producer_key, kind"
            } else {
                "SELECT * FROM attention_items WHERE state = 'open' ORDER BY updated_at DESC, producer_key, subject_ref, kind"
            };
            let mut statement = conn.prepare(sql).map_err(io::Error::other)?;
            let rows = match subject_ref {
                Some(subject_ref) => statement.query_map(params![subject_ref], super::model::row_to_attention_item),
                None => statement.query_map([], super::model::row_to_attention_item),
            }
            .map_err(io::Error::other)?;
            rows.map(|row| row.map_err(io::Error::other)).collect()
        })
        .await
        .map_err(io::Error::other)?
    }

    pub async fn read_attention_history(
        &self,
        subject_ref: Option<String>,
        state: Option<AttentionLifecycleState>,
        cursor: Option<usize>,
        limit: Option<usize>,
    ) -> Result<AttentionHistoryResponse, io::Error> {
        let path = self.db_path.clone();
        let include_terminal = state.is_some();
        let cursor = cursor.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200);
        tokio::task::spawn_blocking(move || {
            let conn = Connection::open(path).map_err(io::Error::other)?;
            super::schema::apply_pragmas(&conn).map_err(io::Error::other)?;
            let mut clauses = Vec::new();
            let mut values = Vec::new();
            if let Some(subject_ref) = subject_ref {
                clauses.push("attention_events.subject_ref = ?");
                values.push(Value::from(subject_ref));
            }
            let from = if include_terminal {
                if let Some(state) = state {
                    clauses.push("attention_events.state = ?");
                    values.push(Value::from(state.as_str().to_string()));
                }
                "attention_events"
            } else {
                clauses.push("attention_items.state = 'open'");
                "attention_events INNER JOIN attention_items USING (producer_key, subject_ref, kind)"
            };
            let where_sql = if clauses.is_empty() { String::new() } else { format!(" WHERE {}", clauses.join(" AND ")) };
            let total: usize = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {from}{where_sql}"),
                    params_from_iter(values.clone()),
                    |row| row.get(0),
                )
                .map_err(io::Error::other)?;
            let mut page_values = values;
            page_values.push(Value::from(i64::try_from(limit).map_err(io::Error::other)?));
            page_values.push(Value::from(i64::try_from(cursor).map_err(io::Error::other)?));
            let mut statement = conn
                .prepare(&format!(
                    "SELECT attention_events.sequence, attention_events.producer_key, attention_events.subject_ref, attention_events.kind, attention_events.state, attention_events.fingerprint, attention_events.timestamp, attention_events.superseding_identity_json FROM {from}{where_sql} ORDER BY attention_events.sequence DESC LIMIT ? OFFSET ?"
                ))
                .map_err(io::Error::other)?;
            let events = statement
                .query_map(params_from_iter(page_values), super::model::row_to_attention_event)
                .map_err(io::Error::other)?
                .map(|row| row.map_err(io::Error::other))
                .collect::<Result<Vec<_>, _>>()?;
            let next_cursor = (cursor + events.len() < total).then_some(cursor + events.len());
            Ok(AttentionHistoryResponse { events, total, next_cursor })
        })
        .await
        .map_err(io::Error::other)?
    }
}

fn select_item(
    tx: &Transaction<'_>,
    identity: &AttentionIdentity,
) -> Result<Option<AttentionItem>, io::Error> {
    tx.query_row(
        "SELECT * FROM attention_items WHERE producer_key = ?1 AND subject_ref = ?2 AND kind = ?3",
        params![identity.producer_key, identity.subject_ref, identity.kind],
        super::model::row_to_attention_item,
    )
    .optional()
    .map_err(io::Error::other)
}

fn insert_event(
    tx: &Transaction<'_>,
    identity: &AttentionIdentity,
    state: AttentionLifecycleState,
    fingerprint: &str,
    timestamp: DateTime<Utc>,
    superseding_identity: Option<&AttentionIdentity>,
) -> Result<(), io::Error> {
    tx.execute(
        "INSERT INTO attention_events (producer_key, subject_ref, kind, state, fingerprint, timestamp, superseding_identity_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            identity.producer_key,
            identity.subject_ref,
            identity.kind,
            state.as_str(),
            fingerprint,
            timestamp.to_rfc3339(),
            superseding_identity.map(serde_json::to_string).transpose().map_err(io::Error::other)?,
        ],
    )
    .map_err(io::Error::other)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::attention::{
        AttentionClose, AttentionEvidence, AttentionIdentity, AttentionPresentation,
        AttentionReporter, AttentionUpsert,
    };

    use super::HistoryStore;

    fn observation(fingerprint: &str) -> AttentionUpsert {
        AttentionUpsert::new(
            AttentionIdentity::new("producer-a", "issue-514", "runtime.awaiting_input").unwrap(),
            AttentionPresentation::new(
                "Awaiting input",
                "Resolve the request",
                vec!["request-1".into()],
            )
            .unwrap(),
            AttentionEvidence::new(fingerprint).unwrap(),
        )
    }

    #[tokio::test]
    async fn history_retains_one_event_for_an_idempotent_observation() {
        let dir = tempfile::TempDir::new().unwrap();
        let reporter = AttentionReporter::new(
            HistoryStore::new(dir.path().join(".ensemble/history.db"))
                .await
                .unwrap(),
        );
        let observation = observation("open-v1");

        reporter.upsert_open(observation.clone()).await.unwrap();
        reporter.upsert_open(observation).await.unwrap();

        let history = reporter.history(None, None, None, None).await.unwrap();
        assert_eq!(history.events.len(), 1);
    }

    #[tokio::test]
    async fn stale_close_cannot_retire_newer_attention() {
        let dir = tempfile::TempDir::new().unwrap();
        let reporter = AttentionReporter::new(
            HistoryStore::new(dir.path().join(".ensemble/history.db"))
                .await
                .unwrap(),
        );
        reporter.upsert_open(observation("open-v1")).await.unwrap();
        reporter.upsert_open(observation("open-v2")).await.unwrap();

        let result = reporter
            .resolve(
                AttentionClose::new(
                    AttentionIdentity::new("producer-a", "issue-514", "runtime.awaiting_input")
                        .unwrap(),
                    "open-v1",
                    AttentionEvidence::new("closed-v1").unwrap(),
                )
                .unwrap(),
            )
            .await
            .unwrap();

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn resolved_attention_is_retained_in_filtered_history_but_absent_from_open_items() {
        let dir = tempfile::TempDir::new().unwrap();
        let reporter = AttentionReporter::new(
            HistoryStore::new(dir.path().join(".ensemble/history.db"))
                .await
                .unwrap(),
        );
        let observation = observation("open-v1");
        reporter.upsert_open(observation.clone()).await.unwrap();
        reporter
            .resolve(
                AttentionClose::new(
                    observation.identity.clone(),
                    "open-v1",
                    AttentionEvidence::new("resolved-v1").unwrap(),
                )
                .unwrap(),
            )
            .await
            .unwrap();

        let open = reporter.open_items().await.unwrap();
        let resolved = reporter
            .history(
                None,
                Some(crate::attention::AttentionLifecycleState::Resolved),
                None,
                None,
            )
            .await
            .unwrap();

        assert!(open.is_empty());
        assert_eq!(resolved.events.len(), 1);
        assert_eq!(resolved.events[0].evidence.fingerprint, "resolved-v1");
    }

    #[tokio::test]
    async fn history_defaults_to_open_events_until_terminal_state_is_requested() {
        let dir = tempfile::TempDir::new().unwrap();
        let reporter = AttentionReporter::new(
            HistoryStore::new(dir.path().join(".ensemble/history.db"))
                .await
                .unwrap(),
        );
        let observation = observation("open-v1");
        reporter.upsert_open(observation.clone()).await.unwrap();
        reporter
            .resolve(
                AttentionClose::new(
                    observation.identity,
                    "open-v1",
                    AttentionEvidence::new("resolved-v1").unwrap(),
                )
                .unwrap(),
            )
            .await
            .unwrap();

        assert!(reporter
            .history(None, None, None, None)
            .await
            .unwrap()
            .events
            .is_empty());
        assert_eq!(
            reporter
                .history(
                    None,
                    Some(crate::attention::AttentionLifecycleState::Resolved),
                    None,
                    None,
                )
                .await
                .unwrap()
                .events
                .len(),
            1,
        );
    }

    #[tokio::test]
    async fn tuple_identity_allows_distinct_producers_for_one_subject() {
        let dir = tempfile::TempDir::new().unwrap();
        let reporter = AttentionReporter::new(
            HistoryStore::new(dir.path().join(".ensemble/history.db"))
                .await
                .unwrap(),
        );
        reporter
            .upsert_open(observation("producer-a-v1"))
            .await
            .unwrap();
        let second = AttentionUpsert::new(
            AttentionIdentity::new("producer-b", "issue-514", "runtime.awaiting_input").unwrap(),
            AttentionPresentation::new(
                "Different producer",
                "Resolve it",
                vec!["request-2".into()],
            )
            .unwrap(),
            AttentionEvidence::new("producer-b-v1").unwrap(),
        );
        reporter.upsert_open(second).await.unwrap();

        let open = reporter.items_for_subject("issue-514").await.unwrap();

        assert_eq!(open.len(), 2);
    }

    #[tokio::test]
    async fn open_item_lookup_targets_an_identity() {
        let dir = tempfile::TempDir::new().unwrap();
        let reporter = AttentionReporter::new(
            HistoryStore::new(dir.path().join(".ensemble/history.db"))
                .await
                .unwrap(),
        );
        let observation = observation("open-v1");
        reporter.upsert_open(observation.clone()).await.unwrap();

        let item = reporter.open_item(&observation.identity).await.unwrap();

        assert_eq!(item.unwrap().identity, observation.identity);
    }
}

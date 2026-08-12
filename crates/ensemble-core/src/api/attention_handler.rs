use crate::api::handlers::{api_error, ApiError};
use crate::api::router::AppState;
use crate::api::security::ApiExposure;
use crate::attention::{AttentionHistoryResponse, AttentionLifecycleState};
use axum::extract::{Extension, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
pub struct AttentionHistoryQuery {
    pub subject_ref: Option<String>,
    pub state: Option<AttentionLifecycleState>,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
}

#[utoipa::path(
    get,
    path = "/api/v1/attention",
    operation_id = "getAttentionHistory",
    params(AttentionHistoryQuery),
    responses(
        (status = 200, description = "Operator-attention lifecycle history", body = AttentionHistoryResponse),
        (status = 404, description = "Unavailable for remotely exposed APIs", body = ApiError),
        (status = 503, description = "Attention history unavailable", body = ApiError)
    ),
    tag = "attention"
)]
pub async fn get_attention_history(
    State(state): State<AppState>,
    Extension(exposure): Extension<ApiExposure>,
    Query(query): Query<AttentionHistoryQuery>,
) -> impl IntoResponse {
    if exposure == ApiExposure::UnsafeRemote {
        return (
            StatusCode::NOT_FOUND,
            api_error("not_found", "API endpoint not found"),
        )
            .into_response();
    }

    let Some(store) = state.history_store.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            api_error(
                "attention_history_unavailable",
                "attention history store is unavailable",
            ),
        )
            .into_response();
    };

    match store
        .read_attention_history(query.subject_ref, query.state, query.cursor, query.limit)
        .await
    {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            api_error(
                "attention_history_unavailable",
                format!("failed to read attention history: {error}"),
            ),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use axum::extract::Extension;

    use crate::api::test_helpers::{app_state_with_document_state, parsed_document_state};
    use crate::attention::{
        AttentionEvidence, AttentionIdentity, AttentionPresentation, AttentionReporter,
        AttentionUpsert,
    };

    use super::*;

    fn observation() -> AttentionUpsert {
        AttentionUpsert::new(
            AttentionIdentity::new("producer-1", "issue-514", "runtime.awaiting_input").unwrap(),
            AttentionPresentation::new(
                "Awaiting input",
                "Resolve the request",
                vec!["request-1".into()],
            )
            .unwrap(),
            AttentionEvidence::new("open-v1").unwrap(),
        )
    }

    #[tokio::test]
    async fn trusted_local_history_returns_persisted_events_with_subject_filter() {
        let state = app_state_with_document_state(parsed_document_state());
        let reporter = AttentionReporter::new(state.history_store.clone().unwrap());
        reporter.upsert_open(observation()).await.unwrap();

        let response = get_attention_history(
            State(state),
            Extension(ApiExposure::TrustedLocal),
            Query(AttentionHistoryQuery {
                subject_ref: Some("issue-514".into()),
                state: None,
                cursor: None,
                limit: None,
            }),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["events"].as_array().unwrap().iter().any(|event| {
            event["identity"]["producer_key"] == "producer-1"
                && event["identity"]["subject_ref"] == "issue-514"
        }));
    }

    #[tokio::test]
    async fn unsafe_remote_history_route_is_hidden() {
        let response = get_attention_history(
            State(app_state_with_document_state(parsed_document_state())),
            Extension(ApiExposure::UnsafeRemote),
            Query(AttentionHistoryQuery::default()),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}

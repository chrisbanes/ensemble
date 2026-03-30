// API handlers — will be fleshed out in Task 4
use crate::api::router::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;

pub async fn get_state(State(_state): State<AppState>) -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}

pub async fn get_issue_detail(
    State(_state): State<AppState>,
    Path(_identifier): Path<String>,
) -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}

pub async fn post_refresh(State(_state): State<AppState>) -> impl IntoResponse {
    StatusCode::NOT_IMPLEMENTED
}

pub async fn method_not_allowed() -> impl IntoResponse {
    StatusCode::METHOD_NOT_ALLOWED
}

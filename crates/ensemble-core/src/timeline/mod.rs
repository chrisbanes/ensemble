pub mod model;
pub mod persistence;
pub mod writer;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
pub struct TimelineQuery {
    pub run_id: String,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct TimelineResponse {
    pub events: Vec<model::TimelineEventRecord>,
    pub total: usize,
    pub next_cursor: Option<usize>,
}

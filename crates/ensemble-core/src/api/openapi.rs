use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Ensemble API",
        version = "0.1.0",
        description = "Ensemble orchestrator REST API for inspecting and controlling agent runs."
    ),
    paths(
        crate::api::handlers::get_state,
        crate::api::handlers::get_issue_detail,
        crate::api::handlers::post_refresh,
        crate::api::history_handler::get_history,
        crate::api::config_handler::get_config,
        crate::api::config_edit_handler::validate_yaml,
        crate::api::config_edit_handler::save_yaml,
        crate::api::config_edit_handler::get_setup_defaults,
        crate::api::config_edit_handler::get_setup_agents,
        crate::api::config_edit_handler::validate_setup,
        crate::api::config_edit_handler::save_setup,
        crate::api::conversation::get_conversation,
        crate::api::conversation::get_conversation_message,
        crate::api::controls::post_stop,
        crate::api::controls::post_retry,
    ),
    components(schemas(
        // Snapshot types
        crate::observability::snapshot::RuntimeSnapshot,
        crate::observability::snapshot::SnapshotCounts,
        crate::observability::snapshot::RunningSessionRow,
        crate::observability::snapshot::TokenSnapshot,
        crate::observability::snapshot::RetryRow,
        crate::observability::snapshot::AgentTotalsSnapshot,
        crate::observability::snapshot::IssueDetailSnapshot,
        crate::observability::snapshot::WorkspaceInfo,
        crate::observability::snapshot::AttemptInfo,
        crate::observability::snapshot::RunningDetail,
        // Orchestrator types
        crate::orchestrator::state::RateLimitSnapshot,
        // Handler response types
        crate::api::handlers::RefreshResponse,
        crate::api::handlers::ApiError,
        crate::api::handlers::ApiErrorDetail,
        // Control types
        crate::api::controls::StopResponse,
        crate::api::controls::RetryResponse,
        // Config types
        crate::api::config_handler::ConfigResponse,
        crate::api::config_edit_handler::ConfigStateResponse,
        crate::api::config_edit_handler::ValidateYamlRequest,
        crate::api::config_edit_handler::SaveYamlRequest,
        crate::api::config_edit_handler::SetupDefaultsResponse,
        crate::api::config_edit_handler::SetupAgentsResponse,
        crate::api::config_edit_handler::DiscoveredAgentInfo,
        crate::api::config_edit_handler::ValidateSetupRequest,
        crate::api::config_edit_handler::ValidateSetupResponse,
        crate::api::config_edit_handler::SaveSetupRequest,
        crate::config::draft::ValidationIssue,
        crate::config::draft::ValidationIssueKind,
        crate::config::setup::SetupRequest,
        crate::config::setup::SetupTracker,
        crate::config::setup::SetupRepo,
        crate::config::setup::SetupAgent,
        crate::config::setup::SetupStep,
        crate::config::setup::SetupCheck,
        crate::config::ensemble::EnsembleConfig,
        crate::config::ensemble::TrackerConfig,
        crate::config::ensemble::AgentConfig,
        crate::config::ensemble::StepConfig,
        crate::config::ensemble::ConcurrencyConfig,
        crate::config::ensemble::PollingConfig,
        crate::config::ensemble::WorkspaceConfig,
        crate::config::ensemble::HooksConfig,
        crate::config::ensemble::AgentRuntimeConfig,
        // History types
        crate::history::model::HistoryRecord,
        crate::history::model::TokenTotals,
        crate::history::reader::HistoryResponse,
        // Conversation types
        crate::api::conversation::ConversationResponse,
        crate::api::conversation::ConversationMessage,
    )),
    tags(
        (name = "state", description = "Runtime state"),
        (name = "issues", description = "Issue details"),
        (name = "controls", description = "Agent control"),
        (name = "history", description = "Completion history"),
        (name = "config", description = "Configuration"),
        (name = "conversation", description = "Agent conversation logs"),
    )
)]
pub struct ApiDoc;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_openapi_spec_generates() {
        let spec = ApiDoc::openapi().to_pretty_json().unwrap();
        assert!(spec.contains("\"openapi\":"));
        assert!(spec.contains("Ensemble API"));
    }
}

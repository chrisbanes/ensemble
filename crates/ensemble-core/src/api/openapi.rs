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
        crate::api::timeline_handler::get_timeline,
        crate::api::config_handler::get_config,
        crate::api::config_edit_handler::validate_yaml,
        crate::api::config_edit_handler::save_yaml,
        crate::api::config_edit_handler::get_setup_defaults,
        crate::api::config_edit_handler::get_setup_agents,
        crate::api::config_edit_handler::validate_setup,
        crate::api::config_edit_handler::save_setup,
        crate::api::config_edit_handler::validate_guided_form,
        crate::api::config_edit_handler::save_guided_form,
        crate::api::conversation::get_conversation,
        crate::api::conversation::get_conversation_message,
        crate::api::interactions::list_open_interactions,
        crate::api::interactions::get_interaction_by_id,
        crate::api::interactions::respond_to_interaction,
        crate::api::interactions::cancel_interaction,
        crate::api::controls::post_stop,
        crate::api::controls::post_retry,
        crate::api::controls::post_finalize_approve,
        crate::api::controls::post_finalize_retry,
        crate::api::controls::post_resume,
        crate::api::fs_handler::list_directory,
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
        crate::observability::snapshot::FinalizeSnapshot,
        crate::observability::snapshot::RepoFinalizeSnapshot,
        crate::observability::snapshot::PendingInputSummary,
        // Orchestrator types
        crate::orchestrator::state::RateLimitSnapshot,
        crate::orchestrator::state::FinalizeStatus,
        crate::orchestrator::state::RepoFinalizeState,
        crate::orchestrator::state::IssueFinalizeState,
        // Handler response types
        crate::api::handlers::RefreshResponse,
        crate::api::handlers::ApiError,
        crate::api::handlers::ApiErrorDetail,
        // Control types
        crate::api::controls::StopResponse,
        crate::api::controls::RetryResponse,
        crate::api::controls::FinalizeApproveResponse,
        crate::api::controls::FinalizeRetryResponse,
        crate::api::controls::ResumeResponse,
        // Interaction types
        crate::api::interactions::InteractionResponseBody,
        crate::interaction::model::InteractionKind,
        crate::interaction::model::InteractionStatus,
        crate::interaction::model::InteractionResponse,
        crate::interaction::model::InteractionRequest,
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
        crate::api::config_edit_handler::ValidateGuidedFormRequest,
        crate::api::config_edit_handler::ValidateGuidedFormResponse,
        crate::api::config_edit_handler::SaveGuidedFormRequest,
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
        crate::config::ensemble::HumanInteractionConfig,
        crate::config::ensemble::HumanResumeMode,
        // Guided form types
        crate::config::form::GuidedConfigForm,
        crate::config::form::GuidedTrackerForm,
        crate::config::form::GuidedRepoForm,
        crate::config::form::GuidedAgentForm,
        crate::config::form::GuidedStepForm,
        crate::config::form::GuidedRuntimeForm,
        crate::config::form::GuidedConcurrencyForm,
        crate::config::form::GuidedPollingForm,
        crate::config::form::GuidedWorkspaceForm,
        crate::config::form::GuidedHooksForm,
        crate::config::form::GuidedAgentRuntimeForm,
        crate::config::form::GuidedTransitionForm,
        // History types
        crate::history::model::HistoryRecord,
        crate::history::model::TokenTotals,
        crate::history::reader::HistoryResponse,
        // Timeline types
        crate::timeline::model::TimelineEventRecord,
        crate::timeline::reader::TimelineResponse,
        // Conversation types
        crate::api::conversation::ConversationResponse,
        crate::api::conversation::ConversationMessage,
        // Filesystem types
        crate::api::fs_handler::ListResponse,
        crate::api::fs_handler::FsEntry,
    )),
    tags(
        (name = "state", description = "Runtime state"),
        (name = "issues", description = "Issue details"),
        (name = "controls", description = "Agent control"),
        (name = "interactions", description = "Human interaction requests"),
        (name = "history", description = "Completion history"),
        (name = "config", description = "Configuration"),
        (name = "conversation", description = "Agent conversation logs"),
        (name = "filesystem", description = "File browser"),
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
        assert!(spec.contains("HumanInteractionConfig"));
        assert!(spec.contains("HumanResumeMode"));
    }

    #[test]
    fn test_openapi_documents_save_guided_form_with_config_state_response() {
        let spec: serde_json::Value =
            serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();

        assert_eq!(
            spec["paths"]["/api/v1/config/form/save"]["post"]["responses"]["200"]["content"]
                ["application/json"]["schema"]["$ref"],
            "#/components/schemas/ConfigStateResponse"
        );
    }

    #[test]
    fn test_openapi_documents_runtime_restart_failures_for_save_endpoints() {
        let spec: serde_json::Value =
            serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();

        for path in [
            "/api/v1/config/yaml/save",
            "/api/v1/config/setup/save",
            "/api/v1/config/form/save",
        ] {
            assert!(
                spec["paths"][path]["post"]["responses"]["500"].is_object(),
                "expected 500 response to be documented for {path}"
            );
        }
    }
}

use ensemble_core::api::openapi::ApiDoc;
use utoipa::OpenApi;

#[test]
fn openapi_documents_step_conversation_routes() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();

    assert!(
        spec["paths"]["/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation"]["get"]
            .is_object()
    );
    assert!(spec["paths"]
        ["/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation/{sequence}"]["get"]
        .is_object());
    assert!(spec["paths"]["/api/v1/{identifier}/conversation"].is_null());
    assert!(spec["components"]["schemas"]["TranscriptResponse"].is_object());
    assert!(spec["components"]["schemas"]["TranscriptRecord"].is_object());
}

#[test]
fn openapi_documents_every_supported_ui_http_operation() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();

    let supported_operations = [
        ("/api/v1/state", "get"),
        ("/api/v1/refresh", "post"),
        ("/api/v1/history", "get"),
        ("/api/v1/interactions", "get"),
        ("/api/v1/interactions/{id}", "get"),
        ("/api/v1/interactions/{id}/respond", "post"),
        ("/api/v1/interactions/{id}/cancel", "post"),
        ("/api/v1/fs/list", "get"),
        ("/api/v1/config", "get"),
        ("/api/v1/config/yaml/validate", "post"),
        ("/api/v1/config/yaml/save", "post"),
        ("/api/v1/config/setup/defaults", "get"),
        ("/api/v1/config/setup/agents", "get"),
        ("/api/v1/config/setup/agents/stream", "get"),
        ("/api/v1/config/setup/validate", "post"),
        ("/api/v1/config/setup/save", "post"),
        ("/api/v1/config/form/validate", "post"),
        ("/api/v1/config/form/save", "post"),
        (
            "/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation",
            "get",
        ),
        (
            "/api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation/{sequence}",
            "get",
        ),
        ("/api/v1/{identifier}/timeline", "get"),
        ("/api/v1/{identifier}/stop", "post"),
        ("/api/v1/{identifier}/retry", "post"),
        ("/api/v1/{identifier}/step/{step_name}", "get"),
        ("/api/v1/{identifier}/finalize/approve", "post"),
        ("/api/v1/{identifier}/finalize/retry", "post"),
        ("/api/v1/issues/{identifier}/resume", "post"),
        ("/api/v1/{identifier}", "get"),
    ];

    for (path, method) in supported_operations {
        assert!(
            spec["paths"][path][method].is_object(),
            "OpenAPI must document {method_upper} {path}",
            method_upper = method.to_uppercase(),
        );
    }

    assert_eq!(
        spec["paths"]["/api/v1/config/setup/agents/stream"]["get"]["responses"]["200"]["content"]
            ["text/event-stream"]["schema"]["$ref"],
        "#/components/schemas/DiscoveredAgentInfo"
    );
}

#[test]
fn openapi_documents_finalize_operational_errors() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();

    for path in [
        "/api/v1/{identifier}/finalize/approve",
        "/api/v1/{identifier}/finalize/retry",
    ] {
        for status in ["500", "503"] {
            assert_eq!(
                spec["paths"][path]["post"]["responses"][status]["content"]["application/json"]
                    ["schema"]["$ref"],
                "#/components/schemas/ApiError",
                "OpenAPI must document {status} ApiError for POST {path}",
            );
        }
    }
}

#[test]
fn openapi_keeps_editor_step_dependencies_optional() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();

    for schema in ["GuidedStepForm", "SetupStep"] {
        assert!(
            !spec["components"]["schemas"][schema]["required"]
                .as_array()
                .is_some_and(
                    |required| required.contains(&serde_json::Value::String("depends".into()))
                ),
            "{schema}.depends must remain optional"
        );
    }
}

#[test]
fn openapi_documents_agent_state_worker_caps_as_integer_maps() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();

    for schema in ["AgentRuntimeConfig", "GuidedAgentRuntimeForm"] {
        let state_caps =
            &spec["components"]["schemas"][schema]["properties"]["max_concurrent_agents_by_state"];
        assert_eq!(state_caps["type"], "object", "{schema} must expose a map");
        assert_eq!(
            state_caps["additionalProperties"]["type"], "integer",
            "{schema} state limits must be integers"
        );
        assert_eq!(
            state_caps["additionalProperties"]["minimum"], 1,
            "{schema} state limits must be positive"
        );
        assert_eq!(
            state_caps["additionalProperties"]["maximum"],
            u32::MAX,
            "{schema} state limits must fit in u32"
        );
    }
}

#[test]
fn openapi_documents_versioned_acceptance_evidence() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();
    let result = &spec["components"]["schemas"]["AcceptanceResult"];

    assert_eq!(result["properties"]["version"]["type"], "integer");
    assert_eq!(
        result["properties"]["evidence"]["$ref"],
        "#/components/schemas/AcceptanceEvidence"
    );
    assert!(result["properties"].get("exit_code").is_none());
    assert!(result["properties"].get("stdout").is_none());
    assert!(result["properties"].get("stderr").is_none());

    let evidence = &spec["components"]["schemas"]["AcceptanceEvidence"];
    assert_eq!(evidence["oneOf"].as_array().map(Vec::len), Some(4));
    for variant in evidence["oneOf"].as_array().unwrap() {
        assert!(variant["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|field| field == "kind")));
    }
}

#[test]
fn openapi_documents_issue_detail_acceptance_attempts() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();
    let issue_detail = &spec["components"]["schemas"]["IssueDetailSnapshot"];

    assert_eq!(
        issue_detail["properties"]["acceptance_attempts"]["items"]["$ref"],
        "#/components/schemas/AcceptanceAttempt"
    );
    assert_eq!(
        spec["components"]["schemas"]["AcceptanceResult"]["properties"]["evidence"]["$ref"],
        "#/components/schemas/AcceptanceEvidence"
    );
    assert_eq!(
        spec["components"]["schemas"]["AcceptanceEvidence"]["oneOf"]
            .as_array()
            .map(Vec::len),
        Some(4)
    );
}

#[test]
fn openapi_documents_versioned_delivery_observations() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();
    let observation = &spec["components"]["schemas"]["DeliveryObservation"];

    assert_eq!(
        observation["properties"]["schema_version"]["type"],
        "integer"
    );
    assert_eq!(
        spec["components"]["schemas"]["RepoFinalizeSnapshot"]["properties"]["observation"]["oneOf"]
            [1]["$ref"],
        "#/components/schemas/DeliveryObservation"
    );
    for schema in [
        "PullRequestTerminalState",
        "Mergeability",
        "BaseFreshness",
        "ReviewDecision",
        "CheckSummary",
        "AutomaticMergeEvidence",
    ] {
        assert!(spec["components"]["schemas"].get(schema).is_some());
    }
}

#[test]
fn openapi_keeps_review_gate_evidence_on_issue_detail() {
    let spec: serde_json::Value =
        serde_json::from_str(&ApiDoc::openapi().to_pretty_json().unwrap()).unwrap();
    let schemas = &spec["components"]["schemas"];
    let issue_detail = &schemas["IssueDetailSnapshot"];

    assert_eq!(
        issue_detail["properties"]["acceptance_attempts"]["items"]["$ref"],
        "#/components/schemas/AcceptanceAttempt"
    );
    assert_eq!(
        issue_detail["properties"]["artifacts"]["oneOf"][1]["$ref"],
        "#/components/schemas/RunArtifacts"
    );
    assert_eq!(
        issue_detail["properties"]["capabilities"]["$ref"],
        "#/components/schemas/IssueActionCapabilities"
    );
    assert_eq!(
        issue_detail["properties"]["workflow_steps"]["items"]["$ref"],
        "#/components/schemas/WorkflowStepInfo"
    );
    assert_eq!(
        schemas["RunArtifacts"]["properties"]["artifact_snapshots"]["items"]["$ref"],
        "#/components/schemas/ArtifactSnapshot"
    );
    assert_eq!(
        schemas["RunArtifacts"]["properties"]["gate_evidence"]["additionalProperties"]["$ref"],
        "#/components/schemas/GateEvidence"
    );
    assert_eq!(
        schemas["GateEvidence"]["properties"]["human_resolution"]["oneOf"][1]["$ref"],
        "#/components/schemas/GateHumanResolution"
    );
    assert_eq!(
        schemas["RepoFinalizeSnapshot"]["properties"]["observation"]["oneOf"][1]["$ref"],
        "#/components/schemas/DeliveryObservation"
    );
}

#[test]
#[ignore = "writes generated OpenAPI output for frontend codegen"]
fn write_openapi_spec() {
    let spec = ApiDoc::openapi().to_pretty_json().unwrap();
    let out_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("ensemble-ui/src-ui/openapi.json");
    std::fs::write(&out_path, &spec).unwrap();
}

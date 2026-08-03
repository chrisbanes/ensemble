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
#[ignore = "writes generated OpenAPI output for frontend codegen"]
fn write_openapi_spec() {
    let spec = ApiDoc::openapi().to_pretty_json().unwrap();
    let out_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("ensemble-ui/src-ui/openapi.json");
    std::fs::write(&out_path, &spec).unwrap();
}

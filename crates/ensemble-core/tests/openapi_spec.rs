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
#[ignore = "writes generated OpenAPI output for frontend codegen"]
fn write_openapi_spec() {
    let spec = ApiDoc::openapi().to_pretty_json().unwrap();
    let out_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("ensemble-ui/src-ui/openapi.json");
    std::fs::write(&out_path, &spec).unwrap();
}

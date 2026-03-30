use ensemble_core::api::openapi::ApiDoc;
use utoipa::OpenApi;

#[test]
fn write_openapi_spec() {
    let spec = ApiDoc::openapi().to_pretty_json().unwrap();
    let out_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("ensemble-ui/src-ui/openapi.json");
    std::fs::write(&out_path, &spec).unwrap();
}

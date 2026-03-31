use std::path::Path;

#[test]
fn ui_source_directory_exists_relative_to_crate() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ui_dir = crate_dir.join("../ensemble-ui/src-ui");
    assert!(
        ui_dir.exists(),
        "UI source directory not found at {}. \
         build.rs expects it here to embed the SPA.",
        ui_dir.display()
    );
}

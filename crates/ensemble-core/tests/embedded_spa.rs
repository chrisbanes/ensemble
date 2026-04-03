use ensemble_core::ui::{normalize_spa_path, resolve_spa_asset};
use std::borrow::Cow;

#[test]
fn normalize_spa_path_maps_root_to_index() {
    assert_eq!(normalize_spa_path("/"), "index.html");
    assert_eq!(normalize_spa_path(""), "index.html");
}

#[test]
fn resolve_spa_asset_checks_html_and_directory_fallbacks() {
    let resolved = resolve_spa_asset("/settings", |path| match path {
        "settings.html" => Some(Cow::Borrowed(b"settings".as_slice())),
        _ => None,
    });

    assert_eq!(resolved.path, "settings.html");
    assert_eq!(resolved.content_type, "text/html");
    assert_eq!(resolved.bytes, b"settings");
}

#[test]
fn resolve_spa_asset_falls_back_to_root_index() {
    let resolved = resolve_spa_asset("/missing", |path| match path {
        "index.html" => Some(Cow::Borrowed(b"root-index".as_slice())),
        _ => None,
    });

    assert_eq!(resolved.path, "index.html");
    assert_eq!(resolved.bytes, b"root-index");
}

//! Embedded SPA UI serving for the desktop app.

use axum::{http::Uri, response::IntoResponse};
use ensemble_core::ui::{serve_spa_response, spa_available as core_spa_available};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/spa"]
struct SpaAssets;

/// Check if SPA is available
pub fn spa_available() -> bool {
    core_spa_available(|asset_path| SpaAssets::get(asset_path).map(|f| f.data))
}

/// Serve the SPA with fallback to index.html for client-side routing.
/// This is an axum-compatible handler that mirrors the CLI embedded_ui implementation.
pub async fn serve_spa(uri: Uri) -> impl IntoResponse {
    serve_spa_response(uri.path(), |asset_path| {
        SpaAssets::get(asset_path).map(|f| f.data)
    })
}

/// Router for serving embedded SPA
pub fn spa_router() -> axum::Router {
    axum::Router::new().fallback(serve_spa)
}

#[cfg(test)]
mod tests {
    use ensemble_core::ui::normalize_spa_path;

    #[test]
    fn test_normalize_path_strips_leading_slash() {
        assert_eq!(normalize_spa_path("/assets/app.js"), "assets/app.js");
    }

    #[test]
    fn test_normalize_path_strips_trailing_slash() {
        assert_eq!(normalize_spa_path("assets/"), "assets");
    }

    #[test]
    fn test_normalize_path_strips_both_slashes() {
        assert_eq!(normalize_spa_path("/assets/app.js/"), "assets/app.js");
    }

    #[test]
    fn test_normalize_path_empty_becomes_index() {
        assert_eq!(normalize_spa_path(""), "index.html");
    }

    #[test]
    fn test_normalize_path_root_slash_becomes_index() {
        assert_eq!(normalize_spa_path("/"), "index.html");
    }

    #[test]
    fn test_normalize_path_no_slashes_unchanged() {
        assert_eq!(normalize_spa_path("style.css"), "style.css");
    }

    #[test]
    fn test_normalize_path_nested_unchanged() {
        assert_eq!(normalize_spa_path("assets/js/app.js"), "assets/js/app.js");
    }
}

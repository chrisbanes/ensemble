use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/spa"]
struct SpaAssets;

/// Check if SPA is available
pub fn spa_available() -> bool {
    SpaAssets::get("index.html").is_some()
}

/// Normalize a request path for embedded asset lookup.
/// Strips leading/trailing slashes and treats empty paths as "index.html".
fn normalize_path(path: &str) -> &str {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    }
}

/// Serve the SPA with fallback to index.html for client-side routing.
/// This is an axum-compatible handler that mirrors the CLI embedded_ui implementation.
pub async fn serve_spa(uri: Uri) -> impl IntoResponse {
    let path = normalize_path(uri.path());

    // Try exact path first
    if let Some(file) = SpaAssets::get(path) {
        let content_type = mime_guess::from_path(path).first_or_octet_stream();
        return Response::builder()
            .header(header::CONTENT_TYPE, content_type.as_ref())
            .body(Body::from(file.data))
            .unwrap();
    }

    // Try with .html extension
    let html_path = format!("{}.html", path);
    if let Some(file) = SpaAssets::get(&html_path) {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(file.data))
            .unwrap();
    }

    // Try index.html in directory
    let dir_index = format!("{}/index.html", path);
    if let Some(file) = SpaAssets::get(&dir_index) {
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(file.data))
            .unwrap();
    }

    // Fallback to root index.html (SPA behavior)
    if let Some(file) = SpaAssets::get("index.html") {
        Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(file.data))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("index.html not found - UI may not be built"))
            .unwrap()
    }
}

/// Router for serving embedded SPA
pub fn spa_router() -> axum::Router {
    axum::Router::new().fallback(serve_spa)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_path_strips_leading_slash() {
        assert_eq!(normalize_path("/assets/app.js"), "assets/app.js");
    }

    #[test]
    fn test_normalize_path_strips_trailing_slash() {
        assert_eq!(normalize_path("assets/"), "assets");
    }

    #[test]
    fn test_normalize_path_strips_both_slashes() {
        assert_eq!(normalize_path("/assets/app.js/"), "assets/app.js");
    }

    #[test]
    fn test_normalize_path_empty_becomes_index() {
        assert_eq!(normalize_path(""), "index.html");
    }

    #[test]
    fn test_normalize_path_root_slash_becomes_index() {
        assert_eq!(normalize_path("/"), "index.html");
    }

    #[test]
    fn test_normalize_path_no_slashes_unchanged() {
        assert_eq!(normalize_path("style.css"), "style.css");
    }

    #[test]
    fn test_normalize_path_nested_unchanged() {
        assert_eq!(normalize_path("assets/js/app.js"), "assets/js/app.js");
    }
}

use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/spa"]
struct SpaAssets;

/// Serve an embedded file by path, returning 404 if not found
#[allow(dead_code)]
pub fn serve_file(path: &str) -> impl IntoResponse {
    match SpaAssets::get(path) {
        Some(file) => {
            let content_type = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, content_type.as_ref())
                .body(Body::from(file.data))
                .unwrap()
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not found"))
            .unwrap(),
    }
}

/// Serve the SPA with fallback to index.html for client-side routing
pub async fn serve_spa(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');

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

/// Check if the SPA is available (assets were embedded)
#[allow(dead_code)]
pub fn spa_available() -> bool {
    SpaAssets::get("index.html").is_some()
}

/// Router for serving embedded SPA
pub fn spa_router() -> axum::Router {
    axum::Router::new().fallback(serve_spa)
}

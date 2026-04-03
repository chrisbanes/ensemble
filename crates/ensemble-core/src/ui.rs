use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};

pub struct ResolvedSpaAsset {
    pub path: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub fn normalize_spa_path(path: &str) -> &str {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    }
}

pub fn resolve_spa_asset<F>(path: &str, mut get_asset: F) -> ResolvedSpaAsset
where
    F: FnMut(&str) -> Option<&'static [u8]>,
{
    let normalized = normalize_spa_path(path);

    for candidate in [
        normalized.to_string(),
        format!("{normalized}.html"),
        format!("{normalized}/index.html"),
        "index.html".to_string(),
    ] {
        if let Some(bytes) = get_asset(&candidate) {
            return ResolvedSpaAsset {
                content_type: content_type_for_path(&candidate).to_string(),
                path: candidate,
                bytes: bytes.to_vec(),
            };
        }
    }

    ResolvedSpaAsset {
        path: "index.html".to_string(),
        content_type: "text/plain; charset=utf-8".to_string(),
        bytes: b"index.html not found - UI may not be built".to_vec(),
    }
}

pub fn serve_file_response<F>(path: &str, mut get_asset: F) -> Response<Body>
where
    F: FnMut(&str) -> Option<&'static [u8]>,
{
    let normalized = normalize_spa_path(path);
    match get_asset(normalized) {
        Some(bytes) => build_response(StatusCode::OK, content_type_for_path(normalized), bytes),
        None => build_response(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            &b"Not found"[..],
        ),
    }
}

pub fn serve_spa_response<F>(path: &str, get_asset: F) -> Response<Body>
where
    F: FnMut(&str) -> Option<&'static [u8]>,
{
    let resolved = resolve_spa_asset(path, get_asset);
    let status = if resolved.path == "index.html"
        && resolved.bytes == b"index.html not found - UI may not be built"
    {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::OK
    };

    build_response(status, &resolved.content_type, resolved.bytes)
}

pub fn spa_available<F>(mut get_asset: F) -> bool
where
    F: FnMut(&str) -> Option<&'static [u8]>,
{
    get_asset("index.html").is_some()
}

fn content_type_for_path(path: &str) -> &str {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
}

fn build_response<T>(status: StatusCode, content_type: &str, body: T) -> Response<Body>
where
    T: Into<Body>,
{
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(body.into())
        .expect("static SPA response should be valid")
}

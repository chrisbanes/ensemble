use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/spa"]
struct SpaAssets;

/// Serve an embedded file by path
pub fn get_file(path: &str) -> Option<EmbeddedFile> {
    SpaAssets::get(path).map(|file| EmbeddedFile {
        data: file.data.to_vec(),
        content_type: mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    })
}

/// Get index.html for SPA fallback
pub fn get_index_html() -> Option<EmbeddedFile> {
    SpaAssets::get("index.html").map(|file| EmbeddedFile {
        data: file.data.to_vec(),
        content_type: "text/html".to_string(),
    })
}

/// Check if SPA is available
pub fn spa_available() -> bool {
    SpaAssets::get("index.html").is_some()
}

pub struct EmbeddedFile {
    pub data: Vec<u8>,
    pub content_type: String,
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

/// Resolve a path to an embedded file or fallback to index.html
pub fn resolve_path(path: &str) -> Option<EmbeddedFile> {
    let path = normalize_path(path);

    // Try exact path
    if let Some(file) = get_file(path) {
        return Some(file);
    }

    // Try with .html
    let html_path = format!("{}.html", path);
    if let Some(file) = get_file(&html_path) {
        return Some(file);
    }

    // Try directory index
    let dir_index = format!("{}/index.html", path);
    if let Some(file) = get_file(&dir_index) {
        return Some(file);
    }

    // Fallback to root index.html
    get_index_html()
}

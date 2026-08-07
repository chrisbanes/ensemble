pub mod coordinator;
pub mod finalize;
pub mod hooks;
pub mod key;
pub mod manager;
pub mod worktree;

use std::path::{Path, PathBuf};

pub(crate) fn canonicalize_allow_missing(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut missing = Vec::new();
    while !existing.exists() {
        let (Some(parent), Some(file_name)) = (existing.parent(), existing.file_name()) else {
            return path.to_path_buf();
        };
        missing.push(file_name.to_os_string());
        existing = parent;
    }

    let mut canonical = existing
        .canonicalize()
        .unwrap_or_else(|_| existing.to_path_buf());
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    canonical
}

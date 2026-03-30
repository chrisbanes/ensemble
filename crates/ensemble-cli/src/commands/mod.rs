pub mod init;
pub mod run;
pub mod web;

use std::path::PathBuf;

/// Common arguments shared between run and web commands
#[derive(Debug)]
pub struct CommonArgs {
    pub config_path: PathBuf,
}

use thiserror::Error;

/// Desktop-specific errors.
#[derive(Error, Debug)]
pub enum DesktopError {
    /// Failed to bind HTTP server to address.
    #[error("Failed to bind HTTP server on {addr}: {source}")]
    BindFailed {
        addr: String,
        #[source]
        source: std::io::Error,
    },

    /// Failed to parse server URL.
    #[error("Failed to parse server URL: {0}")]
    InvalidUrl(#[from] url::ParseError),

    /// Failed to load configuration.
    #[error("Failed to load config: {0}")]
    ConfigLoadFailed(String),

    /// I/O error.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

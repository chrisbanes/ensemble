use thiserror::Error;

#[derive(Debug, Error)]
pub enum AttentionError {
    #[error("invalid attention {field}: {reason}")]
    InvalidField { field: &'static str, reason: String },
    #[error("attention storage error: {reason}")]
    Storage { reason: String },
}

impl From<std::io::Error> for AttentionError {
    fn from(value: std::io::Error) -> Self {
        Self::Storage {
            reason: value.to_string(),
        }
    }
}

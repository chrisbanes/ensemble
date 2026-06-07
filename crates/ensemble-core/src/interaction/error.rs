use thiserror::Error;

#[derive(Debug, Error)]
pub enum InteractionError {
    #[error("interaction not found: {id}")]
    NotFound { id: String },
    #[error("interaction already resolved: {id}")]
    AlreadyResolved { id: String },
    #[error("interaction already cancelled: {id}")]
    AlreadyCancelled { id: String },
    #[error("invalid response for interaction kind: expected {expected}, got {actual}")]
    InvalidResponse { expected: String, actual: String },
    #[error("open blocking interaction already exists for issue {issue_id}")]
    OpenBlockingInteractionExists { issue_id: String },
    #[error("interaction already exists: {id}")]
    ConcurrentModification { id: String },
    #[error("interaction already accepted a command: {id}")]
    CommandAlreadyAccepted { id: String },
    #[error("interaction I/O error: {reason}")]
    Io { reason: String },
    #[error("interaction serialization error: {reason}")]
    Serialization { reason: String },
}

impl From<std::io::Error> for InteractionError {
    fn from(value: std::io::Error) -> Self {
        Self::Io {
            reason: value.to_string(),
        }
    }
}

impl From<serde_json::Error> for InteractionError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization {
            reason: value.to_string(),
        }
    }
}

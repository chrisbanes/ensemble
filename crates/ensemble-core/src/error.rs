use thiserror::Error;

#[derive(Debug, Error)]
pub enum EnsembleError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Tracker(#[from] crate::tracker::TrackerError),
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing workflow file: {path}")]
    MissingWorkflowFile { path: String },
    #[error("workflow parse error: {reason}")]
    WorkflowParseError { reason: String },
    #[error("front matter is not a map")]
    FrontMatterNotAMap,
    #[error("template parse error: {reason}")]
    TemplateParseError { reason: String },
    #[error("template render error: {reason}")]
    TemplateRenderError { reason: String },
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace creation failed: {reason}")]
    CreationFailed { reason: String },
    #[error("hook failed: {hook} — {reason}")]
    HookFailed { hook: String, reason: String },
    #[error("hook timed out: {hook} after {timeout_ms}ms")]
    HookTimedOut { hook: String, timeout_ms: u64 },
    #[error("workspace path outside root: {path}")]
    PathOutsideRoot { path: String },
}

use thiserror::Error;

#[derive(Debug, Error)]
pub enum EnsembleError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Tracker(#[from] crate::tracker::TrackerError),
    #[error(transparent)]
    Pipeline(#[from] PipelineError),
    #[error(transparent)]
    Agent(#[from] AgentError),
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing config file: {path}")]
    MissingConfigFile { path: String },
    #[error("config parse error: {reason}")]
    ConfigParseError { reason: String },
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

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent not found: {command}")]
    AgentNotFound { command: String },
    #[error("invalid workspace cwd: {path}")]
    InvalidWorkspaceCwd { path: String },
    #[error("response timeout after {timeout_ms}ms")]
    ResponseTimeout { timeout_ms: u64 },
    #[error("turn timeout after {timeout_ms}ms")]
    TurnTimeout { timeout_ms: u64 },
    #[error("agent exited unexpectedly: {reason}")]
    AgentExit { reason: String },
    #[error("response error: {reason}")]
    ResponseError { reason: String },
    #[error("turn failed: {reason}")]
    TurnFailed { reason: String },
    #[error("turn cancelled")]
    TurnCancelled,
    #[error("turn requires user input")]
    TurnInputRequired,
    #[error("session startup failed: {reason}")]
    SessionStartupFailed { reason: String },
    #[error("io error: {reason}")]
    IoError { reason: String },
    #[error("hook failed: {reason}")]
    HookFailed { reason: String },
    #[error("prompt error: {reason}")]
    PromptError { reason: String },
}

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error("unknown agent reference: {name}")]
    UnknownAgent { name: String },
    #[error("unknown step dependency: {step} depends on {dependency}")]
    UnknownDependency { step: String, dependency: String },
    #[error("cycle detected in step graph")]
    CycleDetected,
    #[error("no root steps found (all steps have dependencies)")]
    NoRootSteps,
    #[error("step {step} requires tracker writes but tracker does not support them")]
    WritesRequired { step: String },
    #[error("max cycles ({max}) exceeded for issue {issue_id}")]
    MaxCyclesExceeded { issue_id: String, max: u32 },
    #[error("agent must have exactly one of 'prompt' or 'prompt_template', got neither or both: {agent}")]
    InvalidPromptConfig { agent: String },
    #[error("duplicate step name: {name}")]
    DuplicateStepName { name: String },
    #[error("agent must have 'acpx_agent' or both 'executor' and 'model': {agent}")]
    InvalidAgentConfig { agent: String },
}

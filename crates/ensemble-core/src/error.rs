use thiserror::Error;

#[derive(Debug, Error)]
pub enum EnsembleError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
    #[error(transparent)]
    Tracker(#[from] crate::tracker::TrackerError),
    #[error(transparent)]
    Pipeline(#[from] PipelineError),
    #[error(transparent)]
    Agent(#[from] AgentError),
    #[error(transparent)]
    Interaction(#[from] crate::interaction::error::InteractionError),
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
    #[error("config directory unavailable")]
    ConfigDirUnavailable,
    #[error("home directory unavailable")]
    HomeDirUnavailable,
    #[error("relative path not allowed for desktop ENSEMBLE_CONFIG_DIR: {path}")]
    RelativeDesktopOverride { path: String },
    #[error("config directory path must be a directory, not a file: {path}")]
    NotADirectory { path: String },
    #[error("config read failed for '{path}': {reason}")]
    ConfigReadError { path: String, reason: String },
    #[error("path expansion failed for '{path}': {reason}")]
    PathExpansionError { path: String, reason: String },
    #[error("config write rejected: {reason}")]
    ConfigWriteRejected { reason: String },

    #[error("config write failed: {reason}")]
    ConfigWriteFailed { reason: String },

    #[error("pipeline cannot be empty: at least one step is required")]
    EmptyPipeline,
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
pub enum WorktreeError {
    #[error("worktree creation failed for repo {repo}: {reason}")]
    CreationFailed { repo: String, reason: String },
    #[error("worktree already exists at {path}")]
    AlreadyExists { path: String },
    #[error("worktree not found at {path}")]
    NotFound { path: String },
    #[error("git command failed: {command} — {reason}")]
    GitCommandFailed { command: String, reason: String },
    #[error("branch creation failed: {branch} — {reason}")]
    BranchCreationFailed { branch: String, reason: String },
    #[error("rollback failed during cleanup: {reason}")]
    RollbackFailed { reason: String },
    #[error("invalid repo path: {path}")]
    InvalidRepoPath { path: String },
    #[error("cleanup failed for {repo}: {error}")]
    CleanupFailed { repo: String, error: String },
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
    #[error("session startup failed: {reason}")]
    SessionStartupFailed { reason: String },
    #[error("io error: {reason}")]
    IoError { reason: String },
    #[error("invalid agent command '{command}': {reason}")]
    InvalidAgentCommand { command: String, reason: String },
    #[error("hook failed: {reason}")]
    HookFailed { reason: String },
    #[error("prompt error: {reason}")]
    PromptError { reason: String },
    #[error("acpx command failed: {command} — {reason}")]
    AcpxCommandFailed { command: String, reason: String },
    #[error("acpx final status missing: {context}")]
    AcpxFinalStatusMissing { context: String },
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
    #[error("invalid permission_mode for agent {agent}: {reason}")]
    InvalidPermissionMode { agent: String, reason: String },
    #[error("invalid runtime config for agent {agent}: {reason}")]
    InvalidRuntimeConfig { agent: String, reason: String },
    #[error("invalid synthesis step {step}: {reason}")]
    InvalidSynthesisStep { step: String, reason: String },
}

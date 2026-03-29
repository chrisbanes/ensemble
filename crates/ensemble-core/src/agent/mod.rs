pub mod acp_client;
pub mod events;

use std::path::Path;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::AgentError;
use crate::tracker::model::Issue;
use events::WorkerEvent;

/// Trait for running an agent session against an issue.
/// The orchestrator dispatches work through this trait.
/// Implementations must send WorkerEvents via the channel during execution.
#[async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        issue: &Issue,
        agent_name: &str,
        step_name: &str,
        attempt: Option<u32>,
        workspace_path: &Path,
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), AgentError>;
}

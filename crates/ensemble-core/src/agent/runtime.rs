use crate::config::ensemble::AgentConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Acpx,
    Direct,
}

impl RuntimeKind {
    pub fn for_agent(agent: &AgentConfig) -> Self {
        if agent.acpx_agent.is_some() {
            Self::Acpx
        } else {
            Self::Direct
        }
    }
}

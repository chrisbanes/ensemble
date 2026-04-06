use crate::config::ensemble::AgentConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Acpx,
    Direct,
}

impl RuntimeKind {
    pub fn for_agent(agent: &AgentConfig) -> Self {
        match agent.runtime.as_deref() {
            Some("direct") => Self::Direct,
            Some("acpx") => Self::Acpx,
            Some(_) | None if agent.acpx_agent.is_some() => Self::Acpx,
            _ => Self::Direct,
        }
    }
}

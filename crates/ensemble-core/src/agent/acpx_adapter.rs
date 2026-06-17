use std::path::PathBuf;

use super::ResolvedCommand;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpxAgentAdapter<'a> {
    Generic { name: &'a str },
    Opencode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpxAgentInvocation {
    BuiltIn(String),
    RawCommand(String),
}

impl AcpxAgentInvocation {
    pub fn built_in_agent(&self) -> Option<&str> {
        match self {
            Self::BuiltIn(agent) => Some(agent),
            Self::RawCommand(_) => None,
        }
    }

    pub fn raw_command(&self) -> Option<&str> {
        match self {
            Self::BuiltIn(_) => None,
            Self::RawCommand(command) => Some(command),
        }
    }
}

impl<'a> AcpxAgentAdapter<'a> {
    pub fn for_name(name: &'a str) -> Self {
        if name == "opencode" {
            Self::Opencode
        } else {
            Self::Generic { name }
        }
    }

    pub fn supports_startup_model(&self) -> bool {
        matches!(self, Self::Opencode)
    }

    pub fn invocation(&self, model: Option<&str>) -> AcpxAgentInvocation {
        match self {
            Self::Opencode => {
                if let Some(model) = model {
                    return AcpxAgentInvocation::RawCommand(format!(
                        "opencode --model {} acp",
                        shell_words::quote(model)
                    ));
                }

                AcpxAgentInvocation::BuiltIn("opencode".to_string())
            }
            Self::Generic { name } => AcpxAgentInvocation::BuiltIn((*name).to_string()),
        }
    }

    pub fn generic_model_arg<'b>(&self, model: Option<&'b str>) -> Option<&'b str> {
        if self.supports_startup_model() {
            None
        } else {
            model
        }
    }

    pub fn discovery_command(&self, model: Option<&str>) -> ResolvedCommand {
        if matches!(self, Self::Opencode) {
            if let Some(model) = model {
                return ResolvedCommand {
                    program: PathBuf::from("opencode"),
                    args: vec!["--model".to_string(), model.to_string(), "acp".to_string()],
                    env: Vec::new(),
                };
            }
        }

        let mut args = vec!["--agent".to_string(), self.name().to_string()];
        if let Some(model) = self.generic_model_arg(model) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }

        ResolvedCommand {
            program: PathBuf::from("acpx"),
            args,
            env: Vec::new(),
        }
    }

    fn name(&self) -> &'a str {
        match self {
            Self::Generic { name } => name,
            Self::Opencode => "opencode",
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{AcpxAgentAdapter, AcpxAgentInvocation};

    #[test]
    fn generic_agent_uses_acpx_model_selection() {
        let adapter = AcpxAgentAdapter::for_name("codex");

        assert_eq!(
            adapter.invocation(Some("gpt-5.4")),
            AcpxAgentInvocation::BuiltIn("codex".to_string())
        );
        assert_eq!(adapter.generic_model_arg(Some("gpt-5.4")), Some("gpt-5.4"));
        assert!(!adapter.supports_startup_model());
    }

    #[test]
    fn opencode_agent_uses_startup_model_invocation() {
        let adapter = AcpxAgentAdapter::for_name("opencode");

        assert_eq!(
            adapter.invocation(Some("opencode-go/kimi-k2.5")),
            AcpxAgentInvocation::RawCommand(
                "opencode --model opencode-go/kimi-k2.5 acp".to_string()
            )
        );
        assert_eq!(
            adapter.generic_model_arg(Some("opencode-go/kimi-k2.5")),
            None
        );
        assert!(adapter.supports_startup_model());
    }

    #[test]
    fn opencode_startup_model_is_shell_quoted_for_acpx_agent_argument() {
        let adapter = AcpxAgentAdapter::for_name("opencode");

        assert_eq!(
            adapter.invocation(Some("provider/model with space")),
            AcpxAgentInvocation::RawCommand(
                "opencode --model 'provider/model with space' acp".to_string()
            )
        );
    }

    #[test]
    fn opencode_without_model_uses_generic_acpx_agent_name() {
        let adapter = AcpxAgentAdapter::for_name("opencode");

        assert_eq!(
            adapter.invocation(None),
            AcpxAgentInvocation::BuiltIn("opencode".to_string())
        );
        assert_eq!(adapter.generic_model_arg(None), None);
    }

    #[test]
    fn discovery_command_uses_direct_opencode_startup_model() {
        let adapter = AcpxAgentAdapter::for_name("opencode");
        let command = adapter.discovery_command(Some("opencode-go/kimi-k2.5"));

        assert_eq!(command.program, PathBuf::from("opencode"));
        assert_eq!(
            command.args,
            vec![
                "--model".to_string(),
                "opencode-go/kimi-k2.5".to_string(),
                "acp".to_string(),
            ]
        );
    }

    #[test]
    fn discovery_command_keeps_generic_acpx_model_selection() {
        let adapter = AcpxAgentAdapter::for_name("codex");
        let command = adapter.discovery_command(Some("gpt-5.4"));

        assert_eq!(command.program, PathBuf::from("acpx"));
        assert_eq!(
            command.args,
            vec![
                "--agent".to_string(),
                "codex".to_string(),
                "--model".to_string(),
                "gpt-5.4".to_string(),
            ]
        );
    }
}

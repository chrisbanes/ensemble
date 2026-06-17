use std::path::Path;
use std::path::PathBuf;

use super::ResolvedCommand;

const OPENCODE_DEFAULT_COMMAND: &str = "npx -y opencode-ai acp";

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
        self.invocation_from_command(model, None)
    }

    pub fn invocation_for_cwd(&self, model: Option<&str>, cwd: &Path) -> AcpxAgentInvocation {
        self.invocation_from_command(model, opencode_command_from_config(cwd).as_deref())
    }

    fn invocation_from_command(
        &self,
        model: Option<&str>,
        opencode_command: Option<&str>,
    ) -> AcpxAgentInvocation {
        match self {
            Self::Opencode => {
                if let Some(model) = model {
                    return AcpxAgentInvocation::RawCommand(opencode_startup_command(
                        opencode_command.unwrap_or(OPENCODE_DEFAULT_COMMAND),
                        model,
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
        self.discovery_command_from_command(model, None)
    }

    pub fn discovery_command_for_cwd(&self, model: Option<&str>, cwd: &Path) -> ResolvedCommand {
        self.discovery_command_from_command(model, opencode_command_from_config(cwd).as_deref())
    }

    fn discovery_command_from_command(
        &self,
        model: Option<&str>,
        opencode_command: Option<&str>,
    ) -> ResolvedCommand {
        if matches!(self, Self::Opencode) {
            if let Some(model) = model {
                return command_tokens_to_resolved(opencode_startup_tokens(
                    opencode_command.unwrap_or(OPENCODE_DEFAULT_COMMAND),
                    model,
                ));
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

fn opencode_startup_command(base_command: &str, model: &str) -> String {
    opencode_startup_tokens(base_command, model)
        .into_iter()
        .map(|part| shell_words::quote(&part).into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn opencode_startup_tokens(base_command: &str, model: &str) -> Vec<String> {
    let mut tokens = shell_words::split(base_command)
        .unwrap_or_else(|_| shell_words::split(OPENCODE_DEFAULT_COMMAND).expect("valid default"));
    let insert_at = tokens
        .iter()
        .position(|arg| arg == "acp")
        .unwrap_or(tokens.len());
    tokens.splice(
        insert_at..insert_at,
        ["--model".to_string(), model.to_string()],
    );
    tokens
}

fn command_tokens_to_resolved(tokens: Vec<String>) -> ResolvedCommand {
    let mut iter = tokens.into_iter();
    let program = iter
        .next()
        .map(PathBuf::from)
        .expect("opencode startup command is non-empty");
    ResolvedCommand {
        program,
        args: iter.collect(),
        env: Vec::new(),
    }
}

fn opencode_command_from_config(cwd: &Path) -> Option<String> {
    let global = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|home| {
            opencode_command_from_config_file(&home.join(".acpx").join("config.json"))
        });
    let project = opencode_command_from_config_file(&cwd.join(".acpxrc.json"));
    project.or(global)
}

fn opencode_command_from_config_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let agent = json.get("agents")?.get("opencode")?;
    let command = agent.get("command")?.as_str()?.trim();
    if command.is_empty() {
        return None;
    }

    let args = agent
        .get("args")
        .and_then(|args| args.as_array())
        .map(|args| {
            args.iter()
                .filter_map(|arg| arg.as_str())
                .map(|arg| shell_words::quote(arg).into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if args.is_empty() {
        Some(command.to_string())
    } else {
        Some(format!("{command} {}", args.join(" ")))
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
                "npx -y opencode-ai --model opencode-go/kimi-k2.5 acp".to_string()
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
                "npx -y opencode-ai --model 'provider/model with space' acp".to_string()
            )
        );
    }

    #[test]
    fn opencode_startup_model_honors_project_acpx_override() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(".acpxrc.json"),
            r#"{
              "agents": {
                "opencode": {
                  "command": "/custom/opencode",
                  "args": ["acp"]
                }
              }
            }"#,
        )
        .unwrap();

        let adapter = AcpxAgentAdapter::for_name("opencode");

        assert_eq!(
            adapter.invocation_for_cwd(Some("provider/model with space"), dir.path()),
            AcpxAgentInvocation::RawCommand(
                "/custom/opencode --model 'provider/model with space' acp".to_string()
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

        assert_eq!(command.program, PathBuf::from("npx"));
        assert_eq!(
            command.args,
            vec![
                "-y".to_string(),
                "opencode-ai".to_string(),
                "--model".to_string(),
                "opencode-go/kimi-k2.5".to_string(),
                "acp".to_string(),
            ]
        );
    }

    #[test]
    fn discovery_command_honors_project_opencode_override() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(".acpxrc.json"),
            r#"{
              "agents": {
                "opencode": {
                  "command": "/custom/opencode",
                  "args": ["acp"]
                }
              }
            }"#,
        )
        .unwrap();

        let adapter = AcpxAgentAdapter::for_name("opencode");
        let command = adapter.discovery_command_for_cwd(Some("opencode-go/kimi-k2.5"), dir.path());

        assert_eq!(command.program, PathBuf::from("/custom/opencode"));
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

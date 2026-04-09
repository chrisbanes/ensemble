#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractionCommand {
    Approve,
    Reject { reason: String },
    Answer { text: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseInteractionCommandError {
    NotSlashCommand,
    UnknownCommand,
    MissingArgument,
}

pub fn parse_interaction_command(
    raw_body: &str,
) -> Result<InteractionCommand, ParseInteractionCommandError> {
    let body = raw_body.trim();
    if !body.starts_with('/') {
        return Err(ParseInteractionCommandError::NotSlashCommand);
    }

    if body == "/approve" {
        return Ok(InteractionCommand::Approve);
    }

    if let Some(reason) = body.strip_prefix("/reject ") {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err(ParseInteractionCommandError::MissingArgument);
        }
        return Ok(InteractionCommand::Reject {
            reason: reason.to_string(),
        });
    }

    if body == "/reject" {
        return Err(ParseInteractionCommandError::MissingArgument);
    }

    if let Some(text) = body.strip_prefix("/answer ") {
        let text = text.trim();
        if text.is_empty() {
            return Err(ParseInteractionCommandError::MissingArgument);
        }
        return Ok(InteractionCommand::Answer {
            text: text.to_string(),
        });
    }

    if body == "/answer" {
        return Err(ParseInteractionCommandError::MissingArgument);
    }

    Err(ParseInteractionCommandError::UnknownCommand)
}

#[cfg(test)]
mod tests {
    use super::{parse_interaction_command, InteractionCommand, ParseInteractionCommandError};

    #[test]
    fn parses_approve() {
        assert_eq!(
            parse_interaction_command("/approve").unwrap(),
            InteractionCommand::Approve
        );
    }

    #[test]
    fn parses_reject_with_reason() {
        assert_eq!(
            parse_interaction_command("/reject needs docs").unwrap(),
            InteractionCommand::Reject {
                reason: "needs docs".to_string()
            }
        );
    }

    #[test]
    fn parses_answer_with_text() {
        assert_eq!(
            parse_interaction_command("/answer use staging").unwrap(),
            InteractionCommand::Answer {
                text: "use staging".to_string()
            }
        );
    }

    #[test]
    fn rejects_non_slash_commands() {
        assert_eq!(
            parse_interaction_command("looks good").unwrap_err(),
            ParseInteractionCommandError::NotSlashCommand
        );
    }

    #[test]
    fn rejects_missing_arguments() {
        assert_eq!(
            parse_interaction_command("/reject").unwrap_err(),
            ParseInteractionCommandError::MissingArgument
        );
        assert_eq!(
            parse_interaction_command("/answer ").unwrap_err(),
            ParseInteractionCommandError::MissingArgument
        );
    }

    #[test]
    fn rejects_unknown_commands() {
        assert_eq!(
            parse_interaction_command("/shipit").unwrap_err(),
            ParseInteractionCommandError::UnknownCommand
        );
    }
}

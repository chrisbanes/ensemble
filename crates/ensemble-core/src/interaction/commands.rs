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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedInteractionCommand {
    pub interaction_id: String,
    pub command: InteractionCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseScopedInteractionCommandError {
    MissingMarker,
    InvalidMarker,
    DuplicateMarker,
    InvalidCommand(ParseInteractionCommandError),
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

pub fn parse_scoped_interaction_command(
    raw_body: &str,
) -> Result<ScopedInteractionCommand, ParseScopedInteractionCommandError> {
    const MARKER_PREFIX: &str = "<!-- ensemble:interaction:";
    const MARKER_SUFFIX: &str = " -->";

    let body = raw_body.trim();
    let marker_count = body.matches(MARKER_PREFIX).count();
    if marker_count > 1 {
        return Err(ParseScopedInteractionCommandError::DuplicateMarker);
    }

    let (command_body, marker) = body
        .rsplit_once("\n\n")
        .ok_or(ParseScopedInteractionCommandError::MissingMarker)?;
    let interaction_id = marker
        .strip_prefix(MARKER_PREFIX)
        .and_then(|marker| marker.strip_suffix(MARKER_SUFFIX))
        .filter(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        })
        .ok_or(ParseScopedInteractionCommandError::InvalidMarker)?;

    if marker_count == 0 || command_body.contains(MARKER_PREFIX) {
        return Err(ParseScopedInteractionCommandError::InvalidMarker);
    }

    let command = parse_interaction_command(command_body)
        .map_err(ParseScopedInteractionCommandError::InvalidCommand)?;
    Ok(ScopedInteractionCommand {
        interaction_id: interaction_id.to_string(),
        command,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        parse_interaction_command, parse_scoped_interaction_command, InteractionCommand,
        ParseInteractionCommandError, ParseScopedInteractionCommandError,
    };

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

    #[test]
    fn rejects_malformed_known_command_variants() {
        assert_eq!(
            parse_interaction_command("/approve now").unwrap_err(),
            ParseInteractionCommandError::UnknownCommand
        );
        assert_eq!(
            parse_interaction_command("/reject: no").unwrap_err(),
            ParseInteractionCommandError::UnknownCommand
        );
    }

    #[test]
    fn parser_is_case_sensitive() {
        assert_eq!(
            parse_interaction_command("/Approve").unwrap_err(),
            ParseInteractionCommandError::UnknownCommand
        );
    }

    #[test]
    fn parser_treats_unclosed_quotes_as_plain_text_payload() {
        assert_eq!(
            parse_interaction_command("/answer \"staging").unwrap(),
            InteractionCommand::Answer {
                text: "\"staging".to_string(),
            }
        );
    }

    #[test]
    fn scoped_interaction_command_parses_supported_commands() {
        assert_eq!(
            parse_scoped_interaction_command(
                "/approve\n\n<!-- ensemble:interaction:interaction-1 -->"
            )
            .unwrap()
            .command,
            InteractionCommand::Approve
        );
        assert_eq!(
            parse_scoped_interaction_command(
                "/reject needs docs\n\n<!-- ensemble:interaction:interaction-2 -->"
            )
            .unwrap()
            .command,
            InteractionCommand::Reject {
                reason: "needs docs".to_string()
            }
        );
        let answer = parse_scoped_interaction_command(
            "/answer use staging\n\n<!-- ensemble:interaction:interaction-3 -->",
        )
        .unwrap();
        assert_eq!(answer.interaction_id, "interaction-3");
        assert_eq!(
            answer.command,
            InteractionCommand::Answer {
                text: "use staging".to_string()
            }
        );
    }

    #[test]
    fn scoped_interaction_command_rejects_missing_duplicate_and_malformed_markers() {
        assert_eq!(
            parse_scoped_interaction_command("/approve").unwrap_err(),
            ParseScopedInteractionCommandError::MissingMarker
        );
        assert_eq!(
            parse_scoped_interaction_command(
                "/approve\n\n<!-- ensemble:interaction:interaction-1 -->\n\n<!-- ensemble:interaction:interaction-1 -->"
            )
            .unwrap_err(),
            ParseScopedInteractionCommandError::DuplicateMarker
        );
        assert_eq!(
            parse_scoped_interaction_command(
                "/approve\n\nmarker: <!-- ensemble:interaction:interaction-1 -->"
            )
            .unwrap_err(),
            ParseScopedInteractionCommandError::InvalidMarker
        );
        assert_eq!(
            parse_scoped_interaction_command(
                "/approve\n<!-- ensemble:interaction:interaction-1 -->"
            )
            .unwrap_err(),
            ParseScopedInteractionCommandError::MissingMarker
        );
        assert_eq!(
            parse_scoped_interaction_command("/approve\n\n<!-- ensemble:interaction: -->")
                .unwrap_err(),
            ParseScopedInteractionCommandError::InvalidMarker
        );
    }

    #[test]
    fn scoped_interaction_command_rejects_prose_wrapped_commands() {
        assert_eq!(
            parse_scoped_interaction_command(
                "please approve\n/approve\n\n<!-- ensemble:interaction:interaction-1 -->"
            )
            .unwrap_err(),
            ParseScopedInteractionCommandError::InvalidCommand(
                ParseInteractionCommandError::NotSlashCommand
            )
        );
    }
}

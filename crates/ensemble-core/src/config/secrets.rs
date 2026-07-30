use crate::error::ConfigError;
use serde::{Deserialize, Serialize};
use std::fmt;

pub const REDACTED_SECRET: &str = "[REDACTED]";

#[derive(Clone, PartialEq, Eq)]
pub struct SecretValue(String);

impl SecretValue {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SecretDisplay {
    Unset,
    Redacted,
    Environment { variable: String },
}

impl SecretDisplay {
    pub fn from_config_value(value: Option<&str>) -> Self {
        match value {
            None => Self::Unset,
            Some(value) if value.starts_with('$') && value.len() > 1 => Self::Environment {
                variable: value[1..].to_string(),
            },
            Some(_) => Self::Redacted,
        }
    }
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SecretEdit {
    #[default]
    Preserve,
    Remove,
    SetLiteral {
        #[schema(write_only)]
        value: String,
    },
    SetEnvironment {
        variable: String,
    },
}

impl SecretEdit {
    pub fn is_preserve(&self) -> bool {
        matches!(self, Self::Preserve)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        match self {
            Self::SetLiteral { value } if value.trim().is_empty() => {
                Err(ConfigError::ConfigWriteRejected {
                    reason: "secret replacement must not be blank".to_string(),
                })
            }
            Self::SetEnvironment { variable } if variable.trim().is_empty() => {
                Err(ConfigError::ConfigWriteRejected {
                    reason: "secret environment variable name must not be blank".to_string(),
                })
            }
            Self::SetEnvironment { variable }
                if !is_valid_environment_variable_name(variable) =>
            {
                Err(ConfigError::ConfigWriteRejected {
                    reason: "secret environment variable name must start with an ASCII letter or underscore and contain only ASCII letters, digits, or underscores".to_string(),
                })
            }
            _ => Ok(()),
        }
    }
}

fn is_valid_environment_variable_name(variable: &str) -> bool {
    let mut characters = variable.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

impl fmt::Debug for SecretEdit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Preserve => formatter.write_str("Preserve"),
            Self::Remove => formatter.write_str("Remove"),
            Self::SetLiteral { .. } => formatter.write_str("SetLiteral { value: [REDACTED] }"),
            Self::SetEnvironment { variable } => formatter
                .debug_struct("SetEnvironment")
                .field("variable", variable)
                .finish(),
        }
    }
}

pub fn redact_yaml_secrets(raw_yaml: &str) -> Option<String> {
    let mut document: serde_yaml::Value = serde_yaml::from_str(raw_yaml).ok()?;
    redact_value(&mut document);
    serde_yaml::to_string(&document).ok()
}

pub fn merge_redacted_yaml(
    authoritative_yaml: Option<&str>,
    submitted_yaml: &str,
) -> Result<String, ConfigError> {
    let mut submitted: serde_yaml::Value =
        serde_yaml::from_str(submitted_yaml).map_err(|error| ConfigError::ConfigParseError {
            reason: error.to_string(),
        })?;
    let authoritative = authoritative_yaml
        .map(serde_yaml::from_str)
        .transpose()
        .map_err(|error| ConfigError::ConfigParseError {
            reason: format!("stored configuration is not valid YAML: {error}"),
        })?;

    merge_preserve_markers(&mut submitted, authoritative.as_ref())?;
    serde_yaml::to_string(&submitted).map_err(|error| ConfigError::ConfigParseError {
        reason: error.to_string(),
    })
}

fn is_secret_key(value: &serde_yaml::Value) -> bool {
    value.as_str().is_some_and(|key| {
        ["api_key", "token", "password", "secret"]
            .iter()
            .any(|secret_key| key.eq_ignore_ascii_case(secret_key))
    })
}

fn is_environment_reference(value: &serde_yaml::Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| value.starts_with('$') && value.len() > 1)
}

fn is_preserve_marker(value: &serde_yaml::Value) -> bool {
    value.as_str() == Some(REDACTED_SECRET)
}

fn contains_secret_preserve_marker(value: &serde_yaml::Value) -> bool {
    match value {
        serde_yaml::Value::Mapping(mapping) => mapping.iter().any(|(key, value)| {
            (is_secret_key(key) && is_preserve_marker(value))
                || (!is_secret_key(key) && contains_secret_preserve_marker(value))
        }),
        serde_yaml::Value::Sequence(sequence) => {
            sequence.iter().any(contains_secret_preserve_marker)
        }
        serde_yaml::Value::Tagged(tagged) => contains_secret_preserve_marker(&tagged.value),
        _ => false,
    }
}

fn secret_free_identity(value: &serde_yaml::Value) -> serde_yaml::Value {
    match value {
        serde_yaml::Value::Mapping(mapping) => serde_yaml::Value::Mapping(
            mapping
                .iter()
                .filter(|(key, _)| !is_secret_key(key))
                .map(|(key, value)| (key.clone(), secret_free_identity(value)))
                .collect(),
        ),
        serde_yaml::Value::Sequence(sequence) => {
            serde_yaml::Value::Sequence(sequence.iter().map(secret_free_identity).collect())
        }
        serde_yaml::Value::Tagged(tagged) => {
            let mut identity = tagged.clone();
            identity.value = secret_free_identity(&identity.value);
            serde_yaml::Value::Tagged(identity)
        }
        _ => value.clone(),
    }
}

fn sequence_identity_value<'a>(
    value: &'a serde_yaml::Value,
    identity_key: &str,
) -> Option<&'a serde_yaml::Value> {
    value.as_mapping()?.iter().find_map(|(key, value)| {
        key.as_str()
            .is_some_and(|key| key.eq_ignore_ascii_case(identity_key))
            .then_some(value)
            .filter(|value| match value {
                serde_yaml::Value::Bool(_) | serde_yaml::Value::Number(_) => true,
                serde_yaml::Value::String(value) => !value.trim().is_empty(),
                _ => false,
            })
    })
}

fn explicit_sequence_identity(
    value: &serde_yaml::Value,
) -> Option<(&'static str, &serde_yaml::Value)> {
    ["id", "name"]
        .into_iter()
        .find_map(|key| sequence_identity_value(value, key).map(|value| (key, value)))
}

fn sequence_identity_error() -> ConfigError {
    ConfigError::ConfigWriteRejected {
        reason: "secret preserve marker has no unique matching stored sequence entry".to_string(),
    }
}

fn match_authoritative_sequence_entry<'a>(
    submitted: &serde_yaml::Value,
    authoritative: &'a [serde_yaml::Value],
    claimed: &mut [bool],
    submitted_identity_is_unique: bool,
) -> Result<&'a serde_yaml::Value, ConfigError> {
    let explicit_identity = explicit_sequence_identity(submitted);
    if explicit_identity.is_some() && !submitted_identity_is_unique {
        return Err(sequence_identity_error());
    }
    let structural_identity = explicit_identity
        .is_none()
        .then(|| secret_free_identity(submitted));
    let mut candidates = authoritative
        .iter()
        .enumerate()
        .filter(|(index, candidate)| {
            !claimed[*index]
                && match explicit_identity {
                    Some((key, value)) => sequence_identity_value(candidate, key) == Some(value),
                    None => structural_identity
                        .as_ref()
                        .is_some_and(|identity| secret_free_identity(candidate) == *identity),
                }
        });
    let Some((index, candidate)) = candidates.next() else {
        return Err(sequence_identity_error());
    };
    if candidates.next().is_some() {
        return Err(sequence_identity_error());
    }
    claimed[index] = true;
    Ok(candidate)
}

fn redact_value(value: &mut serde_yaml::Value) {
    match value {
        serde_yaml::Value::Mapping(mapping) => {
            for (key, value) in mapping {
                if is_secret_key(key) {
                    if !is_environment_reference(value) {
                        *value = serde_yaml::Value::String(REDACTED_SECRET.to_string());
                    }
                } else {
                    redact_value(value);
                }
            }
        }
        serde_yaml::Value::Sequence(sequence) => {
            for value in sequence {
                redact_value(value);
            }
        }
        serde_yaml::Value::Tagged(tagged) => redact_value(&mut tagged.value),
        _ => {}
    }
}

fn merge_preserve_markers(
    submitted: &mut serde_yaml::Value,
    authoritative: Option<&serde_yaml::Value>,
) -> Result<(), ConfigError> {
    match submitted {
        serde_yaml::Value::Mapping(submitted_mapping) => {
            let authoritative_mapping = authoritative.and_then(serde_yaml::Value::as_mapping);
            for (key, submitted_value) in submitted_mapping {
                let authoritative_value = authoritative_mapping.and_then(|mapping| {
                    mapping.get(key).or_else(|| {
                        key.as_str().and_then(|submitted_key| {
                            mapping.iter().find_map(|(candidate_key, candidate_value)| {
                                candidate_key
                                    .as_str()
                                    .is_some_and(|candidate_key| {
                                        candidate_key.eq_ignore_ascii_case(submitted_key)
                                    })
                                    .then_some(candidate_value)
                            })
                        })
                    })
                });

                if is_secret_key(key) && is_preserve_marker(submitted_value) {
                    let Some(authoritative_value) =
                        authoritative_value.filter(|value| !is_preserve_marker(value))
                    else {
                        return Err(ConfigError::ConfigWriteRejected {
                            reason: "secret preserve marker has no matching stored secret"
                                .to_string(),
                        });
                    };
                    *submitted_value = authoritative_value.clone();
                } else if !is_secret_key(key) {
                    merge_preserve_markers(submitted_value, authoritative_value)?;
                }
            }
        }
        serde_yaml::Value::Sequence(submitted_sequence) => {
            let authoritative_sequence = authoritative
                .and_then(serde_yaml::Value::as_sequence)
                .map_or(&[][..], Vec::as_slice);
            let mut claimed = vec![false; authoritative_sequence.len()];
            let submitted_identities: Vec<_> = submitted_sequence
                .iter()
                .map(|value| {
                    explicit_sequence_identity(value).map(|(key, value)| (key, value.clone()))
                })
                .collect();
            for (index, submitted_value) in submitted_sequence.iter_mut().enumerate() {
                let authoritative_value = if contains_secret_preserve_marker(submitted_value) {
                    let submitted_identity_is_unique =
                        submitted_identities[index].as_ref().is_none_or(|identity| {
                            submitted_identities
                                .iter()
                                .filter(|candidate| candidate.as_ref() == Some(identity))
                                .count()
                                == 1
                        });
                    Some(match_authoritative_sequence_entry(
                        submitted_value,
                        authoritative_sequence,
                        &mut claimed,
                        submitted_identity_is_unique,
                    )?)
                } else {
                    None
                };
                merge_preserve_markers(submitted_value, authoritative_value)?;
            }
        }
        serde_yaml::Value::Tagged(submitted_tagged) => {
            let authoritative_value = match authoritative {
                Some(serde_yaml::Value::Tagged(tagged)) => Some(&tagged.value),
                other => other,
            };
            merge_preserve_markers(&mut submitted_tagged.value, authoritative_value)?;
        }
        _ => {}
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yaml_value(yaml: &str) -> serde_yaml::Value {
        serde_yaml::from_str(yaml).expect("sanitized YAML should remain valid")
    }

    #[test]
    fn redacts_structural_secret_values_without_touching_lookalike_keys() {
        let yaml = r#"
tracker:
  "api_key": ghp_literal
  token_count: 4
services:
  - { Token: inline-secret, tokenized: true }
  - password: |
      first line
      second line
  - SECRET: >
      folded
      value
"#;

        let redacted = redact_yaml_secrets(yaml).expect("valid YAML should be sanitized");
        let value = yaml_value(&redacted);

        assert_eq!(value["tracker"]["api_key"], REDACTED_SECRET);
        assert_eq!(value["tracker"]["token_count"], 4);
        assert_eq!(value["services"][0]["Token"], REDACTED_SECRET);
        assert_eq!(value["services"][0]["tokenized"], true);
        assert_eq!(value["services"][1]["password"], REDACTED_SECRET);
        assert_eq!(value["services"][2]["SECRET"], REDACTED_SECRET);
        for literal in ["ghp_literal", "inline-secret", "first line", "folded"] {
            assert!(!redacted.contains(literal));
        }
    }

    #[test]
    fn preserves_environment_references_and_omits_malformed_yaml() {
        let yaml = r#"
tracker:
  api_key: $GITHUB_TOKEN
  token: "$SERVICE_TOKEN"
"#;

        let redacted = redact_yaml_secrets(yaml).expect("valid YAML should be sanitized");
        let value = yaml_value(&redacted);

        assert_eq!(value["tracker"]["api_key"], "$GITHUB_TOKEN");
        assert_eq!(value["tracker"]["token"], "$SERVICE_TOKEN");
        assert!(redact_yaml_secrets("tracker:\n  api_key: [").is_none());
    }

    #[test]
    fn merge_preserves_only_matching_authoritative_secret_nodes() {
        let authoritative = r#"
tracker:
  api_key: ghp_original
services:
  - name: service
    token: $SERVICE_TOKEN
"#;
        let submitted = r#"
tracker:
  api_key: "[REDACTED]"
  repository: acme/widgets
services:
  - name: service
    token: "[REDACTED]"
"#;

        let merged = merge_redacted_yaml(Some(authoritative), submitted)
            .expect("matching preserve markers should resolve");
        let value = yaml_value(&merged);

        assert_eq!(value["tracker"]["api_key"], "ghp_original");
        assert_eq!(value["tracker"]["repository"], "acme/widgets");
        assert_eq!(value["services"][0]["token"], "$SERVICE_TOKEN");
        assert!(!merged.contains(REDACTED_SECRET));
    }

    #[test]
    fn merge_preserves_sequence_secrets_across_reordering() {
        let authoritative = r#"
services:
  - name: alpha
    token: alpha-secret
  - name: beta
    token: beta-secret
"#;
        let submitted = r#"
services:
  - name: beta
    token: "[REDACTED]"
  - name: alpha
    token: "[REDACTED]"
"#;

        let merged = merge_redacted_yaml(Some(authoritative), submitted)
            .expect("reordered sequence entries should retain their own secrets");
        let value = yaml_value(&merged);

        assert_eq!(value["services"][0]["name"], "beta");
        assert_eq!(value["services"][0]["token"], "beta-secret");
        assert_eq!(value["services"][1]["name"], "alpha");
        assert_eq!(value["services"][1]["token"], "alpha-secret");
    }

    #[test]
    fn merge_preserves_sequence_secrets_after_insertion() {
        let authoritative = r#"
services:
  - name: alpha
    token: alpha-secret
  - name: beta
    token: beta-secret
"#;
        let submitted = r#"
services:
  - name: new
    token: new-secret
  - name: alpha
    token: "[REDACTED]"
  - name: beta
    token: "[REDACTED]"
"#;

        let merged = merge_redacted_yaml(Some(authoritative), submitted)
            .expect("inserted sequence entries should not shift preserved secrets");
        let value = yaml_value(&merged);

        assert_eq!(value["services"][0]["token"], "new-secret");
        assert_eq!(value["services"][1]["token"], "alpha-secret");
        assert_eq!(value["services"][2]["token"], "beta-secret");
    }

    #[test]
    fn merge_preserves_sequence_secrets_while_editing_non_identity_fields() {
        let authoritative = r#"
services:
  - id: service-1
    name: alpha
    endpoint: https://old.example
    token: alpha-secret
  - name: beta
    endpoint: https://old.example
    token: beta-secret
"#;
        let submitted = r#"
services:
  - id: service-1
    name: renamed
    endpoint: https://new.example
    token: "[REDACTED]"
  - name: beta
    endpoint: https://new.example
    token: "[REDACTED]"
"#;

        let merged = merge_redacted_yaml(Some(authoritative), submitted)
            .expect("a stable id should preserve the secret across ordinary field edits");
        let value = yaml_value(&merged);

        assert_eq!(value["services"][0]["name"], "renamed");
        assert_eq!(value["services"][0]["endpoint"], "https://new.example");
        assert_eq!(value["services"][0]["token"], "alpha-secret");
        assert_eq!(value["services"][1]["name"], "beta");
        assert_eq!(value["services"][1]["endpoint"], "https://new.example");
        assert_eq!(value["services"][1]["token"], "beta-secret");
    }

    #[test]
    fn merge_rejects_ambiguous_sequence_secret_identity() {
        let authoritative = r#"
services:
  - name: duplicate
    token: first-secret
  - name: duplicate
    token: second-secret
"#;
        let submitted = r#"
services:
  - name: duplicate
    token: "[REDACTED]"
"#;

        let error = merge_redacted_yaml(Some(authoritative), submitted)
            .expect_err("ambiguous sequence identities must not inherit either secret");

        assert!(error.to_string().contains("no unique matching"));
        assert!(!error.to_string().contains("first-secret"));
        assert!(!error.to_string().contains("second-secret"));
    }

    #[test]
    fn merge_rejects_duplicate_submitted_sequence_identity() {
        let authoritative = r#"
services:
  - id: service-1
    token: original-secret
"#;
        let submitted = r#"
services:
  - id: service-1
    token: replacement-secret
  - id: service-1
    token: "[REDACTED]"
"#;

        let error = merge_redacted_yaml(Some(authoritative), submitted)
            .expect_err("submitted sequence identities must be unique");

        assert!(error.to_string().contains("no unique matching"));
        assert!(!error.to_string().contains("original-secret"));
    }

    #[test]
    fn merge_honors_replacement_removal_and_rejects_orphan_markers() {
        let authoritative = r#"
tracker:
  api_key: ghp_original
  password: old-password
"#;
        let submitted = r#"
tracker:
  api_key: $REPLACEMENT_TOKEN
  secret: new-literal
"#;

        let merged = merge_redacted_yaml(Some(authoritative), submitted)
            .expect("explicit replacement and removal should be accepted");
        let value = yaml_value(&merged);

        assert_eq!(value["tracker"]["api_key"], "$REPLACEMENT_TOKEN");
        assert_eq!(value["tracker"]["secret"], "new-literal");
        assert!(value["tracker"].get("password").is_none());

        let error = merge_redacted_yaml(
            Some("tracker:\n  kind: github\n"),
            "tracker:\n  api_key: \"[REDACTED]\"\n",
        )
        .expect_err("an orphan preserve marker must be rejected");
        assert!(error.to_string().contains("preserve"));
        assert!(!error.to_string().contains("ghp_"));
    }

    #[test]
    fn secret_input_debug_output_never_contains_the_literal() {
        let edit = SecretEdit::SetLiteral {
            value: "ghp_literal_secret".to_string(),
        };
        let value = SecretValue::new("ghp_literal_secret");

        assert!(!format!("{edit:?}").contains("ghp_literal_secret"));
        assert!(!format!("{value:?}").contains("ghp_literal_secret"));
    }

    #[test]
    fn secret_edit_rejects_malformed_environment_variable_names() {
        for variable in ["FOO=BAR", "1TOKEN", "TOKEN-NAME", "$TOKEN", "TOKEN NAME"] {
            let error = SecretEdit::SetEnvironment {
                variable: variable.to_string(),
            }
            .validate()
            .expect_err("environment references must use the supported variable-name grammar");

            assert!(error.to_string().contains("environment variable name"));
        }
        for variable in ["GITHUB_TOKEN", "_TOKEN", "TOKEN1"] {
            SecretEdit::SetEnvironment {
                variable: variable.to_string(),
            }
            .validate()
            .expect("valid environment variable names should be accepted");
        }
    }
}

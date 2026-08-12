use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::AttentionError;

const PRODUCER_KEY_MAX_BYTES: usize = 128;
const SUBJECT_REF_MAX_BYTES: usize = 512;
const KIND_MAX_BYTES: usize = 128;
const SUMMARY_MAX_BYTES: usize = 512;
const REMEDY_MAX_BYTES: usize = 1024;
const FINGERPRINT_MAX_BYTES: usize = 256;
const REFERENCE_MAX_COUNT: usize = 16;
const REFERENCE_MAX_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct AttentionIdentity {
    pub producer_key: String,
    pub subject_ref: String,
    pub kind: String,
}

impl AttentionIdentity {
    pub fn new(
        producer_key: impl Into<String>,
        subject_ref: impl Into<String>,
        kind: impl Into<String>,
    ) -> Result<Self, AttentionError> {
        let identity = Self {
            producer_key: producer_key.into(),
            subject_ref: subject_ref.into(),
            kind: kind.into(),
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn validate(&self) -> Result<(), AttentionError> {
        validate_text("producer_key", &self.producer_key, PRODUCER_KEY_MAX_BYTES)?;
        validate_text("subject_ref", &self.subject_ref, SUBJECT_REF_MAX_BYTES)?;
        validate_text("kind", &self.kind, KIND_MAX_BYTES)?;
        if !is_namespaced_kind(&self.kind) {
            return Err(AttentionError::InvalidField {
                field: "kind",
                reason: "must contain non-empty namespace segments separated by '.'".into(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionPresentation {
    pub summary: String,
    pub remedy: String,
    pub references: Vec<String>,
}

impl AttentionPresentation {
    pub fn new(
        summary: impl Into<String>,
        remedy: impl Into<String>,
        references: Vec<String>,
    ) -> Result<Self, AttentionError> {
        let presentation = Self {
            summary: summary.into(),
            remedy: remedy.into(),
            references,
        };
        presentation.validate()?;
        Ok(presentation)
    }

    pub fn validate(&self) -> Result<(), AttentionError> {
        validate_text("summary", &self.summary, SUMMARY_MAX_BYTES)?;
        validate_text("remedy", &self.remedy, REMEDY_MAX_BYTES)?;
        if self.references.len() > REFERENCE_MAX_COUNT {
            return Err(AttentionError::InvalidField {
                field: "references",
                reason: format!("must contain at most {REFERENCE_MAX_COUNT} entries"),
            });
        }
        for reference in &self.references {
            validate_text("reference", reference, REFERENCE_MAX_BYTES)?;
        }
        let mut unique = self.references.clone();
        unique.sort();
        unique.dedup();
        if unique.len() != self.references.len() {
            return Err(AttentionError::InvalidField {
                field: "references",
                reason: "must not contain duplicate entries".into(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionEvidence {
    pub fingerprint: String,
}

impl AttentionEvidence {
    pub fn new(fingerprint: impl Into<String>) -> Result<Self, AttentionError> {
        let evidence = Self {
            fingerprint: fingerprint.into(),
        };
        validate_text("fingerprint", &evidence.fingerprint, FINGERPRINT_MAX_BYTES)?;
        Ok(evidence)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionUpsert {
    pub identity: AttentionIdentity,
    pub presentation: AttentionPresentation,
    pub evidence: AttentionEvidence,
}

impl AttentionUpsert {
    pub fn new(
        identity: AttentionIdentity,
        presentation: AttentionPresentation,
        evidence: AttentionEvidence,
    ) -> Self {
        Self {
            identity,
            presentation,
            evidence,
        }
    }

    pub fn validate(&self) -> Result<(), AttentionError> {
        self.identity.validate()?;
        self.presentation.validate()?;
        AttentionEvidence::new(&self.evidence.fingerprint)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AttentionLifecycleState {
    Open,
    Resolved,
    Superseded,
}

impl AttentionLifecycleState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Superseded => "superseded",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, AttentionError> {
        match value {
            "open" => Ok(Self::Open),
            "resolved" => Ok(Self::Resolved),
            "superseded" => Ok(Self::Superseded),
            _ => Err(AttentionError::Storage {
                reason: format!("unknown attention lifecycle state: {value}"),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionItem {
    pub identity: AttentionIdentity,
    pub presentation: AttentionPresentation,
    pub evidence: AttentionEvidence,
    pub state: AttentionLifecycleState,
    pub opened_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
    pub superseding_identity: Option<AttentionIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionEvent {
    pub sequence: u64,
    pub identity: AttentionIdentity,
    pub state: AttentionLifecycleState,
    pub evidence: AttentionEvidence,
    pub timestamp: DateTime<Utc>,
    pub superseding_identity: Option<AttentionIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionHistoryResponse {
    pub events: Vec<AttentionEvent>,
    pub total: usize,
    pub next_cursor: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionClose {
    pub identity: AttentionIdentity,
    pub expected_fingerprint: String,
    pub closing_evidence: AttentionEvidence,
}

impl AttentionClose {
    pub fn new(
        identity: AttentionIdentity,
        expected_fingerprint: impl Into<String>,
        closing_evidence: AttentionEvidence,
    ) -> Result<Self, AttentionError> {
        let close = Self {
            identity,
            expected_fingerprint: expected_fingerprint.into(),
            closing_evidence,
        };
        close.validate()?;
        Ok(close)
    }

    pub fn validate(&self) -> Result<(), AttentionError> {
        self.identity.validate()?;
        validate_text(
            "expected_fingerprint",
            &self.expected_fingerprint,
            FINGERPRINT_MAX_BYTES,
        )?;
        AttentionEvidence::new(&self.closing_evidence.fingerprint)?;
        if self.expected_fingerprint == self.closing_evidence.fingerprint {
            return Err(AttentionError::InvalidField {
                field: "closing_evidence",
                reason: "must differ from the open observation fingerprint".into(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AttentionSupersede {
    pub close: AttentionClose,
    pub superseding_identity: AttentionIdentity,
}

impl AttentionSupersede {
    pub fn new(
        close: AttentionClose,
        superseding_identity: AttentionIdentity,
    ) -> Result<Self, AttentionError> {
        let request = Self {
            close,
            superseding_identity,
        };
        request.close.validate()?;
        request.superseding_identity.validate()?;
        Ok(request)
    }
}

fn validate_text(field: &'static str, value: &str, max_bytes: usize) -> Result<(), AttentionError> {
    if value.is_empty() {
        return Err(AttentionError::InvalidField {
            field,
            reason: "must not be empty".into(),
        });
    }
    if value.len() > max_bytes {
        return Err(AttentionError::InvalidField {
            field,
            reason: format!("must not exceed {max_bytes} UTF-8 bytes"),
        });
    }
    if value.chars().any(char::is_control) {
        return Err(AttentionError::InvalidField {
            field,
            reason: "must not contain control characters".into(),
        });
    }
    Ok(())
}

fn is_namespaced_kind(kind: &str) -> bool {
    let mut segments = kind.split('.');
    let first = segments.next();
    first.is_some_and(is_kind_segment)
        && segments.next().is_some_and(is_kind_segment)
        && segments.all(is_kind_segment)
}

fn is_kind_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_observation_preserves_opaque_namespaced_identity() {
        let observation = AttentionUpsert::new(
            AttentionIdentity::new(
                "interaction:request-1",
                "issue-514",
                "runtime.interaction.awaiting_input",
            )
            .expect("namespaced identity is valid"),
            AttentionPresentation::new(
                "Awaiting operator input",
                "Resolve the interaction",
                vec!["request-1".into()],
            )
            .expect("bounded presentation is valid"),
            AttentionEvidence::new("interaction-open:v1").expect("bounded evidence is valid"),
        );

        assert_eq!(
            observation.identity.kind,
            "runtime.interaction.awaiting_input"
        );
    }

    #[test]
    fn attention_observation_rejects_an_unnamespaced_kind() {
        let result = AttentionIdentity::new("producer", "subject", "awaiting_input");

        assert!(matches!(
            result,
            Err(AttentionError::InvalidField { field: "kind", .. })
        ));
    }

    #[test]
    fn attention_presentation_rejects_duplicate_references() {
        let result =
            AttentionPresentation::new("summary", "remedy", vec!["one".into(), "one".into()]);

        assert!(matches!(
            result,
            Err(AttentionError::InvalidField {
                field: "references",
                ..
            })
        ));
    }

    #[test]
    fn attention_identity_rejects_control_characters() {
        let result = AttentionIdentity::new("producer\nkey", "subject", "runtime.waiting");

        assert!(matches!(
            result,
            Err(AttentionError::InvalidField {
                field: "producer_key",
                ..
            })
        ));
    }
}

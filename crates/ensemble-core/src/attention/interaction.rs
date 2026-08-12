use sha2::{Digest, Sha256};

use crate::interaction::InteractionRequest;

use super::{
    AttentionClose, AttentionError, AttentionEvidence, AttentionIdentity, AttentionItem,
    AttentionLifecycleState, AttentionPresentation, AttentionUpsert,
};

pub const AWAITING_INPUT_KIND: &str = "runtime.interaction.awaiting_input";
const MAX_REFERENCE_COUNT: usize = 16;
const MAX_REFERENCE_BYTES: usize = 1024;

pub fn awaiting_interaction_observation(
    interaction: &InteractionRequest,
) -> Result<AttentionUpsert, AttentionError> {
    Ok(AttentionUpsert::new(
        interaction_attention_identity(interaction)?,
        AttentionPresentation::new(
            bounded_interaction_text(&interaction.title, 512, "Operator input required"),
            bounded_interaction_text(&interaction.body, 1024, "Review the interaction request."),
            interaction_attention_references(interaction),
        )?,
        AttentionEvidence::new(interaction_attention_fingerprint(interaction))?,
    ))
}

pub fn interaction_attention_close(
    before: &InteractionRequest,
    after: &InteractionRequest,
) -> Result<AttentionClose, AttentionError> {
    AttentionClose::new(
        interaction_attention_identity(before)?,
        interaction_attention_fingerprint(before),
        AttentionEvidence::new(interaction_attention_fingerprint(after))?,
    )
}

/// Rebuilds a conditional close from the latest durable open observation.
///
/// This lets startup reconciliation retire an interaction after its lifecycle transition was
/// persisted but the original attention write was interrupted.
pub fn interaction_attention_close_from_open(
    open_item: &AttentionItem,
    interaction: &InteractionRequest,
) -> Result<Option<AttentionClose>, AttentionError> {
    let identity = interaction_attention_identity(interaction)?;
    if open_item.state != AttentionLifecycleState::Open || open_item.identity != identity {
        return Ok(None);
    }
    AttentionClose::new(
        identity,
        open_item.evidence.fingerprint.clone(),
        AttentionEvidence::new(interaction_attention_fingerprint(interaction))?,
    )
    .map(Some)
}

pub fn interaction_attention_identity(
    interaction: &InteractionRequest,
) -> Result<AttentionIdentity, AttentionError> {
    AttentionIdentity::new(
        &interaction.id,
        &interaction.issue_identifier,
        AWAITING_INPUT_KIND,
    )
}

pub fn interaction_attention_fingerprint(interaction: &InteractionRequest) -> String {
    let relevant_state = serde_json::json!({
        "id": interaction.id,
        "issue_id": interaction.issue_id,
        "issue_identifier": interaction.issue_identifier,
        "status": interaction.status,
        "awaiting_resume": interaction.awaiting_resume,
        "title": interaction.title,
        "body": interaction.body,
        "artifacts": interaction.artifacts,
        "requested_at": interaction.requested_at,
        "resolved_at": interaction.resolved_at,
    });
    let encoded = serde_json::to_vec(&relevant_state)
        .expect("serialized interaction attention state contains only serializable fields");
    format!("sha256:{:x}", Sha256::digest(encoded))
}

fn interaction_attention_references(interaction: &InteractionRequest) -> Vec<String> {
    let mut references = vec![bounded_interaction_text(
        &format!("interaction:{}", interaction.id),
        MAX_REFERENCE_BYTES,
        "interaction:unknown",
    )];
    references.extend(
        interaction
            .artifacts
            .iter()
            .filter(|reference| valid_reference(reference))
            .cloned(),
    );
    references.sort();
    references.dedup();
    references.truncate(MAX_REFERENCE_COUNT);
    references
}

fn valid_reference(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_REFERENCE_BYTES && !value.chars().any(char::is_control)
}

fn bounded_interaction_text(value: &str, max_bytes: usize, fallback: &str) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let normalized = normalized.trim();
    let value = if normalized.is_empty() {
        fallback
    } else {
        normalized
    };
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use crate::interaction::{InteractionKind, InteractionResumeStrategy, InteractionStatus};

    use super::*;

    fn interaction(status: InteractionStatus) -> InteractionRequest {
        InteractionRequest {
            id: "request-1".into(),
            schema_version: 1,
            issue_id: "issue-id".into(),
            issue_identifier: "issue-514".into(),
            pipeline_cycle: 1,
            completed_steps: vec![],
            step_name: "build".into(),
            agent_name: "solver".into(),
            step_depends: vec![],
            step_tracker_state: None,
            kind: InteractionKind::Question,
            status,
            blocking: true,
            awaiting_resume: true,
            resume_strategy: InteractionResumeStrategy::RerunStep,
            title: "Awaiting input".into(),
            body: "Resolve the question".into(),
            options: vec![],
            artifacts: vec!["artifact:1".into()],
            thread_root_comment_id: None,
            thread_root_comment_url: None,
            last_processed_comment_id: None,
            accepted_command: None,
            ignored_commands: vec![],
            response: None,
            waiting_started_at: None,
            agent_input_tokens: 0,
            agent_output_tokens: 0,
            agent_total_tokens: 0,
            requested_at: Utc::now(),
            resolved_at: None,
        }
    }

    #[test]
    fn observation_uses_interaction_identity_and_opaque_kind() {
        let observation =
            awaiting_interaction_observation(&interaction(InteractionStatus::Open)).unwrap();
        assert_eq!(observation.identity.producer_key, "request-1");
        assert_eq!(observation.identity.subject_ref, "issue-514");
        assert_eq!(observation.identity.kind, AWAITING_INPUT_KIND);
    }

    #[test]
    fn close_requires_evidence_that_differs_after_resolution() {
        let before = interaction(InteractionStatus::Open);
        let mut after = before.clone();
        after.status = InteractionStatus::Resolved;
        after.resolved_at = Some(Utc::now());
        let close = interaction_attention_close(&before, &after).unwrap();
        assert_ne!(
            close.expected_fingerprint,
            close.closing_evidence.fingerprint
        );
    }

    #[test]
    fn close_from_open_observation_uses_its_latest_fingerprint() {
        let before = interaction(InteractionStatus::Open);
        let observation = awaiting_interaction_observation(&before).unwrap();
        let open_item = AttentionItem {
            identity: observation.identity,
            presentation: observation.presentation,
            evidence: AttentionEvidence::new("latest-open-fingerprint").unwrap(),
            state: AttentionLifecycleState::Open,
            opened_at: before.requested_at,
            updated_at: before.requested_at,
            closed_at: None,
            superseding_identity: None,
        };
        let mut resolved = before;
        resolved.status = InteractionStatus::Resolved;
        resolved.resolved_at = Some(Utc::now());

        let close = interaction_attention_close_from_open(&open_item, &resolved)
            .unwrap()
            .unwrap();

        assert_eq!(close.expected_fingerprint, "latest-open-fingerprint");
        assert_ne!(
            close.expected_fingerprint,
            close.closing_evidence.fingerprint
        );
    }

    #[test]
    fn observation_bounds_and_filters_interaction_artifact_references() {
        let mut request = interaction(InteractionStatus::Open);
        request.artifacts = (0..20).map(|index| format!("artifact:{index}")).collect();
        request.artifacts.push("bad\u{0000}artifact".into());
        request.artifacts.push("x".repeat(1025));

        let observation = awaiting_interaction_observation(&request).unwrap();

        assert_eq!(
            observation.presentation.references.len(),
            MAX_REFERENCE_COUNT
        );
        assert!(!observation
            .presentation
            .references
            .iter()
            .any(|reference| reference.contains('\u{0000}')));
    }
}

use sha2::{Digest, Sha256};

const READABLE_PREFIX_MAX_BYTES: usize = 80;

/// Returns one deterministic, path-safe workspace key for an immutable issue identity.
///
/// The readable identifier prefix is only diagnostic. The full SHA-256 suffix,
/// computed from a length-framed identity pair, is the ownership-bearing part.
pub fn issue_workspace_key(issue_id: &str, identifier: &str) -> String {
    let mut prefix: String = identifier
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(READABLE_PREFIX_MAX_BYTES)
        .collect();
    if prefix.is_empty() || prefix == "." || prefix == ".." {
        prefix = "issue".to_string();
    }

    let mut digest = Sha256::new();
    for component in [issue_id.as_bytes(), identifier.as_bytes()] {
        digest.update((component.len() as u64).to_be_bytes());
        digest.update(component);
    }

    format!("{prefix}--{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::issue_workspace_key;

    #[test]
    fn workspace_key_distinguishes_former_punctuation_collisions() {
        assert_ne!(
            issue_workspace_key("issue-a", "a#b"),
            issue_workspace_key("issue-b", "a_b")
        );
    }

    #[test]
    fn workspace_key_is_deterministic_and_uses_immutable_identity() {
        assert_eq!(
            issue_workspace_key("NODE_123", "repo#42"),
            issue_workspace_key("NODE_123", "repo#42")
        );
        assert_ne!(
            issue_workspace_key("NODE_123", "repo#42"),
            issue_workspace_key("NODE_456", "repo#42")
        );
    }

    #[test]
    fn workspace_key_is_a_bounded_safe_path_segment() {
        let key = issue_workspace_key(
            "../NODE/💥",
            &format!("{}../nested/💥", "very-long-identifier".repeat(20)),
        );

        assert!(key.len() <= 146);
        assert!(!key.is_empty());
        assert_ne!(key, ".");
        assert_ne!(key, "..");
        assert!(key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)));
        assert!(!key.contains('/'));
    }

    #[test]
    fn workspace_key_digest_matches_length_framed_fixed_vector() {
        assert_eq!(
            issue_workspace_key("NODE_ABC", "test-repo#7"),
            "test-repo_7--97cce6aedbaacd2ef8fe4118ccad1dc1895f549d08dce5ef24069e3111c1c1bb"
        );
    }
}

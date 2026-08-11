use sha2::{Digest, Sha256};

const READABLE_PREFIX_MAX_BYTES: usize = 80;

/// Returns one deterministic, path-safe workspace key for an immutable issue identity.
///
/// The readable issue-ID prefix is only diagnostic. The full SHA-256 suffix,
/// computed from the length-framed immutable issue ID, is the ownership-bearing part.
pub fn issue_workspace_key(issue_id: &str) -> String {
    let mut prefix: String = issue_id
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
    digest.update((issue_id.len() as u64).to_be_bytes());
    digest.update(issue_id.as_bytes());

    format!("{prefix}--{}", hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::issue_workspace_key;

    #[test]
    fn workspace_key_distinguishes_former_punctuation_collisions() {
        assert_ne!(issue_workspace_key("a#b"), issue_workspace_key("a_b"));
    }

    #[test]
    fn workspace_key_is_deterministic_and_uses_immutable_identity() {
        assert_eq!(
            issue_workspace_key("NODE_123"),
            issue_workspace_key("NODE_123")
        );
        assert_ne!(
            issue_workspace_key("NODE_123"),
            issue_workspace_key("NODE_456")
        );
    }

    #[test]
    fn workspace_key_is_a_bounded_safe_path_segment() {
        let key = issue_workspace_key(&format!(
            "{}../NODE/nested/💥",
            "very-long-issue-id".repeat(20)
        ));

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
            issue_workspace_key("NODE_ABC"),
            "NODE_ABC--da02292e1c3dea3ff44b5e49011f57890f5d02eb400295469ecec963c7079932"
        );
    }
}

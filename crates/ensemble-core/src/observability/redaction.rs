pub fn truncate_for_log(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let prefix: String = input.chars().take(max_chars).collect();
    format!("{prefix}…")
}

pub fn redact_kv(input: &str) -> String {
    const PREFIXES: [&str; 4] = ["api_token=", "authorization=", "token=", "password="];
    for prefix in PREFIXES {
        if input.starts_with(prefix) {
            return format!("{prefix}[REDACTED]");
        }
    }
    input.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_preserves_prefix_and_marks_ellipsis() {
        let out = truncate_for_log("abcdefghijklmnopqrstuvwxyz", 8);
        assert_eq!(out, "abcdefgh…");
    }

    #[test]
    fn redact_token_masks_known_keys() {
        let out = redact_kv("api_token=abc123");
        assert_eq!(out, "api_token=[REDACTED]");
    }
}

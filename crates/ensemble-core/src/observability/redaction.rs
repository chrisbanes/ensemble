use serde_json::Value;

pub fn truncate_for_log(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let prefix: String = input.chars().take(max_chars).collect();
    format!("{prefix}…")
}

pub fn redact_kv(input: &str) -> String {
    const PREFIXES: [&str; 4] = ["api_token=", "authorization=", "token=", "password="];
    const REDACTED: &str = "[REDACTED]";

    if let Ok(mut json) = serde_json::from_str::<Value>(input) {
        redact_json_value(&mut json);
        if let Ok(serialized) = serde_json::to_string(&json) {
            return serialized;
        }
    }

    for prefix in PREFIXES {
        if input.starts_with(prefix) {
            return format!("{prefix}{REDACTED}");
        }
    }
    input.to_string()
}

fn redact_json_value(value: &mut Value) {
    const SECRET_KEYS: [&str; 6] = [
        "token",
        "authorization",
        "api_key",
        "api_token",
        "password",
        "apikey",
    ];

    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if SECRET_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
                    *child = Value::String("[REDACTED]".to_string());
                } else {
                    redact_json_value(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_json_value(item);
            }
        }
        _ => {}
    }
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

    #[test]
    fn redact_masks_all_supported_prefixes() {
        assert_eq!(redact_kv("authorization=abc123"), "authorization=[REDACTED]");
        assert_eq!(redact_kv("token=abc123"), "token=[REDACTED]");
        assert_eq!(redact_kv("password=abc123"), "password=[REDACTED]");
    }

    #[test]
    fn redact_passthrough_non_matching_prefix() {
        assert_eq!(redact_kv("hello=world"), "hello=world");
    }

    #[test]
    fn redact_json_payload_secrets() {
        let input = r#"{"method":"initialize","params":{"token":"abc123","authorization":"bearer xyz","api_key":"sekret","keep":"ok"}}"#;
        let out = redact_kv(input);
        assert!(out.contains(r#""token":"[REDACTED]""#));
        assert!(out.contains(r#""authorization":"[REDACTED]""#));
        assert!(out.contains(r#""api_key":"[REDACTED]""#));
        assert!(out.contains(r#""keep":"ok""#));
    }
}

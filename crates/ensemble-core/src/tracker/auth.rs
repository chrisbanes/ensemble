use std::process::Command;

pub(super) fn resolve_github_token(explicit: Option<&str>) -> Option<String> {
    if let Some(token) = normalize_token(explicit) {
        return Some(token);
    }

    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if let Some(token) = normalize_token(Some(token.as_str())) {
            return Some(token);
        }
    }

    gh_auth_token()
}

fn gh_auth_token() -> Option<String> {
    let gh_bin = std::env::var("ENSEMBLE_GH_BIN").unwrap_or_else(|_| "gh".to_string());
    let output = Command::new(gh_bin)
        .arg("auth")
        .arg("token")
        .arg("--hostname")
        .arg("github.com")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    normalize_token(Some(stdout.as_str()))
}

fn normalize_token(token: Option<&str>) -> Option<String> {
    let token = token?.trim();
    (!token.is_empty()).then(|| token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_token_trims_and_filters_empty_values() {
        assert_eq!(
            normalize_token(Some("  token  ")),
            Some("token".to_string())
        );
        assert_eq!(normalize_token(Some("   ")), None);
        assert_eq!(normalize_token(None), None);
    }
}

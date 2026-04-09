use std::process::Command;

pub(super) fn resolve_github_token(
    explicit: Option<&str>,
    endpoint: Option<&str>,
    configured_hostname: Option<&str>,
) -> Option<String> {
    if let Some(token) = normalize_token(explicit) {
        return Some(token);
    }

    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if let Some(token) = normalize_token(Some(token.as_str())) {
            return Some(token);
        }
    }

    gh_auth_token(endpoint, configured_hostname)
}

fn gh_auth_token(endpoint: Option<&str>, configured_hostname: Option<&str>) -> Option<String> {
    let gh_bin = std::env::var("ENSEMBLE_GH_BIN").unwrap_or_else(|_| "gh".to_string());
    let hostname = gh_hostname(endpoint, configured_hostname);
    let output = Command::new(gh_bin)
        .arg("auth")
        .arg("token")
        .arg("--hostname")
        .arg(hostname)
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

fn gh_hostname(endpoint: Option<&str>, configured_hostname: Option<&str>) -> String {
    if let Some(hostname) = normalize_token(configured_hostname) {
        return hostname;
    }

    if let Some(endpoint) = endpoint {
        if let Ok(url) = reqwest::Url::parse(endpoint) {
            if let Some(host) = url.host_str() {
                if host.eq_ignore_ascii_case("api.github.com") {
                    return "github.com".to_string();
                }
                return host.to_string();
            }
        }
    }

    std::env::var("ENSEMBLE_GH_HOST")
        .ok()
        .or_else(|| std::env::var("GH_HOST").ok())
        .and_then(|v| normalize_token(Some(v.as_str())))
        .unwrap_or_else(|| "github.com".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env::ENV_LOCK;

    #[test]
    fn normalize_token_trims_and_filters_empty_values() {
        assert_eq!(
            normalize_token(Some("  token  ")),
            Some("token".to_string())
        );
        assert_eq!(normalize_token(Some("   ")), None);
        assert_eq!(normalize_token(None), None);
    }

    #[test]
    fn gh_hostname_maps_public_api_host_to_github_dot_com() {
        assert_eq!(
            gh_hostname(Some("https://api.github.com/graphql"), None),
            "github.com".to_string()
        );
    }

    #[test]
    fn gh_hostname_uses_endpoint_host_for_enterprise() {
        assert_eq!(
            gh_hostname(Some("https://ghe.example.com/api/graphql"), None),
            "ghe.example.com".to_string()
        );
    }

    #[test]
    fn gh_hostname_prefers_configured_hostname() {
        assert_eq!(
            gh_hostname(Some("https://api.github.com/graphql"), Some("ghe.internal")),
            "ghe.internal".to_string()
        );
    }

    #[test]
    fn gh_hostname_trims_env_host_values() {
        let _lock = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = std::env::var("ENSEMBLE_GH_HOST").ok();
        std::env::set_var("ENSEMBLE_GH_HOST", "  ghe.env.example.com  ");

        assert_eq!(gh_hostname(None, None), "ghe.env.example.com".to_string());

        match original {
            Some(value) => std::env::set_var("ENSEMBLE_GH_HOST", value),
            None => std::env::remove_var("ENSEMBLE_GH_HOST"),
        }
    }
}

use std::process::Command;

pub(super) fn resolve_github_token(
    explicit: Option<&str>,
    endpoint: Option<&str>,
) -> Option<String> {
    if let Some(token) = normalize_token(explicit) {
        return Some(token);
    }

    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if let Some(token) = normalize_token(Some(token.as_str())) {
            return Some(token);
        }
    }

    gh_auth_token(endpoint)
}

fn gh_auth_token(endpoint: Option<&str>) -> Option<String> {
    let gh_bin = std::env::var("ENSEMBLE_GH_BIN").unwrap_or_else(|_| "gh".to_string());
    let hostname = gh_hostname(endpoint);
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

fn gh_hostname(endpoint: Option<&str>) -> String {
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
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "github.com".to_string())
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

    #[test]
    fn gh_hostname_maps_public_api_host_to_github_dot_com() {
        assert_eq!(
            gh_hostname(Some("https://api.github.com/graphql")),
            "github.com".to_string()
        );
    }

    #[test]
    fn gh_hostname_uses_endpoint_host_for_enterprise() {
        assert_eq!(
            gh_hostname(Some("https://ghe.example.com/api/graphql")),
            "ghe.example.com".to_string()
        );
    }
}

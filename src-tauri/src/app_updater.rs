use serde::{Deserialize, Serialize};
use url::Url;

pub const PLACEHOLDER_REPO_SEGMENT: &str = "/OWNER/REPO/";
pub const PLACEHOLDER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEEzMEU4NUI2MzgwREQxQTYKUldTbTBRMDR0b1VPbzBsaldBc0w1SExSdUYrSVR3bHRvNGhlcmVpR3d6SkNZbGJNdHBqZ1hoNjMK";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub configured: bool,
    pub releases_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateRelease {
    pub version: String,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub releases_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AppUpdateCheckResult {
    #[serde(rename_all = "camelCase")]
    Unconfigured {
        current_version: String,
        releases_url: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    UpToDate {
        current_version: String,
        releases_url: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        current_version: String,
        release: AppUpdateRelease,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum AppUpdateDownloadProgress {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress {
        downloaded_bytes: u64,
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Finished {
        downloaded_bytes: u64,
        content_length: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedUpdaterConfig {
    pub configured: bool,
    pub endpoints: Vec<Url>,
    pub pubkey: String,
    pub releases_url: Option<String>,
    pub allow_insecure_local_http: bool,
}

pub fn resolve_updater_config(
    configured_endpoints: &[String],
    configured_pubkey: &str,
    env_endpoint: Option<&str>,
    env_pubkey: Option<&str>,
) -> Result<ResolvedUpdaterConfig, String> {
    let env_endpoints = env_endpoint
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
    let from_env_endpoint = env_endpoints.as_ref().is_some_and(|list| !list.is_empty());

    let raw_endpoints = match env_endpoints {
        Some(list) if !list.is_empty() => list,
        _ => configured_endpoints
            .iter()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .collect(),
    };

    let raw_pubkey = env_pubkey
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| configured_pubkey.trim());

    let has_placeholder_endpoint = raw_endpoints.iter().any(|endpoint| {
        endpoint
            .to_ascii_lowercase()
            .contains(&PLACEHOLDER_REPO_SEGMENT.to_ascii_lowercase())
    });

    if raw_endpoints.is_empty()
        || has_placeholder_endpoint
        || raw_pubkey.is_empty()
        || raw_pubkey == PLACEHOLDER_PUBKEY
    {
        return Ok(ResolvedUpdaterConfig {
            configured: false,
            endpoints: Vec::new(),
            pubkey: String::new(),
            releases_url: None,
            allow_insecure_local_http: false,
        });
    }

    let mut endpoints = Vec::with_capacity(raw_endpoints.len());
    let mut allow_insecure_local_http = false;
    for raw in raw_endpoints {
        let parsed = Url::parse(&raw).map_err(|error| format!("更新源地址无效：{error}"))?;
        if parsed.scheme() == "https" {
            endpoints.push(parsed);
            continue;
        }
        let is_local_debug_http = cfg!(debug_assertions)
            && from_env_endpoint
            && parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
        if is_local_debug_http {
            allow_insecure_local_http = true;
            endpoints.push(parsed);
        } else {
            return Err("更新源地址必须使用 HTTPS。".to_owned());
        }
    }

    let releases_url = endpoints.iter().find_map(derive_releases_url);

    Ok(ResolvedUpdaterConfig {
        configured: true,
        endpoints,
        pubkey: raw_pubkey.to_owned(),
        releases_url,
        allow_insecure_local_http,
    })
}

pub fn derive_releases_url(endpoint: &Url) -> Option<String> {
    if endpoint.scheme() != "https" || endpoint.host_str() != Some("github.com") {
        return None;
    }
    let segments = endpoint.path_segments()?.collect::<Vec<_>>();
    if segments.len() < 3 || segments[2] != "releases" {
        return None;
    }
    let owner = segments[0];
    let repo = segments[1];
    if !is_valid_github_slug(owner)
        || !is_valid_github_slug(repo)
        || (owner.eq_ignore_ascii_case("OWNER") && repo.eq_ignore_ascii_case("REPO"))
    {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}/releases"))
}

pub fn validate_release_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "发布页链接无效。".to_owned())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("仅支持打开 GitHub 官方发布页面。".to_owned());
    }

    let raw_segments: Vec<&str> = parsed
        .path_segments()
        .ok_or_else(|| "发布页链接格式无效。".to_owned())?
        .collect();
    let segments = match raw_segments.last() {
        Some(&"") => &raw_segments[..raw_segments.len().saturating_sub(1)],
        _ => &raw_segments[..],
    };
    if segments.len() < 3
        || segments[2] != "releases"
        || segments.iter().any(|segment| {
            segment.is_empty() || *segment == "." || *segment == ".."
        })
        || !is_valid_github_slug(segments[0])
        || !is_valid_github_slug(segments[1])
        || (segments[0].eq_ignore_ascii_case("OWNER")
            && segments[1].eq_ignore_ascii_case("REPO"))
    {
        return Err("发布页链接必须是有效的 GitHub Releases 地址。".to_owned());
    }

    Ok(parsed)
}

pub fn classify_install_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("read-only file system")
        || lower.contains("readonly")
        || lower.contains("erofs")
        || lower.contains("/volumes/")
        || lower.contains("same mount point")
        || lower.contains("mount point")
        || lower.contains("permission denied")
        || lower.contains("operation not permitted")
        || lower.contains("os error 30")
        || lower.contains("os error 13")
        || lower.contains("os error 1")
    {
        "readonlyVolume"
    } else if lower.contains("signature") || lower.contains("minisign") || lower.contains("pubkey") {
        "signature"
    } else if lower.contains("network")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("dns")
        || lower.contains("connection")
        || lower.contains("status:")
    {
        "network"
    } else {
        "unknown"
    }
}

pub fn format_install_error(message: &str) -> String {
    if classify_install_error(message) == "readonlyVolume" {
        format!(
            "READONLY_VOLUME: 无法替换当前应用目录（可能正从只读磁盘映像 .dmg 中运行，或缺少写入权限）。请先将 Skill Library.app 拖入「应用程序」目录后再试，或前往 GitHub Releases 手动下载。（{message}）"
        )
    } else {
        format!("应用更新安装失败：{message}")
    }
}

fn is_valid_github_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && !value.starts_with('.')
        && !value.ends_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_placeholder_config_as_unconfigured() {
        let resolved = resolve_updater_config(
            &["https://github.com/OWNER/REPO/releases/latest/download/latest.json".into()],
            PLACEHOLDER_PUBKEY,
            None,
            None,
        )
        .unwrap();
        assert!(!resolved.configured);
        assert!(resolved.endpoints.is_empty());
        assert!(resolved.releases_url.is_none());
    }

    #[test]
    fn resolves_real_github_release_config_and_derives_releases_url() {
        let resolved = resolve_updater_config(
            &["https://github.com/acme/skill-library/releases/latest/download/latest.json".into()],
            "dW50cnVzdGVkIGNvbW1lbnQ6IHJlYWwgcHVia2V5Cg==",
            None,
            None,
        )
        .unwrap();
        assert!(resolved.configured);
        assert_eq!(resolved.endpoints.len(), 1);
        assert_eq!(
            resolved.releases_url.as_deref(),
            Some("https://github.com/acme/skill-library/releases")
        );
        assert!(!resolved.allow_insecure_local_http);
    }

    #[test]
    fn rejects_insecure_non_local_endpoints_even_with_env_override() {
        let err = resolve_updater_config(
            &["https://github.com/OWNER/REPO/releases/latest/download/latest.json".into()],
            PLACEHOLDER_PUBKEY,
            Some("http://example.com/latest.json"),
            Some("dW50cnVzdGVkIGNvbW1lbnQ6IGRldgo="),
        )
        .unwrap_err();
        assert!(err.contains("HTTPS"));
    }

    #[test]
    fn allows_local_http_override_in_debug_builds() {
        let resolved = resolve_updater_config(
            &["https://github.com/OWNER/REPO/releases/latest/download/latest.json".into()],
            PLACEHOLDER_PUBKEY,
            Some("http://127.0.0.1:8787/latest.json"),
            Some("dW50cnVzdGVkIGNvbW1lbnQ6IGRldgo="),
        )
        .unwrap();
        assert_eq!(resolved.configured, true);
        assert_eq!(resolved.allow_insecure_local_http, cfg!(debug_assertions));
        assert!(resolved.releases_url.is_none());
    }

    #[test]
    fn validate_release_url_accepts_github_releases_and_rejects_others() {
        assert!(validate_release_url("https://github.com/acme/skill-library/releases").is_ok());
        assert!(
            validate_release_url("https://github.com/acme/skill-library/releases/tag/v0.2.0")
                .is_ok()
        );
        assert!(validate_release_url("http://github.com/acme/skill-library/releases").is_err());
        assert!(validate_release_url("https://evil.com/acme/skill-library/releases").is_err());
        assert!(validate_release_url("https://github.com/OWNER/REPO/releases").is_err());
        assert!(validate_release_url("https://github.com/acme/skill-library/issues").is_err());
        assert!(validate_release_url("https://user@github.com/acme/repo/releases").is_err());
    }

    #[test]
    fn classifies_readonly_dmg_and_permission_errors() {
        assert_eq!(
            classify_install_error("Read-only file system (os error 30)"),
            "readonlyVolume"
        );
        assert_eq!(
            classify_install_error("Permission denied while replacing /Volumes/Skill Library"),
            "readonlyVolume"
        );
        assert!(format_install_error("Read-only file system").starts_with("READONLY_VOLUME:"));
    }
}

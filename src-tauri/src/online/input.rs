use crate::{LibraryError, PackageSource};
use std::path::PathBuf;
use url::Url;

pub(crate) const INVALID_SOURCE: &str =
    "无法识别此安装来源。请粘贴 HTTPS Git 仓库链接，或选择「从本地导入」。";

#[derive(Debug, Clone)]
pub struct SourceRequest {
    pub(super) repository: String,
    pub(super) name: String,
    pub(super) locator: Locator,
    pub(super) skills: Vec<String>,
}

#[derive(Debug, Clone)]
pub(super) enum Locator {
    Default,
    Reference(String),
    GitHubTree(Vec<String>),
}

impl SourceRequest {
    pub fn parse(input: &str) -> Result<Self, LibraryError> {
        let invalid = || LibraryError::new(INVALID_SOURCE);
        let mut tokens = input.split_whitespace();
        let first = tokens.next().ok_or_else(invalid)?;
        let (source, skills) = if matches!(first, "npx" | "pnpx" | "pnpm" | "bunx") {
            parse_cli_command(first, &mut tokens).ok_or_else(invalid)?
        } else {
            if tokens.next().is_some() {
                return Err(invalid());
            }
            (first, Vec::new())
        };

        let mut request = parse_repository(source).ok_or_else(invalid)?;
        request.skills = skills;
        Ok(request)
    }

    /// Uses the recorded branch, tag, or commit. Older records without a ref resolve the current default.
    pub fn from_provenance(source: &PackageSource) -> Result<Self, LibraryError> {
        let mut request = Self::parse(&source.repository)?;
        if let Some(reference) = &source.reference {
            if !valid_reference(reference) {
                return Err(LibraryError::new(INVALID_SOURCE));
            }
            request.locator = Locator::Reference(reference.clone());
        }
        Ok(request)
    }
}

fn parse_repository(input: &str) -> Option<SourceRequest> {
    let shorthand;
    let input = if input.starts_with("https://") {
        input
    } else {
        let (owner, repo) = input.split_once('/')?;
        if !valid_name(owner) || !valid_name(repo) {
            return None;
        }
        shorthand = format!("https://github.com/{input}");
        &shorthand
    };
    let (without_fragment, fragment) = input
        .split_once('#')
        .map_or((input, None), |(url, fragment)| (url, Some(fragment)));
    let (authority, path) = without_fragment.strip_prefix("https://")?.split_once('/')?;
    if authority.contains(['@', '\\']) {
        return None;
    }
    let parts = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    if parts.iter().any(|part| !valid_name(part)) {
        return None;
    }
    let mut repository = Url::parse(without_fragment).ok()?;
    if repository.host_str().is_none() || repository.query().is_some() {
        return None;
    }

    let mut locator = match fragment {
        Some(fragment) => {
            let reference = fragment.strip_prefix("ref=")?;
            if !valid_reference(reference) {
                return None;
            }
            Locator::Reference(reference.to_owned())
        }
        None => Locator::Default,
    };

    let repo = if repository.host_str() == Some("github.com") && repository.port().is_none() {
        if parts.len() < 2 {
            return None;
        }
        match &parts[2..] {
            [] => {}
            ["tree", rest @ ..] if !rest.is_empty() && fragment.is_none() => {
                locator = Locator::GitHubTree(rest.iter().map(|part| (*part).to_owned()).collect());
            }
            _ => return None,
        }
        let name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        if !valid_name(name) {
            return None;
        }
        repository.set_path(&format!(
            "/{}/{}.git",
            parts[0].to_ascii_lowercase(),
            name.to_ascii_lowercase()
        ));
        parts[1]
    } else {
        repository.set_path(&parts.join("/"));
        parts[parts.len() - 1]
    };
    let name = repo.strip_suffix(".git").unwrap_or(repo);
    if !valid_name(name) {
        return None;
    }

    Some(SourceRequest {
        repository: repository.to_string(),
        name: name.to_owned(),
        locator,
        skills: Vec::new(),
    })
}

fn parse_cli_command<'a>(
    first: &'a str,
    tokens: &mut std::str::SplitWhitespace<'a>,
) -> Option<(&'a str, Vec<String>)> {
    let package = match first {
        "npx" => {
            let mut token = tokens.next()?;
            while matches!(token, "-y" | "--yes") {
                token = tokens.next()?;
            }
            token
        }
        "pnpx" | "bunx" => tokens.next()?,
        "pnpm" => {
            if tokens.next()? != "dlx" {
                return None;
            }
            tokens.next()?
        }
        _ => return None,
    };

    if !is_skills_package(package) || tokens.next()? != "add" {
        return None;
    }

    let source = tokens.next()?;
    let mut skills = Vec::new();
    while let Some(flag) = tokens.next() {
        if let Some(skill) = flag
            .strip_prefix("--skill=")
            .or_else(|| flag.strip_prefix("-s="))
        {
            if !valid_name(skill) || skill.starts_with('-') {
                return None;
            }
            skills.push(skill.to_owned());
            continue;
        }
        if !matches!(flag, "--skill" | "-s") {
            return None;
        }
        let mut count = 0;
        while let Some(skill) = tokens
            .clone()
            .next()
            .filter(|token| valid_name(token) && !token.starts_with('-'))
        {
            skills.push(skill.to_owned());
            tokens.next();
            count += 1;
        }
        if count == 0 {
            return None;
        }
    }
    Some((source, skills))
}

fn is_skills_package(token: &str) -> bool {
    token == "skills"
        || token
            .strip_prefix("skills@")
            .is_some_and(valid_package_version)
}

fn valid_package_version(text: &str) -> bool {
    valid_name(text) && !text.starts_with(['.', '-'])
}

fn valid_name(text: &str) -> bool {
    !text.is_empty()
        && !matches!(text, "." | "..")
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

pub(super) fn valid_reference(reference: &str) -> bool {
    if is_commit(reference) {
        return true;
    }
    let Some(name) = reference
        .strip_prefix("refs/heads/")
        .or_else(|| reference.strip_prefix("refs/tags/"))
    else {
        return false;
    };
    !name.contains("..")
        && !name.ends_with('.')
        && name
            .split('/')
            .all(|part| valid_name(part) && !part.starts_with('.') && !part.ends_with(".lock"))
}

pub(crate) fn is_commit(reference: &str) -> bool {
    reference.len() == 40 && reference.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn scope(parts: &[String]) -> PathBuf {
    parts.iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versioned_skills_cli_commands_and_runners() {
        let request = SourceRequest::parse("npx skills@latest add mattpocock/skills").unwrap();
        assert_eq!(request.repository, "https://github.com/mattpocock/skills.git");
        assert_eq!(request.name, "skills");
        assert!(request.skills.is_empty());

        let request = SourceRequest::parse(
            "npx skills@1.2.3-beta.1 add mattpocock/skills --skill=tdd -s polish review",
        )
        .unwrap();
        assert_eq!(request.repository, "https://github.com/mattpocock/skills.git");
        assert_eq!(request.name, "skills");
        assert_eq!(request.skills, vec!["tdd", "polish", "review"]);

        for command in [
            "npx -y skills@latest add mattpocock/skills",
            "npx --yes skills add mattpocock/skills",
            "pnpx skills@latest add mattpocock/skills",
            "pnpm dlx skills@latest add mattpocock/skills",
            "bunx skills@latest add mattpocock/skills",
        ] {
            let parsed = SourceRequest::parse(command).unwrap();
            assert_eq!(parsed.repository, "https://github.com/mattpocock/skills.git");
            assert_eq!(parsed.name, "skills");
            assert!(parsed.skills.is_empty());
        }
    }

    #[test]
    fn rejects_invalid_package_versions_and_unsupported_cli_flags() {
        for input in [
            "npx skills@ add mattpocock/skills",
            "npx skills@.. add mattpocock/skills",
            "npx skills@-y add mattpocock/skills",
            "npx skills@latest;rm add mattpocock/skills",
            "npx @scope/skills add mattpocock/skills",
            "npx other@latest add mattpocock/skills",
            "npx -y",
            "npx skills@latest add mattpocock/skills --skill=",
            "npx skills@latest add mattpocock/skills --skill=-bad",
            "npx skills@latest add mattpocock/skills --agent claude-code",
            "pnpm add skills mattpocock/skills",
            "pnpm dlx other add mattpocock/skills",
        ] {
            let message = SourceRequest::parse(input).unwrap_err().to_string();
            assert_eq!(message, INVALID_SOURCE, "expected rejection for {input}");
        }
    }
}

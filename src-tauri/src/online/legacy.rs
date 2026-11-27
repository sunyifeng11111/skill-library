use super::input::{is_commit, valid_reference, Locator, SourceRequest};
use crate::PackageSource;

/// Translate legacy Git metadata using the installer parser, without resolving or downloading.
pub(crate) fn legacy_provenance(
    input: &str,
    branch: Option<&str>,
    member_path: Option<&str>,
    revision: Option<&str>,
) -> Option<PackageSource> {
    let request = SourceRequest::parse(input).ok()?;
    let branch = branch
        .filter(|branch| !branch.is_empty())
        .map(branch_reference);
    let member = member_path.filter(|path| !matches!(*path, "" | "."));
    if member.is_some_and(|path| {
        path.contains(['\\', '\0']) || path.split('/').any(|part| matches!(part, "" | "." | ".."))
    }) {
        return None;
    }
    let (reference, scope) = match request.locator {
        Locator::Default => (branch, None),
        Locator::Reference(reference) => (branch.or(Some(reference)), None),
        Locator::GitHubTree(parts) => {
            let reference = match branch {
                Some(reference) => reference,
                None if parts.len() == 1 => branch_reference(&parts[0]),
                None => {
                    // Without the branch, use an explicit member path to split a tree URL.
                    let suffix = member?.split('/').map(str::to_owned).collect::<Vec<_>>();
                    branch_reference(&parts.strip_suffix(suffix.as_slice())?.join("/"))
                }
            };
            let short = reference
                .strip_prefix("refs/heads/")
                .or_else(|| reference.strip_prefix("refs/tags/"))
                .unwrap_or(&reference);
            let prefix = short.split('/').map(str::to_owned).collect::<Vec<_>>();
            let scope = parts.strip_prefix(prefix.as_slice())?.join("/");
            (Some(reference), (!scope.is_empty()).then_some(scope))
        }
    };
    if reference
        .as_deref()
        .is_some_and(|reference| !valid_reference(reference))
    {
        return None;
    }
    let member_path = match member_path {
        Some(".") => ".".into(),
        _ => member
            .map(str::to_owned)
            .or(scope)
            .unwrap_or_else(|| ".".into()),
    };
    Some(PackageSource {
        repository: request.repository,
        member_path,
        revision: revision
            .filter(|revision| is_commit(revision))
            .unwrap_or_default()
            .to_ascii_lowercase(),
        reference,
    })
}

fn branch_reference(branch: &str) -> String {
    if branch.starts_with("refs/") || is_commit(branch) {
        branch.to_owned()
    } else {
        format!("refs/heads/{branch}")
    }
}

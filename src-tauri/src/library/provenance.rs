//! Where an unmanaged skill came from: `skills add` lock files or the Git checkout it lives in.

use crate::PackageSource;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

// skills add records identify installations in the canonical .agents/skills tree.
pub(super) fn installation_records(directory: &Path) -> Option<serde_json::Value> {
    let base = directory.parent()?.parent()?;
    if directory != base.join(".agents/skills") {
        return None;
    }
    let global = std::env::var_os("HOME")
        .and_then(|home| fs::canonicalize(home).ok())
        .as_deref()
        == Some(base);
    let (file, version) = if global {
        let state = std::env::var_os("XDG_STATE_HOME")
            .filter(|s| !s.is_empty())
            .map(|s| PathBuf::from(s).join("skills"))
            .unwrap_or_else(|| base.join(".agents"));
        (state.join(".skill-lock.json"), 3)
    } else {
        (base.join("skills-lock.json"), 1)
    };
    if !file.is_file() {
        return None;
    }
    let record: serde_json::Value = serde_json::from_reader(File::open(file).ok()?).ok()?;
    (record["version"].as_u64() == Some(version)).then_some(record)
}

pub(super) fn installed_source(
    records: Option<&serde_json::Value>,
    path: &Path,
    name: &str,
) -> Option<PackageSource> {
    if !path.file_name()?.to_str()?.eq_ignore_ascii_case(name) {
        return None;
    }
    let entry = &records?["skills"][name];
    let repo = match entry["sourceType"].as_str()? {
        "github" => entry["sourceUrl"]
            .as_str()
            .or_else(|| entry["source"].as_str())?,
        "git" | "gitlab" => entry["sourceUrl"].as_str()?,
        _ => return None,
    };
    let member = match entry["skillPath"].as_str()? {
        "SKILL.md" => ".",
        path => path
            .strip_suffix("/SKILL.md")
            .filter(|p| !p.is_empty() && *p != ".")?,
    };
    crate::online::legacy_provenance(repo, entry["ref"].as_str(), Some(member), None)
}

// A committed manifest establishes the repository member even when its files are edited.
pub(super) fn checkout_source(path: &Path) -> Option<PackageSource> {
    let path = path.canonicalize().ok()?;
    let root = path.ancestors().find(|dir| dir.join(".git").exists())?;
    let relative = path.strip_prefix(root).ok()?.to_str()?;
    let git = |args: &[&str]| {
        let output = crate::online::isolated_git_command(root)
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_ALLOW_PROTOCOL", "")
            .args(["--no-optional-locks", "--literal-pathspecs"])
            .args(args)
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).ok())?
            .map(|s| s.trim_end().to_owned())
    };
    let manifest = if relative.is_empty() {
        "SKILL.md".into()
    } else {
        format!("{relative}/SKILL.md")
    };
    if git(&["ls-tree", "HEAD", "--", &manifest])?.is_empty() {
        return None;
    }
    let head = git(&["symbolic-ref", "HEAD"])?;
    let branch = head.strip_prefix("refs/heads/")?;
    let config = |key: &str| git(&["config", "--local", "--get-all", key]);
    let remote = config(&format!("branch.{branch}.remote"));
    let merge = config(&format!("branch.{branch}.merge"));
    let remotes = git(&["remote"])?;
    let (remote, reference) = match (remote, merge) {
        (Some(remote), Some(reference))
            if remotes.lines().any(|r| r == remote)
                && reference.starts_with("refs/heads/")
                && !reference.contains('\n') =>
        {
            (remote, Some(reference))
        }
        (None, None) if remotes == "origin" => (remotes, None),
        _ => return None,
    };
    let url = config(&format!("remote.{remote}.url"))?;
    if url.lines().count() != 1 {
        return None;
    }
    crate::online::legacy_provenance(
        &url,
        reference.as_deref(),
        Some(if relative.is_empty() { "." } else { relative }),
        None,
    )
}

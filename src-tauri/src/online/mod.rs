mod git;
mod input;
mod legacy;

pub(crate) use git::isolated_git_command;
pub use git::GitSource;
pub(crate) use input::is_commit;
pub use input::SourceRequest;
pub(crate) use legacy::legacy_provenance;

use crate::{ImportSelection, Library, LibraryError, PackageSource, PreviewMember, PreviewStatus};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tempfile::TempDir;

#[derive(Clone, Default)]
pub struct SourceCancellation(Arc<AtomicBool>);

impl SourceCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub(crate) fn check(&self) -> Result<(), LibraryError> {
        if self.0.load(Ordering::Relaxed) {
            Err(LibraryError::new("已取消读取在线来源。"))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceProgress {
    Resolving,
    Downloading,
    ReadingMembers,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageOrigin {
    pub repository: String,
    pub reference: String,
}

impl PackageSource {
    /// Missing refs are legacy provenance, so they cannot be grouped with a known branch.
    pub fn origin(&self) -> Option<PackageOrigin> {
        Some(PackageOrigin {
            repository: self.repository.clone(),
            reference: self.reference.clone()?,
        })
    }
}

pub struct DownloadedPackage {
    _temp: TempDir,
    root: PathBuf,
    scope: PathBuf,
    unsupported: Vec<PathBuf>,
    skills: Vec<String>,
    name: String,
    origin: PackageOrigin,
    revision: String,
    committed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageProposal {
    pub name: String,
    pub origin: PackageOrigin,
    pub revision: String,
    pub members: Vec<PackageMember>,
    pub problems: Vec<PackageProblem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageMember {
    #[serde(flatten)]
    pub member: PreviewMember,
    pub source: PackageSource,
    pub already_installed: bool,
}

impl PackageMember {
    pub fn selection(&self) -> ImportSelection {
        ImportSelection {
            path: self.member.path.clone(),
            fingerprint: self.member.fingerprint.clone(),
            source: Some(self.source.clone()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageProblem {
    pub member_path: String,
    pub message: String,
}

impl GitSource {
    pub fn download(
        &self,
        request: &SourceRequest,
        cancellation: &SourceCancellation,
        mut progress: impl FnMut(SourceProgress),
    ) -> Result<DownloadedPackage, LibraryError> {
        cancellation.check()?;
        progress(SourceProgress::Resolving);
        let temp = tempfile::Builder::new()
            .prefix("skill-library-package-")
            .tempdir()
            .map_err(temporary_error)?;
        // Canonical paths also match the folders returned by Library::preview_folders.
        let base = temp.path().canonicalize().map_err(temporary_error)?;
        let git = base.join("git");
        fs::create_dir(&git).map_err(temporary_error)?;
        let (reference, scope) = self.resolve(request, &git, cancellation)?;

        cancellation.check()?;
        progress(SourceProgress::Downloading);
        let mut archive = tempfile::tempfile_in(&base).map_err(temporary_error)?;
        let (revision, committed_at) =
            self.fetch_archive(request, &reference, &git, &archive, cancellation)?;

        cancellation.check()?;
        progress(SourceProgress::ReadingMembers);
        let root = base.join("files").join(&request.name);
        fs::create_dir_all(&root).map_err(temporary_error)?;
        archive.rewind().map_err(temporary_error)?;
        let unsupported = unpack(archive, &root, cancellation)?;
        fs::remove_dir_all(&git).map_err(temporary_error)?;

        Ok(DownloadedPackage {
            _temp: temp,
            root,
            scope,
            unsupported,
            skills: request.skills.clone(),
            name: request.name.clone(),
            origin: PackageOrigin {
                repository: request.repository.clone(),
                reference: if input::is_commit(&reference) {
                    reference.to_ascii_lowercase()
                } else {
                    reference
                },
            },
            revision,
            committed_at,
        })
    }
}

impl DownloadedPackage {
    pub fn origin(&self) -> &PackageOrigin {
        &self.origin
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn committed_at(&self) -> Option<i64> {
        self.committed_at
    }

    pub(crate) fn root_exists(&self) -> bool {
        self.root.is_dir()
    }

    /// The returned member paths remain readable while this download is held.
    pub fn propose(
        &self,
        library: &Library,
        cancellation: &SourceCancellation,
    ) -> Result<PackageProposal, LibraryError> {
        cancellation.check()?;
        let mut proposal = PackageProposal {
            name: self.name.clone(),
            origin: self.origin.clone(),
            revision: self.revision.clone(),
            members: Vec::new(),
            problems: Vec::new(),
        };
        let installed = library
            .snapshot()?
            .skills
            .into_iter()
            .filter_map(|member| member.source)
            .filter(|source| source.origin().as_ref() == Some(&self.origin))
            .map(|source| source.member_path)
            .collect::<HashSet<_>>();
        let scoped = self.root.join(&self.scope);
        if !scoped.is_dir() {
            return Err(LibraryError::new(
                "此修订中找不到链接指定的目录，请检查链接。",
            ));
        }
        let mut folders = Vec::new();
        self.discover(&scoped, cancellation, &mut folders, &mut proposal.problems)?;
        if folders.is_empty() && proposal.problems.is_empty() {
            proposal.problems.push(PackageProblem {
                member_path: member_path(&self.scope),
                message: "此位置没有包含 SKILL.md 的文件夹。".into(),
            });
        }

        let mut found = HashSet::new();
        for folder in folders {
            cancellation.check()?;
            let relative = folder
                .strip_prefix(&self.root)
                .expect("discovered under the download");
            let path = member_path(relative);
            let preview = library.preview_folders(vec![folder])?;
            for problem in preview.problems {
                let message = problem
                    .message
                    .replace(self.root.to_string_lossy().as_ref(), self.name.as_str());
                proposal.problems.push(PackageProblem {
                    member_path: path.clone(),
                    message,
                });
            }
            for mut member in preview.members {
                let mut matching_names = self
                    .skills
                    .iter()
                    .filter(|requested| {
                        *requested == &member.name || *requested == &member.folder_name
                    })
                    .peekable();
                if !self.skills.is_empty() && matching_names.peek().is_none() {
                    continue;
                }
                found.extend(matching_names);
                let already_installed = installed.contains(&path);
                if already_installed {
                    member.status = PreviewStatus::Duplicate;
                }
                proposal.members.push(PackageMember {
                    member,
                    source: PackageSource {
                        repository: self.origin.repository.clone(),
                        reference: Some(self.origin.reference.clone()),
                        member_path: path.clone(),
                        revision: self.revision.clone(),
                    },
                    already_installed,
                });
            }
        }
        let mut seen = HashSet::new();
        for listed in &mut proposal.members {
            if listed.member.status == PreviewStatus::Ready
                && !seen.insert(&listed.member.fingerprint)
            {
                listed.member.status = PreviewStatus::Duplicate;
            }
        }
        for requested in &self.skills {
            if !found.contains(requested) {
                proposal.problems.push(PackageProblem {
                    member_path: requested.clone(),
                    message: "找不到此名称的可读取 Skill。".into(),
                });
            }
        }
        cancellation.check()?;
        Ok(proposal)
    }

    fn discover(
        &self,
        folder: &Path,
        cancellation: &SourceCancellation,
        folders: &mut Vec<PathBuf>,
        problems: &mut Vec<PackageProblem>,
    ) -> Result<(), LibraryError> {
        cancellation.check()?;
        let manifest = folder.join("SKILL.md");
        if manifest.is_file() || self.unsupported.contains(&manifest) {
            if let Some(entry) = self
                .unsupported
                .iter()
                .find(|entry| entry.starts_with(folder))
            {
                let relative = folder
                    .strip_prefix(&self.root)
                    .expect("discovered under the download");
                let entry = entry
                    .strip_prefix(&self.root)
                    .expect("archive member under the download");
                problems.push(PackageProblem {
                    member_path: member_path(relative),
                    message: format!(
                        "{} 是软链接或特殊文件。请使用实际文件。",
                        member_path(entry)
                    ),
                });
            } else {
                folders.push(folder.to_owned());
            }
            // A Skill includes the full directory. Nested manifests are part of that Skill.
            return Ok(());
        }

        let mut entries = fs::read_dir(folder)
            .map_err(temporary_error)?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(temporary_error)?;
        entries.sort_unstable_by_key(|entry| entry.file_name());
        for entry in entries {
            if entry.file_type().map_err(temporary_error)?.is_dir() {
                self.discover(&entry.path(), cancellation, folders, problems)?;
            }
        }
        Ok(())
    }
}

fn member_path(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".into()
    } else {
        path.iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }
}

fn unpack(
    archive: File,
    root: &Path,
    cancellation: &SourceCancellation,
) -> Result<Vec<PathBuf>, LibraryError> {
    let mut unsupported = Vec::new();
    let mut buffer = [0; 64 * 1024];
    for entry in tar::Archive::new(archive)
        .entries()
        .map_err(temporary_error)?
    {
        cancellation.check()?;
        let mut entry = entry.map_err(temporary_error)?;
        let path = entry.path().map_err(temporary_error)?;
        if !path
            .components()
            .all(|part| matches!(part, Component::Normal(name) if name != ".git"))
        {
            return Err(LibraryError::new("仓库包含无法导入的文件路径。"));
        }
        let target = root.join(path);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            fs::create_dir(&target).map_err(|err| archive_error(root, &target, err))?;
        } else if kind.is_file() {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o644 | (entry.header().mode().map_err(temporary_error)? & 0o111));
            }
            let mut file = options
                .open(&target)
                .map_err(|err| archive_error(root, &target, err))?;
            loop {
                cancellation.check()?;
                let read = entry.read(&mut buffer).map_err(temporary_error)?;
                if read == 0 {
                    break;
                }
                file.write_all(&buffer[..read]).map_err(temporary_error)?;
            }
        } else {
            // Retain the entry's name for preview errors without writing any links or special files.
            unsupported.push(target);
        }
    }
    Ok(unsupported)
}

fn archive_error(root: &Path, target: &Path, err: std::io::Error) -> LibraryError {
    let path = target
        .strip_prefix(root)
        .expect("archive member under the download");
    LibraryError::io("无法读取仓库文件，可能存在同名路径", path, err)
}

fn temporary_error(error: std::io::Error) -> LibraryError {
    LibraryError::new(format!("无法读取下载内容：{error}"))
}

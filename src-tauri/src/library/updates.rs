use super::transaction::sync_directory;
use crate::{
    files,
    online::{is_commit, DownloadedPackage, PackageOrigin, PackageProposal},
    CategoryTarget, GitSource, Library, LibraryError, LibrarySnapshot, PackageSource, Skill,
    SourceCancellation, SourceRequest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs::{self, File},
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::Arc,
};
use tempfile::{Builder, TempDir};
use url::Url;
use uuid::Uuid;

const MAX_CACHED_DOWNLOADS: usize = 16;

#[derive(Default)]
pub(super) struct UpdateDownloadCache {
    entries: Vec<(PackageOrigin, String, Arc<DownloadedPackage>)>,
}

impl UpdateDownloadCache {
    fn get(&mut self, origin: &PackageOrigin, revision: &str) -> Option<Arc<DownloadedPackage>> {
        let index = self
            .entries
            .iter()
            .position(|(cached_origin, cached_rev, _)| {
                cached_origin == origin && cached_rev == revision
            })?;
        let entry = self.entries.remove(index);
        if !entry.2.root_exists() {
            return None;
        }
        let result = Arc::clone(&entry.2);
        self.entries.push(entry);
        Some(result)
    }

    fn insert(&mut self, origin: PackageOrigin, revision: String, downloaded: Arc<DownloadedPackage>) {
        self.entries
            .retain(|(cached_origin, cached_rev, _)| !(cached_origin == &origin && cached_rev == &revision));
        self.entries.push((origin, revision, downloaded));
        while self.entries.len() > MAX_CACHED_DOWNLOADS {
            self.entries.remove(0);
        }
    }
}

/// Legacy records without a ref are checked against the default branch and remain a
/// separate group until a successful update records the resolved origin.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePackage {
    pub repository: String,
    pub reference: Option<String>,
}

impl From<&PackageSource> for UpdatePackage {
    fn from(source: &PackageSource) -> Self {
        match source.origin() {
            Some(origin) => Self {
                repository: origin.repository,
                reference: Some(origin.reference),
            },
            None => Self {
                repository: source.repository.clone(),
                reference: None,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageUpdateStatus {
    Current,
    Available,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdateCheck {
    pub package: UpdatePackage,
    pub member_ids: Vec<Uuid>,
    pub outdated_member_ids: Vec<Uuid>,
    pub status: PackageUpdateStatus,
    pub revision: Option<String>,
    pub updated_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdatePreview {
    pub outdated: Vec<OutdatedMember>,
    pub additions: Vec<UpdateAddition>,
    pub additions_confirmed: bool,
    pub updated_at: Option<i64>,
    pub from_revision: Option<String>,
    pub repository_url: Option<String>,
    pub compare_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutdatedMember {
    pub id: Uuid,
    pub name: String,
    pub skip_reason: Option<String>,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAddition {
    pub member_path: String,
    pub name: String,
    pub description: String,
    pub unavailable: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdateSelection {
    pub revision: String,
    pub backup_members: Vec<Uuid>,
    pub additions: Vec<String>,
    pub target: Option<CategoryTarget>,
    #[serde(default)]
    pub member_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdateOutcome {
    pub library: LibrarySnapshot,
    pub updated: Vec<Uuid>,
    pub added: Vec<Uuid>,
    pub skipped: Vec<OutdatedMember>,
    pub backup: Option<PathBuf>,
}

impl Library {
    pub fn check_package_updates(
        &self,
        git: &GitSource,
        cancellation: &SourceCancellation,
    ) -> Result<Vec<PackageUpdateCheck>, LibraryError> {
        let mut packages: BTreeMap<UpdatePackage, Vec<Skill>> = BTreeMap::new();
        for skill in self.snapshot()?.skills {
            if let Some(source) = &skill.source {
                packages.entry(source.into()).or_default().push(skill);
            }
        }
        Ok(packages
            .into_iter()
            .map(|(package, members)| self.check_package(git, package, &members, cancellation))
            .collect())
    }

    pub fn check_package_update(
        &self,
        git: &GitSource,
        package: &UpdatePackage,
        cancellation: &SourceCancellation,
    ) -> Result<PackageUpdateCheck, LibraryError> {
        let members = package_members(self.snapshot()?.skills, package)?;
        Ok(self.check_package(git, package.clone(), &members, cancellation))
    }

    pub fn preview_package_update(
        &self,
        git: &GitSource,
        package: &UpdatePackage,
        revision: &str,
        cancellation: &SourceCancellation,
    ) -> Result<PackageUpdatePreview, LibraryError> {
        let members = package_members(self.snapshot()?.skills, package)?;
        let source = members[0].source.as_ref().expect("grouped by package");
        let origin = resolve_package_origin(git, source, cancellation)?;
        let downloaded =
            self.get_or_download_revision(git, source, &origin, revision, false, cancellation)?;
        let proposal = downloaded.propose(self, cancellation)?;
        let offered = proposal
            .members
            .iter()
            .map(|member| (member.source.member_path.as_str(), member))
            .collect::<BTreeMap<_, _>>();
        let (previous_paths, additions_confirmed) =
            previous_paths(self, git, &members, revision, cancellation);
        cancellation.check()?;
        let mut outdated = Vec::new();
        let mut from_revisions = BTreeSet::new();
        for member in &members {
            if !is_behind(member, revision) {
                continue;
            }
            let Some(installed) = member.source.as_ref() else {
                continue;
            };
            let Some(upstream) = offered.get(installed.member_path.as_str()) else {
                continue;
            };
            if upstream.member.fingerprint == member.fingerprint {
                continue;
            }
            let path = self.managed_path(member.id)?;
            let changed_files = diff_member_files(&path, &upstream.member.path);
            let state = inspect_for_update(member, &path, false)?;
            if !installed.revision.is_empty() && installed.revision != revision {
                from_revisions.insert(installed.revision.clone());
            }
            outdated.push(OutdatedMember {
                id: member.id,
                name: member.name.clone(),
                skip_reason: state.err().and_then(|skipped| skipped.skip_reason),
                changed_files,
            });
        }
        let from_revision = from_revisions.into_iter().next();
        let (repository_url, compare_url) = build_source_urls(
            &downloaded.origin().repository,
            from_revision.as_deref(),
            revision,
            !outdated.is_empty(),
        );
        let additions = proposal
            .members
            .iter()
            .filter(|member| {
                !member.already_installed && !previous_paths.contains(&member.source.member_path)
            })
            .map(|member| UpdateAddition {
                member_path: member.source.member_path.clone(),
                name: member.member.name.clone(),
                description: member.member.description.clone(),
                unavailable: matches!(member.member.status, crate::PreviewStatus::Duplicate)
                    .then(|| "Skill 库中已有相同内容".into()),
            })
            .collect();
        Ok(PackageUpdatePreview {
            outdated,
            additions,
            additions_confirmed,
            updated_at: downloaded.committed_at(),
            from_revision,
            repository_url,
            compare_url,
        })
    }

    pub fn apply_package_update(
        &self,
        git: &GitSource,
        package: &UpdatePackage,
        selection: &PackageUpdateSelection,
        cancellation: &SourceCancellation,
    ) -> Result<PackageUpdateOutcome, LibraryError> {
        let members = package_members(self.snapshot()?.skills, package)?;
        let source = members[0].source.as_ref().expect("grouped by package");
        let origin = resolve_package_origin(git, source, cancellation)?;
        let downloaded = self.get_or_download_revision(
            git,
            source,
            &origin,
            &selection.revision,
            true,
            cancellation,
        )?;
        let proposal = downloaded.propose(self, cancellation)?;
        let (previous_paths, _) = if selection.additions.is_empty() {
            Default::default()
        } else {
            previous_paths(self, git, &members, &selection.revision, cancellation)
        };

        let observed = members
            .iter()
            .filter_map(|member| member.source.as_ref().map(|source| (member.id, source)))
            .collect::<BTreeMap<_, _>>();
        let mut registry = self.registry()?;
        let members = package_members(
            registry
                .skills
                .iter()
                .map(|member| member.skill.clone())
                .collect(),
            package,
        )?;
        let member_ids = members
            .iter()
            .map(|member| member.id)
            .collect::<HashSet<_>>();
        let selected_members = (!selection.member_ids.is_empty())
            .then(|| selection.member_ids.iter().copied().collect::<HashSet<_>>());
        let mut next = registry.clone();
        let staging = self.stage_content(&registry)?;
        let offered = proposal
            .members
            .iter()
            .map(|member| (member.source.member_path.as_str(), member))
            .collect::<BTreeMap<_, _>>();
        let mut updated = Vec::new();
        let mut fast_forwarded = false;
        let mut skipped = Vec::new();
        let mut originals = Vec::new();
        let mut backup = None;

        for stored in &mut next.skills {
            let member = &mut stored.skill;
            if !member_ids.contains(&member.id) || !is_behind(member, &selection.revision) {
                continue;
            }
            let installed = member.source.as_ref().expect("installed package member");
            let Some(original_source) = observed.get(&member.id) else {
                continue;
            };
            if original_source.revision != installed.revision
                || original_source.member_path != installed.member_path
            {
                return Err(LibraryError::new("安装修订已变化，请重新检查更新。"));
            }
            let path = self.content_path(&registry, registry.skill(member.id)?);
            let explicitly_selected = selected_members
                .as_ref()
                .is_some_and(|ids| ids.contains(&member.id));
            let Some(upstream) = offered.get(installed.member_path.as_str()) else {
                let problem = proposal
                    .problems
                    .iter()
                    .find(|problem| problem.member_path == installed.member_path)
                    .map(|problem| problem.message.as_str())
                    .unwrap_or("上游修订中找不到此成员");
                if explicitly_selected {
                    return Err(LibraryError::new(format!("{}：{problem}", member.name)));
                }
                if selected_members.is_none() {
                    skipped.push(OutdatedMember {
                        id: member.id,
                        name: member.name.clone(),
                        skip_reason: Some(problem.into()),
                        changed_files: Vec::new(),
                    });
                }
                continue;
            };
            if upstream.member.fingerprint == member.fingerprint {
                if !installed.revision.is_empty()
                    || managed_fingerprint(&path).ok().as_deref()
                        == Some(member.fingerprint.as_str())
                {
                    member.source = Some(upstream.source.clone());
                    fast_forwarded = true;
                }
                continue;
            }
            if selected_members
                .as_ref()
                .is_some_and(|ids| !ids.contains(&member.id))
            {
                continue;
            }
            let allow_backup = selection.backup_members.contains(&member.id);
            let original = match inspect_for_update(member, &path, allow_backup)? {
                Ok(original) => original,
                Err(skipped_member) => {
                    skipped.push(skipped_member);
                    continue;
                }
            };
            if original != member.fingerprint || installed.revision.is_empty() {
                self.back_up_update_member(&mut backup, member, &path, &original)?;
            }
            if original != upstream.member.fingerprint {
                let staged = files::stage(
                    &upstream.member.path,
                    &staging.member_path(member.id),
                    &upstream.member.fingerprint,
                )?;
                member.name = staged.name;
                member.description = staged.description;
                member.fingerprint = staged.fingerprint;
            } else {
                member.name.clone_from(&upstream.member.name);
                member.description.clone_from(&upstream.member.description);
                member.fingerprint = original.clone();
            }
            member.source = Some(upstream.source.clone());
            updated.push(member.id);
            originals.push((path, original));
        }

        let mut fingerprints = next.fingerprints();
        let mut installed = next
            .skills
            .iter()
            .filter_map(|member| member.skill.source.as_ref())
            .filter(|source| {
                source.origin().as_ref() == Some(downloaded.origin())
                    || UpdatePackage::from(*source) == *package
            })
            .map(|source| source.member_path.clone())
            .collect::<HashSet<_>>();
        let mut added = Vec::new();
        let mut names = self.folder_names(&next)?;
        let mut category = None;
        for member_path in &selection.additions {
            if !installed.insert(member_path.clone()) {
                continue;
            }
            let upstream = offered
                .get(member_path.as_str())
                .filter(|_| !previous_paths.contains(member_path))
                .ok_or_else(|| {
                    LibraryError::new(format!("找不到所选新增成员：{member_path}。请重新预览。"))
                })?;
            if !fingerprints.insert(upstream.member.fingerprint.clone()) {
                return Err(LibraryError::new(format!(
                    "Skill 库中已有与 {} 相同的内容。",
                    upstream.member.name
                )));
            }
            let category_id = match category {
                Some(resolved) => resolved,
                None => {
                    let target = selection
                        .target
                        .clone()
                        .ok_or_else(|| LibraryError::new("请选择新增成员的分类。"))?;
                    let resolved = next.resolve_target(target)?;
                    category = Some(resolved);
                    resolved
                }
            };
            let id = Uuid::new_v4();
            let staged = files::stage(
                &upstream.member.path,
                &staging.member_path(id),
                &upstream.member.fingerprint,
            )?;
            next.skills.push(names.store(Skill {
                local_origins: Vec::new(),
                id,
                name: staged.name,
                description: staged.description,
                folder_name: staged.folder_name,
                fingerprint: staged.fingerprint,
                category_id,
                source: Some(upstream.source.clone()),
            }));
            added.push(id);
        }

        for (path, before) in originals {
            if managed_fingerprint(&path)? != before {
                return Err(LibraryError::new(format!(
                    "升级期间有文件发生变化：{}。请重新预览。",
                    path.display()
                )));
            }
        }
        cancellation.check()?;
        let backup = backup.map(TempDir::keep);
        if !updated.is_empty() || !added.is_empty() || fast_forwarded {
            let stage = (!updated.is_empty() || !added.is_empty()).then_some(staging);
            if let Err(error) = self.publish_transaction(&mut registry, next, stage) {
                return Err(match backup {
                    Some(path) => {
                        LibraryError::new(format!("{error}；已保存备份 {}", path.display()))
                    }
                    None => error,
                });
            }
        }
        Ok(PackageUpdateOutcome {
            library: self.snapshot_for(&registry),
            updated,
            added,
            skipped,
            backup,
        })
    }

    pub fn attach_package_source(
        &self,
        id: Uuid,
        download: &DownloadedPackage,
        member_path: &str,
        cancellation: &SourceCancellation,
    ) -> Result<LibrarySnapshot, LibraryError> {
        let proposal = download.propose(self, cancellation)?;
        let upstream = proposal
            .members
            .iter()
            .find(|member| member.source.member_path == member_path)
            .ok_or_else(|| LibraryError::new("找不到所选来源成员，请重新预览。"))?;
        let mut registry = self.registry()?;
        let member = registry.skill(id)?;
        if member.skill.source.is_some() {
            return Err(LibraryError::new("该 Skill 已有在线来源。"));
        }
        if registry
            .skills
            .iter()
            .filter_map(|stored| stored.skill.source.as_ref())
            .any(|source| {
                source.origin().as_ref() == Some(download.origin())
                    && source.member_path == member_path
            })
        {
            return Err(LibraryError::new("此来源成员已安装。"));
        }
        let fingerprint = managed_fingerprint(&self.content_path(&registry, member))?;
        let mut source = upstream.source.clone();
        if fingerprint != upstream.member.fingerprint {
            // An attached local variant has no installed upstream revision yet.
            source.revision.clear();
        }
        let mut next = registry.clone();
        let stored = next
            .skills
            .iter_mut()
            .find(|stored| stored.skill.id == id)
            .expect("member validated in the current registry");
        stored.skill.source = Some(source);
        stored.skill.fingerprint = fingerprint;
        cancellation.check()?;
        self.publish_changes(&mut registry, next)?;
        Ok(self.snapshot_for(&registry))
    }

    fn back_up_update_member(
        &self,
        backup: &mut Option<TempDir>,
        member: &Skill,
        source: &Path,
        fingerprint: &str,
    ) -> Result<(), LibraryError> {
        let root = self.root.join("backups");
        let backup_error = |error| LibraryError::io("无法保存升级备份", &root, error);
        if backup.is_none() {
            match fs::create_dir(&root) {
                Ok(()) => sync_directory(&self.root).map_err(backup_error)?,
                Err(error)
                    if error.kind() == ErrorKind::AlreadyExists
                        && fs::symlink_metadata(&root).is_ok_and(|entry| entry.is_dir()) => {}
                Err(error) => return Err(backup_error(error)),
            }
            *backup = Some(
                Builder::new()
                    .prefix("package-update-")
                    .tempdir_in(&root)
                    .map_err(backup_error)?,
            );
        }
        let path = backup.as_ref().expect("backup directory exists").path();
        let destination = path.join(member.id.to_string());
        files::copy_verified(source, &destination, fingerprint)
            .map_err(|error| LibraryError::new(format!("无法备份 {}：{error}", member.name)))?;
        sync_directory(path).map_err(backup_error)?;
        sync_directory(&root).map_err(backup_error)
    }

    pub fn validate_tracked_source_url(&self, raw: &str) -> Result<String, LibraryError> {
        let invalid = || LibraryError::new("仅支持打开已关联的 HTTPS 仓库地址。");
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed.chars().any(|ch| {
                ch.is_ascii_control()
                    || ch.is_whitespace()
                    || matches!(ch, '&' | '|' | '<' | '>' | '^' | '"' | '\'' | '`')
            })
        {
            return Err(invalid());
        }
        let parsed = Url::parse(trimmed).map_err(|_| invalid())?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(invalid());
        }
        if parsed
            .path_segments()
            .is_none_or(|mut segments| segments.any(|segment| segment == ".."))
        {
            return Err(invalid());
        }
        let candidate = parsed.as_str().trim_end_matches('/');
        let registry = self.registry()?;
        let matches_tracked = registry.skills.iter().any(|stored| {
            stored.skill.source.as_ref().is_some_and(|source| {
                repository_web_base(&source.repository).is_some_and(|(_, base)| {
                    candidate == base || candidate.starts_with(&format!("{base}/"))
                })
            })
        });
        if matches_tracked {
            Ok(parsed.to_string())
        } else {
            Err(invalid())
        }
    }

    fn cached_download(
        &self,
        origin: &PackageOrigin,
        revision: &str,
    ) -> Option<Arc<DownloadedPackage>> {
        self.update_cache.lock().ok()?.get(origin, revision)
    }

    fn store_cached_download(&self, downloaded: &Arc<DownloadedPackage>) {
        if let Ok(mut cache) = self.update_cache.lock() {
            cache.insert(
                downloaded.origin().clone(),
                downloaded.revision().to_owned(),
                Arc::clone(downloaded),
            );
        }
    }

    fn download_latest_for_check(
        &self,
        git: &GitSource,
        source: &PackageSource,
        origin: &PackageOrigin,
        remote_revision: &str,
        cancellation: &SourceCancellation,
    ) -> Result<Arc<DownloadedPackage>, LibraryError> {
        if let Some(cached) = self.cached_download(origin, remote_revision) {
            return Ok(cached);
        }
        let pinned = PackageSource {
            reference: Some(origin.reference.clone()),
            ..source.clone()
        };
        let request = SourceRequest::from_provenance(&pinned)?;
        let downloaded = Arc::new(git.download(&request, cancellation, |_| {})?);
        self.store_cached_download(&downloaded);
        Ok(downloaded)
    }

    fn get_or_download_revision(
        &self,
        git: &GitSource,
        source: &PackageSource,
        origin: &PackageOrigin,
        expected_revision: &str,
        verify_remote: bool,
        cancellation: &SourceCancellation,
    ) -> Result<Arc<DownloadedPackage>, LibraryError> {
        if verify_remote {
            let remote = git.check_revision(origin, cancellation)?;
            if remote != expected_revision {
                return Err(LibraryError::new("上游修订已变化，请重新检查更新。"));
            }
        }
        if let Some(cached) = self.cached_download(origin, expected_revision) {
            return Ok(cached);
        }
        let pinned = PackageSource {
            reference: Some(origin.reference.clone()),
            ..source.clone()
        };
        let request = SourceRequest::from_provenance(&pinned)?;
        let downloaded = Arc::new(git.download(&request, cancellation, |_| {})?);
        self.store_cached_download(&downloaded);
        if downloaded.revision() != expected_revision {
            return Err(LibraryError::new("上游修订已变化，请重新检查更新。"));
        }
        Ok(downloaded)
    }

    fn check_package(
        &self,
        git: &GitSource,
        package: UpdatePackage,
        members: &[Skill],
        cancellation: &SourceCancellation,
    ) -> PackageUpdateCheck {
        let member_ids: Vec<Uuid> = members.iter().map(|skill| skill.id).collect();
        let source = members[0].source.as_ref().expect("grouped by package");
        let failed = |error: LibraryError| PackageUpdateCheck {
            package: package.clone(),
            member_ids: member_ids.clone(),
            outdated_member_ids: Vec::new(),
            status: PackageUpdateStatus::Failed,
            revision: None,
            updated_at: None,
            error: Some(error.to_string()),
        };

        let origin = match resolve_package_origin(git, source, cancellation) {
            Ok(origin) => origin,
            Err(error) => return failed(error),
        };
        let remote_revision = match git.check_revision(&origin, cancellation) {
            Ok(revision) => revision,
            Err(error) => return failed(error),
        };
        if !members
            .iter()
            .any(|member| is_behind(member, &remote_revision))
        {
            return PackageUpdateCheck {
                package,
                member_ids,
                outdated_member_ids: Vec::new(),
                status: PackageUpdateStatus::Current,
                revision: Some(remote_revision),
                updated_at: None,
                error: None,
            };
        }

        let downloaded = match self.download_latest_for_check(
            git,
            source,
            &origin,
            &remote_revision,
            cancellation,
        ) {
            Ok(downloaded) => downloaded,
            Err(error) => return failed(error),
        };
        let actual_revision = downloaded.revision().to_owned();
        let proposal = match downloaded.propose(self, cancellation) {
            Ok(proposal) => proposal,
            Err(error) => return failed(error),
        };
        let offered = proposal
            .members
            .iter()
            .map(|member| (member.source.member_path.as_str(), member))
            .collect::<BTreeMap<_, _>>();
        let outdated_member_ids = members
            .iter()
            .filter(|member| is_behind(member, &actual_revision))
            .filter(|member| {
                let Some(installed) = member.source.as_ref() else {
                    return false;
                };
                offered
                    .get(installed.member_path.as_str())
                    .is_some_and(|upstream| upstream.member.fingerprint != member.fingerprint)
            })
            .map(|member| member.id)
            .collect::<Vec<_>>();
        let status = if outdated_member_ids.is_empty() {
            PackageUpdateStatus::Current
        } else {
            PackageUpdateStatus::Available
        };
        PackageUpdateCheck {
            package,
            member_ids,
            outdated_member_ids,
            status,
            revision: Some(actual_revision),
            updated_at: downloaded.committed_at(),
            error: None,
        }
    }
}

fn package_members(
    skills: Vec<Skill>,
    package: &UpdatePackage,
) -> Result<Vec<Skill>, LibraryError> {
    let members = skills
        .into_iter()
        .filter(|skill| {
            skill
                .source
                .as_ref()
                .is_some_and(|source| UpdatePackage::from(source) == *package)
        })
        .collect::<Vec<_>>();
    if members.is_empty() {
        return Err(LibraryError::new(
            "Skill 库中已没有此来源的成员，请重新检查更新。",
        ));
    }
    Ok(members)
}

fn resolve_package_origin(
    git: &GitSource,
    source: &PackageSource,
    cancellation: &SourceCancellation,
) -> Result<PackageOrigin, LibraryError> {
    source.origin().map_or_else(
        || git.resolve_origin(&SourceRequest::from_provenance(source)?, cancellation),
        Ok,
    )
}

fn is_behind(skill: &Skill, revision: &str) -> bool {
    skill
        .source
        .as_ref()
        .is_some_and(|source| source.revision != revision)
}

fn previous_paths(
    library: &Library,
    git: &GitSource,
    members: &[Skill],
    revision: &str,
    cancellation: &SourceCancellation,
) -> (HashSet<String>, bool) {
    let mut paths = HashSet::new();
    let mut revisions = BTreeSet::new();
    for source in members.iter().filter_map(|member| member.source.as_ref()) {
        paths.insert(source.member_path.clone());
        if !source.revision.is_empty() && source.revision != revision {
            revisions.insert(&source.revision);
        }
    }
    let has_baseline = !revisions.is_empty();
    let mut confirmed = has_baseline;
    let template = members[0].source.as_ref().expect("grouped by package");
    for old_rev in revisions {
        let origin = PackageOrigin {
            repository: template.repository.clone(),
            reference: old_rev.clone(),
        };
        let baseline = if let Some(cached) = library.cached_download(&origin, old_rev) {
            cached.propose(library, cancellation)
        } else {
            let pinned = PackageSource {
                reference: Some(old_rev.clone()),
                ..template.clone()
            };
            SourceRequest::from_provenance(&pinned)
                .and_then(|request| git.download(&request, cancellation, |_| {}))
                .and_then(|download| {
                    let download = Arc::new(download);
                    library.store_cached_download(&download);
                    download.propose(library, cancellation)
                })
        };
        match baseline {
            Ok(PackageProposal {
                members, problems, ..
            }) => {
                paths.extend(members.into_iter().map(|member| member.source.member_path));
                paths.extend(problems.into_iter().map(|problem| problem.member_path));
            }
            Err(_) => confirmed = false,
        }
    }
    (paths, confirmed)
}

fn managed_fingerprint(path: &Path) -> Result<String, LibraryError> {
    let error = |err| LibraryError::io("无法读取托管 Skill", path, err);
    if !fs::symlink_metadata(path).map_err(error)?.is_dir()
        || fs::canonicalize(path).map_err(error)? != path
    {
        return Err(LibraryError::new(format!(
            "托管目录已被替换：{}",
            path.display()
        )));
    }
    files::fingerprint(path)
}

fn inspect_for_update(
    member: &Skill,
    path: &Path,
    allow_backup: bool,
) -> Result<Result<String, OutdatedMember>, LibraryError> {
    let skipped = |reason| {
        Ok(Err(OutdatedMember {
            id: member.id,
            name: member.name.clone(),
            skip_reason: Some(reason),
            changed_files: Vec::new(),
        }))
    };
    match managed_fingerprint(path) {
        Ok(fingerprint)
            if allow_backup
                || (fingerprint == member.fingerprint
                    && member
                        .source
                        .as_ref()
                        .is_some_and(|source| !source.revision.is_empty())) =>
        {
            Ok(Ok(fingerprint))
        }
        Ok(_) => skipped("有本地改动".into()),
        Err(error) if allow_backup => Err(error),
        Err(error) => skipped(error.to_string()),
    }
}

#[derive(PartialEq, Eq)]
enum FileStamp {
    Regular([u8; 32], u32),
    Special,
}

fn diff_member_files(local_dir: &Path, upstream_dir: &Path) -> Vec<String> {
    let mut local_files = BTreeMap::new();
    let mut upstream_files = BTreeMap::new();
    collect_member_files(local_dir, local_dir, &mut local_files);
    collect_member_files(upstream_dir, upstream_dir, &mut upstream_files);
    let paths: BTreeSet<String> = local_files
        .keys()
        .chain(upstream_files.keys())
        .cloned()
        .collect();
    paths
        .into_iter()
        .filter(|path| local_files.get(path) != upstream_files.get(path))
        .collect()
}

fn collect_member_files(root: &Path, current: &Path, files: &mut BTreeMap<String, FileStamp>) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect_member_files(root, &path, files);
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let key = relative
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if kind.is_file() {
            if let Some(stamp) = hash_regular_file(&path) {
                files.insert(key, stamp);
            } else {
                files.insert(key, FileStamp::Special);
            }
        } else {
            files.insert(key, FileStamp::Special);
        }
    }
}

fn hash_regular_file(path: &Path) -> Option<FileStamp> {
    let mut file = File::open(path).ok()?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        file.metadata().ok()?.permissions().mode() & 0o111
    };
    #[cfg(not(unix))]
    let mode = 0u32;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(FileStamp::Regular(hasher.finalize().into(), mode))
}

fn repository_web_base(repository: &str) -> Option<(Url, String)> {
    let parsed = Url::parse(repository.trim()).ok()?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?;
    let port = parsed
        .port()
        .map(|value| format!(":{value}"))
        .unwrap_or_default();
    let trimmed_path = parsed.path().trim_end_matches('/');
    let clean_path = if trimmed_path.len() >= 4
        && trimmed_path[trimmed_path.len() - 4..].eq_ignore_ascii_case(".git")
    {
        &trimmed_path[..trimmed_path.len() - 4]
    } else {
        trimmed_path
    };
    if clean_path.is_empty() || clean_path == "/" {
        return None;
    }
    let base = format!("https://{host}{port}{clean_path}");
    Some((parsed, base))
}

fn build_source_urls(
    repository: &str,
    from_revision: Option<&str>,
    to_revision: &str,
    include_diff: bool,
) -> (Option<String>, Option<String>) {
    let Some((parsed, base_url)) = repository_web_base(repository) else {
        return (None, None);
    };
    let repository_url = Some(base_url.clone());
    if !include_diff {
        return (repository_url, None);
    }
    let from = from_revision.filter(|rev| is_commit(rev) && *rev != to_revision);
    let to = is_commit(to_revision).then_some(to_revision);
    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let compare = match host.as_str() {
        "github.com" | "www.github.com" | "gitee.com" | "www.gitee.com" => match (from, to) {
            (Some(from), Some(to)) => format!("{base_url}/compare/{from}...{to}"),
            (None, Some(to)) => format!("{base_url}/commit/{to}"),
            _ => base_url.clone(),
        },
        h if h == "gitlab.com" || h == "www.gitlab.com" || h.contains("gitlab") => match (from, to) {
            (Some(from), Some(to)) => format!("{base_url}/-/compare/{from}...{to}"),
            (None, Some(to)) => format!("{base_url}/-/commit/{to}"),
            _ => base_url.clone(),
        },
        "bitbucket.org" | "www.bitbucket.org" => match (from, to) {
            (Some(from), Some(to)) => format!("{base_url}/branches/compare/{to}..{from}"),
            (None, Some(to)) => format!("{base_url}/commits/{to}"),
            _ => base_url.clone(),
        },
        _ => base_url.clone(),
    };
    (repository_url, Some(compare))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CategoryTarget;

    #[test]
    fn builds_source_and_compare_urls_for_known_and_unknown_hosts() {
        let from = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let to = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        assert_eq!(
            build_source_urls("https://github.com/mattpocock/skills.git", Some(from), to, true),
            (
                Some("https://github.com/mattpocock/skills".into()),
                Some(format!("https://github.com/mattpocock/skills/compare/{from}...{to}")),
            )
        );
        assert_eq!(
            build_source_urls("https://github.com/mattpocock/skills.git", None, to, true),
            (
                Some("https://github.com/mattpocock/skills".into()),
                Some(format!("https://github.com/mattpocock/skills/commit/{to}")),
            )
        );
        assert_eq!(
            build_source_urls("https://github.com/mattpocock/skills.git", Some(from), to, false),
            (Some("https://github.com/mattpocock/skills".into()), None)
        );
        assert_eq!(
            build_source_urls("https://gitlab.example.com/team/skills.git", Some(from), to, true),
            (
                Some("https://gitlab.example.com/team/skills".into()),
                Some(format!("https://gitlab.example.com/team/skills/-/compare/{from}...{to}")),
            )
        );
        assert_eq!(
            build_source_urls("https://gitee.com/org/skills.git", Some(from), to, true),
            (
                Some("https://gitee.com/org/skills".into()),
                Some(format!("https://gitee.com/org/skills/compare/{from}...{to}")),
            )
        );
        assert_eq!(
            build_source_urls("https://bitbucket.org/org/skills.git", Some(from), to, true),
            (
                Some("https://bitbucket.org/org/skills".into()),
                Some(format!(
                    "https://bitbucket.org/org/skills/branches/compare/{to}..{from}"
                )),
            )
        );
        assert_eq!(
            build_source_urls("https://git.internal.example/org/skills.git", Some(from), to, true),
            (
                Some("https://git.internal.example/org/skills".into()),
                Some("https://git.internal.example/org/skills".into()),
            )
        );
    }

    #[test]
    fn validates_only_tracked_https_source_urls() {
        let workspace = tempfile::tempdir().unwrap();
        let library = Library::open(workspace.path().join("library")).unwrap();
        let skill_dir = workspace.path().join("local-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: sample\ndescription: sample skill\n---\nbody\n",
        )
        .unwrap();
        let preview = library.preview_folders(vec![skill_dir]).unwrap();
        let member = preview.members.into_iter().next().unwrap();
        library
            .commit_import(
                vec![crate::ImportSelection {
                    path: member.path,
                    fingerprint: member.fingerprint,
                    source: Some(PackageSource {
                        repository: "https://github.com/mattpocock/skills.git".into(),
                        member_path: "skills/sample".into(),
                        revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                        reference: Some("refs/heads/main".into()),
                    }),
                }],
                CategoryTarget::Uncategorized,
            )
            .unwrap();

        assert_eq!(
            library
                .validate_tracked_source_url("https://github.com/mattpocock/skills")
                .unwrap(),
            "https://github.com/mattpocock/skills"
        );
        assert!(library
            .validate_tracked_source_url(
                "https://github.com/mattpocock/skills/compare/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            )
            .is_ok());
        assert!(library
            .validate_tracked_source_url(
                "https://github.com/mattpocock/skills/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            )
            .is_ok());

        for bad in [
            "",
            "http://github.com/mattpocock/skills",
            "file:///etc/passwd",
            "https://github.com/mattpocock/skills-evil",
            "https://github.com/other/repo",
            "https://user@github.com/mattpocock/skills",
            "https://github.com/mattpocock/skills?foo=1",
            "https://github.com/mattpocock/skills#frag",
            "https://github.com/mattpocock/skills/../other",
            "https://github.com/mattpocock/skills/compare/a...b&echo=1",
        ] {
            assert!(
                library.validate_tracked_source_url(bad).is_err(),
                "expected rejection for {bad}"
            );
        }
    }
}

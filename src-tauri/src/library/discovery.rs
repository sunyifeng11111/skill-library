use super::*;
use super::provenance::{checkout_source, installation_records, installed_source};
use crate::{AgentKind, AgentPreset, PackageSource};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryStatus {
    Directory,
    ExternalLink,
    ManagedLink,
    Imported,
    Invalid,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub path: PathBuf,
    pub name: String,
    pub description: Option<String>,
    pub source_directory: PathBuf,
    pub source_name: String,
    pub agent_id: Option<Uuid>,
    pub agent_kind: Option<AgentKind>,
    pub status: DiscoveryStatus,
    pub source: Option<PackageSource>,
    pub target: Option<PathBuf>,
    #[serde(default)]
    pub copy_imported: bool,
    #[serde(default)]
    pub modified_at: Option<u64>,
    #[serde(default)]
    pub broken_link: bool,
    fingerprint: Option<String>,
    identity: Option<String>,
    pub reason: Option<String>,
    #[serde(default)]
    link_owner: Option<transaction::EntryIdentity>,
}

fn cached_fingerprint(
    path: &Path,
    cache: &mut BTreeMap<PathBuf, String>,
) -> Result<String, LibraryError> {
    if let Some(hash) = cache.get(path) {
        return Ok(hash.clone());
    }
    let hash = files::fingerprint(path)?;
    cache.insert(path.to_owned(), hash.clone());
    Ok(hash)
}

impl Library {
    fn matching_local_member<'a>(
        &self,
        registry: &'a Registry,
        name: &str,
        fingerprint: &str,
        cache: &mut BTreeMap<PathBuf, String>,
    ) -> Option<&'a StoredSkill> {
        registry.skills.iter().find(|member| {
            (member.skill.name == name || member.skill.fingerprint == fingerprint)
                && cached_fingerprint(&self.content_path(registry, member), cache)
                    .ok()
                    .as_deref()
                    == Some(fingerprint)
        })
    }

    pub fn scan_existing_skills(
        &self,
        presets: &[AgentPreset],
        collections: &[PathBuf],
        agent_id: Option<Uuid>,
    ) -> Result<Vec<DiscoveredSkill>, LibraryError> {
        self.scan_local_sources_inner(presets, collections, agent_id, true, false)
    }

    pub fn scan_local_sources(
        &self,
        presets: &[AgentPreset],
        folders: &[PathBuf],
        agent_id: Option<Uuid>,
        include_agents: bool,
    ) -> Result<Vec<DiscoveredSkill>, LibraryError> {
        self.scan_local_sources_inner(presets, folders, agent_id, include_agents, false)
    }

    /// Scans only registered agent directories for valid unmanaged local skills (`Directory` or `ExternalLink`),
    /// skipping owned `ManagedLink`s, invalid entries, and unregistered presets.
    pub fn scan_registered_unmanaged_skills(
        &self,
        agent_id: Option<Uuid>,
    ) -> Result<Vec<DiscoveredSkill>, LibraryError> {
        self.scan_local_sources_inner(&[], &[], agent_id, true, true)
    }

    fn scan_local_sources_inner(
        &self,
        presets: &[AgentPreset],
        folders: &[PathBuf],
        agent_id: Option<Uuid>,
        include_agents: bool,
        unmanaged_only: bool,
    ) -> Result<Vec<DiscoveredSkill>, LibraryError> {
        let registry = self.registry()?.clone();
        let mut agents = BTreeMap::new();
        for preset in presets {
            if let Ok(path) = preset.directory.canonicalize() {
                agents
                    .entry(path)
                    .or_insert((preset.name.to_owned(), None, Some(preset.kind)));
            }
        }
        for stored in &registry.agents {
            let agent = &stored.agent;
            agents.insert(
                agent.directory.clone(),
                (agent.name.clone(), Some(agent.id), Some(agent.kind)),
            );
        }
        let mut roots = BTreeMap::<PathBuf, Option<HashSet<PathBuf>>>::new();
        if let Some(id) = agent_id {
            let directory = &registry.agent(id)?.agent.directory;
            if directory.is_dir() {
                roots.insert(directory.clone(), None);
            }
        } else {
            if include_agents {
                roots.extend(
                    agents
                        .keys()
                        .filter(|p| p.is_dir())
                        .map(|p| (p.clone(), None)),
                );
            }
            for folder in folders {
                if folder.join("SKILL.md").is_file() {
                    let parent = folder
                        .parent()
                        .ok_or_else(|| LibraryError::new("无法读取来源目录。"))?;
                    let parent = fs::canonicalize(parent)
                        .map_err(|e| LibraryError::io("无法打开目录", parent, e))?;
                    let path = parent.join(
                        folder
                            .file_name()
                            .ok_or_else(|| LibraryError::new("无法读取文件夹名称。"))?,
                    );
                    if let Some(paths) = roots.entry(parent).or_insert_with(|| Some(HashSet::new()))
                    {
                        paths.insert(path);
                    }
                } else {
                    let root = fs::canonicalize(folder)
                        .map_err(|e| LibraryError::io("无法打开目录", folder, e))?;
                    roots.insert(root, None);
                }
            }
        }
        let managed: BTreeMap<_, _> = registry
            .skills
            .iter()
            .map(|s| (self.content_path(&registry, s), &s.skill))
            .collect();
        let mut inspected = BTreeMap::new();
        let mut origins = BTreeMap::new();
        let mut rows = Vec::new();
        for (directory, selected) in roots {
            let (source_name, id, kind) = agents
                .get(&directory)
                .cloned()
                .unwrap_or_else(|| (directory.display().to_string(), None, None));
            let paths = match selected {
                Some(paths) => paths.into_iter().collect(),
                None => match fs::read_dir(&directory).and_then(|entries| {
                    entries
                        .map(|e| e.map(|child| child.path()))
                        .collect::<Result<Vec<_>, _>>()
                }) {
                    Ok(paths) => paths,
                    Err(_) if unmanaged_only && agent_id.is_none() => continue,
                    Err(e) => return Err(LibraryError::io("无法读取目录", &directory, e)),
                },
            };
            let records = installation_records(&directory);
            for path in paths {
                if path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(".skill-library-"))
                {
                    continue;
                }
                if !path.is_dir() {
                    if unmanaged_only {
                        continue;
                    }
                    let is_broken_symlink = fs::symlink_metadata(&path)
                        .is_ok_and(|meta| meta.is_symlink())
                        && fs::metadata(&path).is_err();
                    if is_broken_symlink {
                        let name = path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned();
                        rows.push(DiscoveredSkill {
                            link_owner: None,
                            copy_imported: false,
                            modified_at: None,
                            broken_link: true,
                            source: None,
                            fingerprint: None,
                            identity: None,
                            target: fs::read_link(&path).ok(),
                            path,
                            name,
                            description: None,
                            status: DiscoveryStatus::Invalid,
                            reason: Some("原软链接指向的文件夹已不存在".into()),
                            source_directory: directory.clone(),
                            source_name: source_name.clone(),
                            agent_id: id,
                            agent_kind: kind,
                        });
                    }
                    continue;
                }
                let manifest = path.join("SKILL.md");
                if fs::symlink_metadata(&manifest).is_err_and(|e| e.kind() == ErrorKind::NotFound) {
                    continue;
                }
                let target = if path.is_symlink() {
                    path.canonicalize().ok()
                } else {
                    None
                };
                if unmanaged_only
                    && target.as_ref().is_some_and(|p| {
                        managed.contains_key(p)
                            && transaction::active_link(&registry, &path, &directory, p)
                    })
                {
                    continue;
                }
                let (name, description, status, reason) = match files::read_metadata(&manifest) {
                    Ok(metadata) => {
                        let status = match target.as_ref() {
                            Some(p)
                                if managed.contains_key(p)
                                    && transaction::active_link(
                                        &registry, &path, &directory, p,
                                    ) =>
                            {
                                DiscoveryStatus::ManagedLink
                            }
                            Some(_) => DiscoveryStatus::ExternalLink,
                            None => DiscoveryStatus::Directory,
                        };
                        (metadata.name, Some(metadata.description), status, None)
                    }
                    Err(e) => (
                        path.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                        None,
                        DiscoveryStatus::Invalid,
                        Some(e.to_string()),
                    ),
                };
                let (fingerprint, identity, status, reason) = if matches!(
                    status,
                    DiscoveryStatus::Directory | DiscoveryStatus::ExternalLink
                ) {
                    let resolved = match target.as_ref() {
                        Some(p)
                            if status == DiscoveryStatus::ExternalLink
                                && managed.contains_key(p) =>
                        {
                            Ok(p.clone())
                        }
                        _ => files::source_folder(
                            target.as_ref().unwrap_or(&path),
                            &self.root,
                            &self.managed_directory(&registry),
                        ),
                    };
                    match resolved.and_then(|folder| {
                        let hash = cached_fingerprint(&folder, &mut inspected)?;
                        Ok((
                            hash,
                            transaction::DirectoryIdentity::read(&folder)
                                .map_err(|e| LibraryError::io("无法核对目录", &folder, e))?,
                        ))
                    }) {
                        Ok((hash, id)) => (
                            Some(hash),
                            Some(
                                serde_json::to_string(&id).expect("directory identity serializes"),
                            ),
                            status,
                            reason,
                        ),
                        Err(e) if status == DiscoveryStatus::ExternalLink => {
                            (None, None, status, Some(e.to_string()))
                        }
                        Err(e) => (None, None, DiscoveryStatus::Invalid, Some(e.to_string())),
                    }
                } else {
                    (
                        target
                            .as_ref()
                            .filter(|p| managed.contains_key(*p))
                            .and_then(|p| cached_fingerprint(p, &mut inspected).ok()),
                        None,
                        status,
                        reason,
                    )
                };
                if unmanaged_only
                    && (!matches!(
                        status,
                        DiscoveryStatus::Directory | DiscoveryStatus::ExternalLink
                    ) || fingerprint.is_none()
                        || identity.is_none())
                {
                    continue;
                }
                let source = match status {
                    DiscoveryStatus::Directory => installed_source(records.as_ref(), &path, &name)
                        .or_else(|| {
                            origins
                                .entry(path.clone())
                                .or_insert_with(|| checkout_source(&path))
                                .clone()
                        }),
                    DiscoveryStatus::ExternalLink => target.as_ref().and_then(|folder| {
                        installed_source(
                            installation_records(folder.parent()?).as_ref(),
                            folder,
                            &name,
                        )
                        .or_else(|| {
                            origins
                                .entry(folder.clone())
                                .or_insert_with(|| checkout_source(folder))
                                .clone()
                        })
                    }),
                    DiscoveryStatus::ManagedLink => registry
                        .skills
                        .iter()
                        .find(|s| Some(self.content_path(&registry, s)) == target)
                        .and_then(|s| s.skill.source.clone()),
                    _ => None,
                };
                let copy_imported = fingerprint.as_deref().is_some_and(|hash| {
                    self.matching_local_member(&registry, &name, hash, &mut inspected)
                        .is_some()
                });
                let status =
                    if kind.is_none() && status == DiscoveryStatus::Directory && copy_imported {
                        DiscoveryStatus::Imported
                    } else {
                        status
                    };
                let modified_at = files::modified_timestamp(target.as_deref().unwrap_or(&path));
                rows.push(DiscoveredSkill {
                    link_owner: if target.is_some() {
                        transaction::EntryIdentity::link(&path).ok()
                    } else {
                        None
                    },
                    copy_imported,
                    modified_at,
                    broken_link: false,
                    source,
                    fingerprint,
                    identity,
                    path,
                    name,
                    description,
                    status,
                    reason,
                    target,
                    source_directory: directory.clone(),
                    source_name: source_name.clone(),
                    agent_id: id,
                    agent_kind: kind,
                });
            }
        }
        rows.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(rows)
    }
}

#[derive(Debug, Serialize)]
pub struct AdoptionResult {
    pub path: PathBuf,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Context,
    Removed,
    Added,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifestDiff {
    pub left_path: PathBuf,
    pub right_path: PathBuf,
    pub lines: Vec<DiffLine>,
    pub same_manifest: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum UnifiedConflictDecision {
    KeepBoth {
        rows: Vec<DiscoveredSkill>,
    },
    UseCanonical {
        #[serde(rename = "canonicalPath")]
        canonical_path: PathBuf,
        #[serde(default, rename = "canonicalSkillId")]
        canonical_skill_id: Option<Uuid>,
        rows: Vec<DiscoveredSkill>,
    },
    Skip,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedAdoptionRequest {
    pub ready_rows: Vec<DiscoveredSkill>,
    #[serde(default)]
    pub conflicts: Vec<UnifiedConflictDecision>,
    #[serde(default)]
    pub copy_only: bool,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedAdoptionOutcome {
    pub snapshot: LibrarySnapshot,
    pub results: Vec<AdoptionResult>,
    pub managed_count: usize,
    pub imported_count: usize,
    pub backed_up_count: usize,
    pub skipped_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<Uuid>,
}

struct AdoptedEntry {
    skipped: bool,
    skill_id: Option<Uuid>,
    new_skill_id: Option<Uuid>,
    new_agent_id: Option<Uuid>,
    linked: bool,
    backup_item: Option<backups::OriginalBackupItem>,
}

impl AdoptedEntry {
    fn skipped(skill_id: Option<Uuid>) -> Self {
        Self {
            skipped: true,
            skill_id,
            new_skill_id: None,
            new_agent_id: None,
            linked: false,
            backup_item: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AdoptionMode {
    CopyOnly,
    AdoptLocalOnly,
    ManageAll,
}

impl Library {
    pub fn compare_skill_manifests(
        &self,
        left: &Path,
        right: &Path,
    ) -> Result<SkillManifestDiff, LibraryError> {
        let left_text = files::read_manifest_text(left)?;
        let right_text = files::read_manifest_text(right)?;
        let same_manifest = left_text == right_text;
        let lines = files::compute_line_diff(&left_text, &right_text)
            .into_iter()
            .map(|(kind, text)| DiffLine {
                kind: match kind {
                    files::DiffKind::Context => DiffLineKind::Context,
                    files::DiffKind::Removed => DiffLineKind::Removed,
                    files::DiffKind::Added => DiffLineKind::Added,
                },
                text,
            })
            .collect();
        Ok(SkillManifestDiff {
            left_path: left.to_path_buf(),
            right_path: right.to_path_buf(),
            lines,
            same_manifest,
        })
    }

    pub fn trash_broken_link(
        &self,
        path: &Path,
        presets: &[AgentPreset],
    ) -> Result<(), LibraryError> {
        let meta = fs::symlink_metadata(path)
            .map_err(|e| LibraryError::io("无法读取失效链接", path, e))?;
        if !meta.file_type().is_symlink() {
            return Err(LibraryError::new("该路径不是软链接，无法按失效链接清理。"));
        }
        if fs::metadata(path).is_ok() {
            return Err(LibraryError::new("该软链接目标仍然存在，不是失效链接。"));
        }
        let parent = path
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .ok_or_else(|| LibraryError::new("无法确定失效链接所在目录。"))?;
        let registry = self.registry()?;
        let allowed = registry
            .agents
            .iter()
            .any(|a| a.agent.directory == parent)
            || presets
                .iter()
                .any(|p| p.directory.canonicalize().ok().as_ref() == Some(&parent));
        if !allowed {
            return Err(LibraryError::new(
                "仅支持清理已知 AI 工具目录中的失效软链接。",
            ));
        }
        files::move_to_trash(path)?;
        Ok(())
    }

    pub fn adopt_existing_skills(
        &self,
        presets: &[AgentPreset],
        rows: Vec<DiscoveredSkill>,
    ) -> Vec<AdoptionResult> {
        self.process_locations(presets, rows, AdoptionMode::AdoptLocalOnly)
    }

    pub fn manage_existing_skills(
        &self,
        presets: &[AgentPreset],
        mut rows: Vec<DiscoveredSkill>,
    ) -> Vec<AdoptionResult> {
        // Switch aliases while their original source directories still exist.
        rows.sort_by_key(|row| row.status != DiscoveryStatus::ExternalLink);
        self.process_locations(presets, rows, AdoptionMode::ManageAll)
    }

    pub fn commit_local_batch(
        &self,
        presets: &[AgentPreset],
        request: UnifiedAdoptionRequest,
    ) -> Result<UnifiedAdoptionOutcome, LibraryError> {
        let mode = if request.copy_only {
            AdoptionMode::CopyOnly
        } else {
            AdoptionMode::ManageAll
        };
        let batch_id = Uuid::new_v4();
        let summary = request.summary;
        let mut results = Vec::new();
        let mut backup_items = Vec::new();
        let mut added_skill_ids = Vec::new();
        let mut added_agent_ids = Vec::new();
        let mut managed_count = 0usize;
        let mut imported_count = 0usize;
        let mut backed_up_count = 0usize;
        let mut skipped_count = 0usize;

        let mut apply_result = |path: PathBuf, res: Result<AdoptedEntry, LibraryError>| {
            match res {
                Ok(entry) => {
                    if entry.skipped {
                        skipped_count += 1;
                    } else {
                        if let Some(id) = entry.new_skill_id {
                            if !added_skill_ids.contains(&id) {
                                added_skill_ids.push(id);
                            }
                            imported_count += 1;
                        }
                        if let Some(id) = entry.new_agent_id {
                            if !added_agent_ids.contains(&id) {
                                added_agent_ids.push(id);
                            }
                        }
                        if entry.linked {
                            managed_count += 1;
                        }
                        if let Some(item) = entry.backup_item {
                            if item.backup_path.is_some() {
                                backed_up_count += 1;
                            }
                            backup_items.push(item);
                        }
                    }
                    results.push(AdoptionResult {
                        path,
                        skipped: entry.skipped,
                        error: None,
                    });
                }
                Err(error) => {
                    results.push(AdoptionResult {
                        path,
                        skipped: false,
                        error: Some(error.to_string()),
                    });
                }
            }
        };

        let mut ready_rows = request.ready_rows;
        ready_rows.sort_by_key(|row| row.status != DiscoveryStatus::ExternalLink);
        for row in ready_rows {
            let path = row.path.clone();
            let res = self.adopt_location_detailed(
                presets,
                &row,
                mode,
                batch_id,
                summary.as_deref(),
                None,
            );
            apply_result(path, res);
        }

        for decision in request.conflicts {
            match decision {
                UnifiedConflictDecision::Skip => {}
                UnifiedConflictDecision::KeepBoth { mut rows } => {
                    rows.sort_by_key(|row| row.status != DiscoveryStatus::ExternalLink);
                    for row in rows {
                        if row.status == DiscoveryStatus::ManagedLink {
                            continue;
                        }
                        let path = row.path.clone();
                        let res = self.adopt_location_detailed(
                            presets,
                            &row,
                            mode,
                            batch_id,
                            summary.as_deref(),
                            None,
                        );
                        apply_result(path, res);
                    }
                }
                UnifiedConflictDecision::UseCanonical {
                    canonical_path,
                    canonical_skill_id,
                    rows,
                } => {
                    let canonical_id = if let Some(id) = canonical_skill_id {
                        let registry = self.registry()?;
                        if registry.skill(id).is_ok() {
                            Some(id)
                        } else {
                            None
                        }
                    } else if let Some(canonical_row) =
                        rows.iter().find(|r| r.path == canonical_path)
                    {
                        if canonical_row.status == DiscoveryStatus::ManagedLink {
                            self.managed_skill_id_for_row(canonical_row)?
                        } else {
                            let res = self.adopt_location_detailed(
                                presets,
                                canonical_row,
                                mode,
                                batch_id,
                                summary.as_deref(),
                                None,
                            );
                            let id = res.as_ref().ok().and_then(|e| e.skill_id);
                            apply_result(canonical_row.path.clone(), res);
                            id
                        }
                    } else {
                        None
                    };

                    if mode == AdoptionMode::ManageAll {
                        if let Some(target_skill_id) = canonical_id {
                            let mut others: Vec<_> = rows
                                .into_iter()
                                .filter(|r| r.path != canonical_path)
                                .collect();
                            others.sort_by_key(|row| row.status != DiscoveryStatus::ExternalLink);
                            for row in others {
                                let path = row.path.clone();
                                let res = self.adopt_location_detailed(
                                    presets,
                                    &row,
                                    AdoptionMode::ManageAll,
                                    batch_id,
                                    summary.as_deref(),
                                    Some(target_skill_id),
                                );
                                apply_result(path, res);
                            }
                        }
                    }
                }
            }
        }

        let recorded_batch_id = if !backup_items.is_empty() {
            let summary = summary.unwrap_or_else(|| {
                backups::default_batch_summary(managed_count.max(backup_items.len()))
            });
            self.finalize_original_backup_batch(
                batch_id,
                summary,
                &added_skill_ids,
                &added_agent_ids,
            )?;
            Some(batch_id)
        } else if !added_skill_ids.is_empty() {
            let mut registry = self.registry()?;
            registry.copy_only_undos.insert(batch_id, added_skill_ids);
            Some(batch_id)
        } else {
            None
        };

        let snapshot = self.snapshot()?;
        Ok(UnifiedAdoptionOutcome {
            snapshot,
            results,
            managed_count,
            imported_count,
            backed_up_count,
            skipped_count,
            batch_id: recorded_batch_id,
        })
    }

    pub(super) fn adoption_source_folder(
        &self,
        registry: &Registry,
        input: &Path,
        allow_managed: bool,
    ) -> Result<PathBuf, LibraryError> {
        if allow_managed {
            let info = fs::symlink_metadata(input)
                .map_err(|error| LibraryError::io("无法读取", input, error))?;
            if info.is_dir() {
                let canonical = fs::canonicalize(input)
                    .map_err(|error| LibraryError::io("无法读取", input, error))?;
                let is_managed_skill = registry.skills.iter().any(|member| {
                    let path = self.content_path(registry, member);
                    path == canonical || path.canonicalize().ok().as_ref() == Some(&canonical)
                });
                if is_managed_skill {
                    return Ok(canonical);
                }
            }
        }
        files::source_folder(input, &self.root, &self.managed_directory(registry))
    }

    fn managed_skill_id_for_row(&self, row: &DiscoveredSkill) -> Result<Option<Uuid>, LibraryError> {
        let Some(target) = row.target.as_ref().and_then(|t| t.canonicalize().ok()) else {
            return Ok(None);
        };
        let registry = self.registry()?;
        Ok(registry.skills.iter().find_map(|member| {
            let managed = self.content_path(&registry, member).canonicalize().ok()?;
            (managed == target).then_some(member.skill.id)
        }))
    }

    fn process_locations(
        &self,
        presets: &[AgentPreset],
        rows: Vec<DiscoveredSkill>,
        mode: AdoptionMode,
    ) -> Vec<AdoptionResult> {
        let batch_id = Uuid::new_v4();
        let mut backup_items = Vec::new();
        let mut added_skill_ids = Vec::new();
        let mut added_agent_ids = Vec::new();
        let results: Vec<_> = rows
            .into_iter()
            .map(|row| {
                let result =
                    self.adopt_location_detailed(presets, &row, mode, batch_id, None, None);
                match result {
                    Ok(entry) => {
                        if let Some(id) = entry.new_skill_id {
                            added_skill_ids.push(id);
                        }
                        if let Some(id) = entry.new_agent_id {
                            added_agent_ids.push(id);
                        }
                        if let Some(item) = entry.backup_item {
                            backup_items.push(item);
                        }
                        AdoptionResult {
                            skipped: entry.skipped,
                            error: None,
                            path: row.path,
                        }
                    }
                    Err(e) => AdoptionResult {
                        skipped: false,
                        error: Some(e.to_string()),
                        path: row.path,
                    },
                }
            })
            .collect();
        if !backup_items.is_empty() {
            // Every location already committed its own backup item; only metadata is left.
            let _ = self.finalize_original_backup_batch(
                batch_id,
                backups::default_batch_summary(backup_items.len()),
                &added_skill_ids,
                &added_agent_ids,
            );
        }
        results
    }

    fn adopt_location_detailed(
        &self,
        presets: &[AgentPreset],
        row: &DiscoveredSkill,
        mode: AdoptionMode,
        batch_id: Uuid,
        summary: Option<&str>,
        override_skill_id: Option<Uuid>,
    ) -> Result<AdoptedEntry, LibraryError> {
        let changed = || {
            LibraryError::new(format!(
                "{}：安装位置已变化，请重新扫描。",
                row.path.display()
            ))
        };
        let mut current = self.registry()?;
        if override_skill_id.is_none() {
            if let Ok(target) = row.path.canonicalize() {
                let parent = row.source_directory.canonicalize().ok();
                if parent.as_ref().is_some_and(|p| {
                    row.path.file_name().is_some_and(|name| {
                        transaction::active_link(&current, &p.join(name), p, &target)
                    })
                }) && row.path.parent() == Some(&row.source_directory)
                {
                    let existing_id = current.skills.iter().find_map(|m| {
                        let managed = self.content_path(&current, m).canonicalize().ok()?;
                        (managed == target).then_some(m.skill.id)
                    });
                    return Ok(AdoptedEntry::skipped(existing_id));
                }
            }
        } else if row.status == DiscoveryStatus::ManagedLink {
            let target_skill_id = override_skill_id.unwrap();
            if let Ok(target) = row.path.canonicalize() {
                let desired = self
                    .content_path(&current, current.skill(target_skill_id)?)
                    .canonicalize()
                    .ok();
                if desired.as_ref() == Some(&target) {
                    return Ok(AdoptedEntry::skipped(Some(target_skill_id)));
                }
                let Some(agent_id) = row.agent_id else {
                    return Err(changed());
                };
                let filename = row
                    .path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(changed)?
                    .to_owned();
                let previous_link_target = fs::read_link(&row.path).ok();
                let mut next = current.clone();
                let old_skill_id = next.skills.iter().find_map(|m| {
                    let managed = self.content_path(&next, m).canonicalize().ok()?;
                    (managed == target).then_some(m.skill.id)
                });
                let new_category = next.skill(target_skill_id)?.skill.category_id;
                let skill_name = next.skill(target_skill_id)?.skill.name.clone();
                let agent_name = next.agent(agent_id)?.agent.name.clone();
                let a = next.agent_mut(agent_id)?;
                if let Some(old_id) = old_skill_id {
                    let old_category = current
                        .skills
                        .iter()
                        .find(|m| m.skill.id == old_id)
                        .and_then(|m| m.skill.category_id);
                    a.direct.remove(&old_id);
                    a.restore_exclusion(old_category, old_id);
                    a.link_names.remove(&old_id);
                }
                a.direct.insert(target_skill_id);
                a.remove_exclusion(new_category, target_skill_id);
                a.link_names.insert(target_skill_id, filename);
                let item = backups::OriginalBackupItem {
                    id: Uuid::new_v4(),
                    agent_id,
                    agent_name,
                    skill_id: target_skill_id,
                    skill_name,
                    original_path: row.path.clone(),
                    backup_path: None,
                    previous_link_target,
                    size_bytes: 0,
                };
                backups::record_backup_item(&mut next, batch_id, summary, item.clone(), None, None);
                self.publish_changes(&mut current, next)?;
                return Ok(AdoptedEntry {
                    skipped: false,
                    skill_id: Some(target_skill_id),
                    new_skill_id: None,
                    new_agent_id: None,
                    linked: true,
                    backup_item: Some(item),
                });
            }
            return Err(changed());
        }

        let copy_link = row.status == DiscoveryStatus::ExternalLink;
        if (!copy_link && row.status != DiscoveryStatus::Directory)
            || row.path.parent() != Some(&row.source_directory)
        {
            return Err(changed());
        }
        let fingerprint = row.fingerprint.as_ref().ok_or_else(changed)?;
        let input = if copy_link {
            let target = row.target.as_ref().ok_or_else(changed)?;
            if !row.path.is_symlink() || row.path.canonicalize().ok().as_ref() != Some(target) {
                return Err(changed());
            }
            target
        } else {
            &row.path
        };
        let source = self.adoption_source_folder(&current, input, copy_link)?;
        let identity = transaction::DirectoryIdentity::read(&source).map_err(|_| changed())?;
        if serde_json::to_string(&identity).ok() != row.identity {
            return Err(changed());
        }
        let directory = source.parent().ok_or_else(changed)?;
        let name = files::read_metadata(&source.join("SKILL.md"))?.name;
        let provenance = installed_source(installation_records(directory).as_ref(), &source, &name)
            .or_else(|| checkout_source(&source));
        if provenance != row.source {
            return Err(changed());
        }
        let mut next = current.clone();
        let agent_directory = row.source_directory.canonicalize().map_err(|_| changed())?;
        let directory = &agent_directory;
        let configured = next.agents.iter().find(|a| a.agent.directory == *directory);
        let preset = presets
            .iter()
            .find(|p| p.directory.canonicalize().ok().as_deref() == Some(directory));
        let mut new_agent_id = None;
        let link_agent = match mode {
            AdoptionMode::CopyOnly => false,
            AdoptionMode::AdoptLocalOnly => !copy_link,
            AdoptionMode::ManageAll => true,
        };
        let agent_id = match (configured, preset, row.agent_kind) {
            _ if !link_agent => None,
            (Some(a), _, Some(kind))
                if a.agent.kind == kind && row.agent_id.is_none_or(|id| id == a.agent.id) =>
            {
                Some(a.agent.id)
            }
            (None, Some(p), Some(kind)) if p.kind == kind && row.agent_id.is_none() => {
                self.inspect_agent_directory(&next, directory, None, Some(p.name))?;
                let a = StoredAgent::new(crate::AgentDraft {
                    kind,
                    name: p.name.into(),
                    directory: directory.into(),
                });
                let id = a.agent.id;
                next.agents.push(a);
                new_agent_id = Some(id);
                Some(id)
            }
            (None, None, None) if row.agent_id.is_none() => None,
            _ => return Err(changed()),
        };

        let existing = if let Some(forced_id) = override_skill_id {
            Some(current.skill(forced_id)?)
        } else {
            self.matching_local_member(&current, &name, fingerprint, &mut BTreeMap::new())
        };

        if agent_id.is_none() && existing.is_some() {
            if files::fingerprint(&source)? != *fingerprint {
                return Err(changed());
            }
            return Ok(AdoptedEntry::skipped(existing.map(|m| m.skill.id)));
        }
        let filename = row
            .path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(changed)?
            .to_owned();
        let (id, skill_name, target, stage, new_skill_id) = if let Some(member) = existing {
            (
                member.skill.id,
                member.skill.name.clone(),
                self.content_path(&current, member),
                None,
                None,
            )
        } else {
            let stage = self.stage_content(&current)?;
            let id = Uuid::new_v4();
            let member = files::stage(&source, &stage.member_path(id), fingerprint)?;
            let stored = self.folder_names(&next)?.store(Skill {
                local_origins: vec![row.source_name.clone()],
                id,
                name: member.name,
                description: member.description,
                folder_name: member.folder_name,
                fingerprint: member.fingerprint,
                category_id: None,
                source: provenance,
            });
            let skill_name = stored.skill.name.clone();
            let target = self.content_path(&next, &stored);
            for agent in &mut next.agents {
                agent.restore_exclusion(None, id);
            }
            next.skills.push(stored);
            (id, skill_name, target, Some(stage), Some(id))
        };

        if let Some(agent_id) = agent_id {
            let member = next.skill(id)?;
            let agent = next.agent(agent_id)?;
            let agent_name = agent.agent.name.clone();
            if agent
                .assignment(member)
                .path
                .is_some_and(|path| path != row.path)
            {
                return Err(LibraryError::new(
                    "同一 Agent 已通过另一个名称使用此 Skill。",
                ));
            }
            if copy_link {
                let previous = fs::read_link(&row.path).map_err(|_| changed())?;
                let adoption = transaction::LinkAdoption {
                    agent_id,
                    skill_id: id,
                    filename,
                    source,
                    previous: previous.clone(),
                    owner: row.link_owner.ok_or_else(changed)?,
                    directory: transaction::DirectoryIdentity::read(directory)
                        .map_err(|_| changed())?,
                    fingerprint: fingerprint.clone(),
                    allow_different_managed_content: override_skill_id.is_some(),
                };
                let item = backups::OriginalBackupItem {
                    id: Uuid::new_v4(),
                    agent_id,
                    agent_name,
                    skill_id: id,
                    skill_name,
                    original_path: row.path.clone(),
                    backup_path: None,
                    previous_link_target: Some(previous),
                    size_bytes: 0,
                };
                backups::record_backup_item(
                    &mut next,
                    batch_id,
                    summary,
                    item.clone(),
                    new_skill_id,
                    new_agent_id,
                );
                self.publish_link_adoptions(&mut current, next, stage, &[adoption])?;
                Ok(AdoptedEntry {
                    skipped: false,
                    skill_id: Some(id),
                    new_skill_id,
                    new_agent_id,
                    linked: true,
                    backup_item: Some(item),
                })
            } else {
                let category = member.skill.category_id;
                let a = next.agent_mut(agent_id)?;
                a.direct.insert(id);
                a.remove_exclusion(category, id);
                a.link_names.insert(id, filename);
                let item_id = Uuid::new_v4();
                let mut item = backups::OriginalBackupItem {
                    id: item_id,
                    agent_id,
                    agent_name,
                    skill_id: id,
                    skill_name,
                    original_path: row.path.clone(),
                    backup_path: None,
                    previous_link_target: None,
                    size_bytes: files::directory_size(&source),
                };
                let pending = item.clone();
                let staged_backup = self.publish_directory_adoption(
                    &mut current,
                    next,
                    stage,
                    source,
                    target,
                    identity,
                    fingerprint.clone(),
                    Box::new(move |registry, staged| {
                        let mut pending = pending;
                        pending.backup_path = Some(staged.to_path_buf());
                        backups::record_backup_item(
                            registry,
                            batch_id,
                            summary,
                            pending,
                            new_skill_id,
                            new_agent_id,
                        );
                    }),
                )?;
                if let Some(staged) = staged_backup {
                    item.backup_path = Some(staged.clone());
                    if let Ok((dest, size)) =
                        self.relocate_original_backup(batch_id, item_id, &staged)
                    {
                        item.backup_path = Some(dest.clone());
                        item.size_bytes = size;
                        // If this update is lost, restore still finds the fixed location.
                        let _ = self.record_relocated_backup(
                            &mut current,
                            batch_id,
                            item_id,
                            dest,
                            size,
                        );
                    }
                }
                Ok(AdoptedEntry {
                    skipped: false,
                    skill_id: Some(id),
                    new_skill_id,
                    new_agent_id,
                    linked: true,
                    backup_item: Some(item),
                })
            }
        } else {
            if (copy_link && row.path.canonicalize().ok().as_ref() != row.target.as_ref())
                || files::fingerprint(&source)? != *fingerprint
                || transaction::DirectoryIdentity::read(&source).ok() != Some(identity)
            {
                return Err(changed());
            }
            self.publish_transaction(&mut current, next, stage)?;
            Ok(AdoptedEntry {
                skipped: false,
                skill_id: Some(id),
                new_skill_id,
                new_agent_id,
                linked: false,
                backup_item: None,
            })
        }
    }
}


use crate::{
    files, Category, CategoryTarget, ImportOutcome, ImportPreview, ImportSelection, LibraryError,
    LibrarySnapshot, MoveOutcome, PreviewProblem, PreviewStatus, Skill,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, ErrorKind},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

mod agents;
pub mod backups;
mod content;
pub mod discovery;
mod folders;
mod location;
mod provenance;
pub(crate) mod settings;
mod transaction;
mod unload;
mod updates;
use agents::StoredAgent;
pub use updates::{
    OutdatedMember, PackageUpdateCheck, PackageUpdateOutcome, PackageUpdatePreview,
    PackageUpdateSelection, PackageUpdateStatus, UpdateAddition, UpdatePackage,
};

const LIBRARY_VERSION: u32 = 1;
// Older releases must not resolve a relocated library against root/skills.
const RELOCATABLE_VERSION: u32 = 2;
const NAMED_FOLDERS_VERSION: u32 = 3;
const PENDING: &str = ".pending";

enum Publication {
    Durable,
    Visible(LibraryError),
}

pub struct Library {
    root: PathBuf,
    registry: Mutex<Registry>,
    update_cache: Mutex<updates::UpdateDownloadCache>,
    _lock: LibraryLock,
    startup_notice: Option<String>,
    #[cfg(test)]
    fail_registry_sync: std::sync::atomic::AtomicBool,
}

struct LibraryLock(File);

impl Drop for LibraryLock {
    fn drop(&mut self) {
        // A forked subprocess can retain the descriptor until it runs exec.
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Registry {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_directory: Option<PathBuf>,
    categories: Vec<Category>,
    skills: Vec<StoredSkill>,
    #[serde(default)]
    agents: Vec<StoredAgent>,
    #[serde(default)]
    last_install_agents: Vec<Uuid>,
    #[serde(default)]
    preferences: settings::Preferences,
    #[serde(default)]
    transaction: Option<Uuid>,
    #[serde(default)]
    link_owners: BTreeMap<PathBuf, transaction::EntryIdentity>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    original_backups: Vec<backups::OriginalBackupBatch>,
    #[serde(skip)]
    undo: Option<PendingMove>,
    #[serde(skip)]
    copy_only_undos: BTreeMap<Uuid, Vec<Uuid>>,
}

#[derive(Clone)]
struct PendingMove {
    id: Uuid,
    changes: CategoryChanges,
    destination: Option<Uuid>,
    created_category: Option<Uuid>,
}

#[derive(Clone, Default)]
struct CategoryChanges {
    previous: Vec<(Uuid, Option<Uuid>)>,
    exclusions: Vec<(Uuid, Option<Uuid>, Uuid)>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredSkill {
    #[serde(flatten)]
    skill: Skill,
    #[serde(flatten)]
    folder: folders::SkillFolder,
}

impl Library {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, LibraryError> {
        let root = root.as_ref();
        fs::create_dir_all(root)
            .map_err(|error| LibraryError::io("无法创建 Skill 库", root, error))?;
        let root = fs::canonicalize(root)
            .map_err(|error| LibraryError::io("无法打开 Skill 库", root, error))?;
        let lock_path = root.join(".lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|error| LibraryError::io("无法锁定 Skill 库", &lock_path, error))?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|error| {
            LibraryError::io("无法锁定 Skill 库，请关闭其他使用此 Skill 库的窗口", &root, error)
        })?;
        let lock = LibraryLock(lock);

        let registry = Self::read_registry(&root.join("library.json"))?;
        let managed = registry
            .managed_directory
            .clone()
            .unwrap_or_else(|| root.join("skills"));
        if registry.managed_directory.is_some() {
            transaction::DirectoryIdentity::read(&managed).map_err(|error| {
                LibraryError::io("无法打开托管目录，请检查目录或磁盘连接", &managed, error)
            })?;
            location::verify_owner(&managed, &root)?;
        } else {
            match fs::create_dir(&managed) {
                Ok(()) => {}
                Err(error)
                    if error.kind() == ErrorKind::AlreadyExists
                        && fs::symlink_metadata(&managed).is_ok_and(|info| info.is_dir()) => {}
                Err(error) => return Err(LibraryError::io("无法创建托管目录", &managed, error)),
            }
        }
        transaction::recover(&root, &registry)?;
        recover_imports(&managed, &registry)
            .map_err(|error| LibraryError::io("无法恢复上次导入", &managed, error))?;

        let library = Self {
            root,
            registry: Mutex::new(registry),
            update_cache: Mutex::new(updates::UpdateDownloadCache::default()),
            _lock: lock,
            startup_notice: None,
            #[cfg(test)]
            fail_registry_sync: std::sync::atomic::AtomicBool::new(false),
        };
        library.upgrade_skill_folders()?;
        let _ = library.prune_expired_backups();
        Ok(library)
    }

    pub fn snapshot(&self) -> Result<LibrarySnapshot, LibraryError> {
        let registry = self.registry()?;
        Ok(self.snapshot_for(&registry))
    }

    pub fn managed_path(&self, id: Uuid) -> Result<PathBuf, LibraryError> {
        let registry = self.registry()?;
        Ok(self.content_path(&registry, registry.skill(id)?))
    }

    fn snapshot_for(&self, registry: &Registry) -> LibrarySnapshot {
        LibrarySnapshot {
            managed_directory: self.managed_directory(registry),
            storage_notice: self.startup_notice.clone(),
            skills: registry
                .skills
                .iter()
                .map(|member| member.skill.clone())
                .collect(),
            categories: registry.categories.clone(),
            agents: registry
                .agents
                .iter()
                .map(|agent| agent.agent.clone())
                .collect(),
            assignments: registry
                .agents
                .iter()
                .flat_map(|agent| {
                    registry
                        .skills
                        .iter()
                        .map(|member| self.observed_assignment(registry, agent, member))
                        .filter(|assignment| assignment.path.is_some() || assignment.excluded)
                })
                .collect(),
            last_install_agents: registry.last_install_agents.clone(),
            original_backup_count: registry
                .original_backups
                .iter()
                .filter(|b| !b.items.is_empty())
                .count(),
        }
    }

    fn managed_directory(&self, registry: &Registry) -> PathBuf {
        registry
            .managed_directory
            .clone()
            .unwrap_or_else(|| self.root.join("skills"))
    }

    fn content_path(&self, registry: &Registry, stored: &StoredSkill) -> PathBuf {
        self.managed_directory(registry)
            .join(stored.folder.relative_path(stored.skill.id))
    }

    pub fn preview_folders(&self, paths: Vec<PathBuf>) -> Result<ImportPreview, LibraryError> {
        let registry = self.registry()?;
        let mut fingerprints = registry.fingerprints();
        let mut preview = ImportPreview {
            members: Vec::new(),
            problems: Vec::new(),
        };
        for path in paths {
            match files::inspect(&path, &self.root, &self.managed_directory(&registry)) {
                Ok(mut member) => {
                    if !fingerprints.insert(member.fingerprint.clone()) {
                        member.status = PreviewStatus::Duplicate;
                    }
                    preview.members.push(member);
                }
                Err(error) => preview.problems.push(PreviewProblem {
                    path,
                    message: error.to_string(),
                }),
            }
        }
        Ok(preview)
    }

    pub fn commit_import(
        &self,
        selected: Vec<ImportSelection>,
        target: CategoryTarget,
    ) -> Result<ImportOutcome, LibraryError> {
        self.import(selected, target, None, None)
    }

    pub fn commit_import_with_agents(
        &self,
        selected: Vec<ImportSelection>,
        target: CategoryTarget,
        agents: Vec<Uuid>,
    ) -> Result<ImportOutcome, LibraryError> {
        self.import(selected, target, Some(agents), None)
    }

    pub fn collect_local_skills(
        &self,
        selected: Vec<ImportSelection>,
        target: CategoryTarget,
        agents: Option<Vec<Uuid>>,
        origins: BTreeMap<String, Vec<String>>,
    ) -> Result<ImportOutcome, LibraryError> {
        self.import(selected, target, agents, Some(origins))
    }

    fn import(
        &self,
        selected: Vec<ImportSelection>,
        target: CategoryTarget,
        agents: Option<Vec<Uuid>>,
        mut local_origins: Option<BTreeMap<String, Vec<String>>>,
    ) -> Result<ImportOutcome, LibraryError> {
        let mut registry = self.registry()?;
        let mut fingerprints = if local_origins.is_some() {
            registry
                .skills
                .iter()
                .filter_map(|member| files::fingerprint(&self.content_path(&registry, member)).ok())
                .collect()
        } else {
            registry.fingerprints()
        };
        let mut choices = Vec::new();
        let mut duplicates = 0;
        for selection in selected {
            if fingerprints.insert(selection.fingerprint.clone()) {
                choices.push(selection);
            } else {
                duplicates += 1;
            }
        }
        if choices.is_empty() {
            return Ok(ImportOutcome {
                library: self.snapshot_for(&registry),
                added: Vec::new(),
                duplicates,
            });
        }

        let mut next = registry.clone();
        let category_id = next.resolve_target(target)?;
        let staging = self.stage_content(&registry)?;
        let mut names = self.folder_names(&registry)?;
        let mut added = Vec::with_capacity(choices.len());

        for selection in choices {
            let folder = files::source_folder(
                &selection.path,
                &self.root,
                &self.managed_directory(&registry),
            )?;
            let id = Uuid::new_v4();
            let staged = files::stage(&folder, &staging.member_path(id), &selection.fingerprint)?;
            next.skills.push(
                names.store(Skill {
                    local_origins: local_origins
                        .as_mut()
                        .and_then(|by_hash| by_hash.remove(&selection.fingerprint))
                        .unwrap_or_default(),
                    id,
                    name: staged.name,
                    description: staged.description,
                    folder_name: staged.folder_name,
                    fingerprint: staged.fingerprint,
                    category_id,
                    source: selection.source,
                }),
            );
            if local_origins.is_some() && agents.is_none() {
                for agent in &mut next.agents {
                    agent.restore_exclusion(category_id, id);
                }
            }
            added.push(id);
        }
        if let Some(agents) = agents {
            let mut seen = HashSet::new();
            let agents: Vec<_> = agents.into_iter().filter(|id| seen.insert(*id)).collect();
            for id in &agents {
                next.agent_mut(*id)?.direct.extend(&added);
            }
            next.last_install_agents = agents;
        }

        self.publish_transaction(&mut registry, next, Some(staging))?;
        Ok(ImportOutcome {
            library: self.snapshot_for(&registry),
            added,
            duplicates,
        })
    }

    pub fn create_category(&self, name: String) -> Result<LibrarySnapshot, LibraryError> {
        self.edit_registry(|next| {
            next.resolve_target(CategoryTarget::New { name })?;
            Ok(())
        })
        .map(|(library, ())| library)
    }

    pub fn rename_category(&self, id: Uuid, name: String) -> Result<LibrarySnapshot, LibraryError> {
        self.edit_registry(|next| {
            let name = next.category_name(&name, Some(id))?;
            let category = next
                .categories
                .iter_mut()
                .find(|category| category.id == id)
                .ok_or_else(|| LibraryError::new("该分类已不存在，请选择其他分类。"))?;
            category.name = name;
            Ok(())
        })
        .map(|(library, ())| library)
    }

    pub fn delete_category(&self, id: Uuid) -> Result<LibrarySnapshot, LibraryError> {
        self.edit_registry(|next| {
            next.resolve_target(CategoryTarget::Existing { id })?;
            next.categories.retain(|category| category.id != id);
            for agent in &mut next.agents {
                agent.remove_category(id);
            }
            for member in &mut next.skills {
                if member.skill.category_id == Some(id) {
                    member.skill.category_id = None;
                }
            }
            Ok(())
        })
        .map(|(library, ())| library)
    }

    pub fn reorder_categories(&self, ids: Vec<Uuid>) -> Result<LibrarySnapshot, LibraryError> {
        let mut registry = self.registry()?;
        if ids.len() != registry.categories.len() {
            return Err(LibraryError::new("分类列表已发生变化，请重试。"));
        }
        if registry
            .categories
            .iter()
            .map(|category| category.id)
            .eq(ids.iter().copied())
        {
            return Ok(self.snapshot_for(&registry));
        }
        let mut by_id: BTreeMap<Uuid, Category> = registry
            .categories
            .iter()
            .cloned()
            .map(|category| (category.id, category))
            .collect();
        let mut reordered = Vec::with_capacity(ids.len());
        for id in ids {
            let category = by_id
                .remove(&id)
                .ok_or_else(|| LibraryError::new("分类列表已发生变化，请重试。"))?;
            reordered.push(category);
        }
        let mut next = registry.clone();
        next.categories = reordered;
        self.publish_changes(&mut registry, next)?;
        Ok(self.snapshot_for(&registry))
    }

    pub fn move_skills(
        &self,
        ids: Vec<Uuid>,
        target: CategoryTarget,
    ) -> Result<MoveOutcome, LibraryError> {
        let (library, move_result) = self.edit_registry(|next| {
            let ids: HashSet<_> = ids.into_iter().collect();
            if ids.is_empty() {
                return Ok(None);
            }
            let creating = matches!(target, CategoryTarget::New { .. });
            let destination = next.resolve_target(target)?;
            let changes = next.move_members(&ids, destination)?;
            let moved = changes.previous.len();
            if moved == 0 {
                return Ok(None);
            }
            let undo = PendingMove {
                id: Uuid::new_v4(),
                changes,
                destination,
                created_category: if creating { destination } else { None },
            };
            let id = undo.id;
            next.undo = Some(undo);
            Ok(Some((moved, id)))
        })?;
        Ok(MoveOutcome {
            library,
            moved: move_result.map_or(0, |(moved, _)| moved),
            undo: move_result.map(|(_, id)| id),
        })
    }

    pub fn undo_move(&self, id: Uuid) -> Result<LibrarySnapshot, LibraryError> {
        self.edit_registry(|next| {
            let changed = || LibraryError::new("Skill 库已发生变化，无法撤销此次移动。");
            let pending = next
                .undo
                .take()
                .filter(|undo| undo.id == id)
                .ok_or_else(changed)?;
            for (id, category) in pending.changes.previous {
                if category
                    .is_some_and(|id| !next.categories.iter().any(|category| category.id == id))
                {
                    return Err(changed());
                }
                let member = next
                    .skills
                    .iter_mut()
                    .find(|member| member.skill.id == id)
                    .filter(|member| member.skill.category_id == pending.destination)
                    .ok_or_else(changed)?;
                member.skill.category_id = category;
                for agent in &mut next.agents {
                    agent.remove_exclusion(pending.destination, id);
                }
            }
            for (agent, category, member) in pending.changes.exclusions {
                next.agent_mut(agent)?.restore_exclusion(category, member);
            }
            if let Some(id) = pending.created_category {
                if !next
                    .skills
                    .iter()
                    .any(|member| member.skill.category_id == Some(id))
                {
                    next.categories.retain(|category| category.id != id);
                    for agent in &mut next.agents {
                        agent.remove_category(id);
                    }
                }
            }
            Ok(())
        })
        .map(|(library, ())| library)
    }

    fn edit_registry<T>(
        &self,
        edit: impl FnOnce(&mut Registry) -> Result<T, LibraryError>,
    ) -> Result<(LibrarySnapshot, T), LibraryError> {
        let mut registry = self.registry()?;
        let mut next = registry.clone();
        let result = edit(&mut next)?;
        self.publish_changes(&mut registry, next)?;
        Ok((self.snapshot_for(&registry), result))
    }

    fn registry(&self) -> Result<MutexGuard<'_, Registry>, LibraryError> {
        self.registry
            .lock()
            .map_err(|_| LibraryError::new("Skill 库暂时无法访问，请重启应用。"))
    }

    fn read_registry(path: &Path) -> Result<Registry, LibraryError> {
        match File::open(path) {
            Ok(file) => {
                let registry: Registry =
                    serde_json::from_reader(BufReader::new(file)).map_err(|error| {
                        LibraryError::new(format!("无法读取 Skill 库 {}：{error}", path.display()))
                    })?;
                let supported = match registry.version {
                    LIBRARY_VERSION => registry.managed_directory.is_none(),
                    RELOCATABLE_VERSION => registry
                        .managed_directory
                        .as_ref()
                        .is_some_and(|path| path.is_absolute()),
                    NAMED_FOLDERS_VERSION => registry
                        .managed_directory
                        .as_ref()
                        .is_none_or(|path| path.is_absolute()),
                    _ => false,
                };
                if !supported {
                    return Err(LibraryError::new("此 Skill 库版本与当前应用不兼容。"));
                }
                folders::validate_layout(&registry)?;
                Ok(registry)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Registry::empty()),
            Err(error) => Err(LibraryError::io("无法读取 Skill 库", path, error)),
        }
    }

    fn publish(&self, current: &mut Registry, next: Registry) -> Result<Publication, LibraryError> {
        let path = self.root.join("library.json");
        let io_error = |error| LibraryError::io("无法保存 Skill 库", &path, error);
        let mut pending = NamedTempFile::new_in(&self.root).map_err(io_error)?;
        serde_json::to_writer(pending.as_file_mut(), &next).map_err(|error| {
            LibraryError::new(format!("无法保存 Skill 库 {}：{error}", path.display()))
        })?;
        pending.as_file().sync_all().map_err(io_error)?;
        pending
            .persist(path.clone())
            .map_err(|error| io_error(error.error))?;
        *current = next;
        Ok(match self.sync_published_registry() {
            Ok(()) => Publication::Durable,
            Err(error) => Publication::Visible(LibraryError::io(
                "Skill 库已更新，但无法确认已写入磁盘。请重新打开 Skill 库以完成恢复",
                &path,
                error,
            )),
        })
    }

    fn sync_published_registry(&self) -> io::Result<()> {
        #[cfg(test)]
        if self
            .fail_registry_sync
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Err(io::Error::other("injected registry directory sync failure"));
        }
        transaction::sync_directory(&self.root)
    }
}

impl Registry {
    fn empty() -> Self {
        Self {
            version: NAMED_FOLDERS_VERSION,
            managed_directory: None,
            categories: Vec::new(),
            skills: Vec::new(),
            agents: Vec::new(),
            last_install_agents: Vec::new(),
            preferences: settings::Preferences::default(),
            transaction: None,
            link_owners: BTreeMap::new(),
            original_backups: Vec::new(),
            undo: None,
            copy_only_undos: BTreeMap::new(),
        }
    }

    fn move_members(
        &mut self,
        ids: &HashSet<Uuid>,
        destination: Option<Uuid>,
    ) -> Result<CategoryChanges, LibraryError> {
        let mut changes = CategoryChanges::default();
        let mut found = 0;
        for member in &mut self.skills {
            let id = member.skill.id;
            if !ids.contains(&id) {
                continue;
            }
            found += 1;
            let category = member.skill.category_id;
            if category != destination {
                changes.previous.push((id, category));
                member.skill.category_id = destination;
                for agent in &mut self.agents {
                    if agent.clear_move_exclusions(category, id) {
                        changes.exclusions.push((agent.agent.id, category, id));
                    }
                }
            }
        }
        if found != ids.len() {
            return Err(LibraryError::new("部分 Skill 已不存在，请重新选择。"));
        }
        Ok(changes)
    }

    fn fingerprints(&self) -> HashSet<String> {
        self.skills
            .iter()
            .map(|member| member.skill.fingerprint.clone())
            .collect()
    }

    fn category_name(&self, name: &str, except: Option<Uuid>) -> Result<String, LibraryError> {
        let name = name.trim();
        if name.is_empty() || name == "未分类" || name.eq_ignore_ascii_case("全部 Skill") {
            return Err(LibraryError::new("请输入可用的分类名称。"));
        }
        let folded = name.to_lowercase();
        if self
            .categories
            .iter()
            .any(|category| Some(category.id) != except && category.name.to_lowercase() == folded)
        {
            return Err(LibraryError::new("分类名称已存在，请选择其他名称。"));
        }
        Ok(name.to_owned())
    }

    fn resolve_target(&mut self, target: CategoryTarget) -> Result<Option<Uuid>, LibraryError> {
        match target {
            CategoryTarget::Uncategorized => Ok(None),
            CategoryTarget::Existing { id }
                if self.categories.iter().any(|category| category.id == id) =>
            {
                Ok(Some(id))
            }
            CategoryTarget::Existing { .. } => {
                Err(LibraryError::new("该分类已不存在，请选择其他分类。"))
            }
            CategoryTarget::New { name } => {
                let name = self.category_name(&name, None)?;
                let id = Uuid::new_v4();
                self.categories.push(Category { id, name });
                Ok(Some(id))
            }
        }
    }
}

fn recover_imports(managed: &Path, registry: &Registry) -> io::Result<()> {
    let committed: HashSet<_> = registry
        .skills
        .iter()
        .filter_map(|member| match member.folder {
            folders::SkillFolder::Legacy { batch } => Some(batch),
            _ => None,
        })
        .collect();
    for entry in fs::read_dir(managed)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let marker = entry.path().join(PENDING);
        if !marker.symlink_metadata().is_ok_and(|info| info.is_file()) {
            continue;
        }
        if name.starts_with(".staging-") {
            fs::remove_dir_all(entry.path())?;
        } else if registry.version == LIBRARY_VERSION {
            // Only legacy imports used a pending marker inside the batch itself.
            let Ok(batch) = Uuid::parse_str(&name) else {
                continue;
            };
            if committed.contains(&batch) {
                fs::remove_file(marker)?;
            } else {
                fs::remove_dir_all(entry.path())?;
            }
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod publication_tests {
    use super::*;
    use crate::{AgentDraft, AgentKind};

    #[test]
    fn same_target_replacement_after_exchange_preserves_foreign_link_and_archive() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let source = temp.path().join("agent/example");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: Example\ndescription: Example\n---",
        )
        .unwrap();
        let library = Library::open(&root).unwrap();
        library
            .add_agent(AgentDraft {
                kind: AgentKind::Custom,
                name: "Agent".into(),
                directory: source.parent().unwrap().into(),
            })
            .unwrap();
        let registry = fs::read(root.join("library.json")).unwrap();
        let rows = library.scan_existing_skills(&[], &[], None).unwrap();
        transaction::REPLACE_ADOPTED_LINK.set(true);
        assert!(library.adopt_existing_skills(&[], rows)[0].error.is_some());
        assert_eq!(registry, fs::read(root.join("library.json")).unwrap());
        let replacement = fs::symlink_metadata(&source).unwrap();
        drop(library);
        assert!(Library::open(&root).is_err());
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            fs::symlink_metadata(&source).unwrap().ino(),
            replacement.ino()
        );
        assert!(fs::read_dir(source.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|e| e.path().join("contents/SKILL.md").is_file()));
    }

    #[test]
    fn interrupted_adoption_recovers_the_version_selected_by_the_durable_registry() {
        for committed in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("library");
            let source = temp.path().join("agent/example");
            fs::create_dir_all(&source).unwrap();
            fs::write(
                source.join("SKILL.md"),
                "---\nname: Example\ndescription: Example\n---",
            )
            .unwrap();
            let library = Library::open(&root).unwrap();
            library
                .add_agent(AgentDraft {
                    kind: AgentKind::Custom,
                    name: "Agent".into(),
                    directory: source.parent().unwrap().into(),
                })
                .unwrap();
            let previous = fs::read(root.join("library.json")).unwrap();
            let rows = library.scan_existing_skills(&[], &[], None).unwrap();
            library
                .fail_registry_sync
                .store(true, std::sync::atomic::Ordering::Relaxed);
            assert!(library.adopt_existing_skills(&[], rows)[0].error.is_some());
            drop(library);
            if !committed {
                fs::write(root.join("library.json"), previous).unwrap();
            }
            let library = Library::open(&root).unwrap();
            assert_eq!(source.is_symlink(), committed);
            assert!(source.join("SKILL.md").is_file());
            assert_eq!(
                library.snapshot().unwrap().skills.len(),
                usize::from(committed)
            );
            assert!(!root.join(".transaction.json").exists());
        }
    }

    #[test]
    fn a_visible_but_unsynced_registry_keeps_rollback_files_until_recovery() {
        for rename_survived in [true, false] {
            let workspace = tempfile::tempdir().unwrap();
            let root = workspace.path().join("library");
            let agent_dir = workspace.path().join("agent");
            let source = workspace.path().join("example");
            for path in [&agent_dir, &source] {
                fs::create_dir(path).unwrap();
            }
            fs::write(
                source.join("SKILL.md"),
                "---\nname: Example\ndescription: Temporary fixture\n---\nExample",
            )
            .unwrap();
            let library = Library::open(&root).unwrap();
            let agent = library
                .add_agent(AgentDraft {
                    kind: AgentKind::Custom,
                    name: "Fixture".into(),
                    directory: agent_dir.clone(),
                })
                .unwrap()
                .agents[0]
                .id;
            let preview = library.preview_folders(vec![source]).unwrap();
            let member = &preview.members[0];
            let installed = library
                .commit_import_with_agents(
                    vec![ImportSelection {
                        path: member.path.clone(),
                        fingerprint: member.fingerprint.clone(),
                        source: None,
                    }],
                    CategoryTarget::Uncategorized,
                    vec![agent],
                )
                .unwrap();
            let id = installed.added[0];
            let link = agent_dir.join("example");
            let managed = library.managed_path(id).unwrap();
            let previous = fs::read(root.join("library.json")).unwrap();
            let reset = library.preview_defaults().unwrap();

            library
                .fail_registry_sync
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let error = library.restore_defaults(&reset).unwrap_err();
            assert!(error.to_string().contains("Skill 库已更新"));
            assert!(library.snapshot().unwrap().skills.is_empty());
            assert!(!link.exists());
            assert!(!managed.exists());
            assert!(root.join(".transaction.json").is_file());

            drop(library);
            if !rename_survived {
                // Model the pre-rename registry being the one that survived a power loss.
                fs::write(root.join("library.json"), previous).unwrap();
            }
            let library = Library::open(&root).unwrap();
            assert_eq!(
                library.snapshot().unwrap().skills.is_empty(),
                rename_survived
            );
            assert_eq!(link.join("SKILL.md").is_file(), !rename_survived);
            assert_eq!(managed.join("SKILL.md").is_file(), !rename_survived);
            assert!(!root.join(".transaction.json").exists());
        }
    }

    #[test]
    fn an_unsynced_adoption_still_records_a_restorable_original_backup() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let source = temp.path().join("agent/example");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: Example\ndescription: Example\n---\noriginal body",
        )
        .unwrap();
        let library = Library::open(&root).unwrap();
        library
            .add_agent(AgentDraft {
                kind: AgentKind::Custom,
                name: "Agent".into(),
                directory: source.parent().unwrap().into(),
            })
            .unwrap();
        let rows = library.scan_existing_skills(&[], &[], None).unwrap();
        library
            .fail_registry_sync
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(library.adopt_existing_skills(&[], rows)[0].error.is_some());
        drop(library);

        let library = Library::open(&root).unwrap();
        assert!(source.is_symlink());
        let backups = library.list_original_backups().unwrap();
        assert_eq!(backups.len(), 1);
        library.restore_original_backup(backups[0].id).unwrap();
        assert!(!source.is_symlink());
        assert!(fs::read_to_string(source.join("SKILL.md"))
            .unwrap()
            .contains("original body"));
    }

    #[test]
    fn restore_finds_a_relocated_backup_whose_record_still_names_the_staged_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("library");
        let source = temp.path().join("agent/example");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: Example\ndescription: Example\n---\noriginal body",
        )
        .unwrap();
        let library = Library::open(&root).unwrap();
        library
            .add_agent(AgentDraft {
                kind: AgentKind::Custom,
                name: "Agent".into(),
                directory: source.parent().unwrap().into(),
            })
            .unwrap();
        let rows = library.scan_existing_skills(&[], &[], None).unwrap();
        assert!(library.adopt_existing_skills(&[], rows)[0].error.is_none());

        // Model an interruption after the move into original-backups/ but before its record update.
        let mut current = library.registry().unwrap();
        let mut next = current.clone();
        let batch_id = next.original_backups[0].id;
        next.original_backups[0].items[0].backup_path =
            Some(source.with_file_name(".skill-library-interrupted-0-original/contents"));
        library.publish_changes(&mut current, next).unwrap();
        drop(current);

        library.restore_original_backup(batch_id).unwrap();
        assert!(!source.is_symlink());
        assert!(fs::read_to_string(source.join("SKILL.md"))
            .unwrap()
            .contains("original body"));
    }
}

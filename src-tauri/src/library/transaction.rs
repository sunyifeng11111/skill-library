use super::{
    agents::validate_filename,
    content::{ContentChanges, ContentStage},
    Library, Publication, Registry,
};
use crate::{files, LibraryError};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

#[cfg(any(target_vendor = "apple", target_os = "linux"))]
mod exchange;

const JOURNAL: &str = ".transaction.json";

/// An adoption may replace only the exact symlink the user selected, after verifying
/// its current source and the staged or existing managed member's complete content.
pub(super) struct LinkAdoption {
    pub(super) agent_id: Uuid,
    pub(super) skill_id: Uuid,
    pub(super) filename: String,
    pub(super) source: PathBuf,
    pub(super) previous: PathBuf,
    pub(super) owner: EntryIdentity,
    pub(super) directory: DirectoryIdentity,
    pub(super) fingerprint: String,
    pub(super) allow_different_managed_content: bool,
}

#[derive(Serialize, Deserialize)]
struct Transaction {
    id: Uuid,
    links: Vec<LinkEdit>,
    #[serde(default)]
    content: Option<ContentChanges>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    old_content: Option<ContentChanges>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct LinkEdit {
    pub(super) path: PathBuf,
    pub(super) previous: Option<PathBuf>,
    previous_owner: Option<EntryIdentity>,
    pub(super) target: Option<PathBuf>,
    directory: DirectoryIdentity,
    #[serde(default)]
    atomic: bool,
    #[serde(default)]
    original: Option<(DirectoryIdentity, String)>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(super) struct EntryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    created: Option<std::time::Duration>,
}

impl PartialEq for EntryIdentity {
    fn eq(&self, other: &Self) -> bool {
        #[cfg(target_vendor = "apple")]
        {
            // macOS APFS assigns st_dev dynamically across reboots/remounts,
            // while (inode, birthtime) persists on the volume.
            if self.created.is_some() && other.created.is_some() {
                return self.inode == other.inode && self.created == other.created;
            }
            return self.device == other.device
                && self.inode == other.inode
                && self.created == other.created;
        }
        #[cfg(all(unix, not(target_vendor = "apple")))]
        {
            return self.device == other.device
                && self.inode == other.inode
                && self.created == other.created;
        }
        #[cfg(not(unix))]
        {
            self.created == other.created
        }
    }
}

impl Eq for EntryIdentity {}

impl EntryIdentity {
    pub(super) fn link(path: &Path) -> io::Result<Self> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_symlink() {
            return Err(io::Error::from(ErrorKind::InvalidInput));
        }
        Ok(Self::from_metadata(&metadata))
    }

    #[cfg(any(target_vendor = "apple", target_os = "linux"))]
    fn read(path: &Path) -> io::Result<Self> {
        fs::symlink_metadata(path).map(|metadata| Self::from_metadata(&metadata))
    }

    fn from_metadata(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
            created: metadata
                .created()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()),
        }
    }
}

impl DirectoryIdentity {
    pub(super) fn read(path: &Path) -> io::Result<Self> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir() || fs::canonicalize(path)? != path {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "Agent 目录已移动或被替换",
            ));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
}

#[derive(Clone, Copy, Default)]
enum RepairLinks<'a> {
    #[default]
    None,
    All,
    One(&'a Path),
}

impl RepairLinks<'_> {
    fn includes(self, path: &Path) -> bool {
        match self {
            Self::None => false,
            Self::All => true,
            Self::One(target) => target == path,
        }
    }
}

impl From<bool> for RepairLinks<'_> {
    fn from(repair: bool) -> Self {
        if repair {
            Self::All
        } else {
            Self::None
        }
    }
}

/// Receives the staged path of the displaced original and may amend the registry that
/// commits together with the adoption.
pub(super) type RecordOriginal<'a> = Box<dyn FnOnce(&mut Registry, &Path) + 'a>;

#[derive(Default)]
struct LinkPolicy<'a> {
    directory_edit: Option<LinkEdit>,
    record_original: Option<RecordOriginal<'a>>,
    adoptions: &'a [LinkAdoption],
    repair: RepairLinks<'a>,
}

impl Library {
    pub(super) fn preview_reconciled_links(
        &self,
        current: &Registry,
        next: &Registry,
        repair_unchanged: bool,
    ) -> Result<Vec<LinkEdit>, LibraryError> {
        let before = desired_links(self, current)?;
        let after = desired_links(self, next)?;
        plan_links(
            current,
            &before,
            &after,
            &BTreeMap::new(),
            repair_unchanged.into(),
        )
    }

    pub(super) fn publish_changes(
        &self,
        current: &mut Registry,
        next: Registry,
    ) -> Result<(), LibraryError> {
        self.publish_transaction(current, next, None)
    }

    pub(super) fn publish_transaction(
        &self,
        current: &mut Registry,
        next: Registry,
        stage: Option<ContentStage>,
    ) -> Result<(), LibraryError> {
        self.publish_reconciled(current, next, stage, false)
    }

    /// Backup restore reconciles unchanged assignments to recreate missing links.
    pub(super) fn publish_reconciled(
        &self,
        current: &mut Registry,
        next: Registry,
        stage: Option<ContentStage>,
        repair_unchanged: bool,
    ) -> Result<(), LibraryError> {
        let policy = LinkPolicy {
            repair: repair_unchanged.into(),
            ..LinkPolicy::default()
        };
        self.publish_link_changes(current, next, stage, policy)
    }

    pub(super) fn publish_link_adoptions(
        &self,
        current: &mut Registry,
        next: Registry,
        stage: Option<ContentStage>,
        adoptions: &[LinkAdoption],
    ) -> Result<(), LibraryError> {
        let policy = LinkPolicy {
            adoptions,
            ..LinkPolicy::default()
        };
        self.publish_link_changes(current, next, stage, policy)
    }

    pub(super) fn publish_agent_link(
        &self,
        current: &mut Registry,
        next: Registry,
        path: Option<&Path>,
    ) -> Result<(), LibraryError> {
        let policy = LinkPolicy {
            repair: path.map_or(RepairLinks::None, RepairLinks::One),
            ..LinkPolicy::default()
        };
        self.publish_link_changes(current, next, None, policy)
    }

    pub(super) fn publish_directory_adoption(
        &self,
        current: &mut Registry,
        next: Registry,
        stage: Option<ContentStage>,
        path: PathBuf,
        target: PathBuf,
        original: DirectoryIdentity,
        fingerprint: String,
        record_original: RecordOriginal<'_>,
    ) -> Result<Option<PathBuf>, LibraryError> {
        let directory =
            DirectoryIdentity::read(path.parent().unwrap()).map_err(|_| conflict(&path))?;
        let edit = LinkEdit {
            path,
            target: Some(target),
            directory,
            atomic: true,
            original: Some((original, fingerprint)),
            previous: None,
            previous_owner: None,
        };
        let backups = self.publish_link_changes_inner(
            current,
            next,
            stage,
            LinkPolicy {
                directory_edit: Some(edit),
                record_original: Some(record_original),
                ..Default::default()
            },
        )?;
        Ok(backups.into_iter().next())
    }

    fn publish_link_changes(
        &self,
        current: &mut Registry,
        next: Registry,
        stage: Option<ContentStage>,
        policy: LinkPolicy<'_>,
    ) -> Result<(), LibraryError> {
        self.publish_link_changes_inner(current, next, stage, policy)
            .map(|_| ())
    }

    fn publish_link_changes_inner(
        &self,
        current: &mut Registry,
        mut next: Registry,
        stage: Option<ContentStage>,
        mut policy: LinkPolicy<'_>,
    ) -> Result<Vec<PathBuf>, LibraryError> {
        recover(&self.root, current)?;
        let approved = self.verify_adoptions(&mut next, stage.as_ref(), policy.adoptions)?;
        for agent in &mut next.agents {
            agent.remember_link_names(&next.skills);
        }
        let after = desired_links(self, &next)?;
        let before = desired_links(self, current)?;
        let mut planned_after = after.clone();
        if current.version < super::NAMED_FOLDERS_VERSION
            && next.version == super::NAMED_FOLDERS_VERSION
        {
            // A storage upgrade retargets active, owned shortcuts. It must not reinstall
            // a missing shortcut or overwrite a file another tool placed there.
            planned_after.retain(|path, _| {
                before.get(path).is_some_and(|target| {
                    active_link(
                        current,
                        path,
                        path.parent().expect("agent directory"),
                        target,
                    )
                })
            });
        }
        if let Some(edit) = &policy.directory_edit {
            if before.contains_key(&edit.path) || planned_after.remove(&edit.path) != edit.target {
                return Err(conflict(&edit.path));
            }
        }
        let mut links = plan_links(
            current,
            &before,
            &planned_after,
            &approved,
            policy.repair,
        )?;
        links.extend(policy.directory_edit.take());
        next.link_owners = current
            .link_owners
            .iter()
            .filter(|(path, _)| after.contains_key(*path) && after.get(*path) == before.get(*path))
            .map(|(path, owner)| (path.clone(), *owner))
            .collect();
        if links.is_empty() && stage.is_none() {
            return match self.publish(current, next)? {
                Publication::Durable => Ok(Vec::new()),
                Publication::Visible(error) => Err(error),
            };
        }
        let content = stage
            .as_ref()
            .map(|stage| stage.describe(self, current, &next))
            .transpose()?;
        let old_stage =
            if current.managed_directory != next.managed_directory && !current.skills.is_empty() {
                Some(self.stage_content(current)?)
            } else {
                None
            };
        let old_content = old_stage
            .as_ref()
            .map(|stage| stage.describe(self, current, &next))
            .transpose()?;
        let transaction = Transaction {
            id: Uuid::new_v4(),
            links,
            content,
            old_content,
        };
        let original_backups: Vec<PathBuf> = transaction
            .links
            .iter()
            .enumerate()
            .filter(|(_, edit)| edit.original.is_some())
            .map(|(i, edit)| transaction.artifacts(edit, i).old)
            .collect();
        if let (Some(record), Some(staged)) =
            (policy.record_original.take(), original_backups.first())
        {
            record(&mut next, staged);
        }
        transaction.save(&self.root)?;
        if let Some(stage) = stage {
            stage.keep();
        }
        if let Some(old_stage) = old_stage {
            old_stage.keep();
        }
        next.transaction = Some(transaction.id);
        let result = transaction
            .apply(&mut next)
            .and_then(|()| self.publish(current, next));
        match result {
            Ok(Publication::Durable) => {
                // The committed registry identifies the journal after an interrupted cleanup.
                let _ = transaction.finish(&self.root, true);
                Ok(original_backups)
            }
            // The published registry is already visible. Leave both recovery paths intact
            // until a later directory sync or restart settles which version survived.
            Ok(Publication::Visible(error)) => Err(error),
            Err(error) => match recover(&self.root, current) {
                Ok(()) => Err(error),
                Err(recovery) => Err(LibraryError::new(format!("{error}；{recovery}"))),
            },
        }
    }

    fn verify_adoptions(
        &self,
        next: &mut Registry,
        stage: Option<&ContentStage>,
        selections: &[LinkAdoption],
    ) -> Result<BTreeMap<PathBuf, VerifiedAdoption>, LibraryError> {
        let mut approved = BTreeMap::new();
        let mut pairs = BTreeSet::new();
        for selection in selections {
            validate_filename(&selection.filename)?;
            let agent = next.agent(selection.agent_id)?;
            let member = next.skill(selection.skill_id)?;
            let path = agent.agent.directory.join(&selection.filename);
            if !pairs.insert((selection.agent_id, selection.skill_id)) {
                return Err(conflict(&path));
            }
            let directory = &agent.agent.directory;
            DirectoryIdentity::read(directory)
                .map_err(|error| link_error("无法访问 Agent 目录", directory, error))?;
            let changed = || {
                LibraryError::new(format!(
                    "{}：迁移链接或内容已变化。请重新预览。",
                    path.display()
                ))
            };
            // A case-insensitive volume may otherwise resolve a differently spelled selection.
            let entries = directory
                .read_dir()
                .map_err(|error| link_error("无法读取 Agent 目录", directory, error))?;
            if !entries
                .filter_map(Result::ok)
                .any(|entry| entry.file_name() == selection.filename.as_str())
            {
                return Err(changed());
            }
            let source = self.adoption_source_folder(next, &selection.source, true)?;
            let owner = EntryIdentity::link(&path).map_err(|_| changed())?;
            let old = fs::read_link(&path).map_err(|_| changed())?;
            if DirectoryIdentity::read(directory).ok() != Some(selection.directory)
                || owner != selection.owner
                || old != selection.previous
                || fs::canonicalize(&path).ok().as_ref() != Some(&source)
            {
                return Err(changed());
            }
            let managed = stage
                .map(|stage| stage.member_path(selection.skill_id))
                .filter(|path| path.symlink_metadata().is_ok_and(|entry| entry.is_dir()))
                .unwrap_or_else(|| self.content_path(next, member));
            DirectoryIdentity::read(&managed)
                .map_err(|error| LibraryError::io("无法核对托管文件", &managed, error))?;
            if files::fingerprint(&source)? != selection.fingerprint
                || (!selection.allow_different_managed_content
                    && files::fingerprint(&managed)? != selection.fingerprint)
            {
                return Err(changed());
            }
            let verified = VerifiedAdoption {
                old,
                owner,
                directory: selection.directory,
            };
            if approved.insert(path.clone(), verified).is_some() {
                return Err(conflict(&path));
            }
            let category = member.skill.category_id;
            let agent = next.agent_mut(selection.agent_id)?;
            agent
                .link_names
                .insert(selection.skill_id, selection.filename.clone());
            agent.direct.insert(selection.skill_id);
            agent.remove_exclusion(category, selection.skill_id);
        }
        Ok(approved)
    }
}

struct VerifiedAdoption {
    old: PathBuf,
    owner: EntryIdentity,
    directory: DirectoryIdentity,
}

fn plan_links(
    current: &Registry,
    before: &BTreeMap<PathBuf, PathBuf>,
    after: &BTreeMap<PathBuf, PathBuf>,
    approved: &BTreeMap<PathBuf, VerifiedAdoption>,
    repair: RepairLinks<'_>,
) -> Result<Vec<LinkEdit>, LibraryError> {
    let paths: BTreeSet<_> = before.keys().chain(after.keys()).collect();
    let mut changes = Vec::new();
    for path in paths {
        let adoption = approved.get(path);
        let old = adoption
            .map(|adoption| &adoption.old)
            .or_else(|| before.get(path));
        let new = after.get(path);
        let unchanged = old == new && adoption.is_none();
        if unchanged && !repair.includes(path) {
            continue;
        }
        let parent = path.parent().expect("Agent link has a parent");
        let directory = match DirectoryIdentity::read(parent) {
            Ok(directory) => directory,
            Err(error)
                if new.is_none()
                    && matches!(error.kind(), ErrorKind::NotFound | ErrorKind::InvalidInput) =>
            {
                continue
            }
            Err(error) => return Err(link_error("无法访问 Agent 目录", parent, error)),
        };
        if adoption.is_some_and(|adoption| adoption.directory != directory) {
            return Err(conflict(path));
        }
        let owner = adoption
            .map(|adoption| adoption.owner)
            .or_else(|| current.link_owners.get(path).copied());
        let previous = match link_target(path) {
            Ok(actual)
                if actual.as_ref() == old
                    && owner.is_some()
                    && EntryIdentity::link(path).ok() == owner =>
            {
                actual
            }
            Ok(None) if adoption.is_none() => None,
            Ok(None) => return Err(conflict(path)),
            Ok(Some(_)) | Err(EntryError::NotALink) if new.is_none() => continue,
            Ok(Some(_)) | Err(EntryError::NotALink) => return Err(conflict(path)),
            Err(EntryError::Io(error)) => {
                return Err(link_error("无法读取 Agent 链接", path, error))
            }
        };
        if unchanged && previous.is_some() {
            continue;
        }
        if previous.is_some() || new.is_some() {
            let previous_owner = previous.as_ref().and(owner);
            changes.push(LinkEdit {
                path: path.clone(),
                previous,
                previous_owner,
                target: new.cloned(),
                directory,
                atomic: adoption.is_some(),
                original: None,
            });
        }
    }
    Ok(changes)
}

fn desired_links(
    library: &Library,
    registry: &Registry,
) -> Result<BTreeMap<PathBuf, PathBuf>, LibraryError> {
    let mut result = BTreeMap::new();
    for agent in &registry.agents {
        let mut names = BTreeSet::new();
        for member in &registry.skills {
            if let Some(path) = agent.assignment(member).path {
                validate_filename(agent.filename(member))?;
                if !names.insert(comparison_name(agent.filename(member)))
                    || result
                        .insert(path.clone(), library.content_path(registry, member))
                        .is_some()
                {
                    return Err(conflict(&path));
                }
            }
        }
    }
    Ok(result)
}

pub(super) fn recover(root: &Path, registry: &Registry) -> Result<(), LibraryError> {
    let journal = root.join(JOURNAL);
    let file = match File::open(&journal) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(LibraryError::io("无法读取恢复记录", &journal, error)),
    };
    let transaction: Transaction = serde_json::from_reader(file).map_err(|error| {
        LibraryError::new(format!("无法读取恢复记录 {}：{error}", journal.display()))
    })?;
    let committed = registry.transaction == Some(transaction.id);
    if committed {
        sync_directory(root)
            .map_err(|error| LibraryError::io("无法确认 Skill 库已写入磁盘", root, error))?;
    } else {
        transaction.rollback()?;
    }
    transaction.finish(root, committed)
}

impl Transaction {
    fn finish(&self, root: &Path, committed: bool) -> Result<(), LibraryError> {
        self.clean(committed)?;
        let journal = root.join(JOURNAL);
        let error = |error| LibraryError::io("无法清理恢复记录", &journal, error);
        fs::remove_file(&journal).map_err(error)?;
        sync_directory(root).map_err(error)
    }

    fn save(&self, root: &Path) -> Result<(), LibraryError> {
        let path = root.join(JOURNAL);
        let error = |error| LibraryError::io("无法记录 Agent 链接操作", &path, error);
        let pending = NamedTempFile::new_in(root).map_err(error)?;
        serde_json::to_writer(pending.as_file(), self)
            .map_err(|reason| LibraryError::new(format!("无法记录 Agent 链接操作：{reason}")))?;
        pending.as_file().sync_all().map_err(error)?;
        pending
            .persist_noclobber(&path)
            .map_err(|reason| error(reason.error))?;
        sync_directory(root).map_err(error)
    }

    fn apply(&self, next: &mut Registry) -> Result<(), LibraryError> {
        if let Some(content) = &self.content {
            content.apply_replacements()?;
        }
        for (i, edit) in self.links.iter().enumerate() {
            let stage = self.artifacts(edit, i);
            edit.apply(&stage)?;
            if let Some(target) = &edit.target {
                let owner = EntryIdentity::link(&stage.new)
                    .map_err(|error| link_error("无法记录受管链接", &edit.path, error))?;
                if !owned_link(&edit.path, target, Some(owner)) {
                    return Err(conflict(&edit.path));
                }
                next.link_owners.insert(edit.path.clone(), owner);
            }
        }
        if let Some(content) = &self.content {
            content.apply_removals()?;
        }
        if let Some(old) = &self.old_content {
            old.apply_removals()?;
            old.verify_relocation(
                next.managed_directory
                    .as_deref()
                    .expect("relocation destination"),
            )?;
        }
        Ok(())
    }

    fn rollback(&self) -> Result<(), LibraryError> {
        if let Some(old) = &self.old_content {
            old.rollback()?;
        }
        for (i, edit) in self.links.iter().enumerate().rev() {
            edit.rollback(&self.artifacts(edit, i))?;
        }
        if let Some(content) = &self.content {
            content.rollback()?;
        }
        Ok(())
    }

    fn clean(&self, committed: bool) -> Result<(), LibraryError> {
        for (i, edit) in self.links.iter().enumerate() {
            if edit.directory_matches() {
                let stage = self.artifacts(edit, i);
                if edit.atomic && same_staged_link(&stage.old, &stage.new) {
                    remove_matching_link(&stage.old, edit.target.as_deref())?;
                } else {
                    remove_matching_link(&stage.old, edit.previous.as_deref())?;
                }
                remove_matching_link(&stage.new, edit.target.as_deref())?;
                if edit.original.is_some() && !committed {
                    let archive = stage.old.parent().unwrap();
                    match fs::remove_dir(archive) {
                        Ok(()) => {}
                        Err(e) if e.kind() == ErrorKind::NotFound => {}
                        Err(e) => return Err(link_error("无法清理回退目录", archive, e)),
                    }
                }
                if edit.original.is_some() {
                    sync_directory(edit.path.parent().unwrap())
                        .map_err(|e| link_error("无法保存接管结果", &edit.path, e))?;
                }
            }
        }
        if let Some(content) = &self.content {
            content.clean(committed)?;
        }
        if let Some(old) = &self.old_content {
            old.clean(committed)?;
        }
        Ok(())
    }

    fn artifacts(&self, edit: &LinkEdit, index: usize) -> LinkArtifacts {
        let base = format!(".skill-library-{}-{index}", self.id);
        LinkArtifacts {
            new: edit.path.with_file_name(format!("{base}-new")),
            old: if edit.original.is_some() {
                edit.path
                    .with_file_name(format!("{base}-original"))
                    .join("contents")
            } else {
                edit.path.with_file_name(format!("{base}-old"))
            },
        }
    }
}

struct LinkArtifacts {
    new: PathBuf,
    old: PathBuf,
}

#[cfg(test)]
thread_local! {
    pub(super) static REPLACE_ADOPTED_LINK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl LinkEdit {
    fn directory_matches(&self) -> bool {
        DirectoryIdentity::read(self.path.parent().expect("Agent link has a parent"))
            .is_ok_and(|identity| identity == self.directory)
    }

    fn apply(&self, stage: &LinkArtifacts) -> Result<(), LibraryError> {
        let error = |error| link_error("无法更新 Agent 链接", &self.path, error);
        if !self.directory_matches() {
            return Err(error(io::Error::new(
                ErrorKind::NotFound,
                "Agent 目录已发生变化",
            )));
        }
        if let Some(target) = &self.target {
            check_managed_target(target)?;
            create_symlink(target, &stage.new).map_err(error)?;
        }
        if let Some((identity, fingerprint)) = &self.original {
            #[cfg(any(target_vendor = "apple", target_os = "linux"))]
            {
                let archive = stage.old.parent().unwrap();
                fs::create_dir(archive).map_err(error)?;
                publish_symlink(&stage.new, &stage.old).map_err(error)?;
                sync_directory(archive).map_err(error)?;
                sync_directory(self.path.parent().unwrap()).map_err(error)?;
                if DirectoryIdentity::read(&self.path).ok() != Some(*identity) {
                    return Err(conflict(&self.path));
                }
                // Exchange keeps both entries intact even if the installation changes at
                // the last instant. Verify the displaced entry before committing ownership.
                exchange::swap_entries(&self.path, &stage.old).map_err(error)?;
                if DirectoryIdentity::read(&stage.old).ok() != Some(*identity)
                    || files::fingerprint(&stage.old)? != *fingerprint
                {
                    return Err(conflict(&self.path));
                }
                #[cfg(test)]
                if REPLACE_ADOPTED_LINK.replace(false) {
                    fs::remove_file(&self.path).unwrap();
                    create_symlink(self.target.as_ref().unwrap(), &self.path).unwrap();
                }
                sync_directory(archive).map_err(error)?;
                return sync_directory(self.path.parent().unwrap()).map_err(error);
            }
            #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
            return Err(LibraryError::new("当前平台不支持安全地原子切换安装目录。"));
        }
        if let Some(previous) = &self.previous {
            if !owned_link(&self.path, previous, self.previous_owner) {
                return Err(conflict(&self.path));
            }
            #[cfg(any(target_vendor = "apple", target_os = "linux"))]
            if self.atomic {
                return self.exchange(stage, previous);
            }
            rename_exclusive(&self.path, &stage.old).map_err(error)?;
            if !owned_link(&stage.old, previous, self.previous_owner) {
                // Restore any entry that replaced the link while we were moving it.
                rename_exclusive(&stage.old, &self.path).map_err(error)?;
                return Err(conflict(&self.path));
            }
        }
        if self.target.is_some() {
            match publish_symlink(&stage.new, &self.path) {
                Ok(()) => {}
                Err(reason) if reason.kind() == ErrorKind::AlreadyExists => {
                    return Err(conflict(&self.path))
                }
                Err(reason) => return Err(error(reason)),
            }
        }
        sync_directory(self.path.parent().expect("Agent link has a parent")).map_err(error)
    }

    fn rollback(&self, stage: &LinkArtifacts) -> Result<(), LibraryError> {
        if !self.directory_matches() {
            return if self.atomic {
                Err(conflict(&self.path))
            } else {
                Ok(())
            };
        }
        let error = |error| link_error("无法恢复 Agent 链接", &self.path, error);
        let owns_new = same_staged_link(&self.path, &stage.new);
        #[cfg(any(target_vendor = "apple", target_os = "linux"))]
        if self.atomic {
            if self.has_exchanged(stage)? {
                return self.rollback_exchange(stage, owns_new);
            }
            if owns_new {
                return Err(conflict(&self.path));
            }
        }
        if owns_new {
            fs::remove_file(&self.path).map_err(error)?;
        }
        if stage_has_previous(self, stage) {
            rename_exclusive(&stage.old, &self.path).map_err(error)?;
        }
        sync_directory(self.path.parent().expect("Agent link has a parent")).map_err(error)
    }
}

fn stage_has_previous(edit: &LinkEdit, stage: &LinkArtifacts) -> bool {
    edit.previous
        .as_ref()
        .is_some_and(|target| owned_link(&stage.old, target, edit.previous_owner))
}

fn same_staged_link(path: &Path, staged: &Path) -> bool {
    EntryIdentity::link(staged).is_ok_and(|owner| EntryIdentity::link(path).ok() == Some(owner))
}

fn check_managed_target(target: &Path) -> Result<(), LibraryError> {
    DirectoryIdentity::read(target)
        .map_err(|error| LibraryError::io("无法读取托管 Skill", target, error))?;
    let manifest = target.join("SKILL.md");
    let metadata = manifest
        .symlink_metadata()
        .map_err(|error| LibraryError::io("找不到可读取的 SKILL.md", &manifest, error))?;
    if !metadata.is_file() {
        return Err(LibraryError::new(format!(
            "{}：需要可读取的 SKILL.md 文件。",
            manifest.display()
        )));
    }
    Ok(())
}

enum EntryError {
    NotALink,
    Io(io::Error),
}

fn link_target(path: &Path) -> Result<Option<PathBuf>, EntryError> {
    match fs::read_link(path) {
        Ok(target) => Ok(Some(target)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) if error.kind() == ErrorKind::InvalidInput => Err(EntryError::NotALink),
        Err(error) => Err(EntryError::Io(error)),
    }
}

fn points_to(path: &Path, target: &Path) -> bool {
    matches!(link_target(path), Ok(Some(actual)) if actual == target)
}

pub(super) fn active_link(
    registry: &Registry,
    path: &Path,
    directory: &Path,
    target: &Path,
) -> bool {
    owned_link(path, target, registry.link_owners.get(path).copied())
        && DirectoryIdentity::read(directory).is_ok()
        && check_managed_target(target).is_ok()
}

fn owned_link(path: &Path, target: &Path, owner: Option<EntryIdentity>) -> bool {
    owner.is_some_and(|identity| EntryIdentity::link(path).ok() == Some(identity))
        && points_to(path, target)
}

fn remove_matching_link(path: &Path, target: Option<&Path>) -> Result<(), LibraryError> {
    if target.is_some_and(|target| points_to(path, target)) {
        fs::remove_file(path).map_err(|error| link_error("无法清理事务链接", path, error))?;
    }
    Ok(())
}

pub(super) fn comparison_name(filename: &str) -> String {
    if cfg!(any(target_vendor = "apple", windows)) {
        filename.to_lowercase().nfd().collect()
    } else {
        filename.to_owned()
    }
}

pub(super) fn check_writable_directory(directory: &Path) -> io::Result<()> {
    #[cfg(any(target_vendor = "apple", target_os = "linux"))]
    {
        use rustix::fs::{accessat, Access, AtFlags, CWD};
        accessat(
            CWD,
            directory,
            Access::WRITE_OK | Access::EXEC_OK,
            AtFlags::EACCESS,
        )?;
    }
    #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
    if fs::metadata(directory)?.permissions().readonly() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(())
}

pub(super) fn check_new_link(path: &Path) -> Result<(), LibraryError> {
    let parent = path.parent().expect("Agent link has a parent");
    DirectoryIdentity::read(parent)
        .map_err(|error| link_error("无法访问 Agent 目录", parent, error))?;
    check_writable_directory(parent)
        .map_err(|error| link_error("Agent 目录不可写", parent, error))?;
    match link_target(path) {
        Ok(None) => Ok(()),
        Ok(Some(_)) | Err(EntryError::NotALink) => Err(conflict(path)),
        Err(EntryError::Io(error)) => Err(link_error("无法读取 Agent 链接", path, error)),
    }
}

pub(super) fn conflict(path: &Path) -> LibraryError {
    LibraryError::new(format!(
        "{}：Agent 目录有同名文件或链接。请重新选择目录，或移开冲突项后重试。",
        path.display()
    ))
}

fn link_error(action: &str, path: &Path, error: io::Error) -> LibraryError {
    LibraryError::new(format!(
        "{action} {}：{error}。请检查或重新选择目录后重试。",
        path.display()
    ))
}

#[cfg(unix)]
pub(super) fn create_symlink(target: &Path, path: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(windows)]
pub(super) fn create_symlink(target: &Path, path: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(target, path)
}

#[cfg(any(target_vendor = "apple", target_os = "linux"))]
fn publish_symlink(stage: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{linkat, AtFlags, CWD};
    // Keep the staged symlink as proof of ownership during crash recovery.
    linkat(CWD, stage, CWD, destination, AtFlags::empty()).map_err(Into::into)
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
fn publish_symlink(stage: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(stage, destination)
}

#[cfg(any(target_vendor = "apple", target_os = "linux"))]
pub(super) fn rename_exclusive(source: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};
    renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE).map_err(Into::into)
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
pub(super) fn rename_exclusive(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == ErrorKind::NotFound => fs::rename(source, destination),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::from(ErrorKind::AlreadyExists)),
    }
}

#[cfg(unix)]
pub(super) fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
pub(super) fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

use super::{transaction, Library, Registry};
use crate::{files, LibraryError, LibrarySnapshot};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const BACKUPS_DIR: &str = "original-backups";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackupRetention {
    #[default]
    #[serde(rename = "30d")]
    Days30,
    #[serde(rename = "7d")]
    Days7,
    #[serde(rename = "manual")]
    Manual,
}

impl BackupRetention {
    pub fn max_age_secs(self) -> Option<u64> {
        match self {
            Self::Days30 => Some(30 * 86_400),
            Self::Days7 => Some(7 * 86_400),
            Self::Manual => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalBackupItem {
    pub id: Uuid,
    pub agent_id: Uuid,
    pub agent_name: String,
    pub skill_id: Uuid,
    pub skill_name: String,
    pub original_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_link_target: Option<PathBuf>,
    #[serde(default)]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalBackupBatch {
    pub id: Uuid,
    pub created_at: u64,
    pub summary: String,
    pub items: Vec<OriginalBackupItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_skill_ids: Vec<Uuid>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_agent_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalBackupSummary {
    pub id: Uuid,
    pub created_at: u64,
    pub summary: String,
    pub size_bytes: u64,
    pub item_names: Vec<String>,
    pub item_count: usize,
}

impl OriginalBackupBatch {
    pub(super) fn to_summary(&self) -> OriginalBackupSummary {
        let mut names = Vec::new();
        for item in &self.items {
            if !names.contains(&item.skill_name) {
                names.push(item.skill_name.clone());
            }
        }
        let size_bytes = self
            .items
            .iter()
            .fold(0u64, |acc, item| acc.saturating_add(item.size_bytes));
        OriginalBackupSummary {
            id: self.id,
            created_at: self.created_at,
            summary: self.summary.clone(),
            size_bytes,
            item_names: names,
            item_count: self.items.len(),
        }
    }
}

pub(super) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn move_directory(src: &Path, dst: &Path) -> Result<(), LibraryError> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| LibraryError::io("无法准备备份目录", parent, e))?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            files::copy_dir_all(src, dst)
                .map_err(|e| LibraryError::io("无法复制原文件备份", dst, e))?;
            fs::remove_dir_all(src)
                .map_err(|e| LibraryError::io("无法清理临时备份", src, e))?;
            Ok(())
        }
    }
}

pub(super) fn remove_batch_files(root: &Path, batch: &OriginalBackupBatch) {
    for item in &batch.items {
        if let Some(path) = &item.backup_path {
            let _ = fs::remove_dir_all(path);
        }
    }
    remove_batch_dir(root, batch.id);
}

pub(super) fn remove_batch_dir(root: &Path, batch_id: Uuid) {
    let batch_dir = root.join(BACKUPS_DIR).join(batch_id.to_string());
    let _ = fs::remove_dir_all(&batch_dir);
}

pub(super) fn resolve_link_target(original_path: &Path, target: &Path) -> PathBuf {
    if target.is_absolute() {
        return target.to_path_buf();
    }
    match original_path.parent() {
        Some(parent) => parent.join(target),
        None => target.to_path_buf(),
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if normalized
                    .components()
                    .next_back()
                    .is_some_and(|c| matches!(c, Component::Normal(_)))
                {
                    normalized.pop();
                } else {
                    normalized.push(component);
                }
            }
            _ => normalized.push(component),
        }
    }
    normalized
}

pub(super) fn canonicalize_best_effort(path: &Path) -> PathBuf {
    if let Ok(canon) = fs::canonicalize(path) {
        return canon;
    }
    let cleaned = lexical_normalize(path);
    let mut suffix = Vec::new();
    let mut cursor = cleaned.as_path();
    while let Some(name) = cursor.file_name() {
        suffix.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            break;
        };
        if parent.as_os_str().is_empty() {
            break;
        }
        if let Ok(mut canon) = fs::canonicalize(parent) {
            for segment in suffix.iter().rev() {
                canon.push(segment);
            }
            return canon;
        }
        cursor = parent;
    }
    cleaned
}

pub(super) fn symlink_already_matches(original_path: &Path, expected_target: &Path) -> bool {
    let Ok(actual_target) = fs::read_link(original_path) else {
        return false;
    };
    if actual_target == expected_target {
        return true;
    }
    let actual_resolved =
        canonicalize_best_effort(&resolve_link_target(original_path, &actual_target));
    let expected_resolved =
        canonicalize_best_effort(&resolve_link_target(original_path, expected_target));
    actual_resolved == expected_resolved
}

pub(super) fn default_batch_summary(count: usize) -> String {
    format!("纳入统一管理（{count} 项）")
}

/// Adds one adopted location's backup to its batch inside the registry that commits the
/// adoption, so an adopted location never exists without a way back.
pub(super) fn record_backup_item(
    registry: &mut Registry,
    batch_id: Uuid,
    summary: Option<&str>,
    item: OriginalBackupItem,
    new_skill_id: Option<Uuid>,
    new_agent_id: Option<Uuid>,
) {
    let position = match registry
        .original_backups
        .iter()
        .position(|b| b.id == batch_id)
    {
        Some(position) => position,
        None => {
            registry.original_backups.insert(
                0,
                OriginalBackupBatch {
                    id: batch_id,
                    created_at: unix_now(),
                    summary: String::new(),
                    items: Vec::new(),
                    added_skill_ids: Vec::new(),
                    added_agent_ids: Vec::new(),
                },
            );
            0
        }
    };
    let batch = &mut registry.original_backups[position];
    batch.items.push(item);
    for (ids, id) in [
        (&mut batch.added_skill_ids, new_skill_id),
        (&mut batch.added_agent_ids, new_agent_id),
    ] {
        if let Some(id) = id.filter(|id| !ids.contains(id)) {
            ids.push(id);
        }
    }
    batch.summary = summary.map_or_else(|| default_batch_summary(batch.items.len()), str::to_owned);
}

/// The move into `original-backups/` happens before its registry update, so after an
/// interruption the record may still name the staged path while the contents already
/// sit at the item's fixed location.
pub(super) fn resolve_backup(
    root: &Path,
    batch_id: Uuid,
    item: &OriginalBackupItem,
) -> OriginalBackupItem {
    let mut item = item.clone();
    if item
        .backup_path
        .as_deref()
        .is_some_and(|path| !path.exists())
    {
        let fixed = root
            .join(BACKUPS_DIR)
            .join(batch_id.to_string())
            .join(item.id.to_string());
        if fixed.is_dir() {
            item.backup_path = Some(fixed);
        }
    }
    item
}

/// A backup moves back into place, so a vanished backup next to a real folder at the
/// original path means an earlier, interrupted restore already finished this item.
fn already_restored(item: &OriginalBackupItem) -> bool {
    item.backup_path
        .as_deref()
        .is_some_and(|backup| fs::symlink_metadata(backup).is_err())
        && fs::symlink_metadata(&item.original_path).is_ok_and(|meta| meta.is_dir())
}

/// Restores a single backed-up original folder or previous symlink to its original tool path.
pub(super) fn restore_item_to_original_path(item: &OriginalBackupItem) -> Result<(), String> {
    match fs::symlink_metadata(&item.original_path) {
        Ok(_) => {
            if already_restored(item) {
                return Ok(());
            }
            if item.backup_path.is_none()
                && item
                    .previous_link_target
                    .as_deref()
                    .is_some_and(|target| symlink_already_matches(&item.original_path, target))
            {
                return Ok(());
            }
            return Err(format!(
                "{}：目标位置已有其他文件，已保留备份。",
                item.original_path.display()
            ));
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!("{}：{e}", item.original_path.display()));
        }
    }
    if let Some(backup) = &item.backup_path {
        move_directory(backup, &item.original_path).map_err(|err| err.to_string())?;
    } else if let Some(target) = &item.previous_link_target {
        if let Some(parent) = item.original_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        transaction::create_symlink(target, &item.original_path)
            .map_err(|err| format!("无法恢复软链接 {}：{err}", item.original_path.display()))?;
    }
    Ok(())
}

impl Library {
    pub(super) fn relocate_original_backup(
        &self,
        batch_id: Uuid,
        item_id: Uuid,
        staged_contents: &Path,
    ) -> Result<(PathBuf, u64), LibraryError> {
        let dest = self
            .root
            .join(BACKUPS_DIR)
            .join(batch_id.to_string())
            .join(item_id.to_string());
        move_directory(staged_contents, &dest)?;
        // Remove the empty `.skill-library-{txid}-{idx}-original` wrapper in the agent folder.
        if let Some(wrapper) = staged_contents.parent() {
            let _ = fs::remove_dir(wrapper);
        }
        let size = files::directory_size(&dest);
        Ok((dest, size))
    }

    pub(super) fn record_relocated_backup(
        &self,
        current: &mut Registry,
        batch_id: Uuid,
        item_id: Uuid,
        backup_path: PathBuf,
        size_bytes: u64,
    ) -> Result<(), LibraryError> {
        let mut next = current.clone();
        let Some(item) = next
            .original_backups
            .iter_mut()
            .find(|batch| batch.id == batch_id)
            .and_then(|batch| batch.items.iter_mut().find(|item| item.id == item_id))
        else {
            return Ok(());
        };
        item.backup_path = Some(backup_path);
        item.size_bytes = size_bytes;
        self.publish_changes(current, next)
    }

    /// Items are committed with each location; this only settles batch-level metadata.
    pub(super) fn finalize_original_backup_batch(
        &self,
        batch_id: Uuid,
        summary: String,
        added_skill_ids: &[Uuid],
        added_agent_ids: &[Uuid],
    ) -> Result<(), LibraryError> {
        let mut current = self.registry()?;
        let mut next = current.clone();
        let Some(batch) = next.original_backups.iter_mut().find(|b| b.id == batch_id) else {
            return Ok(());
        };
        let mut changed = batch.summary != summary;
        batch.summary = summary;
        for (ids, added) in [
            (&mut batch.added_skill_ids, added_skill_ids),
            (&mut batch.added_agent_ids, added_agent_ids),
        ] {
            for id in added {
                if !ids.contains(id) {
                    ids.push(*id);
                    changed = true;
                }
            }
        }
        if !changed {
            return Ok(());
        }
        self.publish_changes(&mut current, next)
    }

    pub fn list_original_backups(&self) -> Result<Vec<OriginalBackupSummary>, LibraryError> {
        let registry = self.registry()?;
        let mut summaries: Vec<_> = registry
            .original_backups
            .iter()
            .filter(|batch| !batch.items.is_empty())
            .map(OriginalBackupBatch::to_summary)
            .collect();
        summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(summaries)
    }

    pub fn prune_expired_backups(&self) -> Result<(), LibraryError> {
        let mut current = self.registry()?;
        let Some(max_age) = current.preferences.backup_retention.max_age_secs() else {
            return Ok(());
        };
        let now = unix_now();
        let (expired, kept): (Vec<_>, Vec<_>) = current
            .original_backups
            .iter()
            .cloned()
            .partition(|batch| now.saturating_sub(batch.created_at) >= max_age);
        if expired.is_empty() {
            return Ok(());
        }
        let mut next = current.clone();
        next.original_backups = kept;
        // Forget the record first: orphaned files are harmless, a record without files is not.
        self.publish_changes(&mut current, next)?;
        for batch in &expired {
            remove_batch_files(&self.root, batch);
        }
        Ok(())
    }

    pub fn delete_original_backup(
        &self,
        batch_id: Uuid,
    ) -> Result<Vec<OriginalBackupSummary>, LibraryError> {
        let mut current = self.registry()?;
        let Some(pos) = current
            .original_backups
            .iter()
            .position(|b| b.id == batch_id)
        else {
            return self.list_original_backups();
        };
        let removed = current.original_backups[pos].clone();
        let mut next = current.clone();
        next.original_backups.retain(|b| b.id != batch_id);
        self.publish_changes(&mut current, next)?;
        drop(current);
        remove_batch_files(&self.root, &removed);
        self.list_original_backups()
    }

    /// Restores the original files/links in tool directories and detaches the managed links,
    /// while intentionally keeping the managed Skill copies inside the library.
    pub fn restore_original_backup(&self, batch_id: Uuid) -> Result<LibrarySnapshot, LibraryError> {
        self.restore_batch_internal(batch_id, false)
    }

    /// Full immediate Undo for a recent unified/incremental adoption or copy-only import batch.
    pub fn undo_adoption_batch(&self, batch_id: Uuid) -> Result<LibrarySnapshot, LibraryError> {
        let mut current = self.registry()?;
        if let Some(added_ids) = current.copy_only_undos.get(&batch_id).cloned() {
            let mut next = current.clone();
            next.copy_only_undos.remove(&batch_id);
            let removable = removable_unused_skills(&next, &added_ids);
            if removable.is_empty() {
                current.copy_only_undos.remove(&batch_id);
                return Ok(self.snapshot_for(&current));
            }
            next.skills.retain(|m| !removable.contains(&m.skill.id));
            for id in &removable {
                for agent in &mut next.agents {
                    agent.forget_member(*id);
                }
            }
            let stage = self.stage_content(&current)?;
            self.publish_transaction(&mut current, next, Some(stage))?;
            current.copy_only_undos.remove(&batch_id);
            return Ok(self.snapshot_for(&current));
        }
        drop(current);
        self.restore_batch_internal(batch_id, true)
    }

    fn restore_batch_internal(
        &self,
        batch_id: Uuid,
        remove_added_records: bool,
    ) -> Result<LibrarySnapshot, LibraryError> {
        let mut current = self.registry()?;
        let batch = current
            .original_backups
            .iter()
            .find(|b| b.id == batch_id)
            .cloned()
            .ok_or_else(|| LibraryError::new("找不到该原文件备份记录，可能已被恢复或清理。"))?;

        let items: Vec<_> = batch
            .items
            .iter()
            .map(|item| resolve_backup(&self.root, batch_id, item))
            .collect();

        // Verify all backed-up directories exist before detaching links.
        for item in &items {
            if let Some(backup) = &item.backup_path {
                if !backup.is_dir() && !already_restored(item) {
                    return Err(LibraryError::new(format!(
                        "无法恢复「{}」：原文件备份已不存在。",
                        item.skill_name
                    )));
                }
            }
        }

        // Step 1: Detach the managed assignments in the registry and remove managed symlinks.
        let mut next = current.clone();
        for item in &batch.items {
            let category = next
                .skills
                .iter()
                .find(|s| s.skill.id == item.skill_id)
                .and_then(|s| s.skill.category_id);
            if let Ok(agent) = next.agent_mut(item.agent_id) {
                agent.direct.remove(&item.skill_id);
                agent.restore_exclusion(category, item.skill_id);
                agent.link_names.remove(&item.skill_id);
            }
        }
        self.publish_changes(&mut current, next)?;

        // Step 2: Restore each original folder or previous external symlink at its original path.
        let mut restore_errors = Vec::new();
        for item in &items {
            if let Err(err) = restore_item_to_original_path(item) {
                restore_errors.push(err);
            }
        }

        if !restore_errors.is_empty() {
            return Err(LibraryError::new(restore_errors.join("；")));
        }

        // Step 3: Remove the backup record (and for Undo, also remove newly created unused skills & agents).
        let mut final_next = current.clone();
        final_next.original_backups.retain(|b| b.id != batch_id);
        let mut stage = None;

        if remove_added_records {
            let removable_skills = removable_unused_skills(&final_next, &batch.added_skill_ids);
            if !removable_skills.is_empty() {
                final_next
                    .skills
                    .retain(|m| !removable_skills.contains(&m.skill.id));
                for id in &removable_skills {
                    for agent in &mut final_next.agents {
                        agent.forget_member(*id);
                    }
                }
                stage = Some(self.stage_content(&current)?);
            }
            if !batch.added_agent_ids.is_empty() {
                final_next.agents.retain(|agent| {
                    if !batch.added_agent_ids.contains(&agent.agent.id) {
                        return true;
                    }
                    // Keep agent if it still has other assignments or sync subscriptions.
                    !agent.direct.is_empty()
                        || !agent.agent.synced_categories.is_empty()
                        || agent.agent.sync_uncategorized
                });
            }
        }

        self.publish_transaction(&mut current, final_next, stage)?;
        remove_batch_dir(&self.root, batch_id);
        Ok(self.snapshot_for(&current))
    }
}

fn removable_unused_skills(registry: &Registry, candidates: &[Uuid]) -> Vec<Uuid> {
    candidates
        .iter()
        .copied()
        .filter(|skill_id| {
            let Some(member) = registry.skills.iter().find(|m| m.skill.id == *skill_id) else {
                return false;
            };
            !registry
                .agents
                .iter()
                .any(|agent| agent.assignment(member).path.is_some())
        })
        .collect()
}

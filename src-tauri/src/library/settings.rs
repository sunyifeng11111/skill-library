mod archive;

use self::archive::Backup;
use super::{
    backups::{self, OriginalBackupItem},
    transaction::{self, DirectoryIdentity},
    Library, Registry,
};
use crate::{LibraryError, LibrarySnapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Language {
    #[default]
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en")]
    En,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub language: Language,
    pub theme: Theme,
    #[serde(default, rename = "backupRetention")]
    pub backup_retention: super::backups::BackupRetention,
    #[serde(
        default = "default_auto_check_app_updates",
        rename = "autoCheckAppUpdates"
    )]
    pub auto_check_app_updates: bool,
}

fn default_auto_check_app_updates() -> bool {
    true
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: Language::default(),
            theme: Theme::default(),
            backup_retention: super::backups::BackupRetention::default(),
            auto_check_app_updates: default_auto_check_app_updates(),
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetBackupPolicy {
    #[default]
    Keep,
    RestoreOriginals,
    DeleteBackups,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryCounts {
    pub skills: usize,
    pub categories: usize,
    pub agents: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementPreview {
    pub token: String,
    pub current: LibraryCounts,
    pub incoming: LibraryCounts,
    pub links_removed: Vec<PathBuf>,
    pub links_created: Vec<PathBuf>,
    pub preferences: Preferences,
    #[serde(default)]
    pub original_backup_batches: usize,
    #[serde(default)]
    pub original_backup_items: usize,
}

#[derive(Debug, Serialize)]
pub struct SettingsOutcome {
    pub library: LibrarySnapshot,
    pub preferences: Preferences,
}

impl Library {
    pub fn preferences(&self) -> Result<Preferences, LibraryError> {
        Ok(self.registry()?.preferences)
    }

    pub fn set_preferences(&self, preferences: Preferences) -> Result<Preferences, LibraryError> {
        let mut current = self.registry()?;
        let changed = current.preferences != preferences;
        if changed {
            let mut next = current.clone();
            next.preferences = preferences;
            self.publish_changes(&mut current, next)?;
        }
        let saved = current.preferences;
        drop(current);
        if changed {
            let _ = self.prune_expired_backups();
        }
        Ok(saved)
    }

    pub fn export_backup(&self, path: impl AsRef<Path>) -> Result<(), LibraryError> {
        let path = path.as_ref();
        let failure = |error| LibraryError::io("无法导出备份", path, error);
        let current = self.registry()?;
        let name = path.file_name().ok_or_else(|| invalid("备份文件名无效"))?;
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let parent = fs::canonicalize(parent).map_err(failure)?;
        let destination = parent.join(name);
        if destination.starts_with(&self.root)
            || destination.starts_with(self.managed_directory(&current))
            || current
                .agents
                .iter()
                .any(|agent| destination.starts_with(&agent.agent.directory))
        {
            return Err(invalid("请选择 Skill 库和 Agent 目录以外的备份位置"));
        }
        match fs::symlink_metadata(&destination) {
            Ok(entry) if !entry.is_file() => return Err(invalid("请选择普通备份文件")),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(failure(error)),
        }

        let backup = Backup::capture(self, &current)?;
        let mut temporary = NamedTempFile::new_in(&parent).map_err(failure)?;
        serde_json::to_writer(temporary.as_file_mut(), &backup)
            .map_err(|error| invalid(error.to_string()))?;
        temporary.as_file().sync_all().map_err(failure)?;
        temporary
            .persist(destination)
            .map_err(|error| failure(error.error))?;
        transaction::sync_directory(&parent).map_err(failure)
    }

    pub fn preview_backup(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<ReplacementPreview, LibraryError> {
        let (backup, digest) = Backup::read(path.as_ref())?;
        let current = self.registry()?;
        let next = backup.registry(self, &current)?;
        self.replacement_preview(&current, &next, &digest, true)
    }

    pub fn restore_backup(
        &self,
        path: impl AsRef<Path>,
        preview: &ReplacementPreview,
    ) -> Result<SettingsOutcome, LibraryError> {
        let (backup, digest) = Backup::read(path.as_ref())?;
        let mut current = self.registry()?;
        let next = backup.registry(self, &current)?;
        self.replace(&mut current, next, Some((&backup, &digest)), preview)
    }

    pub fn preview_defaults(&self) -> Result<ReplacementPreview, LibraryError> {
        let current = self.registry()?;
        self.replacement_preview(&current, &current.cleared(), "defaults", false)
    }

    pub fn restore_defaults(
        &self,
        preview: &ReplacementPreview,
    ) -> Result<SettingsOutcome, LibraryError> {
        self.restore_defaults_with_policy(preview, ResetBackupPolicy::Keep)
    }

    pub fn restore_defaults_with_policy(
        &self,
        preview: &ReplacementPreview,
        policy: ResetBackupPolicy,
    ) -> Result<SettingsOutcome, LibraryError> {
        let mut current = self.registry()?;
        let next = current.cleared();
        match policy {
            ResetBackupPolicy::Keep => self.replace(&mut current, next, None, preview),
            ResetBackupPolicy::DeleteBackups => {
                let backups_to_delete = current.original_backups.clone();
                let outcome = self.replace(&mut current, next, None, preview)?;
                if backups_to_delete.is_empty() {
                    return Ok(outcome);
                }
                let mut final_next = current.clone();
                final_next.original_backups.clear();
                self.publish_changes(&mut current, final_next)?;
                for batch in &backups_to_delete {
                    backups::remove_batch_files(&self.root, batch);
                }
                Ok(SettingsOutcome {
                    library: self.snapshot_for(&current),
                    preferences: current.preferences,
                })
            }
            ResetBackupPolicy::RestoreOriginals => {
                if current
                    .original_backups
                    .iter()
                    .all(|batch| batch.items.is_empty())
                {
                    return self.replace(&mut current, next, None, preview);
                }
                let fresh_preview = self.replacement_preview(&current, &next, "defaults", false)?;
                if &fresh_preview != preview {
                    return Err(LibraryError::new("Skill 库、链接或备份已变化，请重新预览。"));
                }
                let managed_dir = self.managed_directory(&current);
                let plan = plan_original_restorations(
                    &current,
                    &managed_dir,
                    &self.root,
                    &fresh_preview.links_removed,
                )?;
                self.replace(&mut current, next, None, preview)?;
                self.apply_original_restorations(&mut current, &plan)
            }
        }
    }

    fn apply_original_restorations(
        &self,
        current: &mut Registry,
        plan: &OriginalRestorationPlan,
    ) -> Result<SettingsOutcome, LibraryError> {
        let mut restored_ids: BTreeSet<Uuid> = plan.obsolete_ids.iter().copied().collect();
        let mut errors = Vec::new();
        for planned in &plan.restorations {
            match backups::restore_item_to_original_path(&planned.item) {
                Ok(()) => {
                    restored_ids.insert(planned.item.id);
                    restored_ids.extend(planned.superseded_symlink_ids.iter().copied());
                }
                Err(error) => errors.push(error),
            }
        }
        if !restored_ids.is_empty() {
            let mut final_next = current.clone();
            let mut emptied_batches = Vec::new();
            for batch in &mut final_next.original_backups {
                batch.items.retain(|item| !restored_ids.contains(&item.id));
                if batch.items.is_empty() {
                    emptied_batches.push(batch.id);
                }
            }
            final_next
                .original_backups
                .retain(|batch| !batch.items.is_empty());
            self.publish_changes(current, final_next)?;
            for batch_id in emptied_batches {
                backups::remove_batch_dir(&self.root, batch_id);
            }
        }
        if !errors.is_empty() {
            return Err(LibraryError::new(errors.join("；")));
        }
        Ok(SettingsOutcome {
            library: self.snapshot_for(current),
            preferences: current.preferences,
        })
    }

    fn replace(
        &self,
        current: &mut Registry,
        next: Registry,
        backup: Option<(&Backup, &str)>,
        preview: &ReplacementPreview,
    ) -> Result<SettingsOutcome, LibraryError> {
        let digest = backup.map_or("defaults", |(_, digest)| digest);
        let repair_links = backup.is_some();
        let check = || {
            if &self.replacement_preview(current, &next, digest, repair_links)? != preview {
                return Err(LibraryError::new("Skill 库、链接或备份已变化，请重新预览。"));
            }
            Ok(())
        };
        check()?;
        let stage = self.stage_content(current)?;
        if let Some((backup, _)) = backup {
            backup.stage(&stage)?;
        }
        check()?;
        self.publish_reconciled(current, next, Some(stage), repair_links)?;
        Ok(SettingsOutcome {
            library: self.snapshot_for(current),
            preferences: current.preferences,
        })
    }

    fn replacement_preview(
        &self,
        current: &Registry,
        next: &Registry,
        digest: &str,
        repair_links: bool,
    ) -> Result<ReplacementPreview, LibraryError> {
        let links = self.preview_reconciled_links(current, next, repair_links)?;
        let managed = self.managed_directory(current);
        let mut content = Vec::new();
        for path in std::iter::once(managed).chain(
            current
                .skills
                .iter()
                .map(|member| self.content_path(current, member)),
        ) {
            let identity = match DirectoryIdentity::read(&path) {
                Ok(identity) => Some(identity),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(LibraryError::io("无法核对托管目录", &path, error)),
            };
            content.push((path, identity));
        }
        let scope = serde_json::to_vec(&(digest, current, next, &links, content))
            .map_err(|error| invalid(error.to_string()))?;
        let original_backup_batches = current
            .original_backups
            .iter()
            .filter(|batch| !batch.items.is_empty())
            .count();
        let original_backup_items = current
            .original_backups
            .iter()
            .map(|batch| batch.items.len())
            .sum();
        Ok(ReplacementPreview {
            token: format!("{:x}", Sha256::digest(scope)),
            current: counts(current),
            incoming: counts(next),
            links_removed: links
                .iter()
                .filter(|link| link.previous.is_some())
                .map(|link| link.path.clone())
                .collect(),
            links_created: links
                .iter()
                .filter(|link| link.target.is_some())
                .map(|link| link.path.clone())
                .collect(),
            preferences: next.preferences,
            original_backup_batches,
            original_backup_items,
        })
    }
}

fn normalize_entry_path(path: &Path) -> PathBuf {
    let Some(name) = path.file_name() else {
        return path.to_path_buf();
    };
    match path.parent().and_then(|parent| fs::canonicalize(parent).ok()) {
        Some(parent) => parent.join(name),
        None => path.to_path_buf(),
    }
}

struct PlannedRestoration {
    item: OriginalBackupItem,
    superseded_symlink_ids: Vec<Uuid>,
}

struct OriginalRestorationPlan {
    restorations: Vec<PlannedRestoration>,
    obsolete_ids: Vec<Uuid>,
}

fn points_inside_library(item: &OriginalBackupItem, managed_dir: &Path, root: &Path) -> bool {
    if item.backup_path.is_some() {
        return false;
    }
    let Some(target) = item.previous_link_target.as_deref() else {
        return false;
    };
    let resolved = backups::resolve_link_target(&item.original_path, target);
    let canon_target = backups::canonicalize_best_effort(&resolved);
    let managed_canon = backups::canonicalize_best_effort(managed_dir);
    let root_canon = backups::canonicalize_best_effort(root);
    resolved.starts_with(managed_dir)
        || canon_target.starts_with(&managed_canon)
        || resolved.starts_with(root)
        || canon_target.starts_with(&root_canon)
}

fn plan_original_restorations(
    current: &Registry,
    managed_dir: &Path,
    root: &Path,
    links_removed: &[PathBuf],
) -> Result<OriginalRestorationPlan, LibraryError> {
    let links_removed_keys: BTreeSet<PathBuf> = links_removed
        .iter()
        .map(|path| normalize_entry_path(path))
        .collect();
    let mut ordered_batches: Vec<_> = current.original_backups.iter().collect();
    ordered_batches.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let mut chosen_by_key: BTreeMap<PathBuf, usize> = BTreeMap::new();
    let mut conflicted_keys: BTreeSet<PathBuf> = BTreeSet::new();
    let mut conflicts: Vec<PathBuf> = Vec::new();
    let mut restorations: Vec<PlannedRestoration> = Vec::new();
    let mut obsolete_ids: Vec<Uuid> = Vec::new();
    for batch in ordered_batches {
        for item in &batch.items {
            let item = &backups::resolve_backup(root, batch.id, item);
            if item.backup_path.is_none()
                && (item.previous_link_target.is_none()
                    || points_inside_library(item, managed_dir, root))
            {
                obsolete_ids.push(item.id);
                continue;
            }
            let key = normalize_entry_path(&item.original_path);
            if conflicted_keys.contains(&key) {
                continue;
            }
            if let Some(&idx) = chosen_by_key.get(&key) {
                if item.backup_path.is_none() {
                    restorations[idx].superseded_symlink_ids.push(item.id);
                }
                continue;
            }
            if let Some(backup) = &item.backup_path {
                if !backup.is_dir() {
                    return Err(LibraryError::new(format!(
                        "无法恢复「{}」：原文件备份已不存在。",
                        item.skill_name
                    )));
                }
            }
            match fs::symlink_metadata(&item.original_path) {
                Ok(_) if links_removed_keys.contains(&key) => {}
                Ok(_)
                    if item.backup_path.is_none()
                        && item.previous_link_target.as_deref().is_some_and(|target| {
                            backups::symlink_already_matches(&item.original_path, target)
                        }) => {}
                Ok(_) => {
                    conflicted_keys.insert(key);
                    conflicts.push(item.original_path.clone());
                    continue;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(LibraryError::io(
                        "无法核对原工具目录",
                        &item.original_path,
                        error,
                    ));
                }
            }
            chosen_by_key.insert(key, restorations.len());
            restorations.push(PlannedRestoration {
                item: item.clone(),
                superseded_symlink_ids: Vec::new(),
            });
        }
    }
    if !conflicts.is_empty() {
        let message = if conflicts.len() == 1 {
            format!(
                "{}：目标位置已有其他文件，无法在重置前还原原文件。请先处理冲突，或取消勾选“重置前先还原原文件”。",
                conflicts[0].display()
            )
        } else {
            format!(
                "{} 等 {} 处目标位置已有其他文件，无法在重置前还原原文件。请先处理冲突，或取消勾选“重置前先还原原文件”。",
                conflicts[0].display(),
                conflicts.len()
            )
        };
        return Err(LibraryError::new(message));
    }
    Ok(OriginalRestorationPlan {
        restorations,
        obsolete_ids,
    })
}

fn counts(registry: &Registry) -> LibraryCounts {
    LibraryCounts {
        skills: registry.skills.len(),
        categories: registry.categories.len(),
        agents: registry.agents.len(),
    }
}

fn invalid(detail: impl std::fmt::Display) -> LibraryError {
    LibraryError::new(format!("备份无效：{detail}。"))
}

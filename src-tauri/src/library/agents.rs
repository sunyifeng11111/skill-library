use super::{transaction, Library, Registry, StoredSkill};
use crate::{
    Agent, AgentAssignment, AgentDirectoryPreview, AgentDraft, CategoryTarget, InstallAgentTarget,
    InstallAssignmentsPreview, LibraryError, LibrarySnapshot, PreviewProblem, SyncImpact,
    SyncOutcome,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredAgent {
    #[serde(flatten)]
    pub(super) agent: Agent,
    #[serde(default)]
    pub(super) direct: BTreeSet<Uuid>,
    #[serde(default)]
    pub(super) exclusions: BTreeMap<Uuid, BTreeSet<Uuid>>,
    // Keep deployed and explicitly adopted filenames across updates and disable/enable.
    #[serde(default)]
    pub(super) link_names: BTreeMap<Uuid, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    sync_undo: BTreeMap<Uuid, SyncUndo>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SyncUndo {
    id: Uuid,
    enabled: bool,
    exclusions: BTreeSet<Uuid>,
}

impl Library {
    pub fn preview_agent_directory(
        &self,
        path: &Path,
        home: &Path,
        id: Option<Uuid>,
    ) -> Result<AgentDirectoryPreview, LibraryError> {
        let expanded = path.strip_prefix("~").map(|tail| home.join(tail));
        let registry = self.registry()?;
        self.inspect_agent_directory(&registry, expanded.as_deref().unwrap_or(path), id, None)
    }

    pub fn add_agent(&self, draft: AgentDraft) -> Result<LibrarySnapshot, LibraryError> {
        self.add_agent_with_creation(draft, false)
    }

    pub fn add_agent_with_creation(
        &self,
        draft: AgentDraft,
        create_directory: bool,
    ) -> Result<LibrarySnapshot, LibraryError> {
        self.edit_registry(|next| {
            let name = draft.name.trim();
            if name.is_empty() {
                return Err(LibraryError::new("请输入 Agent 名称。"));
            }
            let preview = self.inspect_agent_directory(next, &draft.directory, None, Some(name))?;
            let directory = Self::prepare_agent_directory(preview, create_directory)?;
            next.agents.push(StoredAgent::new(AgentDraft {
                kind: draft.kind,
                name: name.to_owned(),
                directory,
            }));
            Ok(())
        })
        .map(|(snapshot, ())| snapshot)
    }

    pub fn remove_agent(
        &self,
        id: Uuid,
        shown_skills: Vec<Uuid>,
    ) -> Result<LibrarySnapshot, LibraryError> {
        let mut current = self.registry()?;
        let Some(position) = current.agents.iter().position(|agent| agent.agent.id == id) else {
            return Ok(self.snapshot_for(&current));
        };
        let agent = &current.agents[position];
        let shown: BTreeSet<_> = shown_skills.into_iter().collect();
        if current.skills.iter().any(|member| {
            !shown.contains(&member.skill.id)
                && self
                    .observed_assignment(&current, agent, member)
                    .path
                    .is_some()
        }) {
            return Err(LibraryError::new(
                "这个工具使用的 Skill 已有变化。请关闭窗口，再次点击「移除工具」查看最新列表。",
            ));
        }
        let mut next = current.clone();
        next.agents.remove(position);
        next.last_install_agents.retain(|agent| *agent != id);
        if let Some(pending) = &mut next.undo {
            pending
                .changes
                .exclusions
                .retain(|(agent, _, _)| *agent != id);
        }
        self.publish_changes(&mut current, next)?;
        Ok(self.snapshot_for(&current))
    }

    pub fn change_agent_directory(
        &self,
        id: Uuid,
        directory: PathBuf,
    ) -> Result<LibrarySnapshot, LibraryError> {
        self.change_agent_directory_with_creation(id, directory, false)
    }

    pub fn change_agent_directory_with_creation(
        &self,
        id: Uuid,
        directory: PathBuf,
        create_directory: bool,
    ) -> Result<LibrarySnapshot, LibraryError> {
        self.edit_registry(|next| {
            let preview = self.inspect_agent_directory(next, &directory, Some(id), None)?;
            let agent = next.agent_mut(id)?;
            agent.agent.directory = Self::prepare_agent_directory(preview, create_directory)?;
            Ok(())
        })
        .map(|(snapshot, ())| snapshot)
    }

    pub fn reorder_agents(&self, ids: Vec<Uuid>) -> Result<LibrarySnapshot, LibraryError> {
        let mut current = self.registry()?;
        if ids.len() != current.agents.len() {
            return Err(LibraryError::new("工具列表已发生变化，请重试。"));
        }
        if current
            .agents
            .iter()
            .map(|agent| agent.agent.id)
            .eq(ids.iter().copied())
        {
            return Ok(self.snapshot_for(&current));
        }
        let mut by_id: BTreeMap<Uuid, StoredAgent> = current
            .agents
            .iter()
            .cloned()
            .map(|agent| (agent.agent.id, agent))
            .collect();
        let mut reordered = Vec::with_capacity(ids.len());
        for id in ids {
            let agent = by_id
                .remove(&id)
                .ok_or_else(|| LibraryError::new("工具列表已发生变化，请重试。"))?;
            reordered.push(agent);
        }
        let mut next = current.clone();
        next.agents = reordered;
        self.publish_changes(&mut current, next)?;
        Ok(self.snapshot_for(&current))
    }

    pub fn set_agent_skill(
        &self,
        agent_id: Uuid,
        skill_id: Uuid,
        enabled: bool,
    ) -> Result<LibrarySnapshot, LibraryError> {
        let mut current = self.registry()?;
        let mut next = current.clone();
        let member = next.skill(skill_id)?.clone();
        let category = member.skill.category_id;
        let agent = next.agent_mut(agent_id)?;
        if enabled {
            agent.direct.insert(skill_id);
            agent.remove_exclusion(category, skill_id);
        } else {
            agent.direct.remove(&skill_id);
            agent.restore_exclusion(category, skill_id);
        }
        agent.sync_undo.remove(&category.unwrap_or_default());
        let requested = agent.assignment(&member).path;
        self.publish_agent_link(&mut current, next, requested.as_deref())?;
        Ok(self.snapshot_for(&current))
    }

    pub fn set_category_sync(
        &self,
        agent_id: Uuid,
        category: impl Into<Option<Uuid>>,
        enabled: bool,
    ) -> Result<SyncOutcome, LibraryError> {
        let category = category.into();
        let key = category.unwrap_or_default();
        let mut current = self.registry()?;
        let mut next = current.clone();
        if let Some(id) = category {
            next.resolve_target(CategoryTarget::Existing { id })?;
        }
        let agent = next.agent_mut(agent_id)?;
        if agent.subscribed(category) == enabled {
            let before = self.enabled_in_category(&current, agent_id, category);
            return Ok(self.sync_outcome(&current, agent_id, category, &before, None));
        }
        let undo = Uuid::new_v4();
        let exclusions = agent.exclusions.remove(&key).unwrap_or_default();
        agent.sync_undo.insert(
            key,
            SyncUndo {
                id: undo,
                enabled: !enabled,
                exclusions,
            },
        );
        agent.set_sync(category, enabled);
        let before = self.enabled_in_category(&current, agent_id, category);
        self.publish_changes(&mut current, next)?;
        Ok(self.sync_outcome(&current, agent_id, category, &before, Some(undo)))
    }

    pub fn undo_category_sync(&self, id: Uuid) -> Result<SyncOutcome, LibraryError> {
        let mut current = self.registry()?;
        let mut next = current.clone();
        let (agent_id, key, undo) = next
            .agents
            .iter()
            .find_map(|agent| {
                agent
                    .sync_undo
                    .iter()
                    .find(|(_, undo)| undo.id == id)
                    .map(|(category, undo)| (agent.agent.id, *category, undo.clone()))
            })
            .ok_or_else(|| LibraryError::new("分配已发生变化，无法撤销此次同步。"))?;
        let category = (!key.is_nil()).then_some(key);
        let all_members: BTreeSet<_> = next
            .skills
            .iter()
            .filter(|member| member.skill.category_id == category)
            .map(|member| member.skill.id)
            .collect();
        let agent = next.agent_mut(agent_id)?;
        agent.set_sync(category, undo.enabled);
        agent.sync_undo.remove(&key);
        agent.exclusions.insert(
            key,
            undo.exclusions
                .intersection(&all_members)
                .filter(|id| !agent.direct.contains(id))
                .copied()
                .collect(),
        );
        let before = self.enabled_in_category(&current, agent_id, category);
        self.publish_changes(&mut current, next)?;
        Ok(self.sync_outcome(&current, agent_id, category, &before, None))
    }

    pub(super) fn observed_assignment(
        &self,
        registry: &Registry,
        agent: &StoredAgent,
        member: &StoredSkill,
    ) -> AgentAssignment {
        let mut assignment = agent.assignment(member);
        assignment.path = assignment.path.filter(|path| {
            transaction::active_link(
                registry,
                path,
                &agent.agent.directory,
                &self.content_path(registry, member),
            )
        });
        assignment
    }

    fn enabled_in_category(
        &self,
        registry: &Registry,
        agent_id: Uuid,
        category: Option<Uuid>,
    ) -> BTreeMap<Uuid, bool> {
        let agent = registry.agent(agent_id).expect("sync Agent exists");
        registry
            .skills
            .iter()
            .filter(|member| member.skill.category_id == category)
            .filter_map(|member| {
                let assignment = self.observed_assignment(registry, agent, member);
                assignment
                    .path
                    .map(|_| (assignment.skill_id, assignment.direct))
            })
            .collect()
    }

    fn sync_outcome(
        &self,
        registry: &Registry,
        agent_id: Uuid,
        category: Option<Uuid>,
        before: &BTreeMap<Uuid, bool>,
        undo: Option<Uuid>,
    ) -> SyncOutcome {
        let after = self.enabled_in_category(registry, agent_id, category);
        let impact = SyncImpact {
            enabled: after.keys().filter(|id| !before.contains_key(id)).count(),
            disabled: before.keys().filter(|id| !after.contains_key(id)).count(),
            retained_direct: after
                .iter()
                .filter(|(id, direct)| **direct && before.contains_key(id))
                .count(),
        };
        SyncOutcome {
            library: self.snapshot_for(registry),
            impact,
            undo,
        }
    }

    pub fn preview_install_assignments(
        &self,
        filenames: Vec<String>,
        target: CategoryTarget,
        agents: Vec<Uuid>,
    ) -> Result<InstallAssignmentsPreview, LibraryError> {
        let mut preview = self.registry()?.clone();
        let category = preview.resolve_target(target)?;
        for agent in &agents {
            preview.agent(*agent)?;
        }
        let mut result = InstallAssignmentsPreview {
            targets: Vec::new(),
            conflicts: Vec::new(),
        };
        for agent in &preview.agents {
            let direct = agents.contains(&agent.agent.id);
            let via_category = agent.subscribed(category);
            if !direct && !via_category {
                continue;
            }
            result.targets.push(InstallAgentTarget {
                agent_id: agent.agent.id,
                direct,
                via_category,
            });
            let mut seen = BTreeSet::new();
            let directory = &agent.agent.directory;
            for filename in &filenames {
                validate_filename(filename)?;
                let path = directory.join(filename);
                let check = if seen.insert(transaction::comparison_name(filename)) {
                    transaction::check_new_link(&path)
                } else {
                    Err(transaction::conflict(&path))
                };
                if let Err(error) = check {
                    result.conflicts.push(PreviewProblem {
                        path,
                        message: error.to_string(),
                    });
                }
            }
        }
        Ok(result)
    }

    pub(super) fn inspect_agent_directory(
        &self,
        registry: &Registry,
        path: &Path,
        id: Option<Uuid>,
        name: Option<&str>,
    ) -> Result<AgentDirectoryPreview, LibraryError> {
        let (directory, parent) = resolve_directory(path)?;
        registry.check_agent_identity(id, name, &directory)?;
        if [&self.root, &self.managed_directory(registry)]
            .iter()
            .any(|root| directory.starts_with(root) || root.starts_with(&directory))
        {
            return Err(LibraryError::new(format!(
                "{}：请选择 Skill 库以外的独立目录。",
                directory.display()
            )));
        }
        transaction::check_writable_directory(parent)
            .map_err(|error| LibraryError::io("Agent 目录不可写", &directory, error))?;
        Ok(AgentDirectoryPreview {
            directory,
            exists: parent == path,
        })
    }

    fn prepare_agent_directory(
        preview: AgentDirectoryPreview,
        create: bool,
    ) -> Result<PathBuf, LibraryError> {
        if !preview.exists && create {
            fs::create_dir_all(&preview.directory)
                .map_err(|error| LibraryError::io("无法创建目录", &preview.directory, error))?;
        }
        let path = preview.directory;
        tempfile::Builder::new()
            .prefix(".skill-library-check-")
            .tempfile_in(&path)
            .and_then(tempfile::NamedTempFile::close)
            .map_err(|error| LibraryError::io("无法写入目录", &path, error))?;
        Ok(path)
    }
}

pub(super) fn resolve_directory(path: &Path) -> Result<(PathBuf, &Path), LibraryError> {
    if !path.is_absolute() {
        return Err(LibraryError::new(format!(
            "{}：请输入绝对路径或以 ~/ 开头的路径。",
            path.display()
        )));
    }
    // Resolve the existing prefix, including symlinks, without creating the missing suffix.
    let mut parent = path;
    loop {
        match fs::symlink_metadata(parent) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parent = parent
                    .parent()
                    .ok_or_else(|| LibraryError::io("无法读取目录", path, error))?;
            }
            Err(error) => return Err(LibraryError::io("无法读取目录", path, error)),
        }
    }
    let mut directory =
        fs::canonicalize(parent).map_err(|error| LibraryError::io("无法解析目录", path, error))?;
    if !directory.is_dir() {
        return Err(LibraryError::new(format!(
            "{}：{} 不是文件夹。",
            path.display(),
            parent.display()
        )));
    }
    let suffix = path.strip_prefix(parent).expect("parent is an ancestor");
    for component in suffix.components() {
        let Component::Normal(name) = component else {
            return Err(LibraryError::new(format!(
                "{}：缺失目录中不能包含 ..。",
                path.display()
            )));
        };
        directory.push(name);
    }
    Ok((directory, parent))
}

impl Registry {
    pub(super) fn skill(&self, id: Uuid) -> Result<&StoredSkill, LibraryError> {
        self.skills
            .iter()
            .find(|member| member.skill.id == id)
            .ok_or_else(|| LibraryError::new("找不到该 Skill，请刷新 Skill 库。"))
    }

    pub(super) fn agent(&self, id: Uuid) -> Result<&StoredAgent, LibraryError> {
        self.agents
            .iter()
            .find(|agent| agent.agent.id == id)
            .ok_or_else(missing_agent)
    }

    pub(super) fn agent_mut(&mut self, id: Uuid) -> Result<&mut StoredAgent, LibraryError> {
        self.agents
            .iter_mut()
            .find(|agent| agent.agent.id == id)
            .ok_or_else(missing_agent)
    }

    pub(super) fn check_agent_identity(
        &self,
        id: Option<Uuid>,
        name: Option<&str>,
        directory: &Path,
    ) -> Result<(), LibraryError> {
        for agent in self
            .agents
            .iter()
            .filter(|agent| Some(agent.agent.id) != id)
        {
            let existing = &agent.agent.directory;
            let overlaps =
                |other: &Path| directory.starts_with(other) || other.starts_with(directory);
            if overlaps(existing)
                || fs::canonicalize(existing).is_ok_and(|actual| overlaps(&actual))
            {
                return Err(LibraryError::new(format!(
                    "{}：与「{}」的目录 {} 重叠。请重新选择目录。",
                    directory.display(),
                    agent.agent.name,
                    existing.display()
                )));
            }
        }
        if let Some(name) = name {
            if self.agents.iter().any(|agent| {
                Some(agent.agent.id) != id && agent.agent.name.to_lowercase() == name.to_lowercase()
            }) {
                return Err(LibraryError::new(format!(
                    "{}：Agent 名称「{name}」已存在。请使用其他名称或重新选择目录。",
                    directory.display()
                )));
            }
        }
        Ok(())
    }
}

fn missing_agent() -> LibraryError {
    LibraryError::new("找不到该 Agent，请重新选择。")
}

impl StoredAgent {
    pub(super) fn restore_exclusion(&mut self, category: Option<Uuid>, skill: Uuid) {
        if self.subscribed(category) && !self.direct.contains(&skill) {
            self.exclusions
                .entry(category.unwrap_or_default())
                .or_default()
                .insert(skill);
        }
    }

    pub(super) fn new(draft: AgentDraft) -> Self {
        Self::restored(
            Agent {
                id: Uuid::new_v4(),
                kind: draft.kind,
                name: draft.name,
                directory: draft.directory,
                synced_categories: BTreeSet::new(),
                sync_uncategorized: false,
            },
            BTreeSet::new(),
            BTreeMap::new(),
            BTreeMap::new(),
        )
    }

    pub(super) fn restored(
        agent: Agent,
        direct: BTreeSet<Uuid>,
        exclusions: BTreeMap<Uuid, BTreeSet<Uuid>>,
        link_names: BTreeMap<Uuid, String>,
    ) -> Self {
        Self {
            agent,
            direct,
            exclusions,
            link_names,
            sync_undo: BTreeMap::new(),
        }
    }

    pub(super) fn remember_link_names(&mut self, members: &[StoredSkill]) {
        for member in members {
            if !self.link_names.contains_key(&member.skill.id)
                && self.assignment(member).path.is_some()
            {
                self.link_names
                    .insert(member.skill.id, member.skill.folder_name.clone());
            }
        }
    }

    pub(super) fn forget_member(&mut self, id: Uuid) {
        self.direct.remove(&id);
        self.link_names.remove(&id);
        for exclusions in self.exclusions.values_mut() {
            exclusions.remove(&id);
        }
        for undo in self.sync_undo.values_mut() {
            undo.exclusions.remove(&id);
        }
    }

    fn subscribed(&self, category: Option<Uuid>) -> bool {
        category.map_or(self.agent.sync_uncategorized, |id| {
            self.agent.synced_categories.contains(&id)
        })
    }

    fn set_sync(&mut self, category: Option<Uuid>, enabled: bool) {
        let Some(category) = category else {
            self.agent.sync_uncategorized = enabled;
            return;
        };
        if enabled {
            self.agent.synced_categories.insert(category);
        } else {
            self.agent.synced_categories.remove(&category);
        }
    }

    pub(super) fn remove_category(&mut self, id: Uuid) {
        self.agent.synced_categories.remove(&id);
        self.exclusions.remove(&id);
        self.sync_undo.remove(&id);
    }

    pub(super) fn clear_move_exclusions(&mut self, category: Option<Uuid>, member: Uuid) -> bool {
        let was_excluded = self.remove_exclusion(category, member);
        for exclusions in self.exclusions.values_mut() {
            exclusions.remove(&member);
        }
        was_excluded
    }

    pub(super) fn remove_exclusion(&mut self, category: Option<Uuid>, member: Uuid) -> bool {
        self.exclusions
            .get_mut(&category.unwrap_or_default())
            .is_some_and(|ids| ids.remove(&member))
    }

    pub(super) fn assignment(&self, member: &StoredSkill) -> AgentAssignment {
        let skill_id = member.skill.id;
        let direct = self.direct.contains(&skill_id);
        let subscribed = self.subscribed(member.skill.category_id);
        let excluded = subscribed
            && self
                .exclusions
                .get(&member.skill.category_id.unwrap_or_default())
                .is_some_and(|ids| ids.contains(&skill_id));
        let via_category = subscribed && !excluded;
        let path =
            (direct || via_category).then(|| self.agent.directory.join(self.filename(member)));
        AgentAssignment {
            agent_id: self.agent.id,
            skill_id,
            direct,
            via_category,
            excluded,
            path,
        }
    }

    pub(super) fn filename<'a>(&'a self, member: &'a StoredSkill) -> &'a str {
        self.link_names
            .get(&member.skill.id)
            .unwrap_or(&member.skill.folder_name)
    }
}

pub(super) fn validate_filename(filename: &str) -> Result<(), LibraryError> {
    let mut components = Path::new(filename).components();
    if matches!(components.next(), Some(Component::Normal(part)) if part == filename)
        && components.next().is_none()
        && !filename.contains(['\\', '\0'])
    {
        Ok(())
    } else {
        Err(LibraryError::new(format!(
            "无法用「{filename}」作为 Agent 中的文件夹名称。"
        )))
    }
}

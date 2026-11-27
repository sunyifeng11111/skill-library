use super::{invalid, Preferences};
use crate::{
    library::{
        agents::{validate_filename, StoredAgent},
        content::ContentStage,
        folders::valid_folder,
        transaction::{sync_directory, DirectoryIdentity},
        Library, Registry, StoredSkill,
    },
    Agent, AgentKind, Category, LibraryError, Skill,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const VERSION: u32 = 2;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Backup {
    format: Format,
    version: u32,
    preferences: Preferences,
    categories: Vec<Category>,
    skills: Vec<BackupSkill>,
    agents: Vec<BackupAgent>,
    last_install_agents: Vec<Uuid>,
    #[serde(default, skip_serializing, rename = "migration")]
    _migration: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
enum Format {
    #[serde(rename = "skill-library-backup")]
    SkillLibrary,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupSkill {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    directory_name: Option<String>,
    metadata: Skill,
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Entry {
    Directory {
        path: String,
    },
    File {
        path: String,
        mode: Option<u32>,
        #[serde(with = "file_bytes")]
        bytes: Vec<u8>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupAgent {
    id: Uuid,
    kind: AgentKind,
    name: String,
    directory: PathBuf,
    synced_categories: Vec<Uuid>,
    sync_uncategorized: bool,
    direct: Vec<Uuid>,
    exclusions: Vec<(Uuid, Vec<Uuid>)>,
    link_names: Vec<(Uuid, String)>,
}

impl Backup {
    pub(super) fn capture(library: &Library, registry: &Registry) -> Result<Self, LibraryError> {
        let mut skills = Vec::new();
        for member in &registry.skills {
            let root = library.content_path(registry, member);
            let mut entries = Vec::new();
            collect_entries(&root, &root, &mut entries)?;
            skills.push(BackupSkill {
                directory_name: member.folder.name().map(str::to_owned),
                metadata: member.skill.clone(),
                entries,
            });
        }
        let backup = Self {
            format: Format::SkillLibrary,
            version: VERSION,
            preferences: registry.preferences,
            categories: registry.categories.clone(),
            skills,
            agents: registry.agents.iter().map(BackupAgent::from).collect(),
            last_install_agents: registry.last_install_agents.clone(),
            _migration: None,
        };
        for member in &backup.skills {
            validate_entries(&member.entries)?;
        }
        Ok(backup)
    }

    pub(super) fn read(path: &Path) -> Result<(Self, String), LibraryError> {
        let error = |error| LibraryError::io("无法读取备份", path, error);
        let mut hashed = HashedReader {
            file: open_regular(path).map_err(error)?.0,
            digest: Sha256::new(),
        };
        let backup: Self = serde_json::from_reader(BufReader::new(&mut hashed))
            .map_err(|error| invalid(error.to_string()))?;
        if !matches!(backup.version, 1 | VERSION) {
            return Err(invalid("此备份版本与当前应用不兼容"));
        }
        Ok((backup, format!("{:x}", hashed.digest.finalize())))
    }

    pub(super) fn registry(
        &self,
        library: &Library,
        current: &Registry,
    ) -> Result<Registry, LibraryError> {
        let categories = checked_ids(self.categories.iter().map(|category| category.id))?;
        let skills = checked_ids(self.skills.iter().map(|member| member.metadata.id))?;
        let agents = checked_ids(self.agents.iter().map(|agent| agent.id))?;
        unique_names(
            self.categories
                .iter()
                .map(|category| category.name.as_str()),
        )?;
        if self.categories.iter().any(|category| {
            category.name == "未分类" || category.name.eq_ignore_ascii_case("全部 Skill")
        }) {
            return Err(invalid("分类使用了保留名称"));
        }
        unique_names(self.agents.iter().map(|agent| agent.name.as_str()))?;
        checked_refs(&self.last_install_agents, &agents)?;

        let before: BTreeMap<_, _> = current
            .skills
            .iter()
            .map(|member| (member.skill.id, &member.folder))
            .collect();
        let mut names = library.folder_names(current)?;
        let mut next = current.cleared();
        next.preferences = self.preferences;
        next.categories = self.categories.clone();
        next.last_install_agents = self.last_install_agents.clone();
        for member in &self.skills {
            let skill = &member.metadata;
            if skill.name.trim().is_empty()
                || skill.description.trim().is_empty()
                || skill.fingerprint.len() != 64
                || !skill
                    .fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || skill
                    .category_id
                    .is_some_and(|id| !categories.contains(&id))
            {
                return Err(invalid("Skill 元数据无效"));
            }
            validate_filename(&skill.folder_name)?;
            if let Some(source) = &skill.source {
                crate::SourceRequest::from_provenance(source)?;
                if source.member_path != "." {
                    validate_relative(&source.member_path)?;
                }
                if !source.revision.is_empty()
                    && (!matches!(source.revision.len(), 40 | 64)
                        || !source.revision.bytes().all(|byte| byte.is_ascii_hexdigit()))
                {
                    return Err(invalid("来源修订无效"));
                }
            }
            validate_entries(&member.entries)?;
            if member
                .directory_name
                .as_deref()
                .is_some_and(|name| !valid_folder(name))
            {
                return Err(invalid("Skill 文件夹名称无效"));
            }
            let folder = match before.get(&skill.id) {
                Some(existing) => (*existing).clone(),
                None => names.allocate(skill, member.directory_name.as_deref()),
            };
            next.skills.push(StoredSkill {
                skill: skill.clone(),
                folder,
            });
        }
        for agent in &self.agents {
            validate_directory(&agent.directory, &library.root)?;
            validate_directory(&agent.directory, &library.managed_directory(current))?;
            if next
                .agents
                .iter()
                .any(|existing| overlaps(&agent.directory, &existing.agent.directory))
            {
                return Err(invalid("Agent 目录重叠"));
            }
            next.agents
                .push(agent.restore(&categories, &skills, &next.skills)?);
        }
        Ok(next)
    }

    pub(super) fn stage(&self, stage: &ContentStage) -> Result<(), LibraryError> {
        for member in &self.skills {
            let root = stage.member_path(member.metadata.id);
            let error = |error| LibraryError::io("无法恢复 Skill 文件", &root, error);
            fs::create_dir(&root).map_err(error)?;
            let mut directories: Vec<_> = member
                .entries
                .iter()
                .filter_map(|entry| match entry {
                    Entry::Directory { path } => Some(path),
                    Entry::File { .. } => None,
                })
                .collect();
            directories.sort_unstable();
            for path in &directories {
                let path = root.join(path);
                fs::create_dir(&path)
                    .map_err(|error| LibraryError::io("无法恢复目录", &path, error))?;
            }
            for entry in &member.entries {
                if let Entry::File { path, mode, bytes } = entry {
                    let path = root.join(path);
                    write_file(&path, *mode, bytes)
                        .map_err(|error| LibraryError::io("无法恢复文件", &path, error))?;
                }
            }
            for path in directories.iter().rev() {
                sync_directory(&root.join(path)).map_err(error)?;
            }
            sync_directory(&root).map_err(error)?;
        }
        Ok(())
    }
}

impl From<&StoredAgent> for BackupAgent {
    fn from(stored: &StoredAgent) -> Self {
        let Agent {
            id,
            kind,
            name,
            directory,
            synced_categories,
            sync_uncategorized,
        } = &stored.agent;
        Self {
            id: *id,
            kind: *kind,
            name: name.clone(),
            directory: directory.clone(),
            synced_categories: synced_categories.iter().copied().collect(),
            sync_uncategorized: *sync_uncategorized,
            direct: stored.direct.iter().copied().collect(),
            exclusions: stored
                .exclusions
                .iter()
                .map(|(id, set)| (*id, set.iter().copied().collect()))
                .collect(),
            link_names: stored
                .link_names
                .iter()
                .map(|(id, name)| (*id, name.clone()))
                .collect(),
        }
    }
}

impl BackupAgent {
    fn restore(
        &self,
        categories: &BTreeSet<Uuid>,
        skills: &BTreeSet<Uuid>,
        members: &[StoredSkill],
    ) -> Result<StoredAgent, LibraryError> {
        let synced_categories = checked_refs(&self.synced_categories, categories)?;
        let direct = checked_refs(&self.direct, skills)?;
        let mut exclusions = BTreeMap::new();
        for (category, ids) in &self.exclusions {
            if !category.is_nil() && !categories.contains(category) {
                return Err(invalid("同步例外的分类不存在"));
            }
            let ids = checked_refs(ids, skills)?;
            if !ids.is_disjoint(&direct)
                || members.iter().any(|member| {
                    ids.contains(&member.skill.id)
                        && member.skill.category_id.unwrap_or_default() != *category
                })
                || exclusions.insert(*category, ids).is_some()
            {
                return Err(invalid("同步例外的成员或分类无效"));
            }
        }
        let mut link_names = BTreeMap::new();
        for (id, name) in &self.link_names {
            validate_filename(name)?;
            if !skills.contains(id) || link_names.insert(*id, name.clone()).is_some() {
                return Err(invalid("链接名称的成员无效"));
            }
        }
        Ok(StoredAgent::restored(
            Agent {
                id: self.id,
                kind: self.kind,
                name: self.name.clone(),
                directory: self.directory.clone(),
                synced_categories,
                sync_uncategorized: self.sync_uncategorized,
            },
            direct,
            exclusions,
            link_names,
        ))
    }
}

fn checked_ids(ids: impl IntoIterator<Item = Uuid>) -> Result<BTreeSet<Uuid>, LibraryError> {
    let mut seen = BTreeSet::new();
    for id in ids {
        if id.is_nil() || !seen.insert(id) {
            return Err(invalid("标识为空或重复"));
        }
    }
    Ok(seen)
}

fn checked_refs(ids: &[Uuid], known: &BTreeSet<Uuid>) -> Result<BTreeSet<Uuid>, LibraryError> {
    let accessible = checked_ids(ids.iter().copied())?;
    if !accessible.is_subset(known) {
        return Err(invalid("引用的分类、Skill 或 Agent 不存在"));
    }
    Ok(accessible)
}

fn unique_names<'a>(names: impl IntoIterator<Item = &'a str>) -> Result<(), LibraryError> {
    let mut seen = BTreeSet::new();
    for name in names {
        if name.trim().is_empty() || name != name.trim() || !seen.insert(name.to_lowercase()) {
            return Err(invalid("分类或 Agent 名称为空或重复"));
        }
    }
    Ok(())
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn validate_directory(path: &Path, root: &Path) -> Result<(), LibraryError> {
    if !path.is_absolute()
        || path.components().collect::<PathBuf>().as_os_str() != path.as_os_str()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || path.to_string_lossy().contains('\0')
        || overlaps(path, root)
    {
        return Err(invalid(format!("Agent 目录无效：{}", path.display())));
    }
    // Missing directories can remain configured when no enabled member needs them.
    // Verify existing ancestors so aliases cannot reach another Agent or the managed library.
    for ancestor in path.ancestors() {
        match DirectoryIdentity::read(ancestor) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(LibraryError::io("无法核对 Agent 目录", ancestor, error)),
        }
    }
    Err(invalid("Agent 目录无效"))
}

fn validate_relative(path: &str) -> Result<(), LibraryError> {
    if matches!(path.as_bytes(), [b'a'..=b'z' | b'A'..=b'Z', b':', ..]) {
        return Err(invalid(format!("Skill 文件路径无效：{path}")));
    }
    for component in path.split('/') {
        let mut parts = Path::new(component).components();
        if !matches!(parts.next(), Some(Component::Normal(part)) if part == component)
            || parts.next().is_some()
            || component.contains(['\\', '\0'])
        {
            return Err(invalid(format!("Skill 文件路径无效：{path}")));
        }
    }
    Ok(())
}

fn validate_entries(entries: &[Entry]) -> Result<(), LibraryError> {
    let mut paths = BTreeMap::new();
    let mut normalized = BTreeSet::new();
    for entry in entries {
        let (path, directory) = match entry {
            Entry::Directory { path } => (path, true),
            Entry::File { path, mode, .. } => {
                if mode.is_some_and(|mode| mode > 0o777) {
                    return Err(invalid("文件权限无效"));
                }
                (path, false)
            }
        };
        validate_relative(path)?;
        if !normalized.insert(path.to_lowercase().nfd().collect::<String>()) {
            return Err(invalid(format!("Skill 文件路径重复：{path}")));
        }
        paths.insert(path.as_str(), directory);
    }
    if paths.get("SKILL.md") != Some(&false) {
        return Err(invalid("缺少 SKILL.md 文件"));
    }
    for path in paths.keys() {
        if let Some((parent, _)) = path.rsplit_once('/') {
            if paths.get(parent) != Some(&true) {
                return Err(invalid(format!("Skill 文件缺少父目录：{path}")));
            }
        }
    }
    Ok(())
}

fn collect_entries(root: &Path, path: &Path, entries: &mut Vec<Entry>) -> Result<(), LibraryError> {
    let error = |error| LibraryError::io("无法备份 Skill 文件", path, error);
    DirectoryIdentity::read(path).map_err(error)?;
    let mut children = fs::read_dir(path)
        .map_err(error)?
        .collect::<io::Result<Vec<_>>>()
        .map_err(error)?;
    children.sort_unstable_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let fail = |error| LibraryError::io("无法备份 Skill 文件", &path, error);
        let relative = path.strip_prefix(root).expect("entry inside member");
        let relative = relative
            .to_str()
            .ok_or_else(|| invalid("Skill 文件名必须是 UTF-8"))?
            .to_owned();
        let kind = child.file_type().map_err(fail)?;
        if kind.is_dir() {
            entries.push(Entry::Directory { path: relative });
            collect_entries(root, &path, entries)?;
        } else if kind.is_file() {
            let (bytes, metadata) = read_regular(&path).map_err(fail)?;
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                Some(metadata.permissions().mode() & 0o777)
            };
            #[cfg(not(unix))]
            let mode = {
                let _ = metadata;
                None
            };
            entries.push(Entry::File {
                path: relative,
                bytes,
                mode,
            });
        } else {
            return Err(invalid(format!("需要普通文件或目录：{}", path.display())));
        }
    }
    Ok(())
}

fn read_regular(path: &Path) -> io::Result<(Vec<u8>, fs::Metadata)> {
    let (mut file, metadata) = open_regular(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((bytes, metadata))
}

fn open_regular(path: &Path) -> io::Result<(File, fs::Metadata)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "需要普通文件"));
    }
    Ok((file, metadata))
}

struct HashedReader {
    file: File,
    digest: Sha256,
}

impl Read for HashedReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let size = self.file.read(buffer)?;
        self.digest.update(&buffer[..size]);
        Ok(size)
    }
}

fn write_file(path: &Path, mode: Option<u32>, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create_new(path)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    file.sync_all()
}

mod file_bytes {
    use super::{Deserialize, Engine, STANDARD};
    use serde::{Deserializer, Serializer};

    pub(super) fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<u8>, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        STANDARD.decode(encoded).map_err(serde::de::Error::custom)
    }
}

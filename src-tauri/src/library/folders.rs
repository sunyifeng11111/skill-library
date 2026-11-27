use super::{Library, Registry, StoredSkill, NAMED_FOLDERS_VERSION};
use crate::{LibraryError, Skill};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::PathBuf};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const MAX_FOLDER_BYTES: usize = 255;

#[derive(Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum SkillFolder {
    Named { directory_name: String },
    Legacy { batch: Uuid },
}

impl SkillFolder {
    pub(super) fn name(&self) -> Option<&str> {
        match self {
            Self::Named { directory_name } => Some(directory_name),
            Self::Legacy { .. } => None,
        }
    }

    pub(super) fn relative_path(&self, id: Uuid) -> PathBuf {
        match self {
            Self::Named { directory_name } => PathBuf::from(directory_name),
            Self::Legacy { batch } => PathBuf::from(batch.to_string()).join(id.to_string()),
        }
    }
}

pub(super) struct FolderNames(HashSet<String>);

impl Library {
    pub(super) fn folder_names(&self, registry: &Registry) -> Result<FolderNames, LibraryError> {
        let managed = self.managed_directory(registry);
        let error = |error| LibraryError::io("无法读取 Skill 库文件夹", &managed, error);
        let mut used = HashSet::new();
        for entry in fs::read_dir(&managed).map_err(error)? {
            used.insert(key(&entry.map_err(error)?.file_name().to_string_lossy()));
        }
        used.extend(
            registry
                .skills
                .iter()
                .filter_map(|s| s.folder.name().map(key)),
        );
        Ok(FolderNames(used))
    }

    pub(super) fn upgrade_skill_folders(&self) -> Result<(), LibraryError> {
        let mut current = self.registry()?;
        if current.version == NAMED_FOLDERS_VERSION {
            return Ok(());
        }
        let mut next = current.clone();
        let mut names = self.folder_names(&current)?;
        for member in &mut next.skills {
            member.folder = names.allocate(&member.skill, None);
        }
        next.version = NAMED_FOLDERS_VERSION;
        let stage = if next.skills.is_empty() {
            None
        } else {
            Some(self.stage_content(&current)?)
        };
        self.publish_transaction(&mut current, next, stage)
    }
}

impl FolderNames {
    pub(super) fn store(&mut self, skill: Skill) -> StoredSkill {
        StoredSkill {
            folder: self.allocate(&skill, None),
            skill,
        }
    }

    pub(super) fn allocate(&mut self, skill: &Skill, preferred: Option<&str>) -> SkillFolder {
        if let Some(name) = preferred {
            if self.0.insert(key(name)) {
                return SkillFolder::Named {
                    directory_name: name.to_owned(),
                };
            }
        }
        let mut base = clean(&skill.name);
        if base.is_empty() {
            base = clean(&skill.folder_name);
        }
        if base.is_empty() {
            base = "Skill".into();
        }
        let mut name = base.clone();
        if !self.0.insert(key(&name)) {
            let repository = skill.source.as_ref().and_then(|source| {
                source
                    .repository
                    .trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .map(|s| s.trim_end_matches(".git"))
            });
            let origin = skill.local_origins.iter().filter_map(|s| {
                let mut parts = s.rsplit(['/', '\\']).filter(|v| !v.is_empty());
                let last = parts.next()?;
                if last == skill.folder_name {
                    parts.next()
                } else {
                    Some(last)
                }
            });
            let source = repository
                .into_iter()
                .chain(origin)
                .chain([skill.folder_name.as_str()])
                .map(clean)
                .find(|label| !label.is_empty() && key(label) != key(&base));
            for index in 1.. {
                let suffix = match (source.as_deref().map(|label| prefix(label, 60)), index) {
                    (Some(label), 1) => format!("（{label}）"),
                    (Some(label), n) => format!("（{label} {n}）"),
                    (None, n) => format!("（{}）", n + 1),
                };
                name = format!("{}{suffix}", prefix(&base, MAX_FOLDER_BYTES - suffix.len()));
                if self.0.insert(key(&name)) {
                    break;
                }
            }
        }
        SkillFolder::Named {
            directory_name: name,
        }
    }
}

fn key(name: &str) -> String {
    name.to_lowercase().nfd().collect()
}

fn prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn reserved(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|digit| {
            matches!(
                digit,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

fn unsafe_char(ch: char) -> bool {
    ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
}

fn clean(value: &str) -> String {
    let value = value.replace(unsafe_char, "-");
    let trim = |c: char| c == '.' || c.is_whitespace();
    let mut name = value.trim_matches(trim).to_owned();
    if reserved(&name) {
        name.insert(0, '_');
    }
    prefix(&name, MAX_FOLDER_BYTES)
        .trim_end_matches(trim)
        .to_owned()
}

pub(super) fn valid_folder(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_FOLDER_BYTES
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name.trim() == name
        && !name.contains(unsafe_char)
        && !reserved(name)
}

pub(super) fn validate_layout(registry: &Registry) -> Result<(), LibraryError> {
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    for member in &registry.skills {
        let valid = match member.folder.name() {
            Some(name) => {
                registry.version == NAMED_FOLDERS_VERSION
                    && valid_folder(name)
                    && names.insert(key(name))
            }
            None => registry.version < NAMED_FOLDERS_VERSION,
        };
        if !valid || !ids.insert(member.skill.id) {
            return Err(LibraryError::new("Skill 库中的 Skill 文件夹名称无效或重复。"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, folder: &str) -> Skill {
        Skill {
            id: Uuid::new_v4(),
            name: name.into(),
            folder_name: folder.into(),
            local_origins: Vec::new(),
            description: "Test skill".into(),
            category_id: None,
            source: None,
            fingerprint: "0".repeat(64),
        }
    }

    #[test]
    fn names_are_readable_distinct_and_safe_to_join_to_the_library() {
        let mut names = FolderNames(HashSet::new());
        let mut one = skill("文章润色", "文章润色");
        assert_eq!(names.allocate(&one, None).name(), Some("文章润色"));
        one.local_origins.push("Codex".into());
        assert_eq!(names.allocate(&one, None).name(), Some("文章润色（Codex）"));
        one.local_origins.clear();
        assert_eq!(names.allocate(&one, None).name(), Some("文章润色（2）"));
        assert_eq!(
            names.allocate(&skill("Café", "Café"), None).name(),
            Some("Café")
        );
        assert_ne!(
            names.allocate(&skill("CAFE\u{301}", "Café"), None).name(),
            Some("CAFE\u{301}")
        );
        for name in [
            "../",
            ".staging-foo",
            "..",
            "NUL.txt",
            "LPT1",
            "A:B/?",
            &"名字".repeat(200),
        ] {
            for _ in 0..2 {
                let result = names.allocate(&skill(name, name), None);
                assert!(
                    valid_folder(result.name().unwrap()),
                    "{name}: {:?}",
                    result.name()
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn upgrade_recovers_files_and_owned_shortcuts_together() {
        use crate::library::{transaction, StoredAgent};
        use crate::{AgentDraft, AgentKind};
        use std::{
            os::unix::fs::{symlink, MetadataExt},
            sync::atomic::Ordering,
        };
        for committed in [false, true] {
            let workspace = tempfile::tempdir().unwrap();
            let base = workspace.path().canonicalize().unwrap();
            let root = base.join("registry");
            let managed = base.join("managed");
            let reader = base.join("reader");
            fs::create_dir(&reader).unwrap();
            let library = Library::open_with_default(&root, &managed).unwrap();
            let mut old = library.registry().unwrap().clone();
            old.version = super::super::RELOCATABLE_VERSION;
            let batch = Uuid::new_v4();
            let member = skill("文章润色", "writer");
            let id = member.id;
            let before = managed.join(batch.to_string()).join(id.to_string());
            fs::create_dir_all(&before).unwrap();
            fs::write(
                before.parent().unwrap().join(".DS_Store"),
                "Finder settings",
            )
            .unwrap();
            fs::write(before.join("SKILL.md"), "local edits").unwrap();
            fs::write(before.join(".notes"), "private notes").unwrap();
            let inode = fs::metadata(&before).unwrap().ino();
            let mut agent = StoredAgent::new(AgentDraft {
                kind: AgentKind::Custom,
                name: "Reader".into(),
                directory: reader.clone(),
            });
            agent.direct.insert(id);
            let link = reader.join("writer");
            symlink(&before, &link).unwrap();
            old.link_owners.insert(
                link.clone(),
                transaction::EntryIdentity::link(&link).unwrap(),
            );
            old.skills.push(StoredSkill {
                skill: member,
                folder: SkillFolder::Legacy { batch },
            });
            old.agents.push(agent);
            let registry_file = root.join("library.json");
            let original = serde_json::to_vec(&old).unwrap();
            fs::write(&registry_file, &original).unwrap();
            *library.registry().unwrap() = old.clone();
            let after = managed.join("文章润色");

            library.fail_registry_sync.store(true, Ordering::Relaxed);
            assert!(library
                .upgrade_skill_folders()
                .unwrap_err()
                .to_string()
                .contains("Skill 库已更新"));
            drop(library);
            if !committed {
                fs::write(&registry_file, original).unwrap();
                transaction::recover(&root, &old).unwrap();
                assert_eq!(fs::metadata(&before).unwrap().ino(), inode);
                assert!(!after.exists());
                assert_eq!(fs::read_link(&link).unwrap(), before);
            }
            let reopened = Library::open(&root).unwrap();
            assert_eq!(reopened.managed_path(id).unwrap(), after);
            assert_eq!(fs::metadata(&after).unwrap().ino(), inode);
            assert_eq!(
                fs::read_to_string(after.join(".notes")).unwrap(),
                "private notes"
            );
            assert_eq!(fs::read_link(&link).unwrap(), after);
            assert_eq!(
                fs::read_to_string(link.join("SKILL.md")).unwrap(),
                "local edits"
            );
            assert!(!before.parent().unwrap().exists());
            assert!(!root.join(".transaction.json").exists());
        }
    }
}

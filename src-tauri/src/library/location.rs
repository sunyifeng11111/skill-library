use super::{agents::resolve_directory, transaction, Library, Registry};
use crate::{files, LibraryError, LibrarySnapshot};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

const OWNER: &str = ".skill-library-owner";

impl Library {
    pub fn open_with_default(root: &Path, default: &Path) -> Result<Self, LibraryError> {
        let mut library = Self::open(root)?;
        let uses_legacy_location = library.registry()?.managed_directory.is_none();
        if uses_legacy_location {
            if let Err(error) = library.change_managed_directory(default) {
                library.startup_notice = Some(format!(
                    "未能切换到默认托管目录：{error}。可在设置的数据管理中重新选择。"
                ));
            }
        }
        Ok(library)
    }

    pub fn change_managed_directory(&self, path: &Path) -> Result<LibrarySnapshot, LibraryError> {
        let mut current = self.registry()?;
        transaction::recover(&self.root, &current)?;
        let old = self.managed_directory(&current);
        let (destination, _) = resolve_directory(path)?;
        if old == destination {
            return Ok(self.snapshot_for(&current));
        }
        let overlaps =
            |other: &Path| destination.starts_with(other) || other.starts_with(&destination);
        current.check_agent_identity(None, None, &destination)?;
        if overlaps(&old) || overlaps(&self.root) {
            return Err(LibraryError::new(
                "请选择与当前托管目录、Skill 库数据及 Agent 目录分开的文件夹。",
            ));
        }

        fs::create_dir_all(&destination)
            .map_err(|e| LibraryError::io("无法创建托管目录", &destination, e))?;
        transaction::DirectoryIdentity::read(&destination)
            .map_err(|e| LibraryError::io("无法核对托管目录", &destination, e))?;
        claim_directory(&destination, &self.root)?;
        let mut next = current.clone();
        next.managed_directory = Some(destination);

        let stage = self.stage_content(&next)?;
        for member in &current.skills {
            let source = self.content_path(&current, member);
            transaction::DirectoryIdentity::read(&source)
                .map_err(|e| LibraryError::io("无法核对原 Skill 目录", &source, e))?;
            let fingerprint = files::fingerprint(&source)?;
            files::copy_verified(&source, &stage.member_path(member.skill.id), &fingerprint)?;
        }
        self.publish_transaction(&mut current, next, Some(stage))?;
        Ok(self.snapshot_for(&current))
    }
}

impl Registry {
    pub(super) fn cleared(&self) -> Self {
        Self {
            version: self.version,
            managed_directory: self.managed_directory.clone(),
            original_backups: self.original_backups.clone(),
            ..Self::empty()
        }
    }
}

pub(super) fn verify_owner(directory: &Path, root: &Path) -> Result<(), LibraryError> {
    let marker = directory.join(OWNER);
    let matches = fs::symlink_metadata(&marker).is_ok_and(|info| info.is_file())
        && fs::read(&marker)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PathBuf>(&bytes).ok())
            .as_deref()
            == Some(root);
    if matches {
        Ok(())
    } else {
        Err(LibraryError::new(format!(
            "{}：此文件夹不属于当前 Skill 库，请检查磁盘或目录。",
            directory.display()
        )))
    }
}

fn claim_directory(directory: &Path, root: &Path) -> Result<(), LibraryError> {
    let failure = |error| LibraryError::io("无法使用托管目录", directory, error);
    let marker = directory.join(OWNER);
    match fs::symlink_metadata(&marker) {
        Ok(_) => return verify_owner(directory, root),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(failure(error)),
    }
    for entry in fs::read_dir(directory).map_err(failure)? {
        if entry.map_err(failure)?.file_name() != ".DS_Store" {
            return Err(LibraryError::new(
                "目标文件夹已有其他文件，请新建或选择一个空文件夹。",
            ));
        }
    }
    let pending = NamedTempFile::new_in(directory).map_err(failure)?;
    serde_json::to_writer(pending.as_file(), root).map_err(|e| LibraryError::new(e.to_string()))?;
    pending.as_file().sync_all().map_err(failure)?;
    pending
        .persist_noclobber(&marker)
        .map_err(|e| failure(e.error))?;
    transaction::sync_directory(directory).map_err(failure)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{AgentDraft, AgentKind, CategoryTarget, ImportSelection};
    use std::sync::atomic::Ordering;

    #[test]
    fn interrupted_relocation_recovers_the_content_and_links_for_the_surviving_registry() {
        for committed in [false, true] {
            let workspace = tempfile::tempdir().unwrap();
            let base = workspace.path().canonicalize().unwrap();
            let root = base.join("registry");
            let old = base.join("managed");
            let dest = base.join("moved");
            let source = base.join("example");
            let reader = base.join("reader");
            fs::create_dir(&reader).unwrap();
            fs::create_dir(&source).unwrap();
            fs::write(
                source.join("SKILL.md"),
                "---\nname: example\ndescription: test\n---\noriginal",
            )
            .unwrap();
            let library = Library::open_with_default(&root, &old).unwrap();
            let agent = library
                .add_agent(AgentDraft {
                    kind: AgentKind::Custom,
                    name: "Reader".into(),
                    directory: reader.clone(),
                })
                .unwrap()
                .agents[0]
                .id;
            let member = library
                .preview_folders(vec![source.clone()])
                .unwrap()
                .members
                .remove(0);
            let skill = library
                .commit_import_with_agents(
                    vec![ImportSelection {
                        path: source,
                        fingerprint: member.fingerprint,
                        source: None,
                    }],
                    CategoryTarget::Uncategorized,
                    vec![agent],
                )
                .unwrap()
                .added[0];
            let previous_path = library.managed_path(skill).unwrap();
            let new_path = dest.join(previous_path.strip_prefix(&old).unwrap());
            let registry_file = root.join("library.json");
            let previous = fs::read(&registry_file).unwrap();
            library.fail_registry_sync.store(true, Ordering::Relaxed);
            assert!(library
                .change_managed_directory(&dest)
                .unwrap_err()
                .to_string()
                .contains("Skill 库已更新"));
            drop(library);
            if !committed {
                fs::write(registry_file, previous).unwrap();
            }
            let library = Library::open(&root).unwrap();
            let expected = if committed { &new_path } else { &previous_path };
            assert_eq!(&library.managed_path(skill).unwrap(), expected);
            assert_eq!(&fs::read_link(reader.join("example")).unwrap(), expected);
            assert!(reader.join("example/SKILL.md").is_file());
            assert_eq!(previous_path.is_dir(), !committed);
            assert_eq!(new_path.is_dir(), committed);
            assert!(!root.join(".transaction.json").exists());
        }
    }
}

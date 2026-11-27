use super::{
    transaction::{rename_exclusive, sync_directory, DirectoryIdentity},
    Library, Registry, PENDING,
};
use crate::LibraryError;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};
use tempfile::{Builder, TempDir};
use uuid::Uuid;

/// Same-volume staging for imports, in-place updates and library replacement.
/// Staging uses stable IDs; published folders keep their readable names.
pub(super) struct ContentStage(TempDir);

impl Library {
    pub(super) fn stage_content(&self, registry: &Registry) -> Result<ContentStage, LibraryError> {
        let managed = self.managed_directory(registry);
        if registry.managed_directory.is_some() {
            super::location::verify_owner(&managed, &self.root)?;
        }
        DirectoryIdentity::read(&managed).map_err(|error| content_error(&managed, error))?;
        let directory = Builder::new()
            .prefix(".staging-")
            .tempdir_in(&managed)
            .map_err(|error| LibraryError::io("无法准备托管文件", &managed, error))?;
        let marker = directory.path().join(PENDING);
        File::create(&marker)
            .map_err(|error| LibraryError::io("无法准备托管文件", &marker, error))?;
        Ok(ContentStage(directory))
    }
}

impl ContentStage {
    pub(super) fn member_path(&self, id: Uuid) -> PathBuf {
        self.0.path().join(id.to_string())
    }

    pub(super) fn describe(
        &self,
        library: &Library,
        current: &Registry,
        next: &Registry,
    ) -> Result<ContentChanges, LibraryError> {
        let root = self.0.path().to_owned();
        let identity =
            DirectoryIdentity::read(&root).map_err(|error| content_error(&root, error))?;
        let managed = root.parent().expect("staging inside the library");
        let managed_identity =
            DirectoryIdentity::read(managed).map_err(|error| content_error(managed, error))?;
        // During relocation each volume journals only its own entries.
        let previous = managed_paths(library, current, managed);
        let requested = managed_paths(library, next, managed);
        let mut edits = Vec::new();
        // Upgrade in place by moving the original directories, retaining edits, permissions
        // and extended attributes. The same journal can move each one back after a crash.
        let upgrading = current.version < super::NAMED_FOLDERS_VERSION
            && next.version == super::NAMED_FOLDERS_VERSION;
        let legacy_sources: BTreeMap<_, _> = if upgrading {
            previous.iter().map(|(path, id)| (*id, path)).collect()
        } else {
            BTreeMap::new()
        };
        let mut retired_batches = BTreeMap::new();
        let paths: BTreeSet<_> = previous.keys().chain(requested.keys()).collect();
        for path in paths {
            let existing = previous.contains_key(path);
            if upgrading && existing {
                let batch = path.parent().expect("legacy batch directory");
                if let Some(identity) = read_directory(batch)? {
                    retired_batches.insert(batch.to_owned(), identity);
                }
                continue;
            }
            let staged = requested.get(path).map(|id| match legacy_sources.get(id) {
                Some(old) => (*old).clone(),
                None => self.member_path(*id),
            });
            let replacement = staged
                .map(|path| read_directory(&path).map(|identity| identity.map(|id| (path, id))))
                .transpose()?
                .flatten();
            if existing && requested.contains_key(path) && replacement.is_none() {
                continue;
            }
            if upgrading && replacement.is_none() {
                // An already missing member stays in the registry so it can be restored.
                continue;
            }
            if !existing && replacement.is_none() {
                return Err(LibraryError::new(format!(
                    "缺少已核对的 Skill 文件：{}",
                    path.display()
                )));
            }
            let original = read_directory(path)?;
            if !existing && original.is_some() {
                return Err(LibraryError::new(format!(
                    "托管目录已被占用：{}",
                    path.display()
                )));
            }
            if original.is_some() || replacement.is_some() {
                edits.push(ContentEdit {
                    path: path.clone(),
                    original,
                    replacement,
                });
            }
        }
        sync_directory(&root).map_err(|error| content_error(&root, error))?;
        sync_directory(managed).map_err(|error| content_error(managed, error))?;
        Ok(ContentChanges {
            root,
            identity,
            managed_identity,
            edits,
            new_batches: BTreeSet::new(),
            retired_batches,
        })
    }

    pub(super) fn keep(self) {
        let _ = self.0.keep();
    }
}

fn managed_paths(
    library: &Library,
    registry: &Registry,
    managed: &Path,
) -> BTreeMap<PathBuf, Uuid> {
    if library.managed_directory(registry) != managed {
        return BTreeMap::new();
    }
    registry
        .skills
        .iter()
        .map(|member| (library.content_path(registry, member), member.skill.id))
        .collect()
}

#[derive(Serialize, Deserialize)]
pub(super) struct ContentChanges {
    root: PathBuf,
    identity: DirectoryIdentity,
    managed_identity: DirectoryIdentity,
    edits: Vec<ContentEdit>,
    new_batches: BTreeSet<PathBuf>,
    #[serde(default)]
    retired_batches: BTreeMap<PathBuf, DirectoryIdentity>,
}

#[derive(Serialize, Deserialize)]
struct ContentEdit {
    path: PathBuf,
    original: Option<DirectoryIdentity>,
    replacement: Option<(PathBuf, DirectoryIdentity)>,
}

impl ContentChanges {
    pub(super) fn apply_replacements(&self) -> Result<(), LibraryError> {
        self.check_managed_directory()?;
        for batch in &self.new_batches {
            fs::create_dir(batch).map_err(|error| content_error(batch, error))?;
            sync_parent(batch)?;
        }
        self.apply(true)
    }

    pub(super) fn apply_removals(&self) -> Result<(), LibraryError> {
        self.check_managed_directory()?;
        self.apply(false)
    }

    fn apply(&self, replacing: bool) -> Result<(), LibraryError> {
        for (index, edit) in self
            .edits
            .iter()
            .enumerate()
            .filter(|(_, edit)| edit.replacement.is_some() == replacing)
        {
            if read_directory(&edit.path)? != edit.original {
                return Err(LibraryError::new(format!(
                    "托管目录已发生变化：{}",
                    edit.path.display()
                )));
            }
            if edit.original.is_some() {
                rename_exclusive(&edit.path, &self.backup(index))
                    .map_err(|error| content_error(&edit.path, error))?;
            }
            if let Some((source, expected)) = &edit.replacement {
                if read_directory(source)? != Some(*expected) {
                    return Err(LibraryError::new(format!(
                        "待提交的托管文件已发生变化：{}",
                        source.display()
                    )));
                }
                rename_exclusive(source, &edit.path)
                    .map_err(|error| content_error(&edit.path, error))?;
                if source.parent() != Some(&self.root) {
                    sync_parent(source)?;
                }
            }
            sync_parent(&edit.path)?;
            sync_directory(&self.root).map_err(|error| content_error(&self.root, error))?;
        }
        Ok(())
    }

    // The user can edit managed files directly while we copy them. Compare the
    // retired originals with the published copies before committing the registry.
    pub(super) fn verify_relocation(&self, destination: &Path) -> Result<(), LibraryError> {
        let old_root = self.root.parent().expect("staging inside the library");
        for (index, edit) in self.edits.iter().enumerate() {
            let target = destination.join(
                edit.path
                    .strip_prefix(old_root)
                    .expect("member inside the library"),
            );
            if crate::files::fingerprint(&self.backup(index))?
                != crate::files::fingerprint(&target)?
            {
                return Err(LibraryError::new(format!(
                    "迁移期间 Skill 文件已变化：{}。请重试。",
                    edit.path.display()
                )));
            }
        }
        Ok(())
    }

    pub(super) fn rollback(&self) -> Result<(), LibraryError> {
        self.check_managed_directory()?;
        if read_directory(&self.root)? != Some(self.identity) {
            return Ok(());
        }
        for (index, edit) in self.edits.iter().enumerate().rev() {
            if let Some((source, expected)) = &edit.replacement {
                // An untouched source needs no rollback, even if a foreign entry now
                // occupies its proposed destination.
                if read_directory(source)? != Some(*expected)
                    && read_directory(&edit.path)? == Some(*expected)
                {
                    if let Some(batch) = source.parent().filter(|parent| *parent != self.root) {
                        if read_directory(batch)?.as_ref() != self.retired_batches.get(batch) {
                            return Err(LibraryError::new(format!(
                                "旧 Skill 库文件夹已变化：{}",
                                batch.display()
                            )));
                        }
                    }
                    rename_exclusive(&edit.path, source)
                        .map_err(|error| content_error(&edit.path, error))?;
                    sync_parent(source)?;
                }
                if source.parent() != Some(&self.root) && read_directory(source)? != Some(*expected)
                {
                    return Err(LibraryError::new(format!(
                        "无法恢复原 Skill 文件夹：{}",
                        source.display()
                    )));
                }
            }
            let backup = self.backup(index);
            if edit.original.is_some() && read_directory(&backup)? == edit.original {
                rename_exclusive(&backup, &edit.path)
                    .map_err(|error| content_error(&edit.path, error))?;
            }
            if edit.path.parent().is_some_and(Path::is_dir) {
                sync_parent(&edit.path)?;
            }
        }
        for batch in &self.new_batches {
            match fs::remove_dir(batch) {
                Ok(()) => sync_parent(batch)?,
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(error) => return Err(content_error(batch, error)),
            }
        }
        sync_directory(&self.root).map_err(|error| content_error(&self.root, error))
    }

    pub(super) fn clean(&self, committed: bool) -> Result<(), LibraryError> {
        self.check_managed_directory()?;
        if committed {
            for (batch, identity) in &self.retired_batches {
                if DirectoryIdentity::read(batch).ok().as_ref() != Some(identity) {
                    continue;
                }
                // Finder can leave its view settings as the sole entry in an old batch.
                let mut entries =
                    fs::read_dir(batch).map_err(|error| content_error(batch, error))?;
                if let Some(Ok(entry)) = entries.next() {
                    if entry.file_name() == ".DS_Store"
                        && entries.next().is_none()
                        && entry.file_type().is_ok_and(|kind| kind.is_file())
                    {
                        match fs::remove_file(entry.path()) {
                            Ok(()) => {}
                            Err(error) if error.kind() == ErrorKind::NotFound => {}
                            Err(error) => return Err(content_error(batch, error)),
                        }
                    }
                }
                match fs::remove_dir(batch) {
                    Ok(()) => sync_parent(batch)?,
                    Err(error)
                        if matches!(
                            error.kind(),
                            ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
                        ) => {}
                    Err(error) => return Err(content_error(batch, error)),
                }
            }
        }
        if read_directory(&self.root)? == Some(self.identity) {
            fs::remove_dir_all(&self.root).map_err(|error| content_error(&self.root, error))?;
            sync_parent(&self.root)?;
        }
        Ok(())
    }

    fn backup(&self, index: usize) -> PathBuf {
        self.root.join(format!("previous-{index}"))
    }

    fn check_managed_directory(&self) -> Result<(), LibraryError> {
        let managed = self.root.parent().expect("staging inside the library");
        if read_directory(managed)? == Some(self.managed_identity) {
            Ok(())
        } else {
            Err(LibraryError::new(format!(
                "托管目录已发生变化：{}",
                managed.display()
            )))
        }
    }
}

fn read_directory(path: &Path) -> Result<Option<DirectoryIdentity>, LibraryError> {
    match DirectoryIdentity::read(path) {
        Ok(identity) => Ok(Some(identity)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(content_error(path, error)),
    }
}

fn sync_parent(path: &Path) -> Result<(), LibraryError> {
    let parent = path.parent().expect("directory entry has a parent");
    sync_directory(parent).map_err(|error| content_error(parent, error))
}

fn content_error(path: &Path, error: io::Error) -> LibraryError {
    LibraryError::io("无法处理托管目录", path, error)
}

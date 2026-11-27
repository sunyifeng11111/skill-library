use super::{
    conflict, link_error, owned_link, publish_symlink, rename_exclusive, same_staged_link,
    stage_has_previous, sync_directory, DirectoryIdentity, EntryIdentity, LinkArtifacts, LinkEdit,
};
use crate::LibraryError;
use std::{
    io::{self, ErrorKind},
    path::Path,
};

impl LinkEdit {
    pub(super) fn exchange(
        &self,
        stage: &LinkArtifacts,
        previous: &Path,
    ) -> Result<(), LibraryError> {
        let error = |error| link_error("无法切换 Agent 链接", &self.path, error);
        publish_symlink(&stage.new, &stage.old).map_err(error)?;
        if !owned_link(&self.path, previous, self.previous_owner) {
            return Err(conflict(&self.path));
        }
        swap_entries(&stage.old, &self.path).map_err(error)?;
        if !owned_link(&stage.old, previous, self.previous_owner) {
            // An entry arrived between the final check and the swap. Recovery restores it
            // while our staged link still owns the destination.
            return Err(conflict(&self.path));
        }
        sync_directory(self.path.parent().expect("Agent link has a parent")).map_err(error)
    }

    pub(super) fn has_exchanged(&self, stage: &LinkArtifacts) -> Result<bool, LibraryError> {
        match stage.old.symlink_metadata() {
            Ok(_) => Ok(!same_staged_link(&stage.old, &stage.new)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(link_error("无法核对回退链接", &self.path, error)),
        }
    }

    pub(super) fn rollback_exchange(
        &self,
        stage: &LinkArtifacts,
        owns_new: bool,
    ) -> Result<(), LibraryError> {
        let error = |error| link_error("无法恢复 Agent 链接", &self.path, error);
        if owns_new {
            let restoring = EntryIdentity::read(&stage.old).map_err(error)?;
            swap_entries(&stage.old, &self.path).map_err(error)?;
            if !same_staged_link(&stage.old, &stage.new) {
                if EntryIdentity::read(&self.path).ok() == Some(restoring) {
                    swap_entries(&stage.old, &self.path).map_err(error)?;
                }
                return Err(conflict(&self.path));
            }
            sync_directory(stage.old.parent().unwrap()).map_err(error)?;
            return sync_directory(self.path.parent().expect("Agent link has a parent"))
                .map_err(error);
        }
        if (stage_has_previous(self, stage)
            || self
                .original
                .as_ref()
                .is_some_and(|(id, _)| DirectoryIdentity::read(&stage.old).ok() == Some(*id)))
            && self
                .path
                .symlink_metadata()
                .is_err_and(|error| error.kind() == ErrorKind::NotFound)
        {
            rename_exclusive(&stage.old, &self.path).map_err(error)?;
            sync_directory(stage.old.parent().unwrap()).map_err(error)?;
            return sync_directory(self.path.parent().expect("Agent link has a parent"))
                .map_err(error);
        }
        Err(conflict(&self.path))
    }
}

pub(super) fn swap_entries(left: &Path, right: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};
    renameat_with(CWD, left, CWD, right, RenameFlags::EXCHANGE).map_err(Into::into)
}

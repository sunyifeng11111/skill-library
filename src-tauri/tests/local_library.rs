use skill_library::{CategoryTarget, ImportSelection, Library, PreviewStatus};
use std::{fs, path::PathBuf};
use tempfile::TempDir;

#[cfg(unix)]
#[test]
fn a_closed_library_reopens_while_a_child_still_inherits_its_descriptor() {
    let root = TempDir::new().unwrap();
    let library = Library::open(root.path()).unwrap();
    assert!(Library::open(root.path()).is_err());

    let mut pipe = [-1; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    let child = unsafe { libc::fork() };
    if child == 0 {
        // Before exec, the subprocess still has the parent's file descriptions.
        // These calls are async-signal-safe in the forked process.
        unsafe {
            libc::close(pipe[1]);
            let mut byte = 0_u8;
            libc::read(pipe[0], std::ptr::from_mut(&mut byte).cast(), 1);
            libc::_exit(0);
        }
    }
    unsafe { libc::close(pipe[0]) };
    if child < 0 {
        unsafe { libc::close(pipe[1]) };
        panic!("could not create the subprocess fixture");
    }

    drop(library);
    let reopened = Library::open(root.path());
    unsafe {
        libc::close(pipe[1]);
        libc::waitpid(child, std::ptr::null_mut(), 0);
    }
    assert!(reopened.unwrap().snapshot().unwrap().skills.is_empty());
}

fn skill(workspace: &TempDir, folder: &str, name: &str, description: &str) -> PathBuf {
    let path = workspace.path().join(folder);
    fs::create_dir_all(path.join("references/empty")).unwrap();
    fs::write(
        path.join("SKILL.md"),
        format!("---\nname: '{name}'\ndescription: '{description}'\n---\n# Synthetic fixture\n"),
    )
    .unwrap();
    fs::write(path.join("references/example.bin"), [0, 9, 255]).unwrap();
    path
}

#[test]
fn preview_is_read_only_and_selected_member_reopens_with_complete_files() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let outline = skill(
        &workspace,
        "outline-folder",
        "Write Outline",
        "规划文章的结构",
    );
    let polish = skill(&workspace, "polish-folder", "Prose Polish", "润色文章");
    let library = Library::open(&root).unwrap();

    let preview = library
        .preview_folders(vec![outline.clone(), polish])
        .unwrap();
    assert!(preview.problems.is_empty());
    assert_eq!(preview.members.len(), 2);
    let member = &preview.members[0];
    assert_eq!(member.status, PreviewStatus::Ready);
    assert_eq!(member.name, "Write Outline");
    assert_eq!(member.description, "规划文章的结构");
    assert!(library.snapshot().unwrap().skills.is_empty());
    assert_eq!(fs::read_dir(root.join("skills")).unwrap().count(), 0);

    let installed = library
        .commit_import(
            vec![ImportSelection {
                path: member.path.clone(),
                fingerprint: member.fingerprint.clone(),
                source: None,
            }],
            CategoryTarget::New {
                name: "写作".into(),
            },
        )
        .unwrap();
    let id = installed.library.skills[0].id;
    drop(library);
    let reopened = Library::open(&root).unwrap();
    let view = reopened.snapshot().unwrap();
    assert_eq!(view.skills.len(), 1);
    assert_eq!(view.skills[0].id, id);
    assert_eq!(view.skills[0].category_id, Some(view.categories[0].id));
    assert_eq!(view.categories[0].name, "写作");
    assert_eq!(view.skills[0].name, "Write Outline");
    assert_eq!(view.skills[0].description, "规划文章的结构");
    assert!(view.skills[0].source.is_none());
    let managed = reopened.managed_path(id).unwrap();
    assert_eq!(managed, view.managed_directory.join(&view.skills[0].name));
    assert_eq!(
        fs::read(managed.join("SKILL.md")).unwrap(),
        fs::read(outline.join("SKILL.md")).unwrap()
    );
    assert_eq!(
        fs::read(managed.join("references/example.bin")).unwrap(),
        [0, 9, 255]
    );
    assert!(managed.join("references/empty").is_dir());
}

#[test]
fn same_name_can_have_distinct_content_and_retry_does_not_create_duplicates() {
    let workspace = TempDir::new().unwrap();
    let one = skill(&workspace, "one", "Writing Guide", "Same metadata");
    let two = skill(&workspace, "two", "Writing Guide", "Same metadata");
    let duplicate = skill(&workspace, "copy-of-one", "Writing Guide", "Same metadata");
    fs::write(two.join("references/example.bin"), [7, 8]).unwrap();
    let library = Library::open(workspace.path().join("library")).unwrap();

    let preview = library
        .preview_folders(vec![one, two.clone(), duplicate])
        .unwrap();
    assert_eq!(
        preview
            .members
            .iter()
            .map(|member| member.status)
            .collect::<Vec<_>>(),
        [
            PreviewStatus::Ready,
            PreviewStatus::Ready,
            PreviewStatus::Duplicate
        ],
    );
    assert_eq!(preview.members[0].folder_name, "one");
    assert_eq!(preview.members[1].folder_name, "two");
    let selection = picks(&preview);
    let installed = library
        .commit_import(selection.clone(), CategoryTarget::Uncategorized)
        .unwrap();
    assert_eq!(installed.added.len(), 2);
    assert_ne!(installed.added[0], installed.added[1]);
    let root = installed.library.managed_directory;
    assert_eq!(
        library.managed_path(installed.added[0]).unwrap(),
        root.join("Writing Guide")
    );
    assert_eq!(
        library.managed_path(installed.added[1]).unwrap(),
        root.join("Writing Guide（two）")
    );
    let retried = library
        .commit_import(
            selection,
            CategoryTarget::New {
                name: "Unused".into(),
            },
        )
        .unwrap();
    assert_eq!(retried.duplicates, 2);
    assert!(retried.added.is_empty());
    assert!(retried.library.categories.is_empty());
    assert_eq!(retried.library.skills.len(), 2);
    assert_eq!(
        library.preview_folders(vec![two]).unwrap().members[0].status,
        PreviewStatus::Duplicate,
    );
}

#[test]
fn changed_source_aborts_the_whole_batch_including_the_draft_category() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let one = skill(&workspace, "one", "Outline", "First");
    let two = skill(&workspace, "two", "Review", "Second");
    let library = Library::open(&root).unwrap();
    let preview = library.preview_folders(vec![one, two.clone()]).unwrap();

    fs::write(two.join("references/example.bin"), [8]).unwrap();
    let error = library
        .commit_import(
            picks(&preview),
            CategoryTarget::New {
                name: "写作".into(),
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("预览后文件已发生变化"));
    assert_eq!(fs::read_dir(root.join("skills")).unwrap().count(), 0);
    drop(library);
    let snapshot = Library::open(&root).unwrap().snapshot().unwrap();
    assert!(snapshot.skills.is_empty());
    assert!(snapshot.categories.is_empty());
}

fn picks(preview: &skill_library::ImportPreview) -> Vec<ImportSelection> {
    preview
        .members
        .iter()
        .filter(|member| member.status == PreviewStatus::Ready)
        .map(|member| ImportSelection {
            path: member.path.clone(),
            fingerprint: member.fingerprint.clone(),
            source: None,
        })
        .collect()
}

#[test]
fn batch_move_undo_restores_each_prior_category_and_delete_retains_content() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let one = skill(&workspace, "one", "Outline", "First");
    let two = skill(&workspace, "two", "Review", "Second");
    let category = library.create_category("草稿".into()).unwrap().categories[0].id;
    let first = library
        .commit_import(
            picks(&library.preview_folders(vec![one]).unwrap()),
            CategoryTarget::Existing { id: category },
        )
        .unwrap()
        .added[0];
    let second = library
        .commit_import(
            picks(&library.preview_folders(vec![two]).unwrap()),
            CategoryTarget::Uncategorized,
        )
        .unwrap()
        .added[0];

    let moved = library
        .move_skills(
            vec![first, second],
            CategoryTarget::New {
                name: "写作".into(),
            },
        )
        .unwrap();
    assert_eq!(moved.moved, 2);
    assert_eq!(moved.library.categories.len(), 2);
    let new_id = moved.library.categories[1].id;
    assert!(moved
        .library
        .skills
        .iter()
        .all(|member| member.category_id == Some(new_id)));

    let restored = library.undo_move(moved.undo.unwrap()).unwrap();
    assert_eq!(restored.skills[0].category_id, Some(category));
    assert_eq!(restored.skills[1].category_id, None);
    assert_eq!(restored.categories.len(), 1);

    assert!(library
        .delete_category(category)
        .unwrap()
        .skills
        .iter()
        .all(|member| member.category_id.is_none()));
    assert!(library
        .managed_path(first)
        .unwrap()
        .join("SKILL.md")
        .is_file());
    assert!(library
        .managed_path(second)
        .unwrap()
        .join("SKILL.md")
        .is_file());
    drop(library);
    assert!(Library::open(&root)
        .unwrap()
        .snapshot()
        .unwrap()
        .categories
        .is_empty());
}

#[test]
fn failed_registry_write_leaves_no_managed_files_and_can_be_retried() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let folder = skill(
        &workspace,
        "review",
        "Review Guide",
        "Review synthetic content",
    );
    let selected = picks(&library.preview_folders(vec![folder]).unwrap());

    let blocked = root.join("library.json");
    fs::create_dir(&blocked).unwrap();
    let target = CategoryTarget::New {
        name: "写作".into(),
    };
    assert!(library
        .commit_import(selected.clone(), target.clone())
        .is_err());
    assert_eq!(fs::read_dir(root.join("skills")).unwrap().count(), 0);
    let snapshot = library.snapshot().unwrap();
    assert!(snapshot.skills.is_empty());
    assert!(snapshot.categories.is_empty());

    fs::remove_dir(blocked).unwrap();
    let installed = library.commit_import(selected, target).unwrap();
    assert_eq!(installed.library.skills.len(), 1);
    assert_eq!(installed.library.categories.len(), 1);
}

#[cfg(unix)]
#[test]
fn preview_rejects_a_folder_with_links_without_following_them() {
    use std::os::unix::fs::symlink;

    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let link = skill(
        &workspace,
        "linked",
        "Linked Skill",
        "Contains an external file",
    );
    let valid = skill(
        &workspace,
        "ordinary",
        "Ordinary Skill",
        "Has regular files",
    );
    let external = workspace.path().join("isolated-external.txt");
    fs::write(&external, "synthetic external data").unwrap();
    symlink(&external, link.join("references/link.txt")).unwrap();

    let library = Library::open(&root).unwrap();
    let preview = library.preview_folders(vec![link, valid]).unwrap();
    assert_eq!(preview.members.len(), 1);
    assert_eq!(preview.members[0].name, "Ordinary Skill");
    assert_eq!(preview.problems.len(), 1);
    assert!(preview.problems[0].message.contains("软链接"));
    assert_eq!(fs::read_dir(root.join("skills")).unwrap().count(), 0);
    assert_eq!(
        fs::read_to_string(&external).unwrap(),
        "synthetic external data"
    );
}

#[test]
fn rename_rejects_unavailable_names_and_allows_changing_only_case() {
    let root = TempDir::new().unwrap();
    let library = Library::open(root.path()).unwrap();
    let category = library.create_category("Tools".into()).unwrap().categories[0].id;
    library.create_category("Writing".into()).unwrap();
    for name in [" ", " 未分类 ", "全部 Skill", " writing "] {
        assert!(
            library.rename_category(category, name.into()).is_err(),
            "{name}"
        );
    }
    assert!(library
        .rename_category(uuid::Uuid::new_v4(), "Missing".into())
        .is_err());
    assert_eq!(library.snapshot().unwrap().categories[0].name, "Tools");
    let renamed = library.rename_category(category, "TOOLS".into()).unwrap();
    assert_eq!(renamed.categories[0].name, "TOOLS");
}

#[test]
fn existing_english_package_names_can_still_be_used_as_categories() {
    let root = TempDir::new().unwrap();
    let library = Library::open(root.path()).unwrap();
    for name in ["Uncategorized", "All skills"] {
        let snapshot = library.create_category(name.into()).unwrap();
        assert!(snapshot
            .categories
            .iter()
            .any(|category| category.name == name));
    }
}

#[test]
fn reorders_categories_durably_without_changing_skill_memberships_or_backups() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let source = skill(&workspace, "outline-folder", "Write Outline", "规划文章的结构");
    let library = Library::open(&root).unwrap();

    let alpha = library.create_category("Alpha".into()).unwrap().categories[0].id;
    let beta = library.create_category("Beta".into()).unwrap().categories[1].id;
    let gamma = library.create_category("Gamma".into()).unwrap().categories[2].id;

    let preview = library.preview_folders(vec![source]).unwrap();
    let installed = library
        .commit_import(
            vec![ImportSelection {
                path: preview.members[0].path.clone(),
                fingerprint: preview.members[0].fingerprint.clone(),
                source: None,
            }],
            CategoryTarget::Existing { id: beta },
        )
        .unwrap();
    let skill_id = installed.library.skills[0].id;

    // Invalid ID lists are rejected and preserve existing order
    assert!(library.reorder_categories(vec![alpha, beta]).is_err());
    assert!(library
        .reorder_categories(vec![alpha, alpha, gamma])
        .is_err());
    assert!(library
        .reorder_categories(vec![alpha, beta, uuid::Uuid::new_v4()])
        .is_err());
    assert_eq!(
        library
            .snapshot()
            .unwrap()
            .categories
            .iter()
            .map(|c| c.id)
            .collect::<Vec<_>>(),
        vec![alpha, beta, gamma]
    );

    // Same order succeeds cleanly as a no-op
    let noop = library.reorder_categories(vec![alpha, beta, gamma]).unwrap();
    assert_eq!(
        noop.categories.iter().map(|c| c.id).collect::<Vec<_>>(),
        vec![alpha, beta, gamma]
    );

    // Reorder persists across reopen and preserves skill membership
    let reordered = library.reorder_categories(vec![gamma, alpha, beta]).unwrap();
    assert_eq!(
        reordered
            .categories
            .iter()
            .map(|c| c.id)
            .collect::<Vec<_>>(),
        vec![gamma, alpha, beta]
    );
    assert_eq!(
        reordered
            .skills
            .iter()
            .find(|s| s.id == skill_id)
            .unwrap()
            .category_id,
        Some(beta)
    );

    let backup = workspace.path().join("backup.json");
    library.export_backup(&backup).unwrap();
    drop(library);

    let reopened = Library::open(&root).unwrap();
    let reopened_snap = reopened.snapshot().unwrap();
    assert_eq!(
        reopened_snap
            .categories
            .iter()
            .map(|c| c.id)
            .collect::<Vec<_>>(),
        vec![gamma, alpha, beta]
    );
    assert_eq!(reopened_snap.skills[0].category_id, Some(beta));
    drop(reopened);

    let restored_root = workspace.path().join("restored");
    let restored = Library::open(&restored_root).unwrap();
    let preview_backup = restored.preview_backup(&backup).unwrap();
    let outcome = restored.restore_backup(&backup, &preview_backup).unwrap();
    assert_eq!(
        outcome
            .library
            .categories
            .iter()
            .map(|c| c.id)
            .collect::<Vec<_>>(),
        vec![gamma, alpha, beta]
    );
}

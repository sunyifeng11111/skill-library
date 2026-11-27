#![cfg(unix)]

use skill_library::{
    AgentDraft, AgentKind, AgentPreset, CategoryTarget, ImportSelection, Language, Library,
    Preferences, ResetBackupPolicy, Theme, UnifiedAdoptionRequest,
};
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use uuid::Uuid;

fn install(library: &Library, workspace: &Path, folder: &str, target: CategoryTarget) -> Uuid {
    let source = workspace.join(folder);
    fs::create_dir_all(source.join("support/empty")).unwrap();
    fs::write(
        source.join("SKILL.md"),
        format!("---\nname: {folder}\ndescription: Synthetic fixture\n---\n"),
    )
    .unwrap();
    fs::write(source.join("support/tool.bin"), [0, 255, 12, 10]).unwrap();
    fs::set_permissions(
        source.join("support/tool.bin"),
        fs::Permissions::from_mode(0o751),
    )
    .unwrap();
    let preview = library.preview_folders(vec![source.clone()]).unwrap();
    let outcome = library
        .commit_import(
            vec![ImportSelection {
                path: source.clone(),
                fingerprint: preview.members[0].fingerprint.clone(),
                source: None,
            }],
            target,
        )
        .unwrap();
    fs::remove_dir_all(source).unwrap();
    outcome.added[0]
}

fn agent(library: &Library, workspace: &Path, name: &str) -> (Uuid, PathBuf) {
    let directory = workspace.join(name);
    fs::create_dir(&directory).unwrap();
    let snapshot = library
        .add_agent(AgentDraft {
            kind: AgentKind::Custom,
            name: name.into(),
            directory: directory.clone(),
        })
        .unwrap();
    (
        snapshot.agents.last().unwrap().id,
        directory.canonicalize().unwrap(),
    )
}

#[test]
fn undoing_a_move_preserves_a_new_direct_assignment_in_backups() {
    let workspace = TempDir::new().unwrap();
    let library = Library::open(workspace.path().join("library")).unwrap();
    let (reader, directory) = agent(&library, workspace.path(), "Reader");
    let id = install(
        &library,
        workspace.path(),
        "Outline",
        CategoryTarget::New {
            name: "Writing".into(),
        },
    );
    let writing = library.snapshot().unwrap().categories[0].id;
    library.set_category_sync(reader, writing, true).unwrap();
    library.set_agent_skill(reader, id, false).unwrap();
    let moved = library
        .move_skills(vec![id], CategoryTarget::Uncategorized)
        .unwrap();
    library.set_agent_skill(reader, id, true).unwrap();
    library.undo_move(moved.undo.unwrap()).unwrap();

    let backup = workspace.path().join("undo.json");
    library.export_backup(&backup).unwrap();
    let preview = library.preview_backup(&backup).unwrap();
    let restored = library.restore_backup(&backup, &preview).unwrap();
    assert_eq!(restored.library.skills[0].category_id, Some(writing));
    assert!(restored.library.assignments[0].direct);
    assert!(!restored.library.assignments[0].excluded);
    assert!(directory.join("Outline").is_symlink());
}

#[test]
fn restores_local_files_preferences_and_assignments_in_an_empty_library() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("old");
    let library = Library::open(&root).unwrap();
    let (reader, reader_dir) = agent(&library, workspace.path(), "Reader");
    let (reviewer, reviewer_dir) = agent(&library, workspace.path(), "Reviewer");
    let outline = install(
        &library,
        workspace.path(),
        "Outline",
        CategoryTarget::New {
            name: "Writing".into(),
        },
    );
    let category = library.snapshot().unwrap().categories[0].id;
    let draft = install(
        &library,
        workspace.path(),
        "Draft",
        CategoryTarget::Existing { id: category },
    );
    let original = library.managed_path(outline).unwrap();
    fs::write(original.join(".local-notes"), b"edited after installation").unwrap();
    library.set_category_sync(reader, category, true).unwrap();
    library.set_agent_skill(reader, draft, false).unwrap();
    library.set_agent_skill(reviewer, outline, true).unwrap();
    let preferences = Preferences {
        language: Language::En,
        theme: Theme::Dark,
        backup_retention: Default::default(),
        auto_check_app_updates: true,
    };
    library.set_preferences(preferences).unwrap();

    let backup = workspace.path().join("library.json");
    library.export_backup(&backup).unwrap();
    let reset = library.preview_defaults().unwrap();
    assert_eq!(reset.current.skills, 2);
    assert_eq!(reset.links_removed.len(), 2);
    assert!(reader_dir.join("Outline").is_symlink());
    library.restore_defaults(&reset).unwrap();
    assert!(library.snapshot().unwrap().agents.is_empty());
    assert_eq!(library.preferences().unwrap(), Preferences::default());
    assert!(!original.exists());
    assert!(!reader_dir.join("Outline").is_symlink());

    let new_root = workspace.path().join("restored");
    let restored = Library::open(&new_root).unwrap();
    let preview = restored.preview_backup(&backup).unwrap();
    assert_eq!(preview.current.skills, 0);
    assert_eq!(preview.incoming.skills, 2);
    assert_eq!(preview.incoming.categories, 1);
    assert_eq!(preview.incoming.agents, 2);
    assert!(restored.snapshot().unwrap().skills.is_empty());
    assert!(!reviewer_dir.join("Outline").is_symlink());
    restored.restore_backup(&backup, &preview).unwrap();
    drop(restored);

    let reopened = Library::open(&new_root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(reopened.preferences().unwrap(), preferences);
    assert_eq!(snapshot.categories[0].name, "Writing");
    let skill = snapshot
        .skills
        .iter()
        .find(|skill| skill.id == outline)
        .unwrap();
    assert_eq!(skill.name, "Outline");
    assert_eq!(skill.description, "Synthetic fixture");
    assert_eq!(skill.category_id, Some(category));
    assert!(skill.source.is_none());
    assert_eq!(
        snapshot.agents[0].directory,
        reader_dir.canonicalize().unwrap()
    );
    assert_eq!(snapshot.skills.len(), 2);
    assert!(snapshot
        .assignments
        .iter()
        .any(|assignment| assignment.skill_id == draft
            && assignment.excluded
            && assignment.path.is_none()));
    assert!(snapshot
        .assignments
        .iter()
        .any(|assignment| assignment.skill_id == outline
            && assignment.agent_id == reviewer
            && assignment.direct));
    assert!(snapshot
        .assignments
        .iter()
        .any(|assignment| assignment.skill_id == outline
            && assignment.agent_id == reader
            && assignment.via_category));
    let managed = reopened.managed_path(outline).unwrap();
    assert!(managed.join("support/empty").is_dir());
    assert_eq!(
        fs::read(reviewer_dir.join("Outline/support/tool.bin")).unwrap(),
        [0, 255, 12, 10]
    );
    assert_eq!(
        fs::read(reader_dir.join("Outline/.local-notes")).unwrap(),
        b"edited after installation"
    );
    assert_eq!(
        fs::metadata(managed.join("support/tool.bin"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o751
    );
}

#[test]
fn older_backups_get_readable_names_without_overwriting_a_folder_on_disk() {
    let workspace = TempDir::new().unwrap();
    let library = Library::open(workspace.path().join("source-library")).unwrap();
    let id = install(
        &library,
        workspace.path(),
        "Outline",
        CategoryTarget::Uncategorized,
    );
    let backup = workspace.path().join("backup.json");
    library.export_backup(&backup).unwrap();
    let mut archived: serde_json::Value =
        serde_json::from_slice(&fs::read(&backup).unwrap()).unwrap();
    archived["version"] = 1.into();
    archived["skills"][0]
        .as_object_mut()
        .unwrap()
        .remove("directory_name");
    fs::write(&backup, serde_json::to_vec(&archived).unwrap()).unwrap();

    let restored = Library::open(workspace.path().join("restored")).unwrap();
    let managed = restored.snapshot().unwrap().managed_directory;
    fs::create_dir(managed.join("Outline")).unwrap();
    fs::write(managed.join("Outline/notes"), "existing folder").unwrap();
    let preview = restored.preview_backup(&backup).unwrap();
    restored.restore_backup(&backup, &preview).unwrap();
    assert_eq!(
        restored.managed_path(id).unwrap(),
        managed.join("Outline（2）")
    );
    assert_eq!(
        fs::read_to_string(managed.join("Outline/notes")).unwrap(),
        "existing folder"
    );

    restored.export_backup(&backup).unwrap();
    let another = Library::open(workspace.path().join("another")).unwrap();
    another
        .restore_backup(&backup, &another.preview_backup(&backup).unwrap())
        .unwrap();
    assert_eq!(
        another.managed_path(id).unwrap().file_name().unwrap(),
        "Outline（2）"
    );
}

#[test]
fn rejects_malformed_ambiguous_and_escaping_backups_before_replacing_anything() {
    use serde_json::{json, Value};

    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let (agent, directory) = agent(&library, workspace.path(), "Reader");
    let id = install(
        &library,
        workspace.path(),
        "Outline",
        CategoryTarget::Uncategorized,
    );
    library.set_agent_skill(agent, id, true).unwrap();
    let path = workspace.path().join("backup.json");
    library.export_backup(&path).unwrap();
    let valid: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let managed = library.managed_path(id).unwrap();
    let link = directory.join("Outline");

    let mut cases = Vec::new();
    for name in ["../escape", ".skill-library-owner", "A:B", ".staging-test"] {
        let mut invalid = valid.clone();
        invalid["skills"][0]["directory_name"] = json!(name);
        cases.push(invalid);
    }
    for entry in [
        json!({"kind": "file", "path": "../escape", "bytes": "MA==", "mode": 420}),
        json!({"kind": "file", "path": "/escape", "bytes": "MA==", "mode": 420}),
        json!({"kind": "file", "path": "C:escape", "bytes": "MA==", "mode": 420}),
        json!({"kind": "file", "path": "support//escape", "bytes": "MA==", "mode": 420}),
        json!({"kind": "file", "path": "support/absent/escape", "bytes": "MA==", "mode": 420}),
        json!({"kind": "file", "path": "support/TOOL.BIN", "bytes": "MA==", "mode": 420}),
        json!({"kind": "file", "path": "bad-base64", "bytes": "%%%=", "mode": 420}),
        json!({"kind": "file", "path": "bad-mode", "bytes": "MA==", "mode": 4095}),
        json!({"kind": "link", "path": "external", "target": "../escape"}),
    ] {
        let mut invalid = valid.clone();
        invalid["skills"][0]["entries"]
            .as_array_mut()
            .unwrap()
            .push(entry);
        cases.push(invalid);
    }
    let mut invalid = valid.clone();
    let entries = invalid["skills"][0]["entries"].as_array_mut().unwrap();
    entries.retain(|entry| entry["path"] != "SKILL.md");
    cases.push(invalid);
    let mut invalid = valid.clone();
    invalid["agents"][0]["direct"] = json!([id, id]);
    cases.push(invalid);
    let mut invalid = valid.clone();
    invalid["agents"][0]["directory"] = json!(root.join("skills").canonicalize().unwrap());
    cases.push(invalid);
    let mut invalid = valid.clone();
    invalid["skills"][0]["metadata"]["categoryId"] = json!(Uuid::new_v4());
    cases.push(invalid);
    let mut invalid = valid.clone();
    invalid["preferences"]["language"] = json!("unknown");
    cases.push(invalid);

    for invalid in cases {
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(
            library.preview_backup(&path).is_err(),
            "Unexpectedly accepted {invalid}"
        );
        assert_eq!(library.snapshot().unwrap().skills[0].id, id);
        assert_eq!(fs::read_link(&link).unwrap(), managed);
        assert_eq!(
            fs::read(link.join("support/tool.bin")).unwrap(),
            [0, 255, 12, 10]
        );
    }
    fs::write(&path, b"{ malformed").unwrap();
    assert!(library.preview_backup(&path).is_err());

    fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
    let preview = library.preview_backup(&path).unwrap();
    assert!(preview.links_removed.is_empty());
    assert!(preview.links_created.is_empty());
    fs::write(&path, serde_json::to_vec_pretty(&valid).unwrap()).unwrap();
    assert!(library.restore_backup(&path, &preview).is_err());
    assert_eq!(fs::read_link(&link).unwrap(), managed);
}

#[test]
fn reset_keeps_unowned_entries_even_if_a_recreated_link_points_to_the_original_target() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let (reader, reader_dir) = agent(&library, workspace.path(), "Reader");
    let (reviewer, reviewer_dir) = agent(&library, workspace.path(), "Reviewer");
    let id = install(
        &library,
        workspace.path(),
        "Outline",
        CategoryTarget::Uncategorized,
    );
    let managed = library.managed_path(id).unwrap();
    library.set_agent_skill(reader, id, true).unwrap();
    library.set_agent_skill(reviewer, id, true).unwrap();
    let owned = reader_dir.join("Outline");
    let replaced = reviewer_dir.join("Outline");
    let before_replacement = library.preview_defaults().unwrap();
    assert_eq!(before_replacement.links_removed.len(), 2);

    let original_moved = workspace.path().join("moved-link");
    fs::rename(&replaced, &original_moved).unwrap();
    symlink(&managed, &replaced).unwrap();
    fs::write(reader_dir.join("unrelated"), b"keep").unwrap();
    assert!(library.restore_defaults(&before_replacement).is_err());
    assert_eq!(fs::read_link(&owned).unwrap(), managed);

    let reset = library.preview_defaults().unwrap();
    assert_eq!(reset.links_removed.as_slice(), std::slice::from_ref(&owned));
    library.restore_defaults(&reset).unwrap();
    assert!(!owned.is_symlink());
    assert_eq!(fs::read_link(&replaced).unwrap(), managed);
    assert_eq!(fs::read_link(&original_moved).unwrap(), managed);
    assert_eq!(fs::read(reader_dir.join("unrelated")).unwrap(), b"keep");
    assert!(library.snapshot().unwrap().skills.is_empty());
    assert_eq!(fs::read_dir(root.join("skills")).unwrap().count(), 0);
}

#[test]
fn replacement_rolls_back_existing_and_incoming_content_on_publication_failure() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let (reader, directory) = agent(&library, workspace.path(), "Reader");
    let incoming = workspace.path().join("Incoming");
    fs::create_dir(&incoming).unwrap();
    fs::write(
        incoming.join("SKILL.md"),
        b"---\nname: Incoming\ndescription: Synthetic fixture\n---\n",
    )
    .unwrap();
    let members = library.preview_folders(vec![incoming]).unwrap();
    let source = skill_library::PackageSource {
        repository: "https://github.com/fixture/skills.git".into(),
        member_path: "skills/incoming".into(),
        revision: String::new(),
        reference: Some("refs/heads/main".into()),
    };
    let installed = library
        .commit_import_with_agents(
            vec![ImportSelection {
                path: members.members[0].path.clone(),
                fingerprint: members.members[0].fingerprint.clone(),
                source: Some(source.clone()),
            }],
            CategoryTarget::Uncategorized,
            vec![reader],
        )
        .unwrap();
    let incoming = installed.added[0];
    let managed = library.managed_path(incoming).unwrap();
    let manifest = fs::read(managed.join("SKILL.md")).unwrap();
    let backup = workspace.path().join("backup.json");
    library.export_backup(&backup).unwrap();

    let removed = install(
        &library,
        workspace.path(),
        "Later",
        CategoryTarget::Uncategorized,
    );
    library.set_agent_skill(reader, removed, true).unwrap();
    let edited = b"---\nname: Incoming\ndescription: Locally edited\n---\n";
    fs::write(managed.join("SKILL.md"), edited).unwrap();
    fs::remove_file(directory.join("Incoming")).unwrap();
    fs::write(directory.join("Incoming"), b"unowned").unwrap();
    assert!(library.preview_backup(&backup).is_err());
    assert_eq!(fs::read(directory.join("Incoming")).unwrap(), b"unowned");
    fs::remove_file(directory.join("Incoming")).unwrap();
    let preview = library.preview_backup(&backup).unwrap();
    assert_eq!(preview.current.skills, 2);
    assert_eq!(preview.incoming.skills, 1);
    assert_eq!(preview.links_removed, [directory.join("Later")]);
    assert_eq!(preview.links_created, [directory.join("Incoming")]);
    assert_eq!(fs::read(managed.join("SKILL.md")).unwrap(), edited);
    assert!(directory.join("Later").is_symlink());

    let registry = root.join("library.json");
    let saved_registry = workspace.path().join("saved-registry.json");
    fs::rename(&registry, &saved_registry).unwrap();
    fs::create_dir(&registry).unwrap();
    assert!(library.restore_backup(&backup, &preview).is_err());
    assert_eq!(library.snapshot().unwrap().skills.len(), 2);
    assert_eq!(fs::read(managed.join("SKILL.md")).unwrap(), edited);
    assert!(directory.join("Later").is_symlink());
    assert!(!directory.join("Incoming").is_symlink());

    fs::remove_dir(&registry).unwrap();
    fs::rename(saved_registry, registry).unwrap();
    let fresh = library.preview_backup(&backup).unwrap();
    let restored = library.restore_backup(&backup, &fresh).unwrap();
    assert_eq!(restored.library.last_install_agents, [reader]);
    assert_eq!(restored.library.skills.len(), 1);
    let restored_source = restored.library.skills[0].source.as_ref().unwrap();
    assert_eq!(restored_source.repository, source.repository);
    assert_eq!(restored_source.member_path, source.member_path);
    assert_eq!(restored_source.revision, source.revision);
    assert_eq!(restored_source.reference, source.reference);
    assert_eq!(
        fs::read(directory.join("Incoming/SKILL.md")).unwrap(),
        manifest
    );
    assert!(!directory.join("Later").is_symlink());
}

#[test]
fn legacy_and_new_agent_kinds_keep_their_ids_custom_directories_and_links() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let skill = install(
        &library,
        workspace.path(),
        "Outline",
        CategoryTarget::Uncategorized,
    );
    let mut expected = Vec::new();
    for (kind, name) in [
        ("claudeCode", "Claude Code"),
        ("codex", "Codex"),
        ("custom", "My Agent"),
        ("antigravity", "Antigravity"),
        ("geminiCli", "Gemini CLI"),
    ] {
        let directory = workspace.path().join(name);
        fs::create_dir(&directory).unwrap();
        let draft = serde_json::from_value(serde_json::json!({
            "kind": kind, "name": name, "directory": directory,
        }))
        .unwrap();
        let snapshot = library.add_agent(draft).unwrap();
        let agent = snapshot
            .agents
            .iter()
            .find(|agent| agent.name == name)
            .unwrap();
        library.set_agent_skill(agent.id, skill, true).unwrap();
        expected.push((agent.id, kind, directory.canonicalize().unwrap()));
    }
    drop(library);

    let library = Library::open(&root).unwrap();
    let check = |snapshot: skill_library::LibrarySnapshot| {
        assert_eq!(snapshot.agents.len(), expected.len());
        for (id, kind, directory) in &expected {
            let agent = snapshot
                .agents
                .iter()
                .find(|agent| agent.id == *id)
                .unwrap();
            assert_eq!(serde_json::to_value(agent.kind).unwrap(), *kind);
            assert_eq!(&agent.directory, directory);
            assert!(snapshot
                .assignments
                .iter()
                .any(|a| a.agent_id == *id && a.skill_id == skill && a.direct));
            assert!(fs::read_to_string(directory.join("Outline/SKILL.md"))
                .unwrap()
                .contains("name: Outline"));
        }
    };
    check(library.snapshot().unwrap());
    let backup = workspace.path().join("export.json");
    library.export_backup(&backup).unwrap();
    library
        .restore_defaults(&library.preview_defaults().unwrap())
        .unwrap();
    let preview = library.preview_backup(&backup).unwrap();
    check(library.restore_backup(&backup, &preview).unwrap().library);
}

fn adopt_local_skill(
    library: &Library,
    workspace: &Path,
    agent_name: &'static str,
    skill_folder: &str,
) -> (PathBuf, Uuid) {
    let agent_dir = workspace.join(agent_name);
    let skill_dir = agent_dir.join(skill_folder);
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        format!("---\nname: {skill_folder}\ndescription: Adopted fixture\n---\nlocal body\n"),
    )
    .unwrap();
    let presets = [AgentPreset {
        kind: AgentKind::Custom,
        name: agent_name,
        directory: agent_dir,
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    let matched: Vec<_> = rows
        .into_iter()
        .filter(|row| row.name == skill_folder)
        .collect();
    assert_eq!(matched.len(), 1);
    let outcome = library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: matched,
                conflicts: vec![],
                copy_only: false,
                summary: None,
            },
        )
        .unwrap();
    (skill_dir, outcome.batch_id.expect("backup batch id"))
}

#[test]
fn reset_with_restore_originals_restores_adopted_folders_and_clears_library() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let (adopted_dir, batch_id) = adopt_local_skill(&library, workspace.path(), "Claude", "Alpha");
    let (other_agent, other_dir) = agent(&library, workspace.path(), "Other");
    let extra = install(
        &library,
        workspace.path(),
        "Extra",
        CategoryTarget::New {
            name: "Tools".into(),
        },
    );
    library.set_agent_skill(other_agent, extra, true).unwrap();
    assert!(adopted_dir.is_symlink());
    assert!(other_dir.join("Extra").is_symlink());

    let preview = library.preview_defaults().unwrap();
    assert_eq!(preview.original_backup_batches, 1);
    assert_eq!(preview.original_backup_items, 1);

    let outcome = library
        .restore_defaults_with_policy(&preview, ResetBackupPolicy::RestoreOriginals)
        .unwrap();
    assert!(outcome.library.skills.is_empty());
    assert!(outcome.library.agents.is_empty());
    assert_eq!(outcome.library.original_backup_count, 0);
    assert!(library.list_original_backups().unwrap().is_empty());
    assert!(!other_dir.join("Extra").is_symlink());
    assert!(!adopted_dir.is_symlink());
    assert!(adopted_dir.is_dir());
    assert!(fs::read_to_string(adopted_dir.join("SKILL.md"))
        .unwrap()
        .contains("local body"));
    assert!(!root.join("original-backups").join(batch_id.to_string()).exists());
}

#[test]
fn reset_with_restore_originals_aborts_before_clearing_when_target_is_occupied() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let (adopted_dir, _batch_id) = adopt_local_skill(&library, workspace.path(), "Claude", "Alpha");
    let agent_id = library.snapshot().unwrap().agents[0].id;
    let skill_id = library.snapshot().unwrap().skills[0].id;

    // Detach the managed link and place an unrelated folder at the original path.
    library.set_agent_skill(agent_id, skill_id, false).unwrap();
    assert!(!adopted_dir.exists());
    fs::create_dir_all(&adopted_dir).unwrap();
    fs::write(adopted_dir.join("notes.txt"), "user data").unwrap();

    let preview = library.preview_defaults().unwrap();
    let err = library
        .restore_defaults_with_policy(&preview, ResetBackupPolicy::RestoreOriginals)
        .unwrap_err();
    assert!(err.to_string().contains("已有其他文件"));

    // Library, original backup, and existing user file must all remain intact.
    assert_eq!(library.snapshot().unwrap().skills.len(), 1);
    assert_eq!(library.list_original_backups().unwrap().len(), 1);
    assert_eq!(
        fs::read_to_string(adopted_dir.join("notes.txt")).unwrap(),
        "user data"
    );
}

#[test]
fn reset_with_keep_preserves_original_backups_for_later_restore() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let (adopted_dir, batch_id) = adopt_local_skill(&library, workspace.path(), "Claude", "Alpha");

    let preview = library.preview_defaults().unwrap();
    let outcome = library
        .restore_defaults_with_policy(&preview, ResetBackupPolicy::Keep)
        .unwrap();
    assert!(outcome.library.skills.is_empty());
    assert_eq!(outcome.library.original_backup_count, 1);
    assert!(!adopted_dir.exists());

    let backups = library.list_original_backups().unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].id, batch_id);

    let restored = library.restore_original_backup(batch_id).unwrap();
    assert_eq!(restored.original_backup_count, 0);
    assert!(!adopted_dir.is_symlink());
    assert!(fs::read_to_string(adopted_dir.join("SKILL.md"))
        .unwrap()
        .contains("local body"));
}

#[test]
fn reset_with_delete_backups_removes_records_and_disk_files() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let (adopted_dir, batch_id) = adopt_local_skill(&library, workspace.path(), "Claude", "Alpha");

    let preview = library.preview_defaults().unwrap();
    let outcome = library
        .restore_defaults_with_policy(&preview, ResetBackupPolicy::DeleteBackups)
        .unwrap();
    assert!(outcome.library.skills.is_empty());
    assert_eq!(outcome.library.original_backup_count, 0);
    assert!(library.list_original_backups().unwrap().is_empty());
    assert!(!adopted_dir.exists());
    assert!(!root.join("original-backups").join(batch_id.to_string()).exists());
}

#[test]
fn importing_json_backup_preserves_existing_local_original_backups() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let _extra = install(
        &library,
        workspace.path(),
        "Extra",
        CategoryTarget::Uncategorized,
    );
    let json_backup = workspace.path().join("snapshot.json");
    library.export_backup(&json_backup).unwrap();

    let (_adopted_dir, batch_id) = adopt_local_skill(&library, workspace.path(), "Claude", "Alpha");
    assert_eq!(library.list_original_backups().unwrap().len(), 1);

    let preview = library.preview_backup(&json_backup).unwrap();
    let restored = library.restore_backup(&json_backup, &preview).unwrap();
    assert_eq!(restored.library.original_backup_count, 1);
    let backups = library.list_original_backups().unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].id, batch_id);
    assert!(root.join("original-backups").join(batch_id.to_string()).is_dir());
}

#[test]
fn preferences_deserializes_legacy_json_without_auto_check_app_updates_as_true() {
    let legacy = r#"{"language":"en","theme":"dark","backupRetention":"7d"}"#;
    let parsed: Preferences = serde_json::from_str(legacy).unwrap();
    assert!(parsed.auto_check_app_updates);
    assert_eq!(Preferences::default().auto_check_app_updates, true);

    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let mut updated = library.preferences().unwrap();
    updated.auto_check_app_updates = false;
    let saved = library.set_preferences(updated).unwrap();
    assert!(!saved.auto_check_app_updates);

    let backup = workspace.path().join("prefs-backup.json");
    library.export_backup(&backup).unwrap();

    let restored_root = workspace.path().join("restored");
    let restored = Library::open(&restored_root).unwrap();
    let preview = restored.preview_backup(&backup).unwrap();
    assert!(!preview.preferences.auto_check_app_updates);
    restored.restore_backup(&backup, &preview).unwrap();
    assert!(!restored.preferences().unwrap().auto_check_app_updates);
}

fn adopt_external_symlink(
    library: &Library,
    agent_name: &'static str,
    agent_dir: &Path,
    skill_folder: &str,
    external_dir: &Path,
) -> (PathBuf, Uuid, Uuid) {
    fs::create_dir_all(agent_dir).unwrap();
    if !external_dir.exists() {
        fs::create_dir_all(external_dir).unwrap();
        fs::write(
            external_dir.join("SKILL.md"),
            format!("---\nname: {skill_folder}\ndescription: External fixture\n---\nexternal body\n"),
        )
        .unwrap();
    }
    let link_path = agent_dir.join(skill_folder);
    symlink(external_dir, &link_path).unwrap();
    let presets = [AgentPreset {
        kind: AgentKind::Custom,
        name: agent_name,
        directory: agent_dir.to_path_buf(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    let matched: Vec<_> = rows
        .into_iter()
        .filter(|row| row.name == skill_folder)
        .collect();
    assert_eq!(matched.len(), 1);
    let outcome = library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: matched,
                conflicts: vec![],
                copy_only: false,
                summary: None,
            },
        )
        .unwrap();
    assert!(outcome.results.iter().all(|r| r.error.is_none()));
    let skill_id = outcome
        .snapshot
        .skills
        .iter()
        .find(|s| s.name == skill_folder)
        .map(|s| s.id)
        .expect("adopted skill id");
    (
        link_path,
        outcome.batch_id.expect("backup batch id"),
        skill_id,
    )
}

#[test]
fn reset_with_restore_originals_succeeds_when_external_symlink_already_matches() {
    let workspace = TempDir::new().unwrap();
    let base = workspace.path().canonicalize().unwrap();
    let library = Library::open(base.join("library")).unwrap();
    let agent_dir = base.join("WorkBuddy");
    let external_dir = base.join("external/ego-browser");
    let (agent_link, _batch_id, _skill_id) =
        adopt_external_symlink(&library, "WorkBuddy", &agent_dir, "ego-browser", &external_dir);

    // Simulate an external tool recreating the exact pre-adoption symlink (new inode, unowned).
    fs::remove_file(&agent_link).unwrap();
    symlink(&external_dir, &agent_link).unwrap();

    let preview = library.preview_defaults().unwrap();
    let outcome = library
        .restore_defaults_with_policy(&preview, ResetBackupPolicy::RestoreOriginals)
        .unwrap();
    assert!(outcome.library.skills.is_empty());
    assert!(outcome.library.agents.is_empty());
    assert_eq!(outcome.library.original_backup_count, 0);
    assert!(library.list_original_backups().unwrap().is_empty());
    assert_eq!(fs::read_link(&agent_link).unwrap(), external_dir);
}

#[test]
fn reset_with_restore_originals_aborts_when_external_symlink_points_elsewhere() {
    let workspace = TempDir::new().unwrap();
    let base = workspace.path().canonicalize().unwrap();
    let library = Library::open(base.join("library")).unwrap();
    let agent_dir = base.join("WorkBuddy");
    let external_dir = base.join("external/ego-browser");
    let other_dir = base.join("external/other-browser");
    fs::create_dir_all(&other_dir).unwrap();
    let (agent_link, _batch_id, _skill_id) =
        adopt_external_symlink(&library, "WorkBuddy", &agent_dir, "ego-browser", &external_dir);

    // Replace with a symlink pointing somewhere different from the backed-up target.
    fs::remove_file(&agent_link).unwrap();
    symlink(&other_dir, &agent_link).unwrap();

    let preview = library.preview_defaults().unwrap();
    let err = library
        .restore_defaults_with_policy(&preview, ResetBackupPolicy::RestoreOriginals)
        .unwrap_err();
    assert!(err.to_string().contains("已有其他文件"), "err={err}");
    assert_eq!(library.snapshot().unwrap().skills.len(), 1);
    assert_eq!(library.list_original_backups().unwrap().len(), 1);
    assert_eq!(fs::read_link(&agent_link).unwrap(), other_dir);
}

#[test]
fn reset_with_restore_originals_skips_library_internal_backup_and_cleans_duplicate_batches() {
    let workspace = TempDir::new().unwrap();
    let base = workspace.path().canonicalize().unwrap();
    let library = Library::open(base.join("library")).unwrap();
    let agent_dir = base.join("Qoder");
    let external_dir = base.join("external/yf-topic");

    // Batch 1: adopt external symlink -> external/yf-topic.
    let (agent_link, _batch1, skill_id) =
        adopt_external_symlink(&library, "Qoder", &agent_dir, "yf-topic", &external_dir);

    // Batch 2: external tool restored the same link, then user re-adopted it.
    fs::remove_file(&agent_link).unwrap();
    let (_agent_link, _batch2, _skill_id2) =
        adopt_external_symlink(&library, "Qoder", &agent_dir, "yf-topic", &external_dir);

    // Batch 3: an unowned symlink pointing into the managed library was re-adopted,
    // recording a newer backup whose previous_link_target is inside managed_dir.
    let managed_target = library.managed_path(skill_id).unwrap();
    fs::remove_file(&agent_link).unwrap();
    symlink(&managed_target, &agent_link).unwrap();
    let presets = [AgentPreset {
        kind: AgentKind::Custom,
        name: "Qoder",
        directory: agent_dir.clone(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    let matched: Vec<_> = rows.into_iter().filter(|r| r.name == "yf-topic").collect();
    assert_eq!(matched.len(), 1);
    library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: matched,
                conflicts: vec![],
                copy_only: false,
                summary: None,
            },
        )
        .unwrap();

    assert_eq!(library.list_original_backups().unwrap().len(), 3);

    let preview = library.preview_defaults().unwrap();
    let outcome = library
        .restore_defaults_with_policy(&preview, ResetBackupPolicy::RestoreOriginals)
        .unwrap();
    assert!(outcome.library.skills.is_empty());
    assert!(outcome.library.agents.is_empty());
    assert_eq!(outcome.library.original_backup_count, 0);
    assert!(library.list_original_backups().unwrap().is_empty());
    assert_eq!(fs::read_link(&agent_link).unwrap(), external_dir);
    assert!(agent_link.join("SKILL.md").is_file());
}

#[test]
fn restore_original_backup_succeeds_when_external_symlink_already_matches() {
    let workspace = TempDir::new().unwrap();
    let base = workspace.path().canonicalize().unwrap();
    let library = Library::open(base.join("library")).unwrap();
    let agent_dir = base.join("WorkBuddy");
    let external_dir = base.join("external/ego-browser");
    let (agent_link, batch_id, _skill_id) =
        adopt_external_symlink(&library, "WorkBuddy", &agent_dir, "ego-browser", &external_dir);

    fs::remove_file(&agent_link).unwrap();
    symlink(&external_dir, &agent_link).unwrap();

    let restored = library.restore_original_backup(batch_id).unwrap();
    assert_eq!(restored.skills.len(), 1);
    assert_eq!(restored.original_backup_count, 0);
    assert!(library.list_original_backups().unwrap().is_empty());
    assert_eq!(fs::read_link(&agent_link).unwrap(), external_dir);
}

#[test]
fn opens_registry_and_imports_backup_with_ignored_legacy_migration_field() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    {
        let library = Library::open(&root).unwrap();
        install(
            &library,
            workspace.path(),
            "Alpha",
            CategoryTarget::Uncategorized,
        );
    }

    let registry_path = root.join("library.json");
    let mut registry: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&registry_path).unwrap()).unwrap();
    registry["migration"] = serde_json::json!({
        "dismissed": ["/tmp/old.db"],
        "records": []
    });
    fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();

    let reopened = Library::open(&root).unwrap();
    assert_eq!(reopened.snapshot().unwrap().skills.len(), 1);

    let backup_path = workspace.path().join("legacy-migration-field.json");
    reopened.export_backup(&backup_path).unwrap();
    let mut backup_json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&backup_path).unwrap()).unwrap();
    assert!(backup_json.get("migration").is_none());

    backup_json["migration"] = serde_json::json!({
        "history": { "records": [] },
        "seal": "abc"
    });
    fs::write(&backup_path, serde_json::to_vec(&backup_json).unwrap()).unwrap();

    let target = Library::open(workspace.path().join("restored")).unwrap();
    let preview = target.preview_backup(&backup_path).unwrap();
    assert_eq!(preview.incoming.skills, 1);
    let outcome = target.restore_backup(&backup_path, &preview).unwrap();
    assert_eq!(outcome.library.skills.len(), 1);
}

#[test]
fn restoring_an_original_backup_can_be_retried_after_a_partial_failure() {
    let workspace = TempDir::new().unwrap();
    let root = workspace.path().join("library");
    let library = Library::open(&root).unwrap();
    let agent_dir = workspace.path().join("Claude");
    for name in ["Alpha", "Beta"] {
        let dir = agent_dir.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Adopted fixture\n---\n{name} body\n"),
        )
        .unwrap();
    }
    let presets = [AgentPreset {
        kind: AgentKind::Custom,
        name: "Claude",
        directory: agent_dir.clone(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    let batch_id = library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: rows,
                conflicts: vec![],
                copy_only: false,
                summary: None,
            },
        )
        .unwrap()
        .batch_id
        .expect("backup batch id");
    let alpha = agent_dir.canonicalize().unwrap().join("Alpha");
    let beta = agent_dir.canonicalize().unwrap().join("Beta");
    assert!(alpha.is_symlink() && beta.is_symlink());

    // Occupy Beta's original location so only Alpha can be restored on the first attempt.
    let snapshot = library.snapshot().unwrap();
    let beta_id = snapshot.skills.iter().find(|s| s.name == "Beta").unwrap().id;
    library
        .set_agent_skill(snapshot.agents[0].id, beta_id, false)
        .unwrap();
    fs::create_dir(&beta).unwrap();
    fs::write(beta.join("notes.txt"), "user data").unwrap();

    let error = library.restore_original_backup(batch_id).unwrap_err();
    assert!(error.to_string().contains("已有其他文件"));
    assert!(fs::read_to_string(alpha.join("SKILL.md"))
        .unwrap()
        .contains("Alpha body"));
    assert_eq!(library.list_original_backups().unwrap().len(), 1);

    fs::remove_dir_all(&beta).unwrap();
    let restored = library.restore_original_backup(batch_id).unwrap();
    assert_eq!(restored.original_backup_count, 0);
    assert!(fs::read_to_string(alpha.join("SKILL.md"))
        .unwrap()
        .contains("Alpha body"));
    assert!(fs::read_to_string(beta.join("SKILL.md"))
        .unwrap()
        .contains("Beta body"));
}

#![cfg(unix)]

use skill_library::{AgentDraft, AgentKind, CategoryTarget, ImportSelection, Library};
use std::{fs, path::PathBuf};
use tempfile::TempDir;
use uuid::Uuid;

struct Fixture {
    workspace: TempDir,
    root: PathBuf,
    library: Library,
}

impl Fixture {
    fn new() -> Self {
        let workspace = TempDir::new().unwrap();
        let root = workspace.path().join("library");
        let library = Library::open(&root).unwrap();
        Self {
            workspace,
            root,
            library,
        }
    }

    fn agent(&self, name: &str) -> (Uuid, PathBuf) {
        let directory = self.workspace.path().join(name);
        fs::create_dir(&directory).unwrap();
        let snapshot = self
            .library
            .add_agent(AgentDraft {
                kind: AgentKind::Custom,
                name: name.into(),
                directory: directory.clone(),
            })
            .unwrap();
        (snapshot.agents.last().unwrap().id, directory)
    }

    fn member(&self, name: &str) -> ImportSelection {
        let path = self.workspace.path().join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Example fixture\n---\nSynthetic {name}"),
        )
        .unwrap();
        let preview = self.library.preview_folders(vec![path]).unwrap();
        let member = &preview.members[0];
        ImportSelection {
            path: member.path.clone(),
            fingerprint: member.fingerprint.clone(),
            source: None,
        }
    }
}

#[test]
fn removing_a_tool_preserves_other_installations_and_allows_adding_it_again() {
    let fixture = Fixture::new();
    let (first, directory) = fixture.agent("First");
    let (second, other) = fixture.agent("Second");
    let installed = fixture
        .library
        .commit_import_with_agents(
            vec![fixture.member("outline"), fixture.member("notes")],
            CategoryTarget::Uncategorized,
            vec![first, second],
        )
        .unwrap();
    fixture
        .library
        .set_category_sync(first, None, true)
        .unwrap();
    let outline = installed
        .library
        .skills
        .iter()
        .find(|skill| skill.name == "outline")
        .unwrap()
        .id;
    let notes = installed
        .library
        .skills
        .iter()
        .find(|skill| skill.name == "notes")
        .unwrap()
        .id;
    assert!(fixture.library.remove_agent(first, vec![notes]).is_err());
    assert!(directory.join("outline/SKILL.md").is_file());

    fs::remove_file(directory.join("notes")).unwrap();
    fs::write(directory.join("notes"), "user file").unwrap();
    std::os::unix::fs::symlink(
        fixture.library.managed_path(outline).unwrap(),
        directory.join("my-outline"),
    )
    .unwrap();
    let snapshot = fixture.library.remove_agent(first, vec![outline]).unwrap();
    assert_eq!(snapshot.agents.len(), 1);
    assert_eq!(snapshot.agents[0].id, second);
    assert_eq!(snapshot.last_install_agents, [second]);
    assert_eq!(snapshot.skills.len(), 2);
    assert_eq!(snapshot.assignments.len(), 2);
    assert!(snapshot
        .assignments
        .iter()
        .all(|assignment| assignment.agent_id == second));
    assert!(fs::symlink_metadata(directory.join("outline")).is_err());
    assert_eq!(
        fs::read_to_string(directory.join("notes")).unwrap(),
        "user file"
    );
    assert!(fs::read_link(directory.join("my-outline")).is_ok());
    assert!(other.join("outline/SKILL.md").is_file());
    assert!(other.join("notes/SKILL.md").is_file());
    let backup = fixture.workspace.path().join("backup.json");
    fixture.library.export_backup(&backup).unwrap();
    fixture.library.preview_backup(&backup).unwrap();

    drop(fixture.library);
    let reopened = Library::open(&fixture.root).unwrap();
    assert_eq!(reopened.snapshot().unwrap().agents.len(), 1);
    let added = reopened
        .add_agent(AgentDraft {
            kind: AgentKind::Custom,
            name: "First".into(),
            directory: directory.clone(),
        })
        .unwrap();
    let fresh = added.agents.last().unwrap();
    assert_ne!(fresh.id, first);
    assert!(!fresh.sync_uncategorized);
    assert!(added
        .assignments
        .iter()
        .all(|assignment| assignment.agent_id == second));
    assert_eq!(
        reopened.remove_agent(first, vec![]).unwrap().agents.len(),
        2
    );
}

#[test]
fn first_install_can_assign_the_same_managed_content_to_two_agents() {
    let Fixture {
        root,
        library,
        workspace,
    } = {
        let fixture = Fixture::new();
        let (first, first_dir) = fixture.agent("First");
        let (second, second_dir) = fixture.agent("Second");
        assert!(fixture
            .library
            .snapshot()
            .unwrap()
            .last_install_agents
            .is_empty());
        let installed = fixture
            .library
            .commit_import_with_agents(
                vec![fixture.member("outline")],
                CategoryTarget::Uncategorized,
                vec![first, second],
            )
            .unwrap();
        let id = installed.added[0];
        assert_eq!(installed.library.last_install_agents, [first, second]);
        let managed = fixture.library.managed_path(id).unwrap();
        assert_eq!(fs::read_link(first_dir.join("outline")).unwrap(), managed);
        assert_eq!(fs::read_link(second_dir.join("outline")).unwrap(), managed);
        assert!(fs::read_to_string(first_dir.join("outline/SKILL.md"))
            .unwrap()
            .contains("Synthetic outline"));
        fixture.library.set_agent_skill(second, id, false).unwrap();
        assert!(!second_dir.join("outline").exists());
        assert!(first_dir.join("outline/SKILL.md").is_file());
        fixture
    };

    drop(library);
    let snapshot = Library::open(&root).unwrap().snapshot().unwrap();
    assert_eq!(snapshot.agents.len(), 2);
    assert_eq!(snapshot.assignments.len(), 1);
    assert!(snapshot.assignments[0].direct);
    drop(workspace);
}

#[test]
fn renamed_category_keeps_installed_members_and_agent_sync_after_reopening() {
    let fixture = Fixture::new();
    let (agent, directory) = fixture.agent("Editor");
    let (inbox_agent, inbox) = fixture.agent("Inbox");
    fixture
        .library
        .set_category_sync(inbox_agent, None, true)
        .unwrap();
    let category = fixture
        .library
        .create_category("开发".into())
        .unwrap()
        .categories[0]
        .id;
    fixture
        .library
        .set_category_sync(agent, category, true)
        .unwrap();
    let target = CategoryTarget::Existing { id: category };
    fixture
        .library
        .commit_import_with_agents(vec![fixture.member("direct")], target.clone(), vec![agent])
        .unwrap();
    fixture
        .library
        .commit_import(vec![fixture.member("inherited")], target)
        .unwrap();

    fixture
        .library
        .rename_category(category, " 工具 ".into())
        .unwrap();
    drop(fixture.library);
    let reopened = Library::open(&fixture.root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.categories.len(), 1);
    assert_eq!(snapshot.categories[0].id, category);
    assert_eq!(snapshot.categories[0].name, "工具");
    assert_eq!(snapshot.skills.len(), 2);
    assert!(snapshot
        .skills
        .iter()
        .all(|member| member.category_id == Some(category)));
    assert_eq!(snapshot.assignments.len(), 2);
    assert!(snapshot
        .assignments
        .iter()
        .all(|link| link.agent_id == agent && link.via_category));
    assert!(directory.join("inherited/SKILL.md").is_file());

    let deleted = reopened.delete_category(category).unwrap();
    assert!(deleted
        .skills
        .iter()
        .all(|member| member.category_id.is_none()));
    assert!(directory.join("direct/SKILL.md").is_file());
    assert!(!directory.join("inherited").exists());
    assert!(inbox.join("inherited/SKILL.md").is_file());
    assert!(inbox.join("direct/SKILL.md").is_file());
}

#[test]
fn category_sync_tracks_imports_and_moves_and_undo_restores_exclusions_after_restart() {
    let fixture = Fixture::new();
    let (agent, dir) = fixture.agent("Writing");
    let category = fixture
        .library
        .create_category("Drafts".into())
        .unwrap()
        .categories[0]
        .id;
    let target = CategoryTarget::Existing { id: category };
    let first = fixture
        .library
        .commit_import_with_agents(vec![fixture.member("direct")], target.clone(), vec![agent])
        .unwrap()
        .added[0];

    let switched = fixture
        .library
        .set_category_sync(agent, category, true)
        .unwrap();
    assert_eq!(switched.impact.retained_direct, 1);
    assert_eq!(switched.impact.enabled, 0);
    let later = fixture
        .library
        .commit_import(
            vec![fixture.member("later"), fixture.member("excluded")],
            target,
        )
        .unwrap();
    assert!(dir.join("later/SKILL.md").is_file());
    fixture
        .library
        .set_agent_skill(agent, later.added[1], false)
        .unwrap();
    assert!(!dir.join("excluded").exists());
    let moved = fixture
        .library
        .move_skills(vec![first, later.added[0]], CategoryTarget::Uncategorized)
        .unwrap();
    assert!(dir.join("direct/SKILL.md").is_file());
    assert!(!dir.join("later").exists());
    fixture.library.undo_move(moved.undo.unwrap()).unwrap();

    let switched = fixture
        .library
        .set_category_sync(agent, category, false)
        .unwrap();
    assert_eq!(switched.impact.retained_direct, 1);
    assert_eq!(switched.impact.disabled, 1);
    assert!(dir.join("direct/SKILL.md").is_file());
    assert!(!dir.join("later").exists());
    let token = switched.undo.unwrap();
    let Fixture {
        workspace,
        root,
        library,
    } = fixture;
    drop(library);
    let reopened = Library::open(root).unwrap();
    let undone = reopened.undo_category_sync(token).unwrap();
    assert_eq!(undone.impact.enabled, 1);
    assert!(dir.join("later/SKILL.md").is_file());
    assert!(!dir.join("excluded").exists());
    assert!(undone
        .library
        .assignments
        .iter()
        .any(|assignment| assignment.skill_id == later.added[1]
            && assignment.excluded
            && assignment.path.is_none()));
    drop(workspace);
}

#[test]
fn install_preview_reports_inherited_targets_and_protects_occupied_entries() {
    let fixture = Fixture::new();
    let (inherited, inherited_dir) = fixture.agent("Inherited");
    let (direct, direct_dir) = fixture.agent("Direct");
    let category = fixture
        .library
        .create_category("Drafts".into())
        .unwrap()
        .categories[0]
        .id;
    fixture
        .library
        .set_category_sync(inherited, category, true)
        .unwrap();
    let member = fixture.member("outline");
    fs::write(inherited_dir.join("outline"), "user-owned").unwrap();

    let projected = fixture
        .library
        .preview_install_assignments(
            vec!["outline".into()],
            CategoryTarget::Existing { id: category },
            vec![direct],
        )
        .unwrap();
    assert_eq!(projected.targets.len(), 2);
    assert!(projected
        .targets
        .iter()
        .any(|target| target.agent_id == inherited && target.via_category && !target.direct));
    assert!(projected
        .targets
        .iter()
        .any(|target| target.agent_id == direct && target.direct && !target.via_category));
    assert_eq!(
        projected.conflicts[0].path,
        inherited_dir.join("outline").canonicalize().unwrap()
    );

    let result = fixture.library.commit_import_with_agents(
        vec![member],
        CategoryTarget::Existing { id: category },
        vec![direct],
    );
    assert!(result.unwrap_err().to_string().contains("outline"));
    assert_eq!(
        fs::read_to_string(inherited_dir.join("outline")).unwrap(),
        "user-owned"
    );
    assert!(!direct_dir.join("outline").exists());
    assert!(fixture.library.snapshot().unwrap().skills.is_empty());
    assert_eq!(
        fs::read_dir(fixture.root.join("skills")).unwrap().count(),
        0
    );
}

#[test]
fn unload_preview_names_affected_agents_and_unload_preserves_replaced_entries() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let (first, first_dir) = fixture.agent("First");
    let (second, second_dir) = fixture.agent("Second");
    let installed = fixture
        .library
        .commit_import_with_agents(
            vec![fixture.member("outline"), fixture.member("review")],
            CategoryTarget::Uncategorized,
            vec![first, second],
        )
        .unwrap();
    let skill = installed.added[0];
    let path = fixture.library.managed_path(skill).unwrap();
    let old = second_dir.join("outline");
    let external = fixture.workspace.path().join("user-file");
    fs::write(&external, "external").unwrap();
    fs::remove_file(&old).unwrap();
    symlink(&external, &old).unwrap();

    let impact = fixture.library.preview_unload(vec![skill]).unwrap();
    assert_eq!(impact.members[0].name, "outline");
    assert_eq!(
        impact
            .agents
            .iter()
            .map(|agent| agent.name.as_str())
            .collect::<Vec<_>>(),
        ["First", "Second"]
    );
    assert!(path.join("SKILL.md").is_file());
    assert!(first_dir.join("outline/SKILL.md").is_file());

    let after = fixture.library.unload_skills(impact).unwrap();
    assert_eq!(after.skills.len(), 1);
    assert!(!path.exists());
    assert!(!first_dir.join("outline").exists());
    assert_eq!(fs::read_link(&old).unwrap(), external);
    assert_eq!(fs::read_to_string(&old).unwrap(), "external");
    assert!(first_dir.join("review/SKILL.md").is_file());
}

#[test]
fn failed_registry_publication_rolls_back_links_and_content_and_allows_retry() {
    let fixture = Fixture::new();
    let (_, dir) = fixture.agent("Writing");
    let agent = fixture.library.snapshot().unwrap().agents[0].id;
    let member = fixture.member("outline");
    let registry = fixture.root.join("library.json");
    let saved = fixture.root.join("saved.json");
    fs::rename(&registry, &saved).unwrap();
    fs::create_dir(&registry).unwrap();
    let install = |library: &Library| {
        library.commit_import_with_agents(
            vec![member.clone()],
            CategoryTarget::New {
                name: "Drafts".into(),
            },
            vec![agent],
        )
    };
    assert!(install(&fixture.library).is_err());
    assert!(!dir.join("outline").exists());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    assert_eq!(
        fs::read_dir(fixture.root.join("skills")).unwrap().count(),
        0
    );
    assert!(fixture.library.snapshot().unwrap().categories.is_empty());
    fs::remove_dir(&registry).unwrap();
    fs::rename(saved, registry).unwrap();
    let Fixture {
        workspace,
        root,
        library,
    } = fixture;
    drop(library);
    let reopened = Library::open(root).unwrap();
    assert!(reopened.snapshot().unwrap().skills.is_empty());
    assert_eq!(install(&reopened).unwrap().added.len(), 1);
    assert!(dir.join("outline/SKILL.md").is_file());
    drop(workspace);
}

#[test]
fn an_unmanaged_symlink_is_preserved_even_if_it_points_to_the_managed_content() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let (agent, dir) = fixture.agent("First");
    let installed = fixture
        .library
        .commit_import(
            vec![fixture.member("outline")],
            CategoryTarget::Uncategorized,
        )
        .unwrap();
    let id = installed.added[0];
    let target = fixture.library.managed_path(id).unwrap();
    let link = dir.join("outline");
    symlink(&target, &link).unwrap();
    assert!(fixture.library.set_agent_skill(agent, id, true).is_err());
    assert_eq!(fs::read_link(&link).unwrap(), target);
    assert!(fixture.library.snapshot().unwrap().assignments.is_empty());

    fs::remove_file(&link).unwrap();
    fixture.library.set_agent_skill(agent, id, true).unwrap();
    // An independent user replaces the app's exact pathname, retaining its target.
    fs::rename(&link, dir.join("archived")).unwrap();
    symlink(&target, &link).unwrap();
    fixture.library.set_agent_skill(agent, id, false).unwrap();
    assert_eq!(fs::read_link(&link).unwrap(), target);
    assert_eq!(fs::read_link(dir.join("archived")).unwrap(), target);
}

#[test]
fn an_interrupted_install_recovers_a_complete_library() {
    use std::{
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    // Re-enter this test in a subprocess so interruption leaves the real on-disk transaction.
    const CHILD_ROOT: &str = "SKILL_LIBRARY_RECOVERY_TEST_ROOT";
    const TOTAL: usize = 40;
    let member_names: Vec<_> = (0..TOTAL).map(|i| format!("recovery-{i:02}")).collect();
    if let Some(root) = std::env::var_os(CHILD_ROOT).map(PathBuf::from) {
        let library = Library::open(&root).unwrap();
        let agent = library.snapshot().unwrap().agents[0].id;
        let sources = member_names
            .iter()
            .map(|name| root.parent().unwrap().join(name))
            .collect();
        let preview = library.preview_folders(sources).unwrap();
        let selection = preview
            .members
            .into_iter()
            .map(|member| ImportSelection {
                path: member.path,
                fingerprint: member.fingerprint,
                source: None,
            })
            .collect();
        library
            .commit_import_with_agents(selection, CategoryTarget::Uncategorized, vec![agent])
            .unwrap();
        return;
    }

    let fixture = Fixture::new();
    let (_, dir) = fixture.agent("Recovery");
    for name in &member_names {
        fixture.member(name);
    }
    let Fixture {
        library,
        root,
        workspace,
    } = fixture;
    drop(library);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "an_interrupted_install_recovers_a_complete_library",
        ])
        .env(CHILD_ROOT, &root)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let first = dir.join(&member_names[0]);
    while first.symlink_metadata().is_err() && Instant::now() < deadline {
        assert!(
            child.try_wait().unwrap().is_none(),
            "child stopped before linking a Skill"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let had_started = first.symlink_metadata().is_ok();
    let _ = child.kill();
    child.wait().unwrap();
    assert!(had_started);

    let reopened = Library::open(root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    match snapshot.skills.len() {
        0 => assert_eq!(fs::read_dir(&dir).unwrap().count(), 0),
        TOTAL => assert!(member_names
            .iter()
            .all(|name| dir.join(name).join("SKILL.md").is_file())),
        partial => panic!("Interrupted transaction registered {partial} of {TOTAL} Skills"),
    }
    drop(workspace);
}

#[test]
fn previewing_a_home_relative_directory_leaves_it_missing_until_confirmed() {
    let fixture = Fixture::new();
    let home = fixture.workspace.path().canonicalize().unwrap();
    let preview = fixture
        .library
        .preview_agent_directory("~/Tools/writer/skills".as_ref(), &home, None)
        .unwrap();
    let directory = home.join("Tools/writer/skills");
    assert_eq!(preview.directory, directory);
    assert!(!preview.exists);
    assert!(!home.join("Tools").exists());

    let draft = AgentDraft {
        kind: AgentKind::Custom,
        name: "Writer".into(),
        directory: preview.directory,
    };
    assert!(fixture.library.add_agent(draft.clone()).is_err());
    assert!(!home.join("Tools").exists());
    let saved = fixture
        .library
        .add_agent_with_creation(draft, true)
        .unwrap();
    assert_eq!(saved.agents[0].directory, directory);
    fixture
        .library
        .commit_import_with_agents(
            vec![fixture.member("outline")],
            CategoryTarget::Uncategorized,
            vec![saved.agents[0].id],
        )
        .unwrap();
    assert!(directory.join("outline/SKILL.md").is_file());
}

#[test]
fn directory_validation_names_the_owner_of_aliases_and_overlapping_paths() {
    let fixture = Fixture::new();
    let home = fixture.workspace.path();
    let owned = home.join("tools").join("skills");
    fs::create_dir_all(&owned).unwrap();
    let owner = fixture
        .library
        .add_agent(AgentDraft {
            kind: AgentKind::Custom,
            name: "My Editor".into(),
            directory: owned.clone(),
        })
        .unwrap()
        .agents[0]
        .id;
    let alias = home.join("alias");
    std::os::unix::fs::symlink(&owned, &alias).unwrap();
    for path in [&alias, &alias.join("child"), owned.parent().unwrap()] {
        let error = fixture
            .library
            .preview_agent_directory(path, home, None)
            .unwrap_err();
        assert!(error.to_string().contains("My Editor"), "{error}");
    }
    let child = alias.join("child");
    let error = fixture
        .library
        .add_agent_with_creation(
            AgentDraft {
                kind: AgentKind::Custom,
                name: "Other".into(),
                directory: child.clone(),
            },
            true,
        )
        .unwrap_err();
    assert!(error.to_string().contains("My Editor"));
    assert!(!child.exists());
    assert!(
        fixture
            .library
            .preview_agent_directory(&alias, home, Some(owner))
            .unwrap()
            .exists
    );
}

#[test]
fn an_agent_still_owns_its_actual_directory_after_an_external_relocation() {
    let fixture = Fixture::new();
    let (_, owned) = fixture.agent("Editor");
    let moved = fixture.workspace.path().join("relocated");
    fs::rename(&owned, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &owned).unwrap();
    let error = fixture
        .library
        .preview_agent_directory(&moved.join("skills"), fixture.workspace.path(), None)
        .unwrap_err();
    assert!(error.to_string().contains("Editor"), "{error}");
}

#[cfg(unix)]
#[test]
fn an_unwritable_folder_explains_the_path_and_can_be_retried_after_correction() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let home = fixture.workspace.path();
    let parent = home.join("read-only");
    let (_, owned) = fixture.agent("Read-only Editor");
    fs::create_dir(&parent).unwrap();
    fs::set_permissions(&owned, fs::Permissions::from_mode(0o555)).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
    // Privileged test processes can write even when the permission bits are read-only.
    if tempfile::tempfile_in(&parent).is_err() {
        for path in [&parent, &parent.join("skills")] {
            let error = fixture
                .library
                .preview_agent_directory(path, home, None)
                .unwrap_err();
            assert!(
                error.to_string().contains(path.to_str().unwrap()),
                "{error}"
            );
            assert!(error.to_string().contains("写"), "{error}");
        }
    }
    let overlap = fixture
        .library
        .preview_agent_directory(&owned.join("nested"), home, None)
        .unwrap_err();
    assert!(
        overlap.to_string().contains("「Read-only Editor」"),
        "{overlap}"
    );
    fs::set_permissions(&owned, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        fixture
            .library
            .preview_agent_directory(&parent, home, None)
            .unwrap()
            .exists
    );
}

#[test]
fn changing_to_a_confirmed_missing_directory_keeps_assignments_after_restart() {
    let fixture = Fixture::new();
    let (id, old) = fixture.agent("Writer");
    fixture
        .library
        .commit_import_with_agents(
            vec![fixture.member("outline")],
            CategoryTarget::Uncategorized,
            vec![id],
        )
        .unwrap();
    let new = fixture
        .workspace
        .path()
        .canonicalize()
        .unwrap()
        .join("new/skills");
    assert!(fixture
        .library
        .change_agent_directory(id, new.clone())
        .is_err());
    assert!(!new.exists());
    fixture
        .library
        .change_agent_directory_with_creation(id, new.clone(), true)
        .unwrap();
    drop(fixture.library);
    let loaded = Library::open(&fixture.root).unwrap().snapshot().unwrap();
    assert_eq!(loaded.agents[0].directory, new);
    assert_eq!(
        loaded.assignments[0].path.as_ref(),
        Some(&new.join("outline"))
    );
    assert!(fs::read_to_string(new.join("outline/SKILL.md"))
        .unwrap()
        .contains("Synthetic outline"));
    assert!(!old.join("outline").exists());
}

#[test]
fn a_directory_edit_for_an_agent_that_no_longer_exists_creates_nothing() {
    let fixture = Fixture::new();
    let directory = fixture.workspace.path().join("new/skills");
    assert!(fixture
        .library
        .change_agent_directory_with_creation(Uuid::new_v4(), directory.clone(), true)
        .is_err());
    assert!(!directory.exists());
}

#[test]
fn agent_directory_override_is_atomic_and_keeps_existing_links_on_conflict() {
    let fixture = Fixture::new();
    let (agent, original) = fixture.agent("Agent");
    let replacement = fixture.workspace.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    let installed = fixture
        .library
        .commit_import_with_agents(
            vec![fixture.member("outline")],
            CategoryTarget::Uncategorized,
            vec![agent],
        )
        .unwrap();
    let managed = fixture.library.managed_path(installed.added[0]).unwrap();
    let obstruction = replacement.join("outline");
    fs::write(&obstruction, "unmanaged").unwrap();
    let error = fixture
        .library
        .change_agent_directory(agent, replacement.clone())
        .unwrap_err();
    assert!(error.to_string().contains("outline"));
    assert_eq!(fs::read_to_string(&obstruction).unwrap(), "unmanaged");
    assert_eq!(fs::read_link(original.join("outline")).unwrap(), managed);
    fs::remove_file(&obstruction).unwrap();
    let snapshot = fixture
        .library
        .change_agent_directory(agent, replacement)
        .unwrap();
    assert_eq!(
        snapshot.assignments[0].path.as_ref(),
        Some(&snapshot.agents[0].directory.join("outline"))
    );
    assert_eq!(fs::read_link(obstruction).unwrap(), managed);
    assert!(!original.join("outline").exists());
}

#[test]
fn reopening_a_base_library_preserves_existing_members_without_agent_fields() {
    let workspace = TempDir::new().unwrap();
    let category = Uuid::new_v4();
    let id = Uuid::new_v4();
    let batch = Uuid::new_v4();
    let root = workspace.path().join("library");
    let managed = root
        .join("skills")
        .join(batch.to_string())
        .join(id.to_string());
    fs::create_dir_all(&managed).unwrap();
    fs::write(managed.join("SKILL.md"), "original content").unwrap();
    let base = serde_json::json!({
        "version": 1,
        "categories": [{ "id": category, "name": "Drafts" }],
        "skills": [{
            "id": id,
            "batch": batch,
            "name": "Outline",
            "description": "Preserved from the base library",
            "folderName": "outline",
            "fingerprint": "synthetic-original",
            "categoryId": category,
            "source": null
        }]
    });
    fs::write(
        root.join("library.json"),
        serde_json::to_vec(&base).unwrap(),
    )
    .unwrap();
    let reopened = Library::open(root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.skills[0].id, id);
    assert_eq!(snapshot.skills[0].category_id, Some(category));
    assert!(snapshot.agents.is_empty());
    assert!(snapshot.last_install_agents.is_empty());
    assert_eq!(
        fs::read_to_string(reopened.managed_path(id).unwrap().join("SKILL.md")).unwrap(),
        "original content"
    );
}

#[test]
fn enabling_a_missing_managed_member_does_not_leave_a_dangling_link() {
    let fixture = Fixture::new();
    let (agent, dir) = fixture.agent("Writing");
    let installed = fixture
        .library
        .commit_import(
            vec![fixture.member("outline")],
            CategoryTarget::Uncategorized,
        )
        .unwrap();
    let id = installed.added[0];
    let path = fixture.library.managed_path(id).unwrap();
    fs::remove_file(path.join("SKILL.md")).unwrap();
    assert!(fixture.library.set_agent_skill(agent, id, true).is_err());
    assert!(dir.join("outline").symlink_metadata().is_err());
    assert!(fixture.library.snapshot().unwrap().assignments.is_empty());
}

#[test]
fn sync_impact_and_enabled_state_follow_real_links_and_individual_enable_repairs_missing_links() {
    let fixture = Fixture::new();
    let (agent, dir) = fixture.agent("Assignments");
    let library = &fixture.library;
    let direct = library
        .commit_import_with_agents(
            vec![
                fixture.member("present"),
                fixture.member("missing"),
                fixture.member("replaced"),
            ],
            CategoryTarget::Uncategorized,
            vec![agent],
        )
        .unwrap()
        .added;
    library
        .commit_import(
            vec![fixture.member("inherited")],
            CategoryTarget::Uncategorized,
        )
        .unwrap();
    fs::remove_file(dir.join("missing")).unwrap();
    fs::remove_file(dir.join("replaced")).unwrap();
    fs::write(dir.join("replaced"), "foreign entry").unwrap();

    assert_eq!(library.snapshot().unwrap().assignments.len(), 1);
    let enabled = library.set_category_sync(agent, None, true).unwrap();
    assert_eq!(enabled.impact.enabled, 1);
    assert_eq!(enabled.impact.retained_direct, 1);
    assert_eq!(enabled.library.assignments.len(), 2);
    fs::remove_file(dir.join("inherited")).unwrap();
    let undone = library.undo_category_sync(enabled.undo.unwrap()).unwrap();
    assert_eq!(undone.impact.disabled, 0);
    assert_eq!(undone.impact.retained_direct, 1);
    assert_eq!(undone.library.assignments.len(), 1);
    assert!(library.set_agent_skill(agent, direct[2], true).is_err());
    let repaired = library.set_agent_skill(agent, direct[1], true).unwrap();
    assert_eq!(repaired.assignments.len(), 2);
    assert!(dir.join("missing/SKILL.md").is_file());
    assert_eq!(
        fs::read_to_string(dir.join("replaced")).unwrap(),
        "foreign entry"
    );
}

#[test]
fn presets_offer_the_pinned_user_level_directories() {
    let home = TempDir::new().unwrap();
    let presets = skill_library::agent_presets(home.path());
    assert_eq!(presets.len(), 57);
    let directory = |name| &presets.iter().find(|p| p.name == name).unwrap().directory;
    for (name, relative) in [
        ("Claude Code", ".claude/skills"),
        ("Cursor", ".cursor/skills"),
        ("GitHub Copilot", ".copilot/skills"),
        ("Antigravity", ".gemini/config/skills"),
        ("OpenCode", ".config/opencode/skills"),
        ("Gemini CLI", ".gemini/skills"),
        ("OMP Agent", ".omp/agent/skills"),
        ("WorkBuddy AI", ".workbuddy-ai/skills"),
        ("Shared Skills", ".agents/skills"),
        ("Cline", ".agents/skills"),
        ("Warp", ".agents/skills"),
        ("MiniMax Code", ".minimax/skills"),
    ] {
        assert_eq!(directory(name), &home.path().join(relative));
    }
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.path().join(".codex"));
    assert_eq!(directory("Codex"), &codex.join("skills"));
    assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn moving_managed_content_preserves_relative_paths_edits_links_and_local_backup_destination() {
    let fixture = Fixture::new();
    let root = fixture.root.canonicalize().unwrap();
    let base = fixture.workspace.path().canonicalize().unwrap();
    let (agent, directory) = fixture.agent("Reader");
    let skill = fixture
        .library
        .commit_import_with_agents(
            vec![fixture.member("outline")],
            CategoryTarget::Uncategorized,
            vec![agent],
        )
        .unwrap()
        .added[0];
    let old = fixture.library.managed_path(skill).unwrap();
    let relative = old.strip_prefix(root.join("skills")).unwrap();
    fs::write(old.join("notes.txt"), "local edit").unwrap();
    let backup = base.join("backup.json");
    fixture.library.export_backup(&backup).unwrap();
    drop(fixture.library);
    let default = base.join(".skill-library/skills");
    let library = Library::open_with_default(&root, &default).unwrap();
    assert_eq!(library.snapshot().unwrap().managed_directory, default);
    assert!(!old.exists());
    let link = directory.join("outline");
    assert_eq!(fs::read_link(&link).unwrap(), default.join(relative));
    assert_eq!(
        fs::read_to_string(link.join("notes.txt")).unwrap(),
        "local edit"
    );

    assert!(library.change_managed_directory(&directory).is_err());
    assert!(library
        .change_managed_directory(&default.join("nested"))
        .is_err());
    let custom = base.join("my-skills");
    fs::create_dir(&custom).unwrap();
    fs::write(custom.join("personal.txt"), "keep").unwrap();
    assert!(library.change_managed_directory(&custom).is_err());
    assert_eq!(
        fs::read_to_string(custom.join("personal.txt")).unwrap(),
        "keep"
    );
    fs::remove_file(custom.join("personal.txt")).unwrap();
    fs::remove_file(&link).unwrap();
    fs::write(&link, "occupied").unwrap();
    assert!(library.change_managed_directory(&custom).is_err());
    assert_eq!(library.managed_path(skill).unwrap(), default.join(relative));
    assert!(!custom.join(relative).exists());
    assert_eq!(fs::read_to_string(&link).unwrap(), "occupied");
    fs::remove_file(&link).unwrap();
    library.change_managed_directory(&custom).unwrap();
    assert_eq!(fs::read_link(&link).unwrap(), custom.join(relative));
    assert!(!default.join(relative).exists());
    assert!(library
        .preview_folders(vec![custom.join(relative)])
        .unwrap()
        .members
        .is_empty());
    drop(library);
    let library = Library::open_with_default(&root, &default).unwrap();
    assert_eq!(library.snapshot().unwrap().managed_directory, custom);
    let defaults = library.preview_defaults().unwrap();
    library.restore_defaults(&defaults).unwrap();
    assert_eq!(library.snapshot().unwrap().managed_directory, custom);
    let preview = library.preview_backup(&backup).unwrap();
    library.restore_backup(&backup, &preview).unwrap();
    assert!(library.managed_path(skill).unwrap().starts_with(&custom));
    assert_eq!(
        fs::read_to_string(link.join("notes.txt")).unwrap(),
        "local edit"
    );
}

#[test]
fn shared_skills_links_selected_members_and_preserves_external_links() {
    let fixture = Fixture::new();
    let home = fixture.workspace.path().join("home");
    let preset = skill_library::agent_presets(&home)
        .into_iter()
        .find(|p| p.kind == AgentKind::SharedSkills)
        .unwrap();
    let directory = preset.directory;
    fs::create_dir_all(&directory).unwrap();
    let external = fixture.member("external");
    let external_link = directory.join("external");
    std::os::unix::fs::symlink(&external.path, &external_link).unwrap();
    let target = fixture
        .library
        .add_agent(AgentDraft {
            kind: preset.kind,
            name: preset.name.to_owned(),
            directory: directory.clone(),
        })
        .unwrap()
        .agents[0]
        .id;
    let ids = fixture
        .library
        .commit_import(
            vec![external.clone(), fixture.member("writer")],
            CategoryTarget::Uncategorized,
        )
        .unwrap()
        .added;
    assert!(fixture
        .library
        .set_agent_skill(target, ids[0], true)
        .is_err());
    let link = directory.join("writer");
    assert!(!link.exists());
    fixture
        .library
        .set_agent_skill(target, ids[1], true)
        .unwrap();
    assert_eq!(
        fs::read_link(&link).unwrap(),
        fixture.library.managed_path(ids[1]).unwrap()
    );
    drop(fixture.library);
    let reopened = Library::open(&fixture.root).unwrap();
    assert_eq!(
        reopened.snapshot().unwrap().agents[0].kind,
        AgentKind::SharedSkills
    );
    reopened.set_agent_skill(target, ids[1], false).unwrap();
    assert!(!link.is_symlink());
    assert_eq!(fs::read_link(external_link).unwrap(), external.path);
}

#[test]
fn reorders_agents_durably_and_preserves_assignments_syncs_and_backups() {
    let fixture = Fixture::new();
    let (first, first_dir) = fixture.agent("First");
    let (second, second_dir) = fixture.agent("Second");
    let (third, _third_dir) = fixture.agent("Third");

    let category = fixture
        .library
        .create_category("Writing".into())
        .unwrap()
        .categories[0]
        .id;
    let added = fixture
        .library
        .commit_import(
            vec![fixture.member("outline"), fixture.member("notes")],
            CategoryTarget::Existing { id: category },
        )
        .unwrap()
        .added;
    let outline = added[0];
    let notes = added[1];

    fixture.library.set_agent_skill(first, outline, true).unwrap();
    fixture
        .library
        .set_category_sync(second, category, true)
        .unwrap();
    fixture
        .library
        .set_agent_skill(second, notes, false)
        .unwrap();

    // Invalid permutations are rejected without changing existing order
    assert!(fixture.library.reorder_agents(vec![first, second]).is_err());
    assert!(fixture
        .library
        .reorder_agents(vec![first, first, third])
        .is_err());
    assert!(fixture
        .library
        .reorder_agents(vec![first, second, Uuid::new_v4()])
        .is_err());
    assert_eq!(
        fixture
            .library
            .snapshot()
            .unwrap()
            .agents
            .iter()
            .map(|a| a.id)
            .collect::<Vec<_>>(),
        vec![first, second, third]
    );

    // Same order is a clean no-op
    let noop = fixture
        .library
        .reorder_agents(vec![first, second, third])
        .unwrap();
    assert_eq!(
        noop.agents.iter().map(|a| a.id).collect::<Vec<_>>(),
        vec![first, second, third]
    );

    // Reorder preserves StoredAgent state, symlinks, and persists across reopen & backup
    let reordered = fixture
        .library
        .reorder_agents(vec![third, first, second])
        .unwrap();
    assert_eq!(
        reordered
            .agents
            .iter()
            .map(|a| a.id)
            .collect::<Vec<_>>(),
        vec![third, first, second]
    );
    assert!(first_dir.join("outline/SKILL.md").is_file());
    assert!(second_dir.join("outline/SKILL.md").is_file());
    assert!(!second_dir.join("notes").exists());
    let second_notes = reordered
        .assignments
        .iter()
        .find(|a| a.agent_id == second && a.skill_id == notes)
        .unwrap();
    assert!(second_notes.excluded);

    let backup = fixture.workspace.path().join("agents-backup.json");
    fixture.library.export_backup(&backup).unwrap();
    drop(fixture.library);

    let reopened = Library::open(&fixture.root).unwrap();
    let reopened_snap = reopened.snapshot().unwrap();
    assert_eq!(
        reopened_snap
            .agents
            .iter()
            .map(|a| a.id)
            .collect::<Vec<_>>(),
        vec![third, first, second]
    );
    assert!(reopened_snap
        .agents
        .iter()
        .find(|a| a.id == second)
        .unwrap()
        .synced_categories
        .contains(&category));
    let reset = reopened.preview_defaults().unwrap();
    reopened.restore_defaults(&reset).unwrap();
    drop(reopened);

    let restored_root = fixture.workspace.path().join("restored");
    let restored = Library::open(&restored_root).unwrap();
    let preview = restored.preview_backup(&backup).unwrap();
    let outcome = restored.restore_backup(&backup, &preview).unwrap();
    assert_eq!(
        outcome
            .library
            .agents
            .iter()
            .map(|a| a.id)
            .collect::<Vec<_>>(),
        vec![third, first, second]
    );
}

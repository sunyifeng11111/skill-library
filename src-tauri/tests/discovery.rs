use skill_library::Library;
use std::{fs, path::Path};

fn skill(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::write(
        path.join("SKILL.md"),
        "---\nname: Example\ndescription: Test skill\n---\n",
    )
    .unwrap();
}

#[test]
fn collection_lists_only_direct_installations_once() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let collection = temp.path().join("collection");
    skill(&collection.join("one"));
    skill(&collection.join("nested/two"));
    let rows = library
        .scan_existing_skills(&[], &[collection.clone(), collection], None)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Example");
    assert_eq!(rows[0].description.as_deref(), Some("Test skill"));
}

#[cfg(unix)]
#[test]
fn inventory_reports_sources_and_status_without_changing_the_tree() {
    use skill_library::{AgentDraft, AgentKind, AgentPreset, CategoryTarget, ImportSelection};
    use std::{collections::BTreeMap, os::unix::fs::symlink, path::PathBuf};
    fn observe(root: &Path, tree: &mut BTreeMap<PathBuf, (String, Vec<u8>)>) {
        for child in fs::read_dir(root).unwrap() {
            let path = child.unwrap().path();
            let value = if path.is_symlink() {
                (
                    "link".into(),
                    fs::read_link(&path)
                        .unwrap()
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec(),
                )
            } else if path.is_dir() {
                observe(&path, tree);
                ("directory".into(), vec![])
            } else {
                ("file".into(), fs::read(&path).unwrap())
            };
            tree.insert(path, value);
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let library = Library::open(root.join("library")).unwrap();
    let agent = root.join("agent");
    skill(&agent.join("one"));
    let id = library
        .add_agent(AgentDraft {
            kind: AgentKind::Custom,
            name: "My Agent".into(),
            directory: agent.clone(),
        })
        .unwrap()
        .agents[0]
        .id;
    let preset = AgentPreset {
        kind: AgentKind::Cursor,
        name: "Cursor",
        directory: root.join("preset"),
    };
    skill(&preset.directory.join("one"));
    let external = root.join("external");
    skill(&external);
    symlink("../external", agent.join("alias")).unwrap();
    fs::create_dir(agent.join("bad")).unwrap();
    fs::write(agent.join("bad/SKILL.md"), "invalid").unwrap();
    let preview = library.preview_folders(vec![external.clone()]).unwrap();
    let member = &preview.members[0];
    library
        .commit_import_with_agents(
            vec![ImportSelection {
                path: member.path.clone(),
                fingerprint: member.fingerprint.clone(),
                source: None,
            }],
            CategoryTarget::Uncategorized,
            vec![id],
        )
        .unwrap();
    symlink(
        fs::read_link(agent.join("external")).unwrap(),
        agent.join("unowned"),
    )
    .unwrap();
    let mut before = BTreeMap::new();
    observe(root, &mut before);
    let rows = library
        .scan_existing_skills(&[preset], &[agent.clone()], None)
        .unwrap();
    assert_eq!(rows.len(), 6);
    let statuses: Vec<_> = rows
        .iter()
        .filter(|r| r.source_name == "My Agent")
        .map(|r| r.status)
        .collect();
    use skill_library::DiscoveryStatus::*;
    assert_eq!(
        statuses,
        [ExternalLink, Invalid, ManagedLink, Directory, ExternalLink]
    );
    let alias = rows.iter().find(|r| r.status == ExternalLink).unwrap();
    assert_eq!(
        alias.target.as_ref().unwrap(),
        &external.canonicalize().unwrap()
    );
    assert!(rows
        .iter()
        .any(|r| r.status == Invalid && r.reason.as_ref().is_some_and(|s| !s.is_empty())));
    assert!(rows.iter().any(|r| r.source_name == "Cursor"));
    assert_eq!(
        library
            .scan_existing_skills(&[], &[], Some(id))
            .unwrap()
            .len(),
        5
    );
    let mut after = BTreeMap::new();
    observe(root, &mut after);
    assert_eq!(before, after);
}

#[test]
fn confirm_selected_preset_after_preview() {
    use skill_library::{AgentKind, AgentPreset};
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let root = temp.path().canonicalize().unwrap().join("cursor");
    skill(&root.join("one"));
    let presets = [AgentPreset {
        kind: AgentKind::Cursor,
        name: "Cursor",
        directory: root.clone(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    let results = library.adopt_existing_skills(&presets, rows);
    assert!(results[0].error.is_none(), "{:?}", results[0].error);
    assert!(root.join("one").is_symlink());
    assert!(root.join("one/SKILL.md").is_file());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    let backups = library.list_original_backups().unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].item_count, 1);
    assert_eq!(backups[0].item_names, ["Example"]);
    let inventory = library.scan_existing_skills(&presets, &[], None).unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(
        inventory[0].status,
        skill_library::DiscoveryStatus::ManagedLink
    );
    assert_eq!(library.snapshot().unwrap().agents.len(), 1);
}

#[test]
fn stale_location_fails_independently_and_completed_locations_can_be_retried() {
    use skill_library::{AgentKind, AgentPreset};
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let root = temp.path().canonicalize().unwrap().join("preset");
    let collection = temp.path().join("collection");
    skill(&root.join("a"));
    skill(&root.join("b"));
    skill(&collection.join("copy"));
    let presets = [AgentPreset {
        kind: AgentKind::Cursor,
        name: "Cursor",
        directory: root.clone(),
    }];
    let rows = library
        .scan_existing_skills(&presets, &[collection.clone()], None)
        .unwrap();
    fs::write(root.join("a/extra"), "changed").unwrap();
    for result in library.adopt_existing_skills(&presets, rows.clone()) {
        assert_eq!(result.error.is_some(), result.path == root.join("a"));
    }
    assert!(!root.join("a").is_symlink());
    assert!(root.join("b").is_symlink());
    assert!(!collection.join("copy").is_symlink());
    let count = library.snapshot().unwrap().skills.len();
    for result in library.adopt_existing_skills(&presets, rows) {
        assert_eq!(result.skipped, result.path != root.join("a"));
    }
    assert_eq!(library.snapshot().unwrap().skills.len(), count);
}

#[test]
fn publication_failure_restores_original_and_allows_retry() {
    use skill_library::{AgentKind, AgentPreset};
    let temp = tempfile::tempdir().unwrap();
    let storage = temp.path().join("library");
    let library = Library::open(&storage).unwrap();
    let root = temp.path().canonicalize().unwrap().join("preset");
    let path = root.join("one");
    skill(&path);
    fs::write(path.join("payload"), [0, 255, 3]).unwrap();
    let presets = [AgentPreset {
        kind: AgentKind::Cursor,
        name: "Cursor",
        directory: root.clone(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    fs::create_dir(storage.join("library.json")).unwrap();
    assert!(library.adopt_existing_skills(&presets, rows.clone())[0]
        .error
        .is_some());
    assert!(!path.is_symlink());
    assert_eq!(fs::read(path.join("payload")).unwrap(), [0, 255, 3]);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir(storage.join("library.json")).unwrap();
    drop(library);
    let library = Library::open(&storage).unwrap();
    assert!(library.snapshot().unwrap().agents.is_empty());
    assert!(library.adopt_existing_skills(&presets, rows)[0]
        .error
        .is_none());
}

#[test]
fn same_name_versions_remain_independently_readable() {
    use skill_library::{AgentDraft, AgentKind};
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let mut paths = Vec::new();
    for name in ["one", "two"] {
        let directory = temp.path().canonicalize().unwrap().join(name);
        let location = directory.join("example");
        skill(&location);
        fs::write(location.join("payload"), name).unwrap();
        library
            .add_agent(AgentDraft {
                kind: AgentKind::Custom,
                name: name.into(),
                directory,
            })
            .unwrap();
        paths.push(location);
    }
    let mut rows = library
        .scan_existing_skills(&[], &[], None)
        .unwrap()
        .into_iter();
    for index in 0..2 {
        assert!(!paths[index].is_symlink());
        assert!(
            library.adopt_existing_skills(&[], vec![rows.next().unwrap()])[0]
                .error
                .is_none()
        );
    }
    assert_ne!(
        paths[0].canonicalize().unwrap(),
        paths[1].canonicalize().unwrap()
    );
    assert_eq!(fs::read(paths[0].join("payload")).unwrap(), b"one");
    assert_eq!(fs::read(paths[1].join("payload")).unwrap(), b"two");
}

#[test]
fn project_install_record_follows_only_the_canonical_install_into_the_library() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let canonical = temp.path().join(".agents/skills");
    let unrelated = temp.path().join("elsewhere");
    for root in [&canonical, &unrelated] {
        skill(&root.join("example"));
    }
    fs::write(temp.path().join("skills-lock.json"), r#"{"version":1,"skills":{"Example":{"sourceType":"github","source":"sample/tools","skillPath":"packages/author/SKILL.md"}}}"#).unwrap();
    let rows = library
        .scan_existing_skills(&[], &[canonical, unrelated], None)
        .unwrap();
    let json = serde_json::to_value(&rows).unwrap();
    assert_eq!(json[0]["source"]["memberPath"], "packages/author");
    assert!(json[1]["source"].is_null());
    assert!(library.adopt_existing_skills(&[], vec![rows[0].clone()])[0]
        .error
        .is_none());
    let snapshot = library.snapshot().unwrap();
    let source = snapshot.skills[0].source.as_ref().unwrap();
    assert_eq!(source.member_path, "packages/author");
    assert!(source.revision.is_empty());
}

#[test]
fn tracked_checkout_member_retains_origin_and_dirty_working_files() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let folder = repo.join("skills/example");
    skill(&folder);
    for args in [
        vec!["init", "-b", "develop"],
        vec![
            "remote",
            "add",
            "origin",
            "https://github.com/sample/tools.git",
        ],
        vec!["add", "skills/example/SKILL.md"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.org",
            "commit",
            "-m",
            "fixture",
        ],
    ] {
        assert!(std::process::Command::new("git")
            .current_dir(&repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    fs::write(folder.join("notes"), "local edit").unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let rows = library
        .scan_existing_skills(&[], &[repo.join("skills")], None)
        .unwrap();
    let source = rows[0].source.as_ref().unwrap();
    assert_eq!(source.member_path, "skills/example");
    assert!(source.revision.is_empty());
    assert!(library.adopt_existing_skills(&[], rows)[0].error.is_none());
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git")
            .current_dir(&repo)
            .args(args)
            .status()
            .unwrap()
            .success())
    };
    git(&[
        "remote",
        "add",
        "upstream",
        "https://github.com/other/project.git",
    ]);
    let scan = || {
        library
            .scan_existing_skills(&[], &[repo.join("skills")], None)
            .unwrap()
            .remove(0)
            .source
    };
    assert!(scan().is_none());
    git(&["config", "branch.develop.remote", "upstream"]);
    git(&["config", "branch.develop.merge", "refs/heads/release"]);
    let tracked = scan().unwrap();
    assert!(tracked.repository.contains("other/project"));
    assert_eq!(tracked.reference.as_deref(), Some("refs/heads/release"));
    git(&["checkout", "--detach"]);
    git(&["remote", "remove", "upstream"]);
    assert!(scan().is_none());
    let member = library.snapshot().unwrap().skills.remove(0);
    assert_eq!(
        fs::read_to_string(library.managed_path(member.id).unwrap().join("notes")).unwrap(),
        "local edit"
    );
}

#[test]
fn global_install_record_is_scoped_to_the_users_canonical_install() {
    const CASE: &str = "SKILL_LIBRARY_TEST_GLOBAL_LOCK_HOME";
    if let Some(home) = std::env::var_os(CASE) {
        let home = Path::new(&home);
        let library = Library::open(home.join("library")).unwrap();
        let rows = library
            .scan_existing_skills(
                &[],
                &[home.join(".agents/skills"), home.join("copies")],
                None,
            )
            .unwrap();
        assert_eq!(rows[0].source.as_ref().unwrap().member_path, ".");
        assert!(rows[1].source.is_none());
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    for root in [".agents/skills", "copies"] {
        skill(&temp.path().join(root).join("example"));
    }
    fs::write(temp.path().join(".agents/.skill-lock.json"), r#"{"version":3,"skills":{"Example":{"source":"sample/tools","sourceType":"github","sourceUrl":"https://github.com/sample/tools.git","skillPath":"SKILL.md","skillFolderHash":"tree-hash"}}}"#).unwrap();
    assert!(std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "global_install_record_is_scoped_to_the_users_canonical_install"
        ])
        .env(CASE, temp.path())
        .env("HOME", temp.path())
        .env_remove("XDG_STATE_HOME")
        .status()
        .unwrap()
        .success());
}

#[test]
fn rescan_distinguishes_imported_and_modified_collection_copy() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let root = temp.path().join("collection");
    skill(&root.join("copy"));
    let scan = || {
        library
            .scan_existing_skills(&[], std::slice::from_ref(&root), None)
            .unwrap()
    };
    assert!(library.adopt_existing_skills(&[], scan())[0]
        .error
        .is_none());
    assert_eq!(
        serde_json::to_value(&scan()[0]).unwrap()["status"],
        "imported"
    );
    fs::write(root.join("copy/edit"), "modified").unwrap();
    assert_eq!(
        serde_json::to_value(&scan()[0]).unwrap()["status"],
        "directory"
    );
}

#[cfg(unix)]
#[test]
fn registry_snapshot_completes_while_scan_waits_for_git() {
    use std::{
        os::unix::fs::PermissionsExt,
        thread,
        time::{Duration, Instant},
    };
    const FIXTURE: &str = "SKILL_LIBRARY_TEST_BLOCKED_GIT";
    if let Some(root) = std::env::var_os(FIXTURE) {
        let root = Path::new(&root);
        let library = Library::open(root.join("library")).unwrap();
        thread::scope(|scope| {
            let scan = scope.spawn(|| {
                library
                    .scan_existing_skills(&[], &[root.join("repo")], None)
                    .unwrap()
            });
            let start = Instant::now();
            while !root.join("entered").exists() {
                assert!(start.elapsed() < Duration::from_secs(10));
                thread::sleep(Duration::from_millis(10));
            }
            library.snapshot().unwrap();
            fs::write(root.join("release"), "").unwrap();
            scan.join().unwrap();
            assert!(!root.join("timed-out").exists());
        });
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    skill(&root.join("repo/one"));
    fs::create_dir(root.join("repo/.git")).unwrap();
    let git = root.join("git");
    fs::write(
        &git,
        r#"#!/bin/sh
cd "$SKILL_LIBRARY_TEST_BLOCKED_GIT" || exit 1
touch entered
i=0
while [ ! -f release ]; do
  if [ "$i" -ge 100 ]; then touch timed-out; break; fi
  sleep 0.05
  i=$((i+1))
done
exit 1
"#,
    )
    .unwrap();
    fs::set_permissions(git, fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::join_paths(
        std::iter::once(root.to_path_buf())
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
    )
    .unwrap();
    assert!(std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "registry_snapshot_completes_while_scan_waits_for_git"
        ])
        .env(FIXTURE, root)
        .env("PATH", path)
        .status()
        .unwrap()
        .success());
}

#[cfg(unix)]
#[test]
fn external_link_selection_copies_target_without_replacing_agent_entry() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path().join("library")).unwrap();
    let directory = temp.path().join("links");
    fs::create_dir(&directory).unwrap();
    let target = temp.path().join("original");
    skill(&target);
    let alias = directory.join("alias");
    symlink(&target, &alias).unwrap();
    let scan = || {
        library
            .scan_existing_skills(&[], std::slice::from_ref(&directory), None)
            .unwrap()
            .remove(0)
    };
    let first = scan();
    let replacement = temp.path().join("replacement");
    skill(&replacement);
    fs::remove_file(&alias).unwrap();
    symlink(&replacement, &alias).unwrap();
    assert!(library.adopt_existing_skills(&[], vec![first])[0]
        .error
        .is_some());
    let selected = scan();
    assert!(!selected.copy_imported);
    let result = library.adopt_existing_skills(&[], vec![selected]);
    assert!(result[0].error.is_none());
    assert_eq!(fs::read_link(&alias).unwrap(), replacement);
    let id = library.snapshot().unwrap().skills[0].id;
    assert_eq!(
        fs::read(library.managed_path(id).unwrap().join("SKILL.md")).unwrap(),
        fs::read(alias.join("SKILL.md")).unwrap()
    );
    assert!(scan().copy_imported);
    fs::write(alias.join("extra"), "local change").unwrap();
    assert!(!scan().copy_imported);
    assert!(!library.managed_path(id).unwrap().join("extra").exists());
}

#[cfg(unix)]
#[test]
fn bulk_collection_preserves_90_locations_and_explicit_management_reuses_30_copies() {
    use skill_library::{AgentDraft, AgentKind, CategoryTarget, ImportSelection};
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let library = Library::open(root.join("library")).unwrap();
    let directories = ["First", "Second", "Third"].map(|name| root.join(name));
    for path in &directories {
        fs::create_dir(path).unwrap();
        let snapshot = library
            .add_agent(AgentDraft {
                kind: AgentKind::Custom,
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                directory: path.clone(),
            })
            .unwrap();
        let agent = snapshot
            .agents
            .iter()
            .find(|agent| &agent.directory == path)
            .unwrap();
        library.set_category_sync(agent.id, None, true).unwrap();
    }
    for i in 0..30 {
        let name = format!("skill-{i}");
        let path = directories[0].join(&name);
        skill(&path);
        fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Test skill\n---\n"),
        )
        .unwrap();
        for directory in &directories[1..] {
            symlink(&path, directory.join(&name)).unwrap();
        }
    }
    let rows = library.scan_existing_skills(&[], &[], None).unwrap();
    assert_eq!(rows.len(), 90);
    let manual = library
        .scan_local_sources(&[], &directories[..1], None, false)
        .unwrap();
    assert_eq!(manual.len(), 30);
    let one = library
        .scan_local_sources(&[], &[directories[1].join("skill-0")], None, false)
        .unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].source_name, "Second");
    let picks = rows
        .iter()
        .map(|row| ImportSelection {
            path: row.target.clone().unwrap_or_else(|| row.path.clone()),
            fingerprint: serde_json::to_value(row).unwrap()["fingerprint"]
                .as_str()
                .unwrap()
                .into(),
            source: row.source.clone(),
        })
        .collect();
    let mut origins = std::collections::BTreeMap::<_, Vec<_>>::new();
    for row in &rows {
        let hash = serde_json::to_value(row).unwrap()["fingerprint"]
            .as_str()
            .unwrap()
            .to_owned();
        origins
            .entry(hash)
            .or_default()
            .push(row.source_name.clone());
    }
    let result = library
        .collect_local_skills(picks, CategoryTarget::Uncategorized, None, origins)
        .unwrap();
    assert_eq!(result.added.len(), 30);
    assert_eq!(result.duplicates, 60);
    assert!(result.library.assignments.iter().all(|a| a.path.is_none()));
    for row in &rows {
        match &row.target {
            Some(original) => assert_eq!(&fs::read_link(&row.path).unwrap(), original),
            None => assert!(!row.path.is_symlink()),
        }
    }
    let results = library.manage_existing_skills(&[], rows.clone());
    for result in &results {
        assert!(result.error.is_none(), "{:?}", result);
    }
    assert_eq!(results.len(), 90);
    let snapshot = library.snapshot().unwrap();
    assert_eq!(snapshot.skills.len(), 30);
    assert_eq!(
        snapshot
            .assignments
            .iter()
            .filter(|a| a.path.is_some())
            .count(),
        90
    );
    for member in snapshot.skills {
        assert_eq!(member.local_origins, ["First", "Second", "Third"]);
        let managed = library.managed_path(member.id).unwrap();
        for directory in &directories {
            assert_eq!(
                directory.join(&member.name).canonicalize().unwrap(),
                managed
            );
        }
    }
    assert!(library
        .manage_existing_skills(&[], rows)
        .iter()
        .all(|r| r.skipped && r.error.is_none()));
}

#[cfg(unix)]
#[test]
fn broken_symlink_is_reported_and_moved_to_trash() {
    use skill_library::{AgentKind, AgentPreset, DiscoveryStatus};
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let trash = root.join("trash");
    let library = Library::open(root.join("library")).unwrap();
    let cursor = root.join("cursor");
    fs::create_dir_all(&cursor).unwrap();
    let broken = cursor.join("old-helper");
    symlink(root.join("does-not-exist"), &broken).unwrap();
    let presets = [AgentPreset {
        kind: AgentKind::Cursor,
        name: "Cursor",
        directory: cursor.clone(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, DiscoveryStatus::Invalid);
    assert!(rows[0].broken_link);

    std::env::set_var("SKILL_LIBRARY_TRASH_DIR", &trash);
    let result = library.trash_broken_link(&broken, &presets);
    std::env::remove_var("SKILL_LIBRARY_TRASH_DIR");
    assert!(result.is_ok(), "{:?}", result);
    assert!(fs::symlink_metadata(&broken).is_err());
    assert!(fs::symlink_metadata(trash.join("old-helper")).is_ok());
}

#[test]
fn unified_batch_supports_keep_both_canonical_diff_restore_and_undo() {
    use skill_library::{
        AgentKind, AgentPreset, DiffLineKind, UnifiedAdoptionRequest, UnifiedConflictDecision,
    };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let library = Library::open(root.join("library")).unwrap();
    let claude = root.join("claude");
    let cursor = root.join("cursor");
    let ready = claude.join("ready-skill");
    fs::create_dir_all(&ready).unwrap();
    fs::write(
        ready.join("SKILL.md"),
        "---\nname: ready-skill\ndescription: Ready\n---\nHello\n",
    )
    .unwrap();

    let v1 = claude.join("pdf-helper");
    let v2 = cursor.join("pdf-helper");
    fs::create_dir_all(&v1).unwrap();
    fs::create_dir_all(&v2).unwrap();
    fs::write(
        v1.join("SKILL.md"),
        "---\nname: pdf-helper\ndescription: PDF\n---\nLine A\nOld line\n",
    )
    .unwrap();
    fs::write(
        v2.join("SKILL.md"),
        "---\nname: pdf-helper\ndescription: PDF\n---\nLine A\nNew line\n",
    )
    .unwrap();

    // 1. Real manifest diff works
    let diff = library.compare_skill_manifests(&v1, &v2).unwrap();
    assert!(!diff.same_manifest);
    assert!(diff
        .lines
        .iter()
        .any(|l| l.kind == DiffLineKind::Removed && l.text == "Old line"));
    assert!(diff
        .lines
        .iter()
        .any(|l| l.kind == DiffLineKind::Added && l.text == "New line"));

    let presets = [
        AgentPreset {
            kind: AgentKind::ClaudeCode,
            name: "Claude Code",
            directory: claude.clone(),
        },
        AgentPreset {
            kind: AgentKind::Cursor,
            name: "Cursor",
            directory: cursor.clone(),
        },
    ];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    let ready_rows: Vec<_> = rows
        .iter()
        .filter(|r| r.name == "ready-skill")
        .cloned()
        .collect();
    let conflict_rows: Vec<_> = rows
        .iter()
        .filter(|r| r.name == "pdf-helper")
        .cloned()
        .collect();
    assert_eq!(ready_rows.len(), 1);
    assert_eq!(conflict_rows.len(), 2);

    // 2. Commit with UseCanonical (Cursor v2 wins) + Ready row
    let outcome = library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: ready_rows.clone(),
                conflicts: vec![UnifiedConflictDecision::UseCanonical {
                    canonical_path: v2.clone(),
                    canonical_skill_id: None,
                    rows: conflict_rows.clone(),
                }],
                copy_only: false,
                summary: None,
            },
        )
        .unwrap();
    assert!(outcome.results.iter().all(|r| r.error.is_none()));
    assert_eq!(outcome.managed_count, 3);
    assert_eq!(outcome.backed_up_count, 3);
    let batch_id = outcome.batch_id.expect("batch_id");
    assert_eq!(outcome.snapshot.skills.len(), 2);
    assert_eq!(outcome.snapshot.original_backup_count, 1);
    // Both tools now resolve to the same canonical Cursor v2 content!
    assert_eq!(
        fs::read_to_string(v1.join("SKILL.md")).unwrap(),
        fs::read_to_string(v2.join("SKILL.md")).unwrap()
    );
    assert!(fs::read_to_string(v1.join("SKILL.md"))
        .unwrap()
        .contains("New line"));

    // 3. Full Undo restores both originals cleanly and removes added skills & agents
    let undone = library.undo_adoption_batch(batch_id).unwrap();
    assert_eq!(undone.skills.len(), 0);
    assert_eq!(undone.agents.len(), 0);
    assert_eq!(undone.original_backup_count, 0);
    assert!(!v1.is_symlink());
    assert!(!v2.is_symlink());
    assert!(fs::read_to_string(v1.join("SKILL.md"))
        .unwrap()
        .contains("Old line"));

    // 4. Commit with default KeepBoth, then Restore original backup (which KEEPS library copies)
    let rows2 = library.scan_existing_skills(&presets, &[], None).unwrap();
    let keep_both = library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: vec![],
                conflicts: vec![UnifiedConflictDecision::KeepBoth {
                    rows: rows2
                        .into_iter()
                        .filter(|r| r.name == "pdf-helper")
                        .collect(),
                }],
                copy_only: false,
                summary: Some("测试双版本保留".into()),
            },
        )
        .unwrap();
    assert_eq!(keep_both.snapshot.skills.len(), 2);
    assert!(fs::read_to_string(v1.join("SKILL.md"))
        .unwrap()
        .contains("Old line"));
    assert!(fs::read_to_string(v2.join("SKILL.md"))
        .unwrap()
        .contains("New line"));
    let backup_id = keep_both.batch_id.unwrap();
    let restored = library.restore_original_backup(backup_id).unwrap();
    // Per user decision #2: library keeps its managed Skill copies, tool directories are restored!
    assert_eq!(restored.skills.len(), 2);
    assert_eq!(restored.original_backup_count, 0);
    assert!(!v1.is_symlink());
    assert!(!v2.is_symlink());
    assert!(restored.assignments.iter().all(|a| a.path.is_none()));
}

#[test]
fn copy_only_mode_does_not_touch_tool_folders_and_supports_undo() {
    use skill_library::{AgentKind, AgentPreset, UnifiedAdoptionRequest};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let library = Library::open(root.join("library")).unwrap();
    let claude = root.join("claude");
    skill(&claude.join("one"));
    let presets = [AgentPreset {
        kind: AgentKind::ClaudeCode,
        name: "Claude Code",
        directory: claude.clone(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    let outcome = library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: rows,
                conflicts: vec![],
                copy_only: true,
                summary: None,
            },
        )
        .unwrap();
    assert_eq!(outcome.imported_count, 1);
    assert_eq!(outcome.managed_count, 0);
    assert_eq!(outcome.backed_up_count, 0);
    assert!(!claude.join("one").is_symlink());
    assert_eq!(outcome.snapshot.skills.len(), 1);
    assert_eq!(outcome.snapshot.agents.len(), 0);
    let batch_id = outcome.batch_id.expect("copy_only undo batch_id");
    let undone = library.undo_adoption_batch(batch_id).unwrap();
    assert_eq!(undone.skills.len(), 0);
    assert!(!claude.join("one").is_symlink());
}

#[cfg(target_vendor = "apple")]
#[test]
fn managed_links_survive_macos_device_id_change_across_reboots() {
    use skill_library::{AgentKind, AgentPreset, DiscoveryStatus};

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let storage = root.join("library");
    let claude = root.join("claude");
    skill(&claude.join("one"));
    let presets = [AgentPreset {
        kind: AgentKind::ClaudeCode,
        name: "Claude Code",
        directory: claude.clone(),
    }];

    {
        let library = Library::open(&storage).unwrap();
        let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
        let results = library.adopt_existing_skills(&presets, rows);
        assert!(results[0].error.is_none(), "{:?}", results[0].error);
    }

    // Simulate macOS APFS assigning a different st_dev after a reboot while inode & birthtime persist.
    let registry_path = storage.join("library.json");
    let mut json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&registry_path).unwrap()).unwrap();
    let owners = json["link_owners"].as_object_mut().unwrap();
    assert_eq!(owners.len(), 1);
    for identity in owners.values_mut() {
        let old_dev = identity["device"].as_u64().unwrap();
        identity["device"] = serde_json::json!(old_dev + 2);
    }
    fs::write(&registry_path, serde_json::to_vec(&json).unwrap()).unwrap();

    let library = Library::open(&storage).unwrap();
    let snapshot = library.snapshot().unwrap();
    assert_eq!(snapshot.assignments.len(), 1);
    assert!(snapshot.assignments[0].path.is_some());

    let scanned = library.scan_existing_skills(&presets, &[], None).unwrap();
    assert_eq!(scanned.len(), 1);
    assert_eq!(scanned[0].status, DiscoveryStatus::ManagedLink);

    // Removing the agent must still recognize ownership and clean up the symlink.
    let agent_id = snapshot.agents[0].id;
    let skill_id = snapshot.skills[0].id;
    library.remove_agent(agent_id, vec![skill_id]).unwrap();
    assert!(fs::symlink_metadata(claude.join("one")).is_err());
}

#[test]
fn unowned_symlink_to_managed_skill_has_matching_fingerprint_and_adopts_without_conflict() {
    use skill_library::{
        AgentKind, AgentPreset, CategoryTarget, DiscoveryStatus, ImportSelection,
        UnifiedAdoptionRequest,
    };
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let library = Library::open(root.join("library")).unwrap();
    let source = root.join("source");
    skill(&source);
    let preview = library.preview_folders(vec![source]).unwrap();
    let imported = library
        .commit_import(
            vec![ImportSelection {
                path: preview.members[0].path.clone(),
                fingerprint: preview.members[0].fingerprint.clone(),
                source: None,
            }],
            CategoryTarget::Uncategorized,
        )
        .unwrap();
    let skill_id = imported.added[0];
    let managed = library.managed_path(skill_id).unwrap();

    let qoder = root.join("qoder");
    fs::create_dir(&qoder).unwrap();
    symlink(&managed, qoder.join("example")).unwrap();

    let presets = [AgentPreset {
        kind: AgentKind::Qoder,
        name: "Qoder",
        directory: qoder.clone(),
    }];
    let rows = library.scan_existing_skills(&presets, &[], None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, DiscoveryStatus::ExternalLink);
    assert!(rows[0].copy_imported);
    assert!(rows[0].reason.is_none());
    let serialized = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(
        serialized["fingerprint"].as_str(),
        Some(preview.members[0].fingerprint.as_str())
    );

    let outcome = library
        .commit_local_batch(
            &presets,
            UnifiedAdoptionRequest {
                ready_rows: rows,
                conflicts: vec![],
                copy_only: false,
                summary: None,
            },
        )
        .unwrap();
    assert!(outcome.results.iter().all(|r| r.error.is_none()), "{:?}", outcome.results);
    assert_eq!(outcome.snapshot.skills.len(), 1);
    assert_eq!(outcome.snapshot.agents.len(), 1);
    assert_eq!(outcome.managed_count, 1);

    let after = library.scan_existing_skills(&presets, &[], None).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].status, DiscoveryStatus::ManagedLink);
}

#[cfg(unix)]
#[test]
fn scan_registered_unmanaged_skills_skips_managed_links_and_unregistered_presets() {
    use skill_library::{
        AgentDraft, AgentKind, CategoryTarget, DiscoveryStatus, ImportSelection,
    };
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let library = Library::open(root.join("library")).unwrap();

    // Seed one managed skill in the library
    let managed_src = root.join("managed-src");
    skill(&managed_src);
    let preview = library.preview_folders(vec![managed_src]).unwrap();
    let imported = library
        .commit_import(
            vec![ImportSelection {
                path: preview.members[0].path.clone(),
                fingerprint: preview.members[0].fingerprint.clone(),
                source: None,
            }],
            CategoryTarget::Uncategorized,
        )
        .unwrap();
    let managed_skill_id = imported.added[0];
    let managed_path = library.managed_path(managed_skill_id).unwrap();

    // Registered agent with:
    // 1. an owned ManagedLink (enabled via library)
    // 2. an unmanaged local Directory
    // 3. an unmanaged ExternalLink pointing to external skill
    // 4. an unowned ExternalLink pointing to managed content
    // 5. an Invalid skill (bad SKILL.md) and a broken symlink
    let registered_dir = root.join("registered-agent");
    fs::create_dir(&registered_dir).unwrap();
    let agent = library
        .add_agent(AgentDraft {
            kind: AgentKind::ClaudeCode,
            name: "Claude Code".into(),
            directory: registered_dir.clone(),
        })
        .unwrap()
        .agents[0]
        .clone();
    library
        .set_agent_skill(agent.id, managed_skill_id, true)
        .unwrap();

    skill(&registered_dir.join("local-only"));
    let external = root.join("external-skill");
    skill(&external);
    symlink(&external, registered_dir.join("ext-alias")).unwrap();
    symlink(&managed_path, registered_dir.join("unowned-managed")).unwrap();
    fs::create_dir(registered_dir.join("bad-skill")).unwrap();
    fs::write(registered_dir.join("bad-skill/SKILL.md"), "not-valid-frontmatter").unwrap();
    symlink(root.join("missing-target"), registered_dir.join("broken-link")).unwrap();

    // All registered agents scan
    let all_rows = library.scan_registered_unmanaged_skills(None).unwrap();
    let names: Vec<_> = all_rows.iter().map(|r| r.path.file_name().unwrap().to_str().unwrap()).collect();
    assert_eq!(names, ["ext-alias", "local-only", "unowned-managed"]);
    assert!(all_rows.iter().all(|r| r.agent_id == Some(agent.id)));
    assert!(all_rows
        .iter()
        .all(|r| matches!(r.status, DiscoveryStatus::Directory | DiscoveryStatus::ExternalLink)));

    // Single agent scan matches the same filtered unmanaged set
    let single_rows = library.scan_registered_unmanaged_skills(Some(agent.id)).unwrap();
    let single_names: Vec<_> = single_rows
        .iter()
        .map(|r| r.path.file_name().unwrap().to_str().unwrap())
        .collect();
    assert_eq!(single_names, names);
}



use skill_library::{CategoryTarget, GitSource, Library, SourceCancellation, SourceRequest};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use uuid::Uuid;

struct Fixture {
    temp: TempDir,
    library: Library,
    source: GitSource,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let source_config = temp.path().join("git-config");
        fs::write(
            &source_config,
            format!(
                "[url \"file://{}/\"]\n    insteadOf = https://fixture.example.invalid/qa/\n",
                temp.path().canonicalize().unwrap().display()
            ),
        )
        .unwrap();
        let library = Library::open(temp.path().join("library")).unwrap();
        Self {
            temp,
            library,
            source: GitSource::with_config(source_config),
        }
    }

    fn repository(&self, name: &str, members: &[&str]) -> Repository {
        let work = self.temp.path().join(name);
        fs::create_dir(&work).unwrap();
        git(&work, &["init", "-b", "main"]);
        for name in members {
            write_member(&work.join("skills").join(name), name, "original");
        }
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "Installable package"]);
        let bare = work.with_extension("git");
        git(&work, &["clone", "--bare", ".", bare.to_str().unwrap()]);
        Repository {
            url: format!("https://fixture.example.invalid/qa/{name}.git"),
            work,
            bare,
        }
    }

    fn install(
        &self,
        repository: &Repository,
        target: CategoryTarget,
        names: &[&str],
    ) -> Vec<Uuid> {
        let cancellation = SourceCancellation::default();
        let downloaded = self
            .source
            .download(
                &SourceRequest::parse(&repository.url).unwrap(),
                &cancellation,
                |_| {},
            )
            .unwrap();
        let proposal = downloaded.propose(&self.library, &cancellation).unwrap();
        let selected = proposal
            .members
            .iter()
            .filter(|member| names.contains(&member.member.name.as_str()))
            .map(|member| member.selection())
            .collect();
        self.library.commit_import(selected, target).unwrap().added
    }
}

struct Repository {
    url: String,
    work: PathBuf,
    bare: PathBuf,
}

impl Repository {
    fn publish(&self) -> String {
        git(&self.work, &["add", "-A"]);
        git(&self.work, &["commit", "-m", "Publish next revision"]);
        git(&self.work, &["push", self.bare.to_str().unwrap(), "main"]);
        git(&self.work, &["rev-parse", "HEAD"])
    }

    fn write_member(&self, name: &str, marker: &str) {
        write_member(&self.work.join("skills").join(name), name, marker);
    }
}

fn write_member(path: &Path, name: &str, marker: &str) {
    fs::create_dir_all(path).unwrap();
    fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: Synthetic {name}\n---\n"),
    )
    .unwrap();
    fs::write(path.join("marker.txt"), marker).unwrap();
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .env("GIT_CONFIG_GLOBAL", root.join("no-user-config"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn checks_origins_once_across_categories_and_reports_independent_check_failures() {
    use skill_library::PackageUpdateStatus;

    let fixture = Fixture::new();
    let pack = fixture.repository("writing", &["outline", "polish"]);
    let current = fixture.repository("current", &["search"]);
    let offline = fixture.repository("offline", &["summarize"]);
    let outline = fixture.install(
        &pack,
        CategoryTarget::New {
            name: "Drafts".into(),
        },
        &["outline"],
    )[0];
    let polish = fixture.install(
        &pack,
        CategoryTarget::New {
            name: "Editing".into(),
        },
        &["polish"],
    )[0];
    fixture.install(&current, CategoryTarget::Uncategorized, &["search"]);
    fixture.install(&offline, CategoryTarget::Uncategorized, &["summarize"]);
    pack.write_member("outline", "next");
    let next = pack.publish();
    let disconnected = offline.bare.with_extension("disconnected");
    fs::rename(&offline.bare, &disconnected).unwrap();

    let cancellation = SourceCancellation::default();
    let checks = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap();
    assert_eq!(checks.len(), 3);
    let writing = checks
        .iter()
        .find(|check| check.package.repository == pack.url)
        .unwrap();
    assert_eq!(writing.member_ids, [outline, polish]);
    assert_eq!(writing.outdated_member_ids, [outline]);
    assert_eq!(writing.status, PackageUpdateStatus::Available);
    assert_eq!(writing.revision.as_deref(), Some(next.as_str()));
    assert!(writing.updated_at.is_some());
    let search = checks
        .iter()
        .find(|check| check.package.repository == current.url)
        .unwrap();
    assert_eq!(search.status, PackageUpdateStatus::Current);
    let failed = checks
        .iter()
        .find(|check| check.package.repository == offline.url)
        .unwrap();
    assert_eq!(failed.status, PackageUpdateStatus::Failed);
    assert!(failed
        .error
        .as_ref()
        .is_some_and(|message| !message.is_empty()));

    fs::rename(disconnected, &offline.bare).unwrap();
    let retried = fixture
        .library
        .check_package_update(&fixture.source, &failed.package, &cancellation)
        .unwrap();
    assert_eq!(retried.status, PackageUpdateStatus::Current);
}

#[test]
fn previews_upstream_additions_without_reoffering_previously_unselected_members() {
    let fixture = Fixture::new();
    let pack = fixture.repository("writing", &["outline", "previously-available"]);
    let id = fixture.install(&pack, CategoryTarget::Uncategorized, &["outline"])[0];
    let managed = fixture.library.managed_path(id).unwrap();
    fs::write(managed.join("marker.txt"), "local changes").unwrap();
    pack.write_member("outline", "next");
    pack.write_member("new-skill", "new upstream member");
    let revision = pack.publish();

    let cancellation = SourceCancellation::default();
    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    let preview = fixture
        .library
        .preview_package_update(&fixture.source, &check.package, &revision, &cancellation)
        .unwrap();
    assert_eq!(preview.outdated.len(), 1);
    assert_eq!(preview.outdated[0].id, id);
    assert!(preview.outdated[0]
        .skip_reason
        .as_deref()
        .unwrap()
        .contains("本地改动"));
    assert_eq!(preview.additions.len(), 1);
    assert_eq!(preview.additions[0].member_path, "skills/new-skill");
    assert_eq!(preview.additions[0].name, "new-skill");
    assert_eq!(
        fs::read_to_string(managed.join("marker.txt")).unwrap(),
        "local changes"
    );
    assert_eq!(fixture.library.snapshot().unwrap().skills.len(), 1);
}

#[test]
fn failed_publication_preserves_old_files_and_revisions_and_retry_adds_only_selected_members() {
    use skill_library::PackageUpdateSelection;

    let fixture = Fixture::new();
    let pack = fixture.repository("writing", &["outline", "polish"]);
    let ids = fixture.install(
        &pack,
        CategoryTarget::New {
            name: "Drafts".into(),
        },
        &["outline", "polish"],
    );
    fixture
        .library
        .move_skills(
            vec![ids[1]],
            CategoryTarget::New {
                name: "Editing".into(),
            },
        )
        .unwrap();
    let before = fixture.library.snapshot().unwrap();
    let paths: Vec<_> = ids
        .iter()
        .map(|id| fixture.library.managed_path(*id).unwrap())
        .collect();
    pack.write_member("outline", "outline v2");
    pack.write_member("polish", "polish v2");
    pack.write_member("chosen", "chosen v2");
    pack.write_member("unselected", "unselected v2");
    let revision = pack.publish();
    let cancellation = SourceCancellation::default();
    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    let selection = PackageUpdateSelection {
        revision: revision.clone(),
        backup_members: vec![],
        additions: vec!["skills/chosen".into()],
        target: Some(CategoryTarget::Existing {
            id: before.categories[1].id,
        }),
        member_ids: vec![],
    };
    let root = fixture.temp.path().join("library");
    let registry = root.join("library.json");
    let saved = root.join("saved-library.json");
    fs::rename(&registry, &saved).unwrap();
    fs::create_dir(&registry).unwrap();

    let error = fixture
        .library
        .apply_package_update(&fixture.source, &check.package, &selection, &cancellation)
        .unwrap_err();
    assert!(error.to_string().contains("无法保存 Skill 库"));
    assert_eq!(fixture.library.snapshot().unwrap().skills.len(), 2);
    for path in &paths {
        assert_eq!(
            fs::read_to_string(path.join("marker.txt")).unwrap(),
            "original"
        );
    }

    fs::remove_dir(&registry).unwrap();
    fs::rename(saved, registry).unwrap();
    drop(fixture.library);
    let reopened = Library::open(root).unwrap();
    for (restored, original) in reopened
        .snapshot()
        .unwrap()
        .skills
        .iter()
        .zip(&before.skills)
    {
        assert_eq!(
            restored.source.as_ref().unwrap().revision,
            original.source.as_ref().unwrap().revision
        );
    }

    let outcome = reopened
        .apply_package_update(&fixture.source, &check.package, &selection, &cancellation)
        .unwrap();
    assert_eq!(outcome.updated, ids);
    assert_eq!(outcome.added.len(), 1);
    for ((path, updated), original) in paths
        .iter()
        .zip(&outcome.library.skills)
        .zip(&before.skills)
    {
        assert_eq!(&reopened.managed_path(updated.id).unwrap(), path);
        assert_eq!(updated.id, original.id);
        assert_eq!(updated.category_id, original.category_id);
        assert_eq!(updated.source.as_ref().unwrap().revision, revision);
        assert_eq!(
            fs::read_to_string(path.join("marker.txt")).unwrap(),
            format!("{} v2", updated.name)
        );
    }
    assert_eq!(outcome.library.skills[2].name, "chosen");
    assert_eq!(
        outcome.library.skills[2].category_id,
        Some(before.categories[1].id)
    );
    let repeated = reopened
        .apply_package_update(&fixture.source, &check.package, &selection, &cancellation)
        .unwrap();
    assert!(repeated.updated.is_empty());
    assert!(repeated.added.is_empty());
    assert_eq!(repeated.library.skills.len(), 3);
}

#[test]
fn batch_skips_modified_members_and_explicit_backup_copies_all_readable_files_before_upgrade() {
    use skill_library::PackageUpdateSelection;

    let fixture = Fixture::new();
    let pack = fixture.repository("writing", &["outline", "polish"]);
    let ids = fixture.install(&pack, CategoryTarget::Uncategorized, &["outline", "polish"]);
    let original = fixture.library.snapshot().unwrap();
    let managed = fixture.library.managed_path(ids[0]).unwrap();
    fs::write(
        managed.join("SKILL.md"),
        "local notes without upstream metadata",
    )
    .unwrap();
    fs::write(managed.join("marker.txt"), "local changes").unwrap();
    fs::create_dir(managed.join("nested")).unwrap();
    fs::write(managed.join("nested/extra.bin"), [0, 1, 2, 255]).unwrap();
    fs::write(managed.join(".personal"), "local hidden file").unwrap();
    pack.write_member("outline", "outline v2");
    pack.write_member("polish", "polish v2");
    let revision = pack.publish();
    let cancellation = SourceCancellation::default();
    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    let mut selection = PackageUpdateSelection {
        revision: revision.clone(),
        backup_members: vec![],
        additions: vec![],
        target: None,
        member_ids: vec![],
    };

    let batch = fixture
        .library
        .apply_package_update(&fixture.source, &check.package, &selection, &cancellation)
        .unwrap();
    assert_eq!(batch.updated, [ids[1]]);
    assert_eq!(batch.skipped[0].id, ids[0]);
    assert!(batch.skipped[0]
        .skip_reason
        .as_ref()
        .unwrap()
        .contains("本地改动"));
    assert_eq!(
        batch.library.skills[0].source.as_ref().unwrap().revision,
        original.skills[0].source.as_ref().unwrap().revision
    );
    assert_eq!(
        fs::read_to_string(managed.join("marker.txt")).unwrap(),
        "local changes"
    );

    let blocker = fixture.temp.path().join("library/backups");
    fs::write(&blocker, "block backup directory").unwrap();
    selection.backup_members.push(ids[0]);
    let failed = fixture
        .library
        .apply_package_update(&fixture.source, &check.package, &selection, &cancellation)
        .unwrap_err();
    assert!(failed.to_string().contains("备份"));
    assert_eq!(
        fs::read(managed.join("nested/extra.bin")).unwrap(),
        [0, 1, 2, 255]
    );
    assert_eq!(
        fixture.library.snapshot().unwrap().skills[0]
            .source
            .as_ref()
            .unwrap()
            .revision,
        original.skills[0].source.as_ref().unwrap().revision
    );

    fs::remove_file(blocker).unwrap();
    let root = fixture.temp.path().join("library");
    drop(fixture.library);
    let reopened = Library::open(root).unwrap();
    let updated = reopened
        .apply_package_update(&fixture.source, &check.package, &selection, &cancellation)
        .unwrap();
    assert_eq!(updated.updated, [ids[0]]);
    assert!(updated.skipped.is_empty());
    let backup_root = updated.backup.unwrap();
    let backup = fs::read_dir(backup_root)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        fs::read_to_string(backup.join("SKILL.md")).unwrap(),
        "local notes without upstream metadata"
    );
    assert_eq!(
        fs::read_to_string(backup.join("marker.txt")).unwrap(),
        "local changes"
    );
    assert_eq!(
        fs::read_to_string(backup.join(".personal")).unwrap(),
        "local hidden file"
    );
    assert_eq!(
        fs::read(backup.join("nested/extra.bin")).unwrap(),
        [0, 1, 2, 255]
    );
    assert_eq!(
        fs::read_to_string(managed.join("marker.txt")).unwrap(),
        "outline v2"
    );
    assert_eq!(
        updated.library.skills[0].source.as_ref().unwrap().revision,
        revision
    );
}

#[test]
fn adds_source_to_local_members_without_claiming_an_uninstalled_revision() {
    use skill_library::{ImportSelection, PackageUpdateStatus};

    let fixture = Fixture::new();
    let pack = fixture.repository("writing", &["outline", "polish"]);
    let local = fixture.temp.path().join("local");
    write_member(&local.join("outline"), "outline", "local draft");
    write_member(&local.join("polish"), "polish", "original");
    let selected = fixture
        .library
        .preview_folders(vec![local.join("outline"), local.join("polish")])
        .unwrap()
        .members
        .into_iter()
        .map(|member| ImportSelection {
            path: member.path,
            fingerprint: member.fingerprint,
            source: None,
        })
        .collect();
    let imported = fixture
        .library
        .commit_import(
            selected,
            CategoryTarget::New {
                name: "Local".into(),
            },
        )
        .unwrap();
    let managed = fixture.library.managed_path(imported.added[0]).unwrap();
    let cancellation = SourceCancellation::default();
    let downloaded = fixture
        .source
        .download(
            &SourceRequest::parse(&pack.url).unwrap(),
            &cancellation,
            |_| {},
        )
        .unwrap();
    assert!(fixture
        .library
        .attach_package_source(imported.added[0], &downloaded, "missing", &cancellation)
        .is_err());
    let attached = fixture
        .library
        .attach_package_source(
            imported.added[0],
            &downloaded,
            "skills/outline",
            &cancellation,
        )
        .unwrap();
    let source = attached.skills[0].source.as_ref().unwrap();
    assert_eq!(source.repository, pack.url);
    assert_eq!(source.member_path, "skills/outline");
    assert!(source.revision.is_empty());
    assert!(fixture
        .library
        .attach_package_source(
            imported.added[1],
            &downloaded,
            "skills/outline",
            &cancellation
        )
        .is_err());
    let attached = fixture
        .library
        .attach_package_source(
            imported.added[1],
            &downloaded,
            "skills/polish",
            &cancellation,
        )
        .unwrap();
    assert_eq!(
        attached.skills[1].source.as_ref().unwrap().revision,
        downloaded.revision()
    );
    assert_eq!(
        attached.skills[0].category_id,
        imported.library.skills[0].category_id
    );
    assert_eq!(
        fixture.library.managed_path(imported.added[0]).unwrap(),
        managed
    );
    assert_eq!(
        fs::read_to_string(managed.join("marker.txt")).unwrap(),
        "local draft"
    );
    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    assert_eq!(check.status, PackageUpdateStatus::Available);
    let preview = fixture
        .library
        .preview_package_update(
            &fixture.source,
            &check.package,
            downloaded.revision(),
            &cancellation,
        )
        .unwrap();
    assert_eq!(preview.outdated.len(), 1);
    assert!(preview.outdated[0]
        .skip_reason
        .as_deref()
        .unwrap()
        .contains("本地改动"));
}

#[cfg(unix)]
#[test]
fn retries_a_download_failure_and_preserves_direct_and_synced_links_for_updates_and_additions() {
    use skill_library::{AgentDraft, AgentKind, PackageUpdateSelection};
    use std::os::unix::fs::MetadataExt;

    let fixture = Fixture::new();
    let pack = fixture.repository("writing", &["outline", "polish"]);
    let independent = fixture.repository("independent", &["research"]);
    let ids = fixture.install(
        &pack,
        CategoryTarget::New {
            name: "Writing".into(),
        },
        &["outline", "polish"],
    );
    let research = fixture.install(&independent, CategoryTarget::Uncategorized, &["research"])[0];
    let category = fixture.library.snapshot().unwrap().categories[0].id;
    let claude = fixture
        .temp
        .path()
        .canonicalize()
        .unwrap()
        .join("claude-fixture");
    let antigravity = fixture
        .temp
        .path()
        .canonicalize()
        .unwrap()
        .join("antigravity-fixture");
    fs::create_dir(&claude).unwrap();
    fs::create_dir(&antigravity).unwrap();
    let first_agent = fixture
        .library
        .add_agent(AgentDraft {
            name: "Claude fixture".into(),
            kind: AgentKind::Custom,
            directory: claude.clone(),
        })
        .unwrap()
        .agents[0]
        .id;
    let second_agent = fixture
        .library
        .add_agent(AgentDraft {
            name: "Antigravity fixture".into(),
            kind: AgentKind::Custom,
            directory: antigravity.clone(),
        })
        .unwrap()
        .agents[1]
        .id;
    fixture
        .library
        .set_agent_skill(first_agent, ids[0], true)
        .unwrap();
    fixture
        .library
        .set_category_sync(second_agent, category, true)
        .unwrap();
    fixture
        .library
        .set_agent_skill(second_agent, ids[1], false)
        .unwrap();
    let original = fixture.library.snapshot().unwrap();
    let outline = fixture.library.managed_path(ids[0]).unwrap();
    let before = fs::symlink_metadata(claude.join("outline")).unwrap().ino();
    let sync_before = fs::symlink_metadata(antigravity.join("outline"))
        .unwrap()
        .ino();
    pack.write_member("outline", "outline v2");
    pack.write_member("polish", "polish v2");
    pack.write_member("chosen", "new member");
    pack.publish();
    independent.write_member("research", "independent v2");
    independent.publish();
    let cancellation = SourceCancellation::default();
    let checks = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap();
    let writing = checks
        .iter()
        .find(|check| check.package.repository == pack.url)
        .unwrap();
    let other = checks
        .iter()
        .find(|check| check.package.repository == independent.url)
        .unwrap();
    let selection = PackageUpdateSelection {
        revision: writing.revision.clone().unwrap(),
        backup_members: vec![],
        additions: vec!["skills/chosen".into()],
        target: Some(CategoryTarget::Existing { id: category }),
        member_ids: vec![],
    };

    let disconnected = pack.bare.with_extension("disconnected");
    fs::rename(&pack.bare, &disconnected).unwrap();
    assert!(fixture
        .library
        .apply_package_update(&fixture.source, &writing.package, &selection, &cancellation)
        .is_err());
    assert_eq!(
        fs::read_to_string(claude.join("outline/marker.txt")).unwrap(),
        "original"
    );
    assert_eq!(
        fs::read_to_string(antigravity.join("outline/marker.txt")).unwrap(),
        "original"
    );
    assert!(!antigravity.join("chosen").exists());
    assert_eq!(
        fixture.library.snapshot().unwrap().skills[0]
            .source
            .as_ref()
            .unwrap()
            .revision,
        original.skills[0].source.as_ref().unwrap().revision
    );

    let other_result = fixture
        .library
        .apply_package_update(
            &fixture.source,
            &other.package,
            &PackageUpdateSelection {
                revision: other.revision.clone().unwrap(),
                backup_members: vec![],
                additions: vec![],
                target: None,
                member_ids: vec![],
            },
            &cancellation,
        )
        .unwrap();
    assert_eq!(other_result.updated, [research]);

    fs::rename(disconnected, &pack.bare).unwrap();
    let outcome = fixture
        .library
        .apply_package_update(&fixture.source, &writing.package, &selection, &cancellation)
        .unwrap();
    assert_eq!(outcome.updated, ids);
    assert_eq!(outcome.added.len(), 1);
    assert_eq!(fs::read_link(claude.join("outline")).unwrap(), outline);
    assert_eq!(fs::read_link(antigravity.join("outline")).unwrap(), outline);
    assert_eq!(
        fs::read_to_string(claude.join("outline/marker.txt")).unwrap(),
        "outline v2"
    );
    assert_eq!(
        fs::read_to_string(antigravity.join("outline/marker.txt")).unwrap(),
        "outline v2"
    );
    assert_eq!(
        fs::symlink_metadata(claude.join("outline")).unwrap().ino(),
        before
    );
    assert_eq!(
        fs::symlink_metadata(antigravity.join("outline"))
            .unwrap()
            .ino(),
        sync_before
    );
    assert!(!antigravity.join("polish").exists());
    assert_eq!(
        fs::read_to_string(antigravity.join("chosen/marker.txt")).unwrap(),
        "new member"
    );
    assert!(!claude.join("chosen").exists());
    assert!(outcome
        .library
        .assignments
        .iter()
        .any(|item| item.agent_id == first_agent && item.skill_id == ids[0] && item.direct));
    assert!(outcome
        .library
        .assignments
        .iter()
        .any(|item| item.agent_id == second_agent && item.skill_id == ids[1] && item.excluded));
}

#[test]
fn an_interrupted_update_recovers_files_and_revisions_together_on_reopen() {
    use skill_library::PackageUpdateSelection;
    use std::{
        process::Stdio,
        thread,
        time::{Duration, Instant},
    };

    const TEST_ROOT: &str = "SKILL_LIBRARY_PACKAGE_UPDATE_TEST_ROOT";
    if let Some(root) = std::env::var_os(TEST_ROOT).map(PathBuf::from) {
        let source = GitSource::with_config(root.parent().unwrap().join("git-config"));
        let library = Library::open(root).unwrap();
        let cancellation = SourceCancellation::default();
        let check = library
            .check_package_updates(&source, &cancellation)
            .unwrap()
            .remove(0);
        let selection = PackageUpdateSelection {
            revision: check.revision.unwrap(),
            backup_members: vec![],
            additions: vec![],
            target: None,
            member_ids: vec![],
        };
        library
            .apply_package_update(&source, &check.package, &selection, &cancellation)
            .unwrap();
        return;
    }

    let fixture = Fixture::new();
    let names = (0..48)
        .map(|index| format!("fixture-{index:02}"))
        .collect::<Vec<_>>();
    let references = names.iter().map(String::as_str).collect::<Vec<_>>();
    let pack = fixture.repository("recovery", &references);
    let installed = fixture.install(&pack, CategoryTarget::Uncategorized, &references);
    let paths = installed
        .iter()
        .map(|id| {
            fixture
                .library
                .managed_path(*id)
                .unwrap()
                .join("marker.txt")
        })
        .collect::<Vec<_>>();
    let before = fixture.library.snapshot().unwrap().skills[0]
        .source
        .as_ref()
        .unwrap()
        .revision
        .clone();
    for name in &names {
        pack.write_member(name, "next");
    }
    let next = pack.publish();
    let root = fixture.temp.path().join("library");
    drop(fixture.library);

    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "an_interrupted_update_recovers_files_and_revisions_together_on_reopen",
        ])
        .env(TEST_ROOT, &root)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut started = false;
    while Instant::now() < deadline {
        if paths
            .iter()
            .any(|path| fs::read_to_string(path).as_deref().ok() != Some("original"))
        {
            started = true;
            break;
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(1));
    }
    let _ = child.kill();
    child.wait().unwrap();
    assert!(started);
    let reopened = Library::open(root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.skills.len(), installed.len());
    let revision = &snapshot.skills[0].source.as_ref().unwrap().revision;
    let marker = if revision == &before {
        "original"
    } else {
        assert_eq!(revision, &next);
        "next"
    };
    for ((member, id), path) in snapshot.skills.iter().zip(installed).zip(paths) {
        assert_eq!(member.id, id);
        assert_eq!(&member.source.as_ref().unwrap().revision, revision);
        assert_eq!(fs::read_to_string(path).unwrap(), marker);
    }
}

#[test]
fn adopted_install_record_offers_update_without_replacing_agent_files() {
    use skill_library::{AgentDraft, AgentKind, PackageUpdateStatus};
    let fixture = Fixture::new();
    let pack = fixture.repository("writing", &["outline"]);
    let directory = fixture.temp.path().join(".agents/skills");
    let member = directory.join("outline");
    write_member(&member, "outline", "local draft");
    fs::write(fixture.temp.path().join("skills-lock.json"), serde_json::json!({
        "version":1, "skills":{"outline":{"sourceType":"git","sourceUrl":pack.url,"skillPath":"skills/outline/SKILL.md"}}
    }).to_string()).unwrap();
    let agent = fixture
        .library
        .add_agent(AgentDraft {
            kind: AgentKind::Custom,
            name: "Local".into(),
            directory,
        })
        .unwrap()
        .agents[0]
        .id;
    let rows = fixture
        .library
        .scan_existing_skills(&[], &[], Some(agent))
        .unwrap();
    assert!(fixture.library.adopt_existing_skills(&[], rows)[0]
        .error
        .is_none());
    let cancel = SourceCancellation::default();
    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancel)
        .unwrap()
        .remove(0);
    assert_eq!(check.status, PackageUpdateStatus::Available);
    let preview = fixture
        .library
        .preview_package_update(
            &fixture.source,
            &check.package,
            check.revision.as_deref().unwrap(),
            &cancel,
        )
        .unwrap();
    assert_eq!(
        preview.outdated[0].skip_reason.as_deref(),
        Some("有本地改动")
    );
    assert_eq!(
        fs::read_to_string(member.join("marker.txt")).unwrap(),
        "local draft"
    );
}

#[test]
fn ignores_unrelated_repository_commits_and_reports_only_changed_skills() {
    use skill_library::PackageUpdateStatus;

    let fixture = Fixture::new();
    let pack = fixture.repository("monorepo", &["outline", "polish"]);
    let ids = fixture.install(&pack, CategoryTarget::Uncategorized, &["outline", "polish"]);
    let outline = ids[0];
    let polish = ids[1];

    // Commit an unrelated repo file without changing any installed skill.
    fs::write(pack.work.join("README.md"), "repo notes").unwrap();
    pack.publish();

    let cancellation = SourceCancellation::default();
    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    assert_eq!(check.status, PackageUpdateStatus::Current);
    assert!(check.outdated_member_ids.is_empty());

    // Locally edit outline, then change only polish upstream.
    // outline must NOT be reported as having an upstream update.
    let outline_path = fixture.library.managed_path(outline).unwrap();
    fs::write(outline_path.join("marker.txt"), "local edit").unwrap();
    pack.write_member("polish", "polish v2");
    pack.publish();

    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    assert_eq!(check.status, PackageUpdateStatus::Available);
    assert_eq!(check.outdated_member_ids, [polish]);
}

#[test]
fn updates_single_selected_member_fast_forwards_unchanged_and_returns_preview_metadata() {
    use skill_library::{PackageUpdateSelection, PackageUpdateStatus};

    let fixture = Fixture::new();
    let pack = fixture.repository("monorepo", &["outline", "polish", "notes"]);
    fixture.install(
        &pack,
        CategoryTarget::Uncategorized,
        &["outline", "polish", "notes"],
    );
    let snapshot = fixture.library.snapshot().unwrap();
    let id_for = |name: &str| {
        snapshot
            .skills
            .iter()
            .find(|skill| skill.name == name)
            .unwrap()
            .id
    };
    let (outline, polish, notes) = (id_for("outline"), id_for("polish"), id_for("notes"));
    let initial_revision = snapshot.skills[0]
        .source
        .as_ref()
        .unwrap()
        .revision
        .clone();

    pack.write_member("outline", "outline v2");
    pack.write_member("polish", "polish v2");
    let next_revision = pack.publish();

    let cancellation = SourceCancellation::default();
    let check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    assert_eq!(check.status, PackageUpdateStatus::Available);
    assert_eq!(check.outdated_member_ids, [outline, polish]);
    assert_eq!(check.revision.as_deref(), Some(next_revision.as_str()));
    assert!(check.updated_at.is_some());

    let preview = fixture
        .library
        .preview_package_update(&fixture.source, &check.package, &next_revision, &cancellation)
        .unwrap();
    assert_eq!(preview.outdated.len(), 2);
    assert_eq!(preview.outdated[0].id, outline);
    assert_eq!(preview.outdated[0].changed_files, ["marker.txt"]);
    assert_eq!(preview.outdated[1].id, polish);
    assert_eq!(preview.outdated[1].changed_files, ["marker.txt"]);
    assert_eq!(preview.updated_at, check.updated_at);
    assert_eq!(
        preview.from_revision.as_deref(),
        Some(initial_revision.as_str())
    );
    assert_eq!(
        preview.repository_url.as_deref(),
        Some("https://fixture.example.invalid/qa/monorepo")
    );
    assert_eq!(
        preview.compare_url.as_deref(),
        Some("https://fixture.example.invalid/qa/monorepo")
    );

    // Update only outline; notes (unchanged) should fast-forward its revision,
    // while polish stays at initial_revision with its old content.
    let outcome = fixture
        .library
        .apply_package_update(
            &fixture.source,
            &check.package,
            &PackageUpdateSelection {
                revision: next_revision.clone(),
                backup_members: vec![],
                additions: vec![],
                target: None,
                member_ids: vec![outline],
            },
            &cancellation,
        )
        .unwrap();
    assert_eq!(outcome.updated, [outline]);
    assert_eq!(
        fs::read_to_string(fixture.library.managed_path(outline).unwrap().join("marker.txt"))
            .unwrap(),
        "outline v2"
    );
    assert_eq!(
        fs::read_to_string(fixture.library.managed_path(polish).unwrap().join("marker.txt"))
            .unwrap(),
        "original"
    );
    assert_eq!(
        fs::read_to_string(fixture.library.managed_path(notes).unwrap().join("marker.txt"))
            .unwrap(),
        "original"
    );

    let find_rev = |id: Uuid| {
        outcome
            .library
            .skills
            .iter()
            .find(|skill| skill.id == id)
            .unwrap()
            .source
            .as_ref()
            .unwrap()
            .revision
            .clone()
    };
    assert_eq!(find_rev(outline), next_revision);
    assert_eq!(find_rev(notes), next_revision);
    assert_eq!(find_rev(polish), initial_revision);

    let after_check = fixture
        .library
        .check_package_updates(&fixture.source, &cancellation)
        .unwrap()
        .remove(0);
    assert_eq!(after_check.status, PackageUpdateStatus::Available);
    assert_eq!(after_check.outdated_member_ids, [polish]);
}

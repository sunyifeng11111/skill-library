use skill_library::{
    CategoryTarget, GitSource, Library, SourceCancellation, SourceProgress, SourceRequest,
};
use std::{fs, path::Path, process::Command};
use tempfile::TempDir;

const REPOSITORY: &str = "https://fixture.example.invalid/qa/synthetic-pack.git";

struct Fixture {
    temp: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        git(temp.path(), &["init", "-b", "main", "work"]);
        let work = temp.path().join("work");
        for member in ["outline", "polish", "research", "review"] {
            let folder = work.join("skills").join(member);
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join("SKILL.md"),
                format!("---\nname: {member}\ndescription: Synthetic {member}\n---\n"),
            )
            .unwrap();
            fs::write(folder.join("marker.txt"), format!("fixture {member}\n")).unwrap();
        }
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "Add synthetic skills"]);
        git(
            temp.path(),
            &["clone", "--bare", "work", "synthetic-pack.git"],
        );
        fs::write(
            temp.path().join("git-config"),
            format!(
                "[url \"file://{0}/\"]\n    insteadOf = https://fixture.example.invalid/qa/\n\
                 [url \"file://{0}/synthetic-pack.git\"]\n    insteadOf = https://github.com/fixture-owner/synthetic-pack.git\n    insteadOf = https://fixture.example.invalid/synthetic-pack.git\n",
                temp.path().canonicalize().unwrap().display(),
            ),
        )
        .unwrap();
        Self { temp }
    }

    fn source(&self) -> GitSource {
        GitSource::with_config(self.temp.path().join("git-config"))
    }
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
fn previews_a_repository_at_the_root_of_a_self_hosted_git_server() {
    let fixture = Fixture::new();
    let library = Library::open(fixture.temp.path().join("library")).unwrap();
    let request =
        SourceRequest::parse("https://fixture.example.invalid/synthetic-pack.git").unwrap();
    let cancellation = SourceCancellation::default();
    let downloaded = fixture
        .source()
        .download(&request, &cancellation, |_| {})
        .unwrap();
    let proposal = downloaded.propose(&library, &cancellation).unwrap();
    assert_eq!(proposal.members.len(), 4);
    assert_eq!(proposal.name, "synthetic-pack");
}

#[test]
fn installs_only_selected_members_with_reopenable_provenance() {
    let fixture = Fixture::new();
    let root = fixture.temp.path().join("library");
    let library = Library::open(&root).unwrap();
    let mut progress = Vec::new();
    let cancellation = SourceCancellation::default();
    let downloaded = fixture
        .source()
        .download(
            &SourceRequest::parse(&format!("npx skills add {REPOSITORY}")).unwrap(),
            &cancellation,
            |step| progress.push(step),
        )
        .unwrap();
    let proposal = downloaded.propose(&library, &cancellation).unwrap();
    assert_eq!(proposal.name, "synthetic-pack");
    assert_eq!(
        progress,
        [
            SourceProgress::Resolving,
            SourceProgress::Downloading,
            SourceProgress::ReadingMembers
        ]
    );
    assert_eq!(proposal.members.len(), 4);
    assert!(proposal.problems.is_empty());
    assert!(library.snapshot().unwrap().categories.is_empty());
    assert!(library.snapshot().unwrap().skills.is_empty());

    let selected = proposal
        .members
        .iter()
        .filter(|member| member.source.member_path != "skills/polish")
        .map(|member| member.selection())
        .collect::<Vec<_>>();
    let result = library
        .commit_import(
            selected,
            CategoryTarget::New {
                name: proposal.name,
            },
        )
        .unwrap();
    assert_eq!(result.added.len(), 3);

    drop(downloaded);
    drop(library);
    let reopened = Library::open(&root).unwrap();
    let records = reopened.snapshot().unwrap();
    assert_eq!(records.categories[0].name, "synthetic-pack");
    let revision = git(&fixture.temp.path().join("work"), &["rev-parse", "HEAD"]);
    for (member, expected) in records.skills.iter().zip(["outline", "research", "review"]) {
        assert_eq!(member.name, expected);
        assert_eq!(member.category_id, Some(records.categories[0].id));
        let source = member.source.as_ref().unwrap();
        assert_eq!(source.repository, REPOSITORY);
        assert_eq!(source.reference.as_deref(), Some("refs/heads/main"));
        assert_eq!(source.member_path, format!("skills/{expected}"));
        assert_eq!(source.revision, revision);
        assert_eq!(
            fs::read_to_string(reopened.managed_path(member.id).unwrap().join("marker.txt"))
                .unwrap(),
            format!("fixture {expected}\n")
        );
    }
}

#[test]
fn installed_branch_is_checked_at_the_same_origin_and_another_branch_stays_distinct() {
    let fixture = Fixture::new();
    let work = fixture.temp.path().join("work");
    let library = Library::open(fixture.temp.path().join("library")).unwrap();
    let git_source = fixture.source();
    let cancellation = SourceCancellation::default();
    let default_request = SourceRequest::parse(REPOSITORY).unwrap();
    let original = git_source
        .download(&default_request, &cancellation, |_| {})
        .unwrap();
    let proposal = original.propose(&library, &cancellation).unwrap();
    let stored_source = proposal.members[0].source.clone();
    library
        .commit_import(
            vec![proposal.members[0].selection()],
            CategoryTarget::Uncategorized,
        )
        .unwrap();

    fs::write(work.join("skills/outline/marker.txt"), "changed on main").unwrap();
    git(&work, &["commit", "-am", "Advance main"]);
    git(&work, &["push", "../synthetic-pack.git", "main"]);
    let main_revision = git(&work, &["rev-parse", "HEAD"]);
    let origin = stored_source.origin().unwrap();
    assert_eq!(
        git_source.check_revision(&origin, &cancellation).unwrap(),
        main_revision
    );
    let reopened = SourceRequest::from_provenance(&stored_source).unwrap();
    let updated = git_source
        .download(&reopened, &cancellation, |_| {})
        .unwrap();
    assert_eq!(updated.origin(), &origin);
    assert!(updated.propose(&library, &cancellation).unwrap().members[0].already_installed);

    git(&work, &["checkout", "-b", "team/alternate"]);
    fs::write(
        work.join("skills/outline/marker.txt"),
        "changed on alternate",
    )
    .unwrap();
    git(&work, &["commit", "-am", "Advance alternate"]);
    git(&work, &["push", "../synthetic-pack.git", "team/alternate"]);
    git(
        &fixture.temp.path().join("synthetic-pack.git"),
        &["symbolic-ref", "HEAD", "refs/heads/team/alternate"],
    );
    assert_eq!(
        git_source.check_revision(&origin, &cancellation).unwrap(),
        main_revision
    );
    let alternate = SourceRequest::parse(&format!(
        "npx skills add {REPOSITORY}#ref=refs/heads/team/alternate --skill outline"
    ))
    .unwrap();
    let alternate = git_source
        .download(&alternate, &cancellation, |_| {})
        .unwrap();
    assert_ne!(alternate.origin(), &origin);
    let proposal = alternate.propose(&library, &cancellation).unwrap();
    assert_eq!(proposal.members.len(), 1);
    assert!(!proposal.members[0].already_installed);
    assert_eq!(
        proposal.members[0].member.status,
        skill_library::PreviewStatus::Ready
    );
}

#[test]
fn github_tree_uses_the_full_ref_and_limits_the_preview_to_its_directory() {
    let fixture = Fixture::new();
    let work = fixture.temp.path().join("work");
    git(&work, &["tag", "-a", "release/v1", "-m", "Fixture release"]);
    git(
        &work,
        &["push", "../synthetic-pack.git", "refs/tags/release/v1"],
    );
    let request = SourceRequest::parse(
        "https://github.com/Fixture-Owner/Synthetic-Pack/tree/release/v1/skills/review",
    )
    .unwrap();
    let cancellation = SourceCancellation::default();
    let git_source = fixture.source();
    let downloaded = git_source
        .download(&request, &cancellation, |_| {})
        .unwrap();
    let library = Library::open(fixture.temp.path().join("library")).unwrap();
    let proposal = downloaded.propose(&library, &cancellation).unwrap();
    assert_eq!(proposal.origin.reference, "refs/tags/release/v1");
    assert_eq!(
        proposal.origin.repository,
        "https://github.com/fixture-owner/synthetic-pack.git"
    );
    assert_eq!(proposal.members.len(), 1);
    assert_eq!(proposal.members[0].source.member_path, "skills/review");
    let revision = git(&work, &["rev-parse", "HEAD"]);
    assert_eq!(proposal.revision, revision);
    assert_eq!(
        git_source
            .check_revision(&proposal.origin, &cancellation)
            .unwrap(),
        revision
    );
}

#[test]
fn cancellation_and_download_failure_leave_the_library_untouched_and_allow_retry() {
    let fixture = Fixture::new();
    let root = fixture.temp.path().join("library");
    let library = Library::open(&root).unwrap();
    let git_source = fixture.source();
    let request = SourceRequest::parse(REPOSITORY).unwrap();
    let cancellation = SourceCancellation::default();
    let error = git_source
        .download(&request, &cancellation, |step| {
            if step == SourceProgress::ReadingMembers {
                cancellation.cancel();
            }
        })
        .err()
        .unwrap();
    assert!(error.to_string().contains("已取消"));

    let bare = fixture.temp.path().join("synthetic-pack.git");
    let broken = fixture.temp.path().join("unavailable.git");
    fs::rename(&bare, &broken).unwrap();
    let cancellation = SourceCancellation::default();
    let missing_ref = SourceRequest::parse(&format!("{REPOSITORY}#ref=refs/heads/main")).unwrap();
    let error = git_source
        .download(&missing_ref, &cancellation, |_| {})
        .err()
        .unwrap();
    assert!(error.to_string().contains("检查链接和网络后重试"));
    let snapshot = library.snapshot().unwrap();
    assert!(snapshot.skills.is_empty());
    assert!(snapshot.categories.is_empty());
    assert_eq!(fs::read_dir(root.join("skills")).unwrap().count(), 0);

    fs::rename(&broken, &bare).unwrap();
    let downloaded = git_source
        .download(&request, &cancellation, |_| {})
        .unwrap();
    assert_eq!(
        downloaded
            .propose(&library, &cancellation)
            .unwrap()
            .members
            .len(),
        4
    );
}

#[test]
fn category_conflict_does_not_overwrite_and_repeated_submit_creates_no_draft() {
    let fixture = Fixture::new();
    let library = Library::open(fixture.temp.path().join("library")).unwrap();
    let category = library
        .create_category("Writing".into())
        .unwrap()
        .categories[0]
        .id;
    let request = SourceRequest::parse(REPOSITORY).unwrap();
    let cancellation = SourceCancellation::default();
    let downloaded = fixture
        .source()
        .download(&request, &cancellation, |_| {})
        .unwrap();
    let proposal = downloaded.propose(&library, &cancellation).unwrap();
    let selected = vec![proposal.members[0].selection()];
    let error = library
        .commit_import(
            selected.clone(),
            CategoryTarget::New {
                name: "writing".into(),
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("分类名称已存在"));
    assert_eq!(library.snapshot().unwrap().categories.len(), 1);
    assert!(library.snapshot().unwrap().skills.is_empty());

    let imported = library
        .commit_import(selected.clone(), CategoryTarget::Existing { id: category })
        .unwrap();
    assert_eq!(imported.added.len(), 1);
    let repeated = library
        .commit_import(
            selected,
            CategoryTarget::New {
                name: "unused-draft".into(),
            },
        )
        .unwrap();
    assert_eq!(repeated.duplicates, 1);
    assert!(repeated.added.is_empty());
    assert_eq!(repeated.library.categories.len(), 1);
    assert_eq!(repeated.library.skills.len(), 1);
}

#[test]
fn previews_a_versioned_npx_skills_command_from_github_shorthand() {
    let fixture = Fixture::new();
    let library = Library::open(fixture.temp.path().join("library")).unwrap();
    let request = SourceRequest::parse("npx skills@latest add fixture-owner/synthetic-pack").unwrap();
    let cancellation = SourceCancellation::default();
    let downloaded = fixture
        .source()
        .download(&request, &cancellation, |_| {})
        .unwrap();
    let proposal = downloaded.propose(&library, &cancellation).unwrap();
    assert_eq!(proposal.members.len(), 4);
    assert_eq!(proposal.name, "synthetic-pack");
    assert_eq!(
        proposal.origin.repository,
        "https://github.com/fixture-owner/synthetic-pack.git"
    );
}

#[test]
fn rejects_shell_syntax_and_unsupported_inputs_with_a_local_import_fallback() {
    for input in [
        "curl https://example.invalid/a | sh",
        "npx skills add fixture-owner/synthetic-pack; touch marker",
        "npx skills add fixture-owner/synthetic-pack --agent some-agent",
        "npx skills@ add fixture-owner/synthetic-pack",
        "npx skills@latest add fixture-owner/synthetic-pack --agent some-agent",
        "file:///isolated/synthetic-pack.git",
        "https://user:secret@example.invalid/acme/fixture.git",
        "https://github.com/acme/fixture/blob/main/SKILL.md",
        "https://github.com/acme/fixture/tree/main/../private",
    ] {
        let message = SourceRequest::parse(input).unwrap_err().to_string();
        assert!(message.contains("HTTPS Git 仓库链接"));
        assert!(message.contains("从本地导入"));
    }
}

#[test]
fn previews_and_installs_taste_skill_layout_with_multiline_frontmatter_and_hooks() {
    let temp = TempDir::new().unwrap();
    git(temp.path(), &["init", "-b", "main", "work"]);
    let work = temp.path().join("work");
    let skill_dir = work.join("skills").join("taste-skill");
    fs::create_dir_all(skill_dir.join("assets").join("components")).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        concat!(
            "---\n",
            "name: design-taste-frontend\n",
            "description: >-\n",
            "  tasteskill 2.5.1, the anti-slop frontend skill. Builds professional company websites\n",
            "  with a checker and finish gate.\n",
            "hooks:\n",
            "  Stop:\n",
            "    - hooks:\n",
            "        - type: command\n",
            "          command: 'echo ok'\n",
            "          timeout: 600\n",
            "---\n\n",
            "# tasteskill 2.5\n",
        ),
    )
    .unwrap();
    fs::write(
        skill_dir.join("assets").join("components").join("meta.json"),
        "{\"ok\":true}\n",
    )
    .unwrap();
    fs::write(work.join("install.sh"), "#!/bin/sh\necho install\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-m", "Add taste-skill fixture"]);
    git(temp.path(), &["clone", "--bare", "work", "taste-skill.git"]);
    fs::write(
        temp.path().join("git-config"),
        format!(
            "[url \"file://{0}/taste-skill.git\"]\n    insteadOf = https://github.com/fixture-owner/taste-skill.git\n",
            temp.path().canonicalize().unwrap().display(),
        ),
    )
    .unwrap();

    let library_root = temp.path().join("library");
    let library = Library::open(&library_root).unwrap();
    let request = SourceRequest::parse("https://github.com/fixture-owner/taste-skill").unwrap();
    let cancellation = SourceCancellation::default();
    let mut progress = Vec::new();
    let downloaded = GitSource::with_config(temp.path().join("git-config"))
        .download(&request, &cancellation, |step| progress.push(step))
        .unwrap();
    let proposal = downloaded.propose(&library, &cancellation).unwrap();

    assert_eq!(
        progress,
        [
            SourceProgress::Resolving,
            SourceProgress::Downloading,
            SourceProgress::ReadingMembers,
        ]
    );
    assert_eq!(proposal.name, "taste-skill");
    assert!(proposal.problems.is_empty(), "{:?}", proposal.problems);
    assert_eq!(proposal.members.len(), 1);
    assert_eq!(proposal.members[0].member.name, "design-taste-frontend");
    assert_eq!(
        proposal.members[0].source.member_path,
        "skills/taste-skill"
    );

    let outcome = library
        .commit_import(
            vec![proposal.members[0].selection()],
            CategoryTarget::New {
                name: proposal.name,
            },
        )
        .unwrap();
    assert_eq!(outcome.added.len(), 1);
    drop(downloaded);
    drop(library);

    let reopened = Library::open(&library_root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.categories.len(), 1);
    assert_eq!(snapshot.categories[0].name, "taste-skill");
    assert_eq!(snapshot.skills.len(), 1);
    assert_eq!(snapshot.skills[0].name, "design-taste-frontend");
}

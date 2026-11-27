use super::{
    input::{is_commit, scope, valid_reference, Locator},
    PackageOrigin, SourceCancellation, SourceRequest,
};
use crate::LibraryError;
use std::{
    env,
    fs::File,
    io::{Read, Seek},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const GIT_TIMEOUT: Duration = Duration::from_secs(180);

/// A `git` process in `work` that ignores any `GIT_*` variables inherited from the app's environment.
pub(crate) fn isolated_git_command(work: &Path) -> Command {
    let mut command = Command::new("git");
    for (key, _) in env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command.current_dir(work);
    command
}

#[derive(Default)]
pub struct GitSource {
    config: Option<PathBuf>,
}

impl GitSource {
    /// Uses a trusted, caller-supplied Git config. This also allows HTTPS-to-file rewrites
    /// in isolated fixtures. Source input itself is still restricted to HTTPS.
    pub fn with_config(config: impl Into<PathBuf>) -> Self {
        Self {
            config: Some(config.into()),
        }
    }

    /// Queries a recorded ref without downloading any member files. Commit pins are immutable.
    pub fn check_revision(
        &self,
        origin: &PackageOrigin,
        cancellation: &SourceCancellation,
    ) -> Result<String, LibraryError> {
        cancellation.check()?;
        let request = SourceRequest::parse(&origin.repository)?;
        let reference = &origin.reference;
        if !valid_reference(reference) {
            return Err(LibraryError::new("无效的 Git 来源引用。"));
        }
        if is_commit(reference) {
            return Ok(reference.to_ascii_lowercase());
        }

        let temporary = tempfile::tempdir().map_err(temporary_error)?;
        let peeled = format!("{reference}^{{}}");
        let mut command = self.command(temporary.path());
        command.args(["ls-remote", "--", &request.repository, reference, &peeled]);
        let output = output_text(command, cancellation)?;
        let revision = |name: &str| {
            output.lines().find_map(|line| {
                let (oid, found) = line.split_once('\t')?;
                (found == name && is_commit(oid)).then(|| oid.to_owned())
            })
        };
        revision(&peeled)
            .or_else(|| revision(reference))
            .ok_or_else(|| LibraryError::new("上游已找不到安装时的 Git 分支或标签。"))
    }

    pub(crate) fn resolve_origin(
        &self,
        request: &SourceRequest,
        cancellation: &SourceCancellation,
    ) -> Result<PackageOrigin, LibraryError> {
        let temporary = tempfile::tempdir().map_err(temporary_error)?;
        let (reference, _) = self.resolve(request, temporary.path(), cancellation)?;
        Ok(PackageOrigin {
            repository: request.repository.clone(),
            reference,
        })
    }

    pub(super) fn resolve(
        &self,
        request: &SourceRequest,
        work: &Path,
        cancellation: &SourceCancellation,
    ) -> Result<(String, PathBuf), LibraryError> {
        match &request.locator {
            Locator::Reference(reference) => Ok((reference.clone(), PathBuf::new())),
            Locator::Default => {
                let mut command = self.command(work);
                command.args(["ls-remote", "--symref", "--", &request.repository, "HEAD"]);
                let output = output_text(command, cancellation)?;
                let reference = output
                    .lines()
                    .find_map(|line| line.strip_prefix("ref: ")?.strip_suffix("\tHEAD"))
                    .filter(|reference| valid_reference(reference))
                    .map(str::to_owned)
                    .or_else(|| {
                        output.lines().find_map(|line| {
                            let oid = line.strip_suffix("\tHEAD")?;
                            is_commit(oid).then(|| oid.to_owned())
                        })
                    })
                    .ok_or_else(|| LibraryError::new("仓库没有可下载的默认分支。"))?;
                Ok((reference, PathBuf::new()))
            }
            Locator::GitHubTree(parts) if is_commit(&parts[0]) => {
                Ok((parts[0].clone(), scope(&parts[1..])))
            }
            Locator::GitHubTree(parts) => {
                let mut command = self.command(work);
                command.args(["ls-remote", "--refs", "--", &request.repository]);
                let prefixes = (1..=parts.len())
                    .map(|count| {
                        let path = parts[..count].join("/");
                        [format!("refs/heads/{path}"), format!("refs/tags/{path}")]
                    })
                    .collect::<Vec<_>>();
                for reference in prefixes
                    .iter()
                    .flatten()
                    .filter(|reference| valid_reference(reference))
                {
                    command.arg(reference);
                }
                let output = output_text(command, cancellation)?;
                let refs = output
                    .lines()
                    .filter_map(|line| line.split_once('\t').map(|(_, reference)| reference));
                let refs = refs.collect::<std::collections::HashSet<_>>();
                for (index, [branch, tag]) in prefixes.iter().enumerate().rev() {
                    match (refs.contains(branch.as_str()), refs.contains(tag.as_str())) {
                        (true, true) => return Err(LibraryError::new(
                            "分支和标签同名。请在仓库链接末尾使用 #ref=refs/heads/名称 或 #ref=refs/tags/名称。",
                        )),
                        (true, false) => return Ok((branch.clone(), scope(&parts[index + 1..]))),
                        (false, true) => return Ok((tag.clone(), scope(&parts[index + 1..]))),
                        (false, false) => {}
                    }
                }
                Err(LibraryError::new("找不到链接指定的 Git 分支、标签或修订。"))
            }
        }
    }

    pub(super) fn fetch_archive(
        &self,
        request: &SourceRequest,
        reference: &str,
        work: &Path,
        archive: &File,
        cancellation: &SourceCancellation,
    ) -> Result<(String, Option<i64>), LibraryError> {
        let mut init = self.command(work);
        init.args(["init", "--bare", "--template="]);
        output_text(init, cancellation)?;

        let mut fetch = self.command(work);
        fetch.args([
            "fetch",
            "--depth=1",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-auto-maintenance",
            "--",
            &request.repository,
            reference,
        ]);
        output_text(fetch, cancellation)?;

        let mut revision = self.command(work);
        revision.args(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
        let revision = output_text(revision, cancellation)?.trim().to_owned();

        let mut timestamp = self.command(work);
        timestamp.args(["show", "-s", "--format=%ct", &revision]);
        let committed_at = output_text(timestamp, cancellation)
            .ok()
            .and_then(|text| text.trim().parse::<i64>().ok());

        let mut export = self.command(work);
        export.args(["archive", "--format=tar", &revision]);
        let stdout = archive.try_clone().map_err(temporary_error)?;
        run(export, stdout, cancellation)?;
        Ok((revision, committed_at))
    }

    fn command(&self, work: &Path) -> Command {
        let mut command = isolated_git_command(work);
        command
            .env_remove("SSH_ASKPASS")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CEILING_DIRECTORIES", work)
            .env(
                "GIT_CONFIG_GLOBAL",
                self.config.as_deref().unwrap_or(Path::new("/dev/null")),
            )
            .env(
                "GIT_ALLOW_PROTOCOL",
                if self.config.is_some() {
                    "https:file"
                } else {
                    "https"
                },
            )
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.askPass=",
                "-c",
                "credential.helper=",
                "-c",
                "http.followRedirects=initial",
            ]);
        command
    }
}

fn output_text(
    command: Command,
    cancellation: &SourceCancellation,
) -> Result<String, LibraryError> {
    let mut output = tempfile::tempfile().map_err(temporary_error)?;
    run(
        command,
        output.try_clone().map_err(temporary_error)?,
        cancellation,
    )?;
    output.rewind().map_err(temporary_error)?;
    let mut text = String::new();
    output.read_to_string(&mut text).map_err(temporary_error)?;
    Ok(text)
}

fn run(
    mut command: Command,
    stdout: File,
    cancellation: &SourceCancellation,
) -> Result<(), LibraryError> {
    cancellation.check()?;
    let mut errors = tempfile::tempfile().map_err(temporary_error)?;
    command
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(errors.try_clone().map_err(temporary_error)?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        LibraryError::new(format!("无法启动 Git：{error}。请确认系统已安装 Git。"))
    })?;
    let start = Instant::now();
    let wait_error = |error| LibraryError::new(format!("无法读取 Git 下载状态：{error}"));
    loop {
        if let Err(error) = cancellation.check() {
            terminate(&mut child);
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                errors.rewind().map_err(temporary_error)?;
                let mut detail = Vec::new();
                errors
                    .take(4096)
                    .read_to_end(&mut detail)
                    .map_err(temporary_error)?;
                let detail = String::from_utf8_lossy(&detail);
                return Err(LibraryError::new(format!(
                    "Git 无法读取仓库。请检查链接和网络后重试。\n{}",
                    detail.trim()
                )));
            }
            Err(error) => {
                terminate(&mut child);
                return Err(wait_error(error));
            }
            Ok(None) if start.elapsed() >= GIT_TIMEOUT => {
                terminate(&mut child);
                return Err(LibraryError::new("Git 下载超时。请检查网络后重试。"));
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        // The child started its own process group. Git's HTTPS helper belongs to it as well.
        unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn temporary_error(error: std::io::Error) -> LibraryError {
    LibraryError::new(format!("无法读取 Git 临时文件：{error}"))
}

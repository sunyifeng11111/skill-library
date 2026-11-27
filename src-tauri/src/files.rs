use crate::{LibraryError, PreviewMember, PreviewStatus};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

const MANIFEST: &str = "SKILL.md";
const MAX_FRONTMATTER_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
pub(crate) struct Metadata {
    pub(crate) name: String,
    pub(crate) description: String,
}

pub(crate) fn inspect(
    path: &Path,
    library_root: &Path,
    managed: &Path,
) -> Result<PreviewMember, LibraryError> {
    let path = source_folder(path, library_root, managed)?;
    let folder_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| LibraryError::new("请选择包含 SKILL.md 的文件夹。"))?
        .to_owned();
    let metadata = read_metadata(&path.join(MANIFEST))?;
    Ok(PreviewMember {
        name: metadata.name,
        description: metadata.description,
        fingerprint: fingerprint(&path)?,
        folder_name,
        path,
        status: PreviewStatus::Ready,
    })
}

pub(crate) fn source_folder(
    path: &Path,
    library_root: &Path,
    managed: &Path,
) -> Result<PathBuf, LibraryError> {
    let info =
        fs::symlink_metadata(path).map_err(|error| LibraryError::io("无法读取", path, error))?;
    if !info.is_dir() {
        return Err(LibraryError::new("请选择包含 SKILL.md 的文件夹。"));
    }
    let path = fs::canonicalize(path).map_err(|error| LibraryError::io("无法读取", path, error))?;
    if [library_root, managed]
        .iter()
        .any(|root| path.starts_with(root) || root.starts_with(&path))
    {
        return Err(LibraryError::new("请选择 Skill 库以外的独立 Skill 文件夹。"));
    }
    Ok(path)
}

pub(crate) fn stage(
    source: &Path,
    destination: &Path,
    expected_fingerprint: &str,
) -> Result<PreviewMember, LibraryError> {
    let fingerprint = copy_verified(source, destination, expected_fingerprint)?;
    let metadata = read_metadata(&destination.join(MANIFEST))?;
    Ok(PreviewMember {
        path: source.to_owned(),
        name: metadata.name,
        description: metadata.description,
        folder_name: source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| LibraryError::new("请选择名称可读取的 Skill 文件夹。"))?
            .to_owned(),
        fingerprint,
        status: PreviewStatus::Ready,
    })
}

pub(crate) fn copy_verified(
    source: &Path,
    destination: &Path,
    expected_fingerprint: &str,
) -> Result<String, LibraryError> {
    let library_error = |error| LibraryError::io("无法复制 Skill", source, error);
    fs::create_dir(destination).map_err(library_error)?;
    visit(source, source, Some(destination), &mut Sha256::new()).map_err(library_error)?;
    let fingerprint = fingerprint(destination)?;
    if fingerprint != expected_fingerprint {
        return Err(LibraryError::new(format!(
            "预览后文件已发生变化：{}。请重新读取文件夹。",
            source.display()
        )));
    }
    #[cfg(unix)]
    File::open(destination)
        .and_then(|directory| directory.sync_all())
        .map_err(library_error)?;
    Ok(fingerprint)
}

pub(crate) fn read_metadata(path: &Path) -> Result<Metadata, LibraryError> {
    let invalid = || {
        LibraryError::new(format!(
            "{} 需要包含带 name 和 description 的 YAML 元数据。",
            path.display()
        ))
    };
    let info = fs::symlink_metadata(path)
        .map_err(|error| LibraryError::io("找不到可读取的 SKILL.md", path, error))?;
    if !info.is_file() {
        return Err(invalid());
    }

    let file = File::open(path).map_err(|error| LibraryError::io("无法读取", path, error))?;
    let mut reader = BufReader::new(file.take(MAX_FRONTMATTER_BYTES));
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| LibraryError::io("无法读取", path, error))?;
    if line.trim_start_matches('\u{feff}').trim_end() != "---" {
        return Err(invalid());
    }

    let mut yaml = String::new();
    loop {
        line.clear();
        let len = reader
            .read_line(&mut line)
            .map_err(|error| LibraryError::io("无法读取", path, error))?;
        if len == 0 {
            return Err(invalid());
        }
        if matches!(line.trim_end(), "---" | "...") {
            break;
        }
        yaml.push_str(&line);
    }
    let metadata: Metadata = serde_yaml_ng::from_str(&yaml).map_err(|error| {
        LibraryError::new(format!("{} 的元数据无法读取：{error}", path.display()))
    })?;
    if metadata.name.trim().is_empty() || metadata.description.trim().is_empty() {
        return Err(invalid());
    }
    Ok(metadata)
}

pub(crate) fn fingerprint(path: &Path) -> Result<String, LibraryError> {
    let mut digest = Sha256::new();
    visit(path, path, None, &mut digest)
        .map_err(|error| LibraryError::io("无法读取完整 Skill", path, error))?;
    Ok(format!("{:x}", digest.finalize()))
}

fn visit(
    root: &Path,
    path: &Path,
    destination: Option<&Path>,
    digest: &mut Sha256,
) -> io::Result<()> {
    let mut entries = fs::read_dir(path)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_unstable_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type()?;
        if !kind.is_dir() && !kind.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} 是软链接或特殊文件。请使用实际文件。", path.display()),
            ));
        }
        let relative = path.strip_prefix(root).expect("directory entry under root");
        let relative = relative.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("无法读取文件名 {}", path.display()),
            )
        })?;
        if let Some(destination) = destination {
            let target: PathBuf = destination.join(relative);
            if kind.is_dir() {
                fs::create_dir(&target)?;
                visit(root, &path, Some(destination), digest)?;
                #[cfg(unix)]
                File::open(&target)?.sync_all()?;
            } else {
                fs::copy(&path, &target)?;
                File::open(&target)?.sync_all()?;
            }
            continue;
        }

        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        if kind.is_dir() {
            digest.update(b"D");
            visit(root, &path, None, digest)?;
        } else {
            digest.update(b"F");
            let mut file = File::open(&path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                digest.update((file.metadata()?.permissions().mode() & 0o111).to_le_bytes());
            }
            let mut file_digest = Sha256::new();
            io::copy(&mut file, &mut DigestWriter(&mut file_digest))?;
            digest.update(file_digest.finalize());
        }
    }
    Ok(())
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn directory_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        total = total.saturating_add(directory_size(&entry.path()));
    }
    total
}

pub(crate) fn modified_timestamp(path: &Path) -> Option<u64> {
    let manifest_time = fs::metadata(path.join(MANIFEST))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let dir_time = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    match (manifest_time, dir_time) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

pub(crate) fn copy_dir_all(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if file_type.is_symlink() {
            #[cfg(unix)]
            {
                let target = fs::read_link(&from)?;
                std::os::unix::fs::symlink(target, &to)?;
            }
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

pub(crate) fn move_to_trash(path: &Path) -> Result<PathBuf, LibraryError> {
    let trash_dir = if let Some(override_dir) = std::env::var_os("SKILL_LIBRARY_TRASH_DIR") {
        PathBuf::from(override_dir)
    } else {
        #[cfg(target_vendor = "apple")]
        {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or_else(|| LibraryError::new("无法确定系统废纸篓目录。"))?;
            home.join(".Trash")
        }
        #[cfg(not(target_vendor = "apple"))]
        {
            let base = std::env::var_os("XDG_DATA_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
                })
                .ok_or_else(|| LibraryError::new("无法确定系统废纸篓目录。"))?;
            base.join("Trash").join("files")
        }
    };
    fs::create_dir_all(&trash_dir)
        .map_err(|e| LibraryError::io("无法访问系统废纸篓", &trash_dir, e))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("broken-link");
    let mut candidate = trash_dir.join(name);
    let mut counter = 1u32;
    while fs::symlink_metadata(&candidate).is_ok() {
        candidate = trash_dir.join(format!("{name} {counter}"));
        counter += 1;
    }
    match fs::rename(path, &candidate) {
        Ok(()) => Ok(candidate),
        Err(error) if is_cross_device(&error) => {
            #[cfg(unix)]
            {
                let target = fs::read_link(path)
                    .map_err(|e| LibraryError::io("无法读取失效链接", path, e))?;
                std::os::unix::fs::symlink(&target, &candidate)
                    .map_err(|e| LibraryError::io("无法移入系统废纸篓", &candidate, e))?;
                fs::remove_file(path)
                    .map_err(|e| LibraryError::io("无法移除原失效链接", path, e))?;
                Ok(candidate)
            }
            #[cfg(not(unix))]
            Err(LibraryError::io("无法移入系统废纸篓", path, error))
        }
        Err(error) => Err(LibraryError::io("无法移入系统废纸篓", path, error)),
    }
}

fn is_cross_device(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

pub(crate) fn read_manifest_text(dir: &Path) -> Result<String, LibraryError> {
    let manifest = dir.join(MANIFEST);
    let file = File::open(&manifest)
        .map_err(|e| LibraryError::io("无法读取 SKILL.md", &manifest, e))?;
    let mut buf = Vec::new();
    file.take(256 * 1024)
        .read_to_end(&mut buf)
        .map_err(|e| LibraryError::io("无法读取 SKILL.md", &manifest, e))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiffKind {
    Context,
    Removed,
    Added,
}

/// Computes a compact line-by-line diff (with up to 2 context lines around each hunk).
pub(crate) fn compute_line_diff(left: &str, right: &str) -> Vec<(DiffKind, String)> {
    let a: Vec<&str> = left.lines().collect();
    let b: Vec<&str> = right.lines().collect();
    let n = a.len();
    let m = b.len();

    // Cap DP table size for very large manifests so comparison stays instant.
    if n.saturating_mul(m) > 250_000 {
        let mut out = Vec::new();
        for line in a.iter().take(40) {
            out.push((DiffKind::Removed, (*line).to_owned()));
        }
        for line in b.iter().take(40) {
            out.push((DiffKind::Added, (*line).to_owned()));
        }
        return out;
    }

    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            if a[i] == b[j] {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }

    let mut raw = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            raw.push((DiffKind::Context, a[i].to_owned()));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            raw.push((DiffKind::Removed, a[i].to_owned()));
            i += 1;
        } else {
            raw.push((DiffKind::Added, b[j].to_owned()));
            j += 1;
        }
    }
    while i < n {
        raw.push((DiffKind::Removed, a[i].to_owned()));
        i += 1;
    }
    while j < m {
        raw.push((DiffKind::Added, b[j].to_owned()));
        j += 1;
    }

    // Keep only changed lines and +/- 2 lines of surrounding context.
    let changed: Vec<bool> = raw
        .iter()
        .map(|(k, _)| *k != DiffKind::Context)
        .collect();
    let mut keep = vec![false; raw.len()];
    for (idx, is_change) in changed.iter().enumerate() {
        if *is_change {
            let start = idx.saturating_sub(2);
            let end = (idx + 2).min(raw.len().saturating_sub(1));
            for slot in &mut keep[start..=end] {
                *slot = true;
            }
        }
    }
    raw.into_iter()
        .zip(keep)
        .filter_map(|(entry, include)| include.then_some(entry))
        .take(120)
        .collect()
}


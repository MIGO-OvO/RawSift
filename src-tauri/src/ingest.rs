use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;
use thiserror::Error;

const COPY_BUFFER_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCopy {
    pub bytes: u64,
    pub blake3: String,
    pub destination: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedFile {
    pub original_name: String,
    pub destination: String,
    pub bytes: u64,
    pub blake3: String,
    pub disposition: CommitDisposition,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitDisposition {
    Committed,
    AlreadyPresent,
    RenamedConflict,
}

#[derive(Debug, Error)]
pub enum IngestError {
    #[error("来源不存在或不是文件：{0}")]
    InvalidSource(String),
    #[error("目标已经存在：{0}")]
    DestinationExists(String),
    #[error("目标目录不能与来源目录重叠")]
    OverlappingPaths,
    #[error("复制后大小不一致：读取 {source_bytes} 字节，写入 {destination_bytes} 字节")]
    SizeMismatch {
        source_bytes: u64,
        destination_bytes: u64,
    },
    #[error("目标端回读校验失败")]
    ChecksumMismatch,
    #[error("暂存目录不存在：{0}")]
    MissingStaging(String),
    #[error("暂存文件缺失：{0}")]
    MissingStagedAsset(String),
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
pub fn commit_staging(
    staging: &Path,
    final_directory: &Path,
) -> Result<Vec<CommittedFile>, IngestError> {
    if !staging.is_dir() {
        return Err(IngestError::MissingStaging(staging.display().to_string()));
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(staging)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file()
            || path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        {
            continue;
        }
        paths.push(path);
    }
    commit_paths(staging, final_directory, paths)
}

pub fn commit_selected_staging(
    staging: &Path,
    final_directory: &Path,
    allowed_names: &[String],
) -> Result<Vec<CommittedFile>, IngestError> {
    if !staging.is_dir() {
        return Err(IngestError::MissingStaging(staging.display().to_string()));
    }
    let mut paths = Vec::with_capacity(allowed_names.len());
    for name in allowed_names {
        let path = staging.join(name);
        if !path.is_file() {
            return Err(IngestError::MissingStagedAsset(path.display().to_string()));
        }
        paths.push(path);
    }
    commit_paths(staging, final_directory, paths)
}

fn commit_paths(
    staging: &Path,
    final_directory: &Path,
    paths: Vec<PathBuf>,
) -> Result<Vec<CommittedFile>, IngestError> {
    fs::create_dir_all(final_directory)?;
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for path in paths {
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown")
            .to_lowercase();
        groups.entry(stem).or_default().push(path);
    }

    let mut committed = Vec::new();
    for paths in groups.into_values() {
        commit_group(&paths, final_directory, &mut committed)?;
    }
    remove_directory_if_empty(staging)?;
    if let Some(parent) = staging.parent() {
        remove_directory_if_empty(parent)?;
    }
    sync_directory(final_directory);
    Ok(committed)
}

fn commit_group(
    staged_paths: &[PathBuf],
    final_directory: &Path,
    committed: &mut Vec<CommittedFile>,
) -> Result<(), IngestError> {
    if staged_paths.is_empty() {
        return Ok(());
    }

    let mut has_different_conflict = false;
    for staged in staged_paths {
        let candidate = final_directory.join(staged.file_name().unwrap_or_default());
        if candidate.exists() && !files_match(staged, &candidate)? {
            has_different_conflict = true;
            break;
        }
    }

    let suffix = if has_different_conflict {
        Some(next_available_suffix(staged_paths, final_directory))
    } else {
        None
    };

    for staged in staged_paths {
        let original_name = staged
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let destination = suffix
            .map(|number| path_with_suffix(staged, final_directory, number))
            .unwrap_or_else(|| final_directory.join(&original_name));
        let metadata = fs::metadata(staged)?;
        let (_, hash) = hash_file(staged)?;

        let disposition = if destination.exists() {
            debug_assert!(files_match(staged, &destination)?);
            fs::remove_file(staged)?;
            CommitDisposition::AlreadyPresent
        } else {
            fs::rename(staged, &destination)?;
            if suffix.is_some() {
                CommitDisposition::RenamedConflict
            } else {
                CommitDisposition::Committed
            }
        };
        committed.push(CommittedFile {
            original_name,
            destination: destination.to_string_lossy().into_owned(),
            bytes: metadata.len(),
            blake3: hash.to_hex().to_string(),
            disposition,
        });
    }
    Ok(())
}

fn files_match(left: &Path, right: &Path) -> Result<bool, IngestError> {
    if fs::metadata(left)?.len() != fs::metadata(right)?.len() {
        return Ok(false);
    }
    let (_, left_hash) = hash_file(left)?;
    let (_, right_hash) = hash_file(right)?;
    Ok(left_hash == right_hash)
}

fn next_available_suffix(staged_paths: &[PathBuf], final_directory: &Path) -> u32 {
    (2..u32::MAX)
        .find(|number| {
            staged_paths
                .iter()
                .all(|path| !path_with_suffix(path, final_directory, *number).exists())
        })
        .unwrap_or(u32::MAX)
}

fn path_with_suffix(path: &Path, final_directory: &Path, number: u32) -> PathBuf {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path.extension().unwrap_or_default().to_string_lossy();
    final_directory.join(format!("{stem}_{number:02}.{extension}"))
}

fn remove_directory_if_empty(path: &Path) -> Result<(), IngestError> {
    if path.is_dir() && fs::read_dir(path)?.next().is_none() {
        fs::remove_dir(path)?;
    }
    Ok(())
}

/// Copies into a sibling `.part` file, fsyncs it, re-reads it, and only then
/// atomically renames it to `destination`. The source is never opened writable.
pub fn copy_verified(source: &Path, destination: &Path) -> Result<VerifiedCopy, IngestError> {
    if !source.is_file() {
        return Err(IngestError::InvalidSource(source.display().to_string()));
    }
    if destination.exists() {
        return Err(IngestError::DestinationExists(
            destination.display().to_string(),
        ));
    }
    ensure_non_overlapping(source, destination)?;
    let parent = destination.parent().ok_or(IngestError::OverlappingPaths)?;
    fs::create_dir_all(parent)?;

    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("rawsift-copy");
    let partial = parent.join(format!(".{file_name}.rawsift.part"));
    if partial.exists() {
        fs::remove_file(&partial)?;
    }

    let copy_result = copy_and_hash(source, &partial);
    let (source_bytes, source_hash) = match copy_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
    };

    let (destination_bytes, destination_hash) = hash_file(&partial)?;
    if source_bytes != destination_bytes {
        let _ = fs::remove_file(&partial);
        return Err(IngestError::SizeMismatch {
            source_bytes,
            destination_bytes,
        });
    }
    if source_hash != destination_hash {
        let _ = fs::remove_file(&partial);
        return Err(IngestError::ChecksumMismatch);
    }

    fs::rename(&partial, destination)?;
    sync_directory(parent);
    Ok(VerifiedCopy {
        bytes: source_bytes,
        blake3: source_hash.to_hex().to_string(),
        destination: destination.to_path_buf(),
    })
}

fn copy_and_hash(source: &Path, partial: &Path) -> Result<(u64, blake3::Hash), IngestError> {
    let input = File::open(source)?;
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(partial)?;
    let mut reader = BufReader::with_capacity(COPY_BUFFER_SIZE, input);
    let mut writer = BufWriter::with_capacity(COPY_BUFFER_SIZE, output);
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; COPY_BUFFER_SIZE];
    let mut total = 0u64;

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        writer.write_all(&buffer[..read])?;
        total += read as u64;
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok((total, hasher.finalize()))
}

pub fn hash_file(path: &Path) -> Result<(u64, blake3::Hash), IngestError> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(COPY_BUFFER_SIZE, file);
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0u8; COPY_BUFFER_SIZE];
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, hasher.finalize()))
}

fn ensure_non_overlapping(source: &Path, destination: &Path) -> Result<(), IngestError> {
    let source = fs::canonicalize(source)?;
    let source_parent = source.parent().ok_or(IngestError::OverlappingPaths)?;
    let destination_parent = destination.parent().ok_or(IngestError::OverlappingPaths)?;
    let destination_parent = canonicalize_allow_missing(destination_parent)?;
    if destination_parent == source_parent
        || destination_parent.starts_with(source_parent)
        || source_parent.starts_with(&destination_parent)
    {
        return Err(IngestError::OverlappingPaths);
    }
    Ok(())
}

fn canonicalize_allow_missing(path: &Path) -> Result<PathBuf, std::io::Error> {
    let mut candidate = path;
    let mut missing: Vec<OsString> = Vec::new();
    while !candidate.exists() {
        if let Some(name) = candidate.file_name() {
            missing.push(name.to_owned());
        }
        candidate = candidate.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no existing destination ancestor",
            )
        })?;
    }
    let mut resolved = fs::canonicalize(candidate)?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[cfg(unix)]
fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) {}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn verified_copy_round_trips_content_and_hash() {
        let source_directory = tempdir().unwrap();
        let destination_directory = tempdir().unwrap();
        let source = source_directory.path().join("DSC00001.ARW");
        let destination = destination_directory.path().join("shoot/DSC00001.ARW");
        let bytes = vec![0x5a; COPY_BUFFER_SIZE + 317];
        File::create(&source).unwrap().write_all(&bytes).unwrap();

        let result = copy_verified(&source, &destination).unwrap();

        assert_eq!(result.bytes, bytes.len() as u64);
        assert_eq!(result.blake3, blake3::hash(&bytes).to_hex().to_string());
        assert_eq!(fs::read(destination).unwrap(), bytes);
    }

    #[test]
    fn never_overwrites_an_existing_destination() {
        let source_directory = tempdir().unwrap();
        let destination_directory = tempdir().unwrap();
        let source = source_directory.path().join("source.ARW");
        let destination = destination_directory.path().join("destination.ARW");
        fs::write(&source, b"source").unwrap();
        fs::write(&destination, b"existing").unwrap();

        let error = copy_verified(&source, &destination).unwrap_err();

        assert!(matches!(error, IngestError::DestinationExists(_)));
        assert_eq!(fs::read(&destination).unwrap(), b"existing");
    }

    #[test]
    fn commit_keeps_pair_names_in_sync_when_one_conflicts() {
        let destination_root = tempdir().unwrap();
        let staging = destination_root.path().join(".rawsift-staging/session");
        let final_directory = destination_root.path().join("2026/2026-09-04_test");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&final_directory).unwrap();
        fs::write(staging.join("DSC00001.JPG"), b"new jpeg").unwrap();
        fs::write(staging.join("DSC00001.ARW"), b"new raw").unwrap();
        fs::write(final_directory.join("DSC00001.JPG"), b"different jpeg").unwrap();

        let result = commit_staging(&staging, &final_directory).unwrap();

        assert_eq!(result.len(), 2);
        assert!(final_directory.join("DSC00001_02.JPG").is_file());
        assert!(final_directory.join("DSC00001_02.ARW").is_file());
        assert_eq!(
            fs::read(final_directory.join("DSC00001.JPG")).unwrap(),
            b"different jpeg"
        );
    }

    #[test]
    fn commit_skips_identical_existing_content() {
        let destination_root = tempdir().unwrap();
        let staging = destination_root.path().join(".rawsift-staging/session");
        let final_directory = destination_root.path().join("shoot");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&final_directory).unwrap();
        fs::write(staging.join("DSC00001.ARW"), b"same raw").unwrap();
        fs::write(final_directory.join("DSC00001.ARW"), b"same raw").unwrap();

        let result = commit_staging(&staging, &final_directory).unwrap();

        assert_eq!(result.len(), 1);
        assert!(matches!(
            result[0].disposition,
            CommitDisposition::AlreadyPresent
        ));
        assert!(!staging.exists());
    }

    #[test]
    fn selected_commit_never_imports_an_unselected_staged_file() {
        let destination_root = tempdir().unwrap();
        let staging = destination_root
            .path()
            .join(".rawsift-staging/session/capture");
        let final_directory = destination_root.path().join("shoot");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("DSC00001.ARW"), b"selected raw").unwrap();
        fs::write(staging.join("DSC00001.JPG"), b"stale jpeg").unwrap();

        let result =
            commit_selected_staging(&staging, &final_directory, &["DSC00001.ARW".to_owned()])
                .unwrap();

        assert_eq!(result.len(), 1);
        assert!(final_directory.join("DSC00001.ARW").is_file());
        assert!(!final_directory.join("DSC00001.JPG").exists());
        assert!(staging.join("DSC00001.JPG").is_file());
    }
}

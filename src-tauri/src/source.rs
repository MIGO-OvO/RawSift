use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::Serialize;
use thiserror::Error;
use walkdir::{DirEntry, WalkDir};

use crate::metadata::{ExifSummary, read_photo_metadata};

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("来源目录不存在或不是文件夹：{0}")]
    InvalidRoot(String),
    #[error("无法读取来源目录：{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Jpeg,
    Raw,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub kind: AssetKind,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub id: String,
    pub stem: String,
    pub captured_at: String,
    pub date_key: String,
    pub preview_path: Option<String>,
    pub jpeg: Option<MediaAsset>,
    pub raw: Option<MediaAsset>,
    pub orientation_degrees: u16,
    pub orientation_mirrored: bool,
    pub exif: Option<ExifSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateGroup {
    pub date_key: String,
    pub capture_count: usize,
    pub paired_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub source_root: String,
    pub source_name: String,
    pub scanned_files: usize,
    pub unsupported_files: usize,
    pub captures: Vec<Capture>,
    pub date_groups: Vec<DateGroup>,
}

#[derive(Default)]
struct CaptureBuilder {
    stem: String,
    captured_at: Option<SystemTime>,
    jpeg: Option<MediaAsset>,
    raw: Option<MediaAsset>,
}

pub fn scan_local_source(root: String, recursive: bool) -> Result<ScanResult, SourceError> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(SourceError::InvalidRoot(root));
    }

    let canonical_root = fs::canonicalize(&root_path)?;
    let max_depth = if recursive { usize::MAX } else { 1 };
    let mut builders: HashMap<String, CaptureBuilder> = HashMap::new();
    let mut scanned_files = 0usize;
    let mut unsupported_files = 0usize;

    let walker = WalkDir::new(&canonical_root)
        .follow_links(false)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(should_visit);

    for entry in walker.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        scanned_files += 1;
        let path = entry.path();
        let Some(kind) = asset_kind(path) else {
            unsupported_files += 1;
            continue;
        };
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            unsupported_files += 1;
            continue;
        };

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                unsupported_files += 1;
                continue;
            }
        };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let canonical_path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let parent = canonical_path.parent().unwrap_or(&canonical_root);
        let group_key = format!(
            "{}\0{}",
            parent.to_string_lossy().to_lowercase(),
            stem.to_lowercase()
        );
        let asset = MediaAsset {
            id: stable_id(&canonical_path.to_string_lossy()),
            kind,
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
                .to_owned(),
            path: canonical_path.to_string_lossy().into_owned(),
            size_bytes: metadata.len(),
        };
        let builder = builders.entry(group_key).or_insert_with(|| CaptureBuilder {
            stem: stem.to_owned(),
            ..CaptureBuilder::default()
        });
        builder.captured_at = Some(
            builder
                .captured_at
                .map_or(modified, |current| current.min(modified)),
        );
        match kind {
            AssetKind::Jpeg => {
                if builder.jpeg.is_none() {
                    builder.jpeg = Some(asset);
                }
            }
            AssetKind::Raw => {
                if builder.raw.is_none() {
                    builder.raw = Some(asset);
                }
            }
        }
    }

    let mut captures: Vec<Capture> = builders
        .into_iter()
        .map(|(key, builder)| build_capture(&key, builder))
        .collect();
    captures.sort_by(|left, right| {
        left.captured_at
            .cmp(&right.captured_at)
            .then_with(|| left.stem.cmp(&right.stem))
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut grouped: BTreeMap<String, DateGroup> = BTreeMap::new();
    for capture in &captures {
        let group = grouped
            .entry(capture.date_key.clone())
            .or_insert(DateGroup {
                date_key: capture.date_key.clone(),
                capture_count: 0,
                paired_count: 0,
                total_bytes: 0,
            });
        group.capture_count += 1;
        group.paired_count += usize::from(capture.jpeg.is_some() && capture.raw.is_some());
        group.total_bytes += capture.jpeg.as_ref().map_or(0, |asset| asset.size_bytes)
            + capture.raw.as_ref().map_or(0, |asset| asset.size_bytes);
    }
    let mut date_groups: Vec<_> = grouped.into_values().collect();
    date_groups.sort_by(|left, right| right.date_key.cmp(&left.date_key));

    let source_name = canonical_root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("本地来源")
        .to_owned();

    Ok(ScanResult {
        source_root: canonical_root.to_string_lossy().into_owned(),
        source_name,
        scanned_files,
        unsupported_files,
        captures,
        date_groups,
    })
}

fn should_visit(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if entry.file_type().is_symlink() {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    !name.starts_with('.') && !name.eq_ignore_ascii_case(".rawsift-staging")
}

fn asset_kind(path: &Path) -> Option<AssetKind> {
    match path
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Some(AssetKind::Jpeg),
        "arw" => Some(AssetKind::Raw),
        _ => None,
    }
}

fn build_capture(key: &str, builder: CaptureBuilder) -> Capture {
    let photo_metadata = builder
        .jpeg
        .as_ref()
        .or(builder.raw.as_ref())
        .map(|asset| read_photo_metadata(Path::new(&asset.path)))
        .unwrap_or_default();
    let file_time = builder.captured_at.unwrap_or(SystemTime::UNIX_EPOCH);
    let local: DateTime<Local> = file_time.into();
    let utc: DateTime<Utc> = file_time.into();
    let captured_at = photo_metadata
        .captured_at
        .unwrap_or_else(|| utc.to_rfc3339_opts(SecondsFormat::Secs, true));
    let date_key = photo_metadata
        .date_key
        .unwrap_or_else(|| local.format("%Y-%m-%d").to_string());
    let preview_path = builder.jpeg.as_ref().map(|asset| asset.path.clone());
    Capture {
        id: stable_id(key),
        stem: builder.stem,
        captured_at,
        date_key,
        preview_path,
        jpeg: builder.jpeg,
        raw: builder.raw,
        orientation_degrees: photo_metadata.orientation_degrees,
        orientation_mirrored: photo_metadata.orientation_mirrored,
        exif: photo_metadata.exif,
    }
}

fn stable_id(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex()[..16].to_owned()
}

#[cfg(test)]
mod tests {
    use std::{fs::File, io::Write};

    use tempfile::tempdir;

    use super::*;

    fn write_file(path: &Path, bytes: &[u8]) {
        let mut file = File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }

    #[test]
    fn pairs_jpeg_and_raw_in_the_same_directory() {
        let directory = tempdir().unwrap();
        write_file(&directory.path().join("DSC00001.JPG"), b"jpeg");
        write_file(&directory.path().join("DSC00001.ARW"), b"raw");

        let result =
            scan_local_source(directory.path().to_string_lossy().into_owned(), true).unwrap();

        assert_eq!(result.captures.len(), 1);
        assert!(result.captures[0].jpeg.is_some());
        assert!(result.captures[0].raw.is_some());
        assert_eq!(result.date_groups[0].paired_count, 1);
    }

    #[test]
    fn does_not_pair_matching_stems_across_directories() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("A")).unwrap();
        fs::create_dir(directory.path().join("B")).unwrap();
        write_file(&directory.path().join("A/DSC00001.JPG"), b"jpeg");
        write_file(&directory.path().join("B/DSC00001.ARW"), b"raw");

        let result =
            scan_local_source(directory.path().to_string_lossy().into_owned(), true).unwrap();

        assert_eq!(result.captures.len(), 2);
        assert!(
            result
                .captures
                .iter()
                .all(|capture| capture.jpeg.is_none() || capture.raw.is_none())
        );
    }

    #[test]
    fn non_recursive_scan_ignores_nested_files() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("nested")).unwrap();
        write_file(&directory.path().join("top.JPG"), b"jpeg");
        write_file(&directory.path().join("nested/inside.ARW"), b"raw");

        let result =
            scan_local_source(directory.path().to_string_lossy().into_owned(), false).unwrap();

        assert_eq!(result.captures.len(), 1);
        assert_eq!(result.captures[0].stem, "top");
    }
}

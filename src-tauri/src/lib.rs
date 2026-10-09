mod devices;
mod ingest;
mod metadata;
mod preview;
mod session_store;
mod source;

use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use serde::{Deserialize, Serialize};
use source::{Capture, MediaAsset, ScanResult};
use tauri::Manager;
use tauri::ipc::Channel;
use uuid::Uuid;

struct AppState {
    registered_source: RwLock<Option<RegisteredSource>>,
    ingest_lock: Arc<Mutex<()>>,
    sessions: session_store::SessionStore,
    operations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AppState {
    fn new(sessions: session_store::SessionStore) -> Self {
        Self {
            registered_source: RwLock::new(None),
            ingest_lock: Arc::new(Mutex::new(())),
            sessions,
            operations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct RegisteredSource {
    root: PathBuf,
    captures: HashMap<String, Capture>,
}

struct OperationLease {
    id: String,
    operations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl OperationLease {
    fn reserve(
        operations: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
        id: &str,
    ) -> Result<Self, String> {
        let mut active = operations.lock().map_err(|_| "导入任务锁已损坏")?;
        if active.contains_key(id) {
            return Err("此批次正在提交，请等待完成".to_owned());
        }
        active.insert(id.to_owned(), Arc::new(AtomicBool::new(false)));
        Ok(Self {
            id: id.to_owned(),
            operations: Arc::clone(operations),
        })
    }
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.operations.lock() {
            active.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ImportMode {
    Jpeg,
    Raw,
    #[serde(rename = "jpeg+raw")]
    JpegAndRaw,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageRequest {
    capture_id: String,
    destination_root: String,
    session_id: String,
    import_mode: ImportMode,
    operation_id: String,
    source_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedAsset {
    name: String,
    bytes: u64,
    blake3: String,
    staging_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRequest {
    destination_root: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitRequest {
    destination_root: String,
    session_id: String,
    relative_folder: String,
    capture_ids: Vec<String>,
    import_mode: ImportMode,
    review_session_id: String,
    source_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitResult {
    files: Vec<ingest::CommittedFile>,
    persistence_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    operation_id: String,
    capture_id: String,
    phase: ingest::Phase,
    file_name: String,
    bytes_processed: u64,
    total_bytes: u64,
    files_completed: usize,
    total_files: usize,
    speed_bytes_per_second: f64,
}

#[tauri::command]
fn cancel_transfer(state: tauri::State<'_, AppState>, operation_id: String) -> Result<(), String> {
    if let Some(cancelled) = state
        .operations
        .lock()
        .map_err(|_| "导入任务锁已损坏")?
        .get(&operation_id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn load_import_history(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<session_store::ImportBatch>, String> {
    state
        .sessions
        .load_import_history()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_source_session(
    state: tauri::State<'_, AppState>,
    source_root: String,
) -> Result<Option<session_store::SessionSnapshot>, String> {
    state
        .sessions
        .load_latest_for_source(&source_root)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn discard_batch(
    state: tauri::State<'_, AppState>,
    request: SessionRequest,
) -> Result<(), String> {
    let id = parse_session_id(&request.session_id)?;
    let root = PathBuf::from(request.destination_root);
    {
        let registered = state
            .registered_source
            .read()
            .map_err(|_| "来源登记锁已损坏")?;
        if let Some(source) = registered.as_ref() {
            ensure_disjoint_roots(&source.root, &root)?;
        }
    }
    let lock = Arc::clone(&state.ingest_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "暂存队列锁已损坏")?;
        let staging = staging_directory(&root, id);
        if staging.exists() {
            ensure_contained(&root, &staging)?;
            std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn discover_photo_devices() -> Result<devices::Discovery, String> {
    tauri::async_runtime::spawn_blocking(devices::discover)
        .await
        .map_err(|error| format!("设备检测任务失败：{error}"))?
}

#[tauri::command]
async fn scan_local_source(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root: String,
    recursive: bool,
) -> Result<ScanResult, String> {
    let result =
        tauri::async_runtime::spawn_blocking(move || source::scan_local_source(root, recursive))
            .await
            .map_err(|error| format!("扫描任务异常终止：{error}"))?
            .map_err(|error| error.to_string())?;

    app.asset_protocol_scope()
        .allow_directory(&result.source_root, recursive)
        .map_err(|error| format!("无法授权预览目录：{error}"))?;

    let registered = RegisteredSource {
        root: PathBuf::from(&result.source_root),
        captures: result
            .captures
            .iter()
            .cloned()
            .map(|capture| (capture.id.clone(), capture))
            .collect(),
    };
    *state
        .registered_source
        .write()
        .map_err(|_| "来源登记锁已损坏".to_owned())? = Some(registered);
    Ok(result)
}

#[tauri::command]
async fn preview_histogram(
    state: tauri::State<'_, AppState>,
    capture_id: String,
) -> Result<preview::PreviewHistogram, String> {
    let jpeg = {
        let registered = state
            .registered_source
            .read()
            .map_err(|_| "来源登记锁已损坏".to_owned())?;
        registered
            .as_ref()
            .and_then(|source| source.captures.get(&capture_id))
            .and_then(|capture| capture.jpeg.clone())
            .ok_or_else(|| "当前照片组没有可分析的 JPEG 预览".to_owned())?
    };

    tauri::async_runtime::spawn_blocking(move || {
        preview::decode_histogram(Path::new(&jpeg.path)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("直方图任务异常终止：{error}"))?
}

#[tauri::command]
async fn preview_thumbnail(
    state: tauri::State<'_, AppState>,
    capture_id: String,
) -> Result<tauri::ipc::Response, String> {
    let path = {
        let registered = state
            .registered_source
            .read()
            .map_err(|_| "来源登记锁已损坏")?;
        registered
            .as_ref()
            .and_then(|source| source.captures.get(&capture_id))
            .and_then(|capture| capture.jpeg.as_ref())
            .map(|jpeg| jpeg.path.clone())
            .ok_or("当前照片组没有 JPEG 预览")?
    };
    let bytes =
        tauri::async_runtime::spawn_blocking(move || preview::decode_thumbnail(Path::new(&path)))
            .await
            .map_err(|error| format!("缩略图任务异常终止：{error}"))?
            .map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn save_session_snapshot(
    state: tauri::State<'_, AppState>,
    snapshot: session_store::SessionSnapshot,
) -> Result<(), String> {
    state
        .sessions
        .save_session(&snapshot)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_last_session(
    state: tauri::State<'_, AppState>,
) -> Result<Option<session_store::SessionSnapshot>, String> {
    state
        .sessions
        .load_latest_active()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_review_update(
    state: tauri::State<'_, AppState>,
    update: session_store::ReviewUpdate,
) -> Result<(), String> {
    state
        .sessions
        .save_review(&update)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_transfer_update(
    state: tauri::State<'_, AppState>,
    update: session_store::TransferUpdate,
) -> Result<(), String> {
    state
        .sessions
        .save_transfer(&update)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_transfer_state(
    state: tauri::State<'_, AppState>,
    session_id: String,
    capture_id: String,
) -> Result<(), String> {
    state
        .sessions
        .remove_transfer(&session_id, &capture_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn stage_capture(
    state: tauri::State<'_, AppState>,
    request: StageRequest,
    on_progress: Channel<TransferProgress>,
) -> Result<Vec<StagedAsset>, String> {
    let session_id = parse_session_id(&request.session_id)?;
    let destination_root = PathBuf::from(request.destination_root);
    let capture_id = request.capture_id;
    let (assets, all_asset_names) = {
        let registered = state
            .registered_source
            .read()
            .map_err(|_| "来源登记锁已损坏".to_owned())?;
        let registered = registered
            .as_ref()
            .ok_or_else(|| "请先扫描照片来源".to_owned())?;
        if registered.root != Path::new(&request.source_root) {
            return Err("来源已改变，请重新选择照片".to_owned());
        }
        ensure_disjoint_roots(&registered.root, &destination_root)?;
        let capture = registered
            .captures
            .get(&capture_id)
            .ok_or_else(|| "照片组不属于当前已登记来源".to_owned())?;
        let assets = assets_for_mode(capture, request.import_mode)?;
        let all_asset_names = [capture.jpeg.as_ref(), capture.raw.as_ref()]
            .into_iter()
            .flatten()
            .map(|asset| asset.name.clone())
            .collect::<Vec<_>>();
        (assets, all_asset_names)
    };
    let ingest_lock = Arc::clone(&state.ingest_lock);
    parse_session_id(&request.operation_id)?;
    let operations = Arc::clone(&state.operations);
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = operations.lock().map_err(|_| "导入任务锁已损坏")?;
        if active.contains_key(&request.operation_id) {
            return Err("导入任务已在运行".to_owned());
        }
        active.insert(request.operation_id.clone(), Arc::clone(&cancelled));
    }
    let operation_id = request.operation_id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ingest_lock
            .lock()
            .map_err(|_| "暂存队列锁已损坏".to_owned())?;
        let staging = capture_staging_directory(&destination_root, session_id, &capture_id);
        ensure_contained(&destination_root, &staging)?;
        let total_files = assets.len();
        let mut last_emit = Instant::now();
        for name in all_asset_names {
            if assets.iter().any(|asset| asset.name == name) {
                continue;
            }
            remove_if_file(&staging.join(&name))?;
            remove_if_file(&staging.join(format!(".{name}.rawsift.part")))?;
        }
        let mut staged = Vec::with_capacity(assets.len());
        for (index, asset) in assets.into_iter().enumerate() {
            let mut phase_started = Instant::now();
            let mut previous_phase = ingest::Phase::Copying;
            let mut progress = |phase, bytes, total| {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(ingest::IngestError::Cancelled);
                }
                if phase != previous_phase || bytes == 0 {
                    phase_started = Instant::now();
                    previous_phase = phase;
                }
                // Throttle IPC to 20 Hz while always reporting stage boundaries.
                if bytes == 0 || bytes == total || last_emit.elapsed().as_millis() >= 50 {
                    let _ = on_progress.send(TransferProgress {
                        operation_id: operation_id.clone(),
                        capture_id: capture_id.clone(),
                        phase,
                        file_name: asset.name.clone(),
                        bytes_processed: bytes,
                        total_bytes: total,
                        files_completed: index,
                        total_files,
                        speed_bytes_per_second: bytes as f64
                            / phase_started.elapsed().as_secs_f64().max(0.001),
                    });
                    last_emit = Instant::now();
                }
                Ok(())
            };
            let destination = staging.join(&asset.name);
            if destination.exists() {
                let (source_bytes, source_hash) =
                    ingest::hash_file_with_progress(Path::new(&asset.path), &mut progress)
                        .map_err(|error| error.to_string())?;
                let (destination_bytes, destination_hash) =
                    ingest::hash_file_with_progress(&destination, &mut progress)
                        .map_err(|error| error.to_string())?;
                if source_bytes == destination_bytes && source_hash == destination_hash {
                    ingest::record_verified(
                        &destination,
                        destination_bytes,
                        destination_hash.to_hex().as_ref(),
                    )
                    .map_err(|error| error.to_string())?;
                    staged.push(StagedAsset {
                        name: asset.name,
                        bytes: destination_bytes,
                        blake3: destination_hash.to_hex().to_string(),
                        staging_path: destination.to_string_lossy().into_owned(),
                    });
                    continue;
                }
                remove_if_file(&destination)?;
            }
            let verified = ingest::copy_verified_with_progress(
                Path::new(&asset.path),
                &destination,
                &mut progress,
            )
            .map_err(|error| error.to_string())?;
            ingest::record_verified(&destination, verified.bytes, &verified.blake3)
                .map_err(|error| error.to_string())?;
            staged.push(StagedAsset {
                name: asset.name,
                bytes: verified.bytes,
                blake3: verified.blake3,
                staging_path: verified.destination.to_string_lossy().into_owned(),
            });
        }
        Ok(staged)
    })
    .await
    .map_err(|error| format!("暂存任务异常终止：{error}"));
    state
        .operations
        .lock()
        .map_err(|_| "导入任务锁已损坏")?
        .remove(&request.operation_id);
    result?
}

#[tauri::command]
async fn unstage_capture(
    state: tauri::State<'_, AppState>,
    request: SessionRequest,
    capture_id: String,
) -> Result<(), String> {
    let session_id = parse_session_id(&request.session_id)?;
    let destination_root = PathBuf::from(request.destination_root);
    let assets = {
        let registered = state
            .registered_source
            .read()
            .map_err(|_| "来源登记锁已损坏".to_owned())?;
        let registered = registered
            .as_ref()
            .ok_or_else(|| "请先扫描照片来源".to_owned())?;
        ensure_disjoint_roots(&registered.root, &destination_root)?;
        let capture = registered
            .captures
            .get(&capture_id)
            .ok_or_else(|| "照片组不属于当前已登记来源".to_owned())?;
        [capture.jpeg.clone(), capture.raw.clone()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
    };
    let ingest_lock = Arc::clone(&state.ingest_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ingest_lock
            .lock()
            .map_err(|_| "暂存队列锁已损坏".to_owned())?;
        let staging = capture_staging_directory(&destination_root, session_id, &capture_id);
        for asset in assets {
            ensure_contained(&destination_root, &staging)?;
            let destination = staging.join(&asset.name);
            let partial = staging.join(format!(".{}.rawsift.part", asset.name));
            remove_if_file(&destination)?;
            remove_if_file(&ingest::verified_record_path(&destination))?;
            remove_if_file(&partial)?;
        }
        remove_directory_if_empty(&staging)?;
        Ok(())
    })
    .await
    .map_err(|error| format!("清理暂存任务异常终止：{error}"))?
}

#[tauri::command]
async fn commit_session(
    state: tauri::State<'_, AppState>,
    request: CommitRequest,
    on_progress: Channel<TransferProgress>,
) -> Result<CommitResult, String> {
    let session_id = parse_session_id(&request.session_id)?;
    let destination_root = PathBuf::from(&request.destination_root);
    let relative_folder = safe_relative_folder(&request.relative_folder)?;
    parse_session_id(&request.review_session_id)?;
    let _lease = OperationLease::reserve(&state.operations, &request.session_id)?;
    if let Some(receipt) = state
        .sessions
        .load_import_batch(&request.session_id)
        .map_err(|e| e.to_string())?
    {
        if receipt.session_id != request.review_session_id
            || receipt.capture_ids != request.capture_ids
            || receipt.destination != destination_root.join(&relative_folder).to_string_lossy()
        {
            return Err("批次标识已用于另一份导入清单".to_owned());
        }
        return Ok(CommitResult {
            files: receipt.files,
            persistence_warning: None,
        });
    }
    let commit_tasks = {
        let registered = state
            .registered_source
            .read()
            .map_err(|_| "来源登记锁已损坏".to_owned())?;
        let registered = registered
            .as_ref()
            .ok_or_else(|| "请先扫描照片来源".to_owned())?;
        if registered.root != Path::new(&request.source_root) {
            return Err("来源已改变，提交已停止".to_owned());
        }
        ensure_disjoint_roots(&registered.root, &destination_root)?;
        let mut unique_ids = std::collections::HashSet::new();
        let mut tasks = Vec::with_capacity(request.capture_ids.len());
        for capture_id in &request.capture_ids {
            if !unique_ids.insert(capture_id) {
                return Err("提交清单包含重复的照片组".to_owned());
            }
            let capture = registered
                .captures
                .get(capture_id)
                .ok_or_else(|| "提交清单包含不属于当前来源的照片组".to_owned())?;
            let names = assets_for_mode(capture, request.import_mode)?
                .into_iter()
                .map(|asset| asset.name)
                .collect::<Vec<_>>();
            tasks.push((capture_id.clone(), names));
        }
        tasks
    };
    if commit_tasks.is_empty() {
        return Err("提交清单为空".to_owned());
    }
    let ingest_lock = Arc::clone(&state.ingest_lock);
    let retained_tasks = commit_tasks.clone();
    let cleanup_root = destination_root.clone();
    let batch_destination = destination_root
        .join(&relative_folder)
        .to_string_lossy()
        .into_owned();
    ensure_contained(&destination_root, Path::new(&batch_destination))?;
    let batch_id = request.session_id.clone();
    let committed = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ingest_lock
            .lock()
            .map_err(|_| "暂存队列锁已损坏".to_owned())?;
        let final_directory = destination_root.join(relative_folder);
        let mut committed = Vec::new();
        let total_files = commit_tasks.iter().map(|(_, names)| names.len()).sum();
        let mut files_completed = 0;
        for (capture_id, names) in commit_tasks {
            let staging = capture_staging_directory(&destination_root, session_id, &capture_id);
            ensure_contained(&destination_root, &staging)?;
            for name in &names {
                let mut started = Instant::now();
                let mut last_emit = Instant::now();
                ingest::verify_recorded_with_progress(
                    &staging.join(name),
                    &mut |phase, bytes, total| {
                        if bytes == 0 {
                            started = Instant::now();
                        }
                        if bytes == 0 || bytes == total || last_emit.elapsed().as_millis() >= 50 {
                            let _ = on_progress.send(TransferProgress {
                                operation_id: batch_id.clone(),
                                capture_id: capture_id.clone(),
                                phase,
                                file_name: name.clone(),
                                bytes_processed: bytes,
                                total_bytes: total,
                                files_completed,
                                total_files,
                                speed_bytes_per_second: bytes as f64
                                    / started.elapsed().as_secs_f64().max(0.001),
                            });
                            last_emit = Instant::now();
                        }
                        Ok(())
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            committed.extend(
                ingest::commit_selected_retained(&staging, &final_directory, &names, &mut |file| {
                    files_completed += 1;
                    let _ = on_progress.send(TransferProgress {
                        operation_id: batch_id.clone(),
                        capture_id: capture_id.clone(),
                        phase: ingest::Phase::Committing,
                        file_name: file.original_name.clone(),
                        bytes_processed: 0,
                        total_bytes: 0,
                        files_completed,
                        total_files,
                        speed_bytes_per_second: 0.0,
                    });
                })
                .map_err(|error| error.to_string())?,
            );
        }
        Ok::<_, String>(committed)
    })
    .await
    .map_err(|error| format!("提交任务异常终止：{error}"))??;
    let batch = session_store::ImportBatch {
        batch_id: request.session_id.clone(),
        session_id: request.review_session_id,
        source_root: request.source_root,
        destination: batch_destination,
        import_mode: match request.import_mode {
            ImportMode::Jpeg => "jpeg",
            ImportMode::Raw => "raw",
            ImportMode::JpegAndRaw => "jpeg+raw",
        }
        .to_owned(),
        capture_ids: request.capture_ids,
        files: committed.clone(),
        completed_at: chrono::Utc::now().to_rfc3339(),
    };
    // Record both the receipt and committed capture states in one DB transaction.
    // Failure leaves staging intact, so a retry can recognize the published files.
    state
        .sessions
        .save_import_batch(&batch)
        .map_err(|e| format!("照片已写入目标，但导入记录保存失败；请重试完成记录：{e}"))?;
    let mut persistence_warning = None;
    for (capture_id, names) in retained_tasks {
        let staging = capture_staging_directory(&cleanup_root, session_id, &capture_id);
        for name in names {
            let _ = remove_if_file(&ingest::verified_record_path(&staging.join(&name)));
            if let Err(error) = remove_if_file(&staging.join(name)) {
                persistence_warning = Some(format!("导入已完成，暂存清理失败：{error}"));
            }
        }
        let _ = remove_directory_if_empty(&staging);
    }
    let _ = remove_directory_if_empty(&staging_directory(&cleanup_root, session_id));
    Ok(CommitResult {
        files: committed,
        persistence_warning,
    })
}

fn assets_for_mode(capture: &Capture, mode: ImportMode) -> Result<Vec<MediaAsset>, String> {
    let mut assets = Vec::with_capacity(2);
    if matches!(mode, ImportMode::Jpeg | ImportMode::JpegAndRaw) {
        assets.push(
            capture
                .jpeg
                .clone()
                .ok_or_else(|| format!("{} 缺少 JPEG", capture.stem))?,
        );
    }
    if matches!(mode, ImportMode::Raw | ImportMode::JpegAndRaw) {
        assets.push(
            capture
                .raw
                .clone()
                .ok_or_else(|| format!("{} 缺少 ARW", capture.stem))?,
        );
    }
    Ok(assets)
}

fn parse_session_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "无效的会话标识".to_owned())
}

fn staging_directory(destination_root: &Path, session_id: Uuid) -> PathBuf {
    destination_root
        .join(".rawsift-staging")
        .join(session_id.to_string())
}

fn capture_staging_directory(
    destination_root: &Path,
    session_id: Uuid,
    capture_id: &str,
) -> PathBuf {
    staging_directory(destination_root, session_id).join(capture_id)
}

fn safe_relative_folder(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("目标子文件夹必须是安全的相对路径".to_owned());
    }
    Ok(path)
}

fn ensure_disjoint_roots(source_root: &Path, destination_root: &Path) -> Result<(), String> {
    let source = std::fs::canonicalize(source_root).map_err(|error| error.to_string())?;
    let destination = std::fs::canonicalize(destination_root).map_err(|error| error.to_string())?;
    if source == destination || source.starts_with(&destination) || destination.starts_with(&source)
    {
        return Err("来源与目标目录不能互相包含".to_owned());
    }
    Ok(())
}

fn ensure_contained(root: &Path, child: &Path) -> Result<(), String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let child = ingest::canonicalize_allow_missing(child).map_err(|e| e.to_string())?;
    if child == root || !child.starts_with(&root) {
        return Err("目标子目录不能通过链接指向照片库以外的位置".to_owned());
    }
    Ok(())
}

fn remove_if_file(path: &Path) -> Result<(), String> {
    if path.is_file() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn remove_directory_if_empty(path: &Path) -> Result<(), String> {
    if path.is_dir()
        && std::fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .next()
            .is_none()
    {
        std::fs::remove_dir(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let database_path = app.path().app_local_data_dir()?.join("rawsift.sqlite3");
            let sessions = session_store::SessionStore::open(&database_path)?;
            app.manage(AppState::new(sessions));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            discover_photo_devices,
            scan_local_source,
            preview_histogram,
            preview_thumbnail,
            save_session_snapshot,
            load_last_session,
            save_review_update,
            save_transfer_update,
            remove_transfer_state,
            stage_capture,
            unstage_capture,
            commit_session,
            cancel_transfer,
            load_import_history,
            load_source_session,
            discard_batch
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RawSift");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn capture_scoped_staging_preserves_same_named_files() {
        let source_root = tempdir().unwrap();
        let destination_root = tempdir().unwrap();
        let first_source = source_root.path().join("A/DSC00001.ARW");
        let second_source = source_root.path().join("B/DSC00001.ARW");
        fs::create_dir_all(first_source.parent().unwrap()).unwrap();
        fs::create_dir_all(second_source.parent().unwrap()).unwrap();
        fs::write(&first_source, b"first capture").unwrap();
        fs::write(&second_source, b"second capture").unwrap();
        let session_id = Uuid::new_v4();
        let first_staging =
            capture_staging_directory(destination_root.path(), session_id, "capture-a");
        let second_staging =
            capture_staging_directory(destination_root.path(), session_id, "capture-b");

        ingest::copy_verified(&first_source, &first_staging.join("DSC00001.ARW")).unwrap();
        ingest::copy_verified(&second_source, &second_staging.join("DSC00001.ARW")).unwrap();
        let final_directory = destination_root.path().join("2026/2026-09-04_test");
        ingest::commit_selected_staging(
            &first_staging,
            &final_directory,
            &["DSC00001.ARW".to_owned()],
        )
        .unwrap();
        ingest::commit_selected_staging(
            &second_staging,
            &final_directory,
            &["DSC00001.ARW".to_owned()],
        )
        .unwrap();

        assert_eq!(
            fs::read(final_directory.join("DSC00001.ARW")).unwrap(),
            b"first capture"
        );
        assert_eq!(
            fs::read(final_directory.join("DSC00001_02.ARW")).unwrap(),
            b"second capture"
        );
    }

    #[test]
    fn rejects_unsafe_destination_subfolders() {
        assert!(safe_relative_folder(r"2026\2026-09-04").is_ok());
        assert!(safe_relative_folder(r"..\outside").is_err());
        assert!(safe_relative_folder(r"C:\outside").is_err());
    }
}

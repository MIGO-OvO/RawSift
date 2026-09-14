import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import type {
  ImportMode,
  PreviewHistogram,
  ReviewStatus,
  ScanResult,
  TransferState,
} from "./types";
import { demoScan } from "./demo";

export function isDesktopRuntime() {
  return isTauri();
}

export interface PhotoDevice {
  id: string;
  name: string;
  root: string | null;
  transport: "msc" | "mtp";
}

export async function discoverPhotoDevices(): Promise<{ devices: PhotoDevice[]; warning: string | null }> {
  if (!isTauri()) return { devices: [], warning: null };
  return invoke("discover_photo_devices");
}

export async function chooseAndScanSource(recursive = true): Promise<ScanResult | null> {
  if (!isTauri()) {
    return demoScan;
  }

  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择只读照片来源",
  });

  if (!selected) {
    return null;
  }

  return scanLocalSource(selected, recursive);
}

export async function scanLocalSource(root: string, recursive = true): Promise<ScanResult> {
  if (!isTauri()) return demoScan;
  return invoke<ScanResult>("scan_local_source", { root, recursive });
}

export async function chooseDestination(): Promise<string | null> {
  if (!isTauri()) return "D:\\Photos";
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择照片库目标目录",
  });
  return selected ?? null;
}

export async function confirmCommit(fileCount: number, destination: string): Promise<boolean> {
  const message = `将 ${fileCount} 次拍摄提交到：\n${destination}\n\n提交前已完成目标端回读校验。是否继续？`;
  if (!isTauri()) return window.confirm(message);
  return confirm(message, {
    title: "确认完成导入",
    kind: "info",
    okLabel: "完成导入",
    cancelLabel: "继续审片",
  });
}

export async function loadPreviewHistogram(captureId: string): Promise<PreviewHistogram> {
  return invoke<PreviewHistogram>("preview_histogram", { captureId });
}

export async function loadPreviewThumbnail(captureId: string): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("preview_thumbnail", { captureId });
  return URL.createObjectURL(new Blob([bytes], { type: "image/bmp" }));
}

export interface PersistedSession {
  sessionId: string;
  sourceRoot: string;
  recursive: boolean;
  activeDate: string;
  currentCaptureId: string | null;
  destinationRoot: string | null;
  shootName: string;
  importMode: ImportMode;
  showInfo: boolean;
  showHistogram: boolean;
  autoAdvance: boolean;
  reviews: Record<string, ReviewStatus>;
  transfers: Record<string, TransferState>;
}

export async function loadLastSession(): Promise<PersistedSession | null> {
  if (!isTauri()) return null;
  return invoke<PersistedSession | null>("load_last_session");
}

export async function saveSessionSnapshot(snapshot: PersistedSession): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("save_session_snapshot", { snapshot });
}

export async function saveReviewUpdate(
  sessionId: string,
  captureId: string,
  status: ReviewStatus,
): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("save_review_update", { update: { sessionId, captureId, status } });
}

export async function saveTransferUpdate(
  sessionId: string,
  captureId: string,
  transfer: TransferState,
): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("save_transfer_update", { update: { sessionId, captureId, transfer } });
}

export async function removeTransferState(sessionId: string, captureId: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("remove_transfer_state", { sessionId, captureId });
}

export interface StageCaptureRequest {
  captureId: string;
  destinationRoot: string;
  sessionId: string;
  importMode: ImportMode;
}

export interface StagedAsset {
  name: string;
  bytes: number;
  blake3: string;
  stagingPath: string;
}

export interface CommittedFile {
  originalName: string;
  destination: string;
  bytes: number;
  blake3: string;
  disposition: "committed" | "alreadyPresent" | "renamedConflict";
}

export interface CommitResult {
  files: CommittedFile[];
  persistenceWarning: string | null;
}

export async function stageCapture(request: StageCaptureRequest): Promise<StagedAsset[]> {
  return invoke<StagedAsset[]>("stage_capture", { request });
}

export async function unstageCapture(
  captureId: string,
  destinationRoot: string,
  sessionId: string,
): Promise<void> {
  return invoke<void>("unstage_capture", {
    captureId,
    request: { destinationRoot, sessionId },
  });
}

export async function commitSession(
  destinationRoot: string,
  sessionId: string,
  relativeFolder: string,
  captureIds: string[],
  importMode: ImportMode,
): Promise<CommitResult> {
  return invoke<CommitResult>("commit_session", {
    request: { destinationRoot, sessionId, relativeFolder, captureIds, importMode },
  });
}

export function imageUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("data:")) return path;
  return isTauri() ? convertFileSrc(path) : null;
}

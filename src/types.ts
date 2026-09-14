export type AssetKind = "jpeg" | "raw";
export type ReviewStatus = "unreviewed" | "keep" | "reject";
export type ImportMode = "jpeg" | "raw" | "jpeg+raw";
export type WorkspaceMode = "single" | "grid" | "compare";
export type StatusFilter = "all" | ReviewStatus | "failed";

export interface MediaAsset {
  id: string;
  kind: AssetKind;
  name: string;
  path: string;
  sizeBytes: number;
}

export interface ExifSummary {
  exposureTime: string | null;
  aperture: string | null;
  iso: number | null;
  focalLength: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  width: number | null;
  height: number | null;
}

export interface PreviewHistogram {
  red: number[];
  green: number[];
  blue: number[];
  luminance: number[];
  sampleCount: number;
  width: number;
  height: number;
}

export interface Capture {
  id: string;
  stem: string;
  capturedAt: string;
  dateKey: string;
  previewPath: string | null;
  jpeg: MediaAsset | null;
  raw: MediaAsset | null;
  orientationDegrees: 0 | 90 | 180 | 270;
  orientationMirrored: boolean;
  exif: ExifSummary | null;
}

export interface DateGroup {
  dateKey: string;
  captureCount: number;
  pairedCount: number;
  totalBytes: number;
}

export interface ScanResult {
  sourceRoot: string;
  sourceName: string;
  scannedFiles: number;
  unsupportedFiles: number;
  captures: Capture[];
  dateGroups: DateGroup[];
}

export interface TransferState {
  status: "queued" | "copying" | "verifying" | "verified" | "committed" | "failed";
  progress: number;
  speedBytesPerSecond?: number;
  error?: string;
}

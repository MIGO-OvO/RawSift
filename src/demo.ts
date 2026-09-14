import type { Capture, ScanResult } from "./types";

const scenes = [
  ["harbor", "#6b8891", "#18272d"],
  ["alley", "#ba7956", "#2a2020"],
  ["platform", "#a2a481", "#2b302f"],
  ["window", "#756c72", "#202226"],
  ["rain", "#627c86", "#171f26"],
  ["neon", "#ad586b", "#27202f"],
] as const;

function preview(label: string, light: string, dark: string, index: number) {
  const x = 22 + ((index * 19) % 46);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067" viewBox="0 0 1600 1067"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="${light}"/></linearGradient><filter id="n"><feTurbulence baseFrequency=".8" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 .08 0"/></filter></defs><rect width="1600" height="1067" fill="url(#g)"/><circle cx="${x}%" cy="42%" r="220" fill="${light}" opacity=".42"/><path d="M0 820L430 510l250 210 250-360 670 707H0z" fill="#0d1113" opacity=".66"/><rect width="1600" height="1067" filter="url(#n)" opacity=".28"/><text x="72" y="980" fill="white" opacity=".64" font-family="sans-serif" font-size="32" letter-spacing="8">${label.toUpperCase()}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeCapture(index: number, dateKey: string): Capture {
  const scene = scenes[index % scenes.length]!;
  const number = String(4512 + index).padStart(5, "0");
  const stem = `DSC${number}`;
  const capturedAt = `${dateKey}T${String(9 + Math.floor(index / 6)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}:${String((index * 13) % 60).padStart(2, "0")}+08:00`;
  return {
    id: `demo-${dateKey}-${index}`,
    stem,
    capturedAt,
    dateKey,
    previewPath: preview(scene[0], scene[1], scene[2], index),
    jpeg: {
      id: `${stem}-jpg`,
      kind: "jpeg",
      name: `${stem}.JPG`,
      path: `${stem}.JPG`,
      sizeBytes: 14_200_000 + index * 37_111,
    },
    raw: {
      id: `${stem}-raw`,
      kind: "raw",
      name: `${stem}.ARW`,
      path: `${stem}.ARW`,
      sizeBytes: 82_600_000 + index * 113_777,
    },
    orientationDegrees: index === 4 || index === 11 ? 90 : 0,
    orientationMirrored: false,
    exif: {
      exposureTime: "1/640",
      aperture: "ƒ/2.8",
      iso: 400,
      focalLength: "70 mm",
      cameraModel: "ILCE-6700",
      lensModel: "E 16-55mm F2.8 G",
      width: 6192,
      height: 4128,
    },
  };
}

const captures = [
  ...Array.from({ length: 18 }, (_, index) => makeCapture(index, "2026-09-04")),
  ...Array.from({ length: 7 }, (_, index) => makeCapture(index + 22, "2026-09-03")),
];

export const demoScan: ScanResult = {
  sourceRoot: "Sony α6700 · USB 3.2",
  sourceName: "Sony α6700",
  scannedFiles: captures.length * 2,
  unsupportedFiles: 14,
  captures,
  dateGroups: ["2026-09-04", "2026-09-03"].map((dateKey) => {
    const items = captures.filter((capture) => capture.dateKey === dateKey);
    return {
      dateKey,
      captureCount: items.length,
      pairedCount: items.filter((capture) => capture.jpeg && capture.raw).length,
      totalBytes: items.reduce(
        (sum, capture) => sum + (capture.jpeg?.sizeBytes ?? 0) + (capture.raw?.sizeBytes ?? 0),
        0,
      ),
    };
  }),
};

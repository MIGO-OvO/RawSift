import type { PreviewHistogram } from "./types";

const BINS = 256;
const MAX_EDGE = 512;

export async function histogramFromImageUrl(source: string): Promise<PreviewHistogram> {
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("无法载入预览以生成直方图"));
  });
  image.src = source;
  await loaded;

  const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前图形环境不支持直方图");
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const red = Array<number>(BINS).fill(0);
  const green = Array<number>(BINS).fill(0);
  const blue = Array<number>(BINS).fill(0);
  const luminance = Array<number>(BINS).fill(0);

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const r = pixels[offset]!;
    const g = pixels[offset + 1]!;
    const b = pixels[offset + 2]!;
    red[r] = (red[r] ?? 0) + 1;
    green[g] = (green[g] ?? 0) + 1;
    blue[b] = (blue[b] ?? 0) + 1;
    const y = Math.round(r * 0.2126 + g * 0.7152 + b * 0.0722);
    luminance[y] = (luminance[y] ?? 0) + 1;
  }

  return { red, green, blue, luminance, sampleCount: width * height, width, height };
}

export function histogramPaths(histogram: PreviewHistogram, logarithmic = false, mode: "rgb" | "luminance" = "rgb") {
  const channels = [histogram.red, histogram.green, histogram.blue, histogram.luminance];
  const selected = mode === "rgb" ? channels.slice(0, 3) : [histogram.luminance];
  const peak = Math.max(1, ...selected.flat());
  return channels.map((channel) => areaPath(channel, peak, logarithmic));
}

function areaPath(values: number[], peak: number, logarithmic: boolean) {
  const width = 256;
  const floor = 100;
  const points = values.map((value, index) => {
    const x = (index / values.length) * width;
    const normalized = logarithmic ? Math.log1p(value) / Math.log1p(peak) : value / peak;
    const y = floor - Math.min(1, normalized) * 96;
    return `L${x.toFixed(2)} ${y.toFixed(2)} L${((index + 1) / values.length * width).toFixed(2)} ${y.toFixed(2)}`;
  });
  return `M0 ${floor} ${points.join(" ")} L${width} ${floor} Z`;
}

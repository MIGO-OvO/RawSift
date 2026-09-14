import { memo, useEffect, useRef, useState } from "react";
import { imageUrl, isDesktopRuntime, loadPreviewThumbnail } from "./native";
import type { Capture } from "./types";

const thumbnails = new Map<string, string>();
let thumbnailWork: Promise<unknown> = Promise.resolve();

// The browser applies JPEG EXIF (including mirrors) once. Demo SVGs have no EXIF.
export const PhotoPreview = memo(function PhotoPreview({ capture, rotation = 0, focus = false, lazy = false }: {
  capture: Capture; rotation?: number; focus?: boolean; lazy?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ source: "", width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [thumbnail, setThumbnail] = useState<{ key: string; url: string } | null>(null);
  const small = lazy && isDesktopRuntime() && !!capture.jpeg;
  const thumbnailKey = `${capture.id}:${capture.jpeg?.sizeBytes}:${capture.capturedAt}`;
  const source = small ? (thumbnail?.key === thumbnailKey ? thumbnail.url : null) : imageUrl(capture.previewPath);
  const needsOrientation = small || source?.startsWith("data:image/svg");
  const angle = (rotation + (needsOrientation ? capture.orientationDegrees : 0)) % 360;
  const quarterTurn = angle % 180 !== 0;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setFailed(false), [source]);

  useEffect(() => {
    if (!small || !host.current) return;
    let cancelled = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      thumbnailWork = thumbnailWork.catch(() => {}).then(async () => {
        if (cancelled) return;
        try {
          let url = thumbnails.get(thumbnailKey);
          if (url) { thumbnails.delete(thumbnailKey); }
          else { url = await loadPreviewThumbnail(capture.id); }
          thumbnails.set(thumbnailKey, url);
          if (thumbnails.size > 128) {
            const oldest = thumbnails.keys().next().value!;
            URL.revokeObjectURL(thumbnails.get(oldest)!);
            thumbnails.delete(oldest);
          }
          if (!cancelled) setThumbnail({ key: thumbnailKey, url });
        } catch { if (!cancelled) setFailed(true); }
      });
    }, { rootMargin: "100px" });
    observer.observe(host.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [small, thumbnailKey, capture.id]);

  const ready = source === size.source && size.width > 0 && box.width > 0;
  const fit = ready ? Math.min(box.width / (quarterTurn ? size.height : size.width), box.height / (quarterTurn ? size.width : size.height)) : 0;
  const scale = focus ? 1 : fit;
  return (
    <div className="photo-preview" ref={host}>
      {source && !failed ? <img
        key={source} alt={capture.stem} src={source} decoding="async" draggable={false}
        loading={lazy ? "lazy" : "eager"}
        onLoad={(event) => setSize({ source, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setFailed(true)}
        style={{ width: ready ? size.width * scale : "100%", height: ready ? size.height * scale : "100%", visibility: ready ? "visible" : "hidden", transform: `translate(-50%, -50%) rotate(${angle}deg) scaleX(${needsOrientation && capture.orientationMirrored ? -1 : 1})` }}
      /> : <span className="preview-message">{failed ? "预览加载失败" : small ? "加载中…" : "暂无 JPEG 预览"}</span>}
    </div>
  );
});

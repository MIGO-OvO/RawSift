import { memo, useEffect, useRef, useState } from "react";
import { imageUrl, isDesktopRuntime, loadPreviewThumbnail } from "./native";
import type { Capture, ViewTransform } from "./types";

const thumbnails = new Map<string, string>();
let thumbnailWork: Promise<unknown> = Promise.resolve();

// The browser applies JPEG EXIF (including mirrors) once. Demo SVGs have no EXIF.
export const PhotoPreview = memo(function PhotoPreview({ capture, rotation = 0, focus = false, lazy = false, transform, onTransformChange }: {
  capture: Capture; rotation?: number; focus?: boolean; lazy?: boolean;
  transform?: ViewTransform; onTransformChange?: (value: ViewTransform) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ source: "", width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [thumbnail, setThumbnail] = useState<{ key: string; url: string } | null>(null);
  const [localTransform, setLocalTransform] = useState<ViewTransform>({ zoom: "fit", x: 0, y: 0 });
  const [pixelRatio, setPixelRatio] = useState(window.devicePixelRatio || 1);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
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
      setPixelRatio(window.devicePixelRatio || 1);
    });
    observer.observe(element);
    const updateDpi = () => setPixelRatio(window.devicePixelRatio || 1);
    window.addEventListener("resize", updateDpi);
    return () => { observer.disconnect(); window.removeEventListener("resize", updateDpi); };
  }, []);
  useEffect(() => setFailed(false), [source]);
  useEffect(() => { setLocalTransform({ zoom: "fit", x: 0, y: 0 }); drag.current = null; }, [capture.id, rotation]);

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
  const viewport = transform ?? localTransform;
  // 100% means one JPEG pixel per physical screen pixel, including high DPI.
  const scale = focus ? 1 / pixelRatio : viewport.zoom === "fit" ? fit : viewport.zoom / pixelRatio;
  const width = (quarterTurn ? size.height : size.width) * scale;
  const height = (quarterTurn ? size.width : size.height) * scale;
  const limitX = width ? Math.max(0, (width - box.width) / 2) / width : 0;
  const limitY = height ? Math.max(0, (height - box.height) / 2) / height : 0;
  const x = Math.max(-limitX, Math.min(limitX, viewport.x));
  const y = Math.max(-limitY, Math.min(limitY, viewport.y));
  const update = (value: ViewTransform) => (onTransformChange ?? setLocalTransform)(value);
  const latest = useRef({ ready, lazy, viewport, scale, width, height, box, pixelRatio, focus, x, y, update });
  latest.current = { ready, lazy, viewport, scale, width, height, box, pixelRatio, focus, x, y, update };
  useEffect(() => {
    const element = host.current!;
    const wheel = (event: WheelEvent) => {
      const state = latest.current;
      if (state.lazy || !state.ready) return;
      event.preventDefault();
      if (state.focus) return;
      const currentZoom = state.viewport.zoom === "fit" ? state.scale * state.pixelRatio : state.viewport.zoom;
      const zoom = Math.min(8, Math.max(0.05, currentZoom * Math.exp(-event.deltaY * 0.002)));
      const ratio = zoom / currentZoom;
      const bounds = element.getBoundingClientRect();
      const anchorX = event.clientX - bounds.left - bounds.width / 2;
      const anchorY = event.clientY - bounds.top - bounds.height / 2;
      state.update({ zoom, x: state.x + anchorX * (1 - ratio) / (state.width * ratio), y: state.y + anchorY * (1 - ratio) / (state.height * ratio) });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div className={`photo-preview ${!lazy && ready ? "interactive-preview" : ""}`} ref={host}
      onDoubleClick={() => { if (!lazy) update({ zoom: viewport.zoom === "fit" ? 1 : "fit", x: 0, y: 0 }); }}
      onPointerDown={event => { if (lazy || event.button !== 0 || !ready) return; drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { const pointer = drag.current; if (!pointer || pointer.id !== event.pointerId || !width || !height) return;
        update({ ...viewport, x: Math.max(-limitX, Math.min(limitX, x + (event.clientX - pointer.x) / width)), y: Math.max(-limitY, Math.min(limitY, y + (event.clientY - pointer.y) / height)) });
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {source && !failed ? <img
        key={source} alt={capture.stem} src={source} decoding="async" draggable={false}
        loading={lazy ? "lazy" : "eager"}
        onLoad={(event) => setSize({ source, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setFailed(true)}
        style={{ width: ready ? size.width * scale : "100%", height: ready ? size.height * scale : "100%", visibility: ready ? "visible" : "hidden", transform: `translate(calc(-50% + ${x * width}px), calc(-50% + ${y * height}px)) rotate(${angle}deg) scaleX(${needsOrientation && capture.orientationMirrored ? -1 : 1})` }}
      /> : <span className="preview-message">{failed ? "预览加载失败" : small ? "加载中…" : "暂无 JPEG 预览"}</span>}
      {source && !failed && !ready && !lazy && <span className="preview-message" role="status">加载预览…</span>}
    </div>
  );
});

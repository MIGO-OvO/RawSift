import { useEffect, useState } from "react";
import { PhotoPreview } from "../PhotoPreview";
import type { Capture, ViewTransform } from "../types";

const fitted = (): ViewTransform => ({ zoom: "fit", x: 0, y: 0 });

export function CompareView({ first, second, rotations, activeSlot, onSlot, onReplace, onSwap, focus }: {
  first: Capture | null; second: Capture | null; rotations: Record<string, number>;
  activeSlot: 0 | 1; onSlot: (slot: 0 | 1) => void; onReplace: (slot: 0 | 1) => void;
  onSwap: () => void; focus: boolean;
}) {
  const [linked, setLinked] = useState(true);
  const [views, setViews] = useState<[ViewTransform, ViewTransform]>([fitted(), fitted()]);
  useEffect(() => { setViews([fitted(), fitted()]); }, [first?.id, second?.id]);
  const update = (slot: 0 | 1, value: ViewTransform) => setViews(previous => linked ? [value, value] : slot === 0 ? [value, previous[1]] : [previous[0], value]);
  const zoom = views[activeSlot].zoom;
  return <section className="compare-view" aria-label="A/B 照片比较">
    <div className="compare-toolbar" role="group" aria-label="比较操作">
      <button type="button" aria-pressed={activeSlot === 0} onClick={() => onSlot(0)}>选择 A</button>
      <button type="button" aria-pressed={activeSlot === 1} onClick={() => onSlot(1)}>选择 B</button>
      <button type="button" onClick={onSwap} disabled={!first || !second}>交换 A/B</button>
      <button type="button" aria-pressed={linked} onClick={() => { if (!linked) setViews([views[activeSlot], views[activeSlot]]); setLinked(value => !value); }}>同步缩放和平移</button>
      <button type="button" aria-pressed={zoom === "fit"} onClick={() => update(activeSlot, fitted())}>适应窗口</button>
      <button type="button" aria-pressed={zoom === 1} onClick={() => update(activeSlot, { zoom: 1, x: 0, y: 0 })}>100%</button>
    </div>
    {[first, second].map((capture, index) => {
      const slot = index as 0 | 1;
      return <div className={`compare-pane ${activeSlot === slot ? "active" : ""}`} key={slot} onPointerDown={() => onSlot(slot)}>
        {capture ? <PhotoPreview capture={capture} rotation={rotations[capture.id]} transform={views[slot]} onTransformChange={value => update(slot, value)} focus={focus} /> : <div className="no-preview"><span>从网格或胶片条选择照片 {slot === 0 ? "A" : "B"}</span></div>}
        <div className="compare-caption"><span>{slot === 0 ? "A" : "B"}</span><strong>{capture?.stem ?? "尚未选择"}</strong><button type="button" aria-label={`替换比较照片 ${slot === 0 ? "A" : "B"}`} onClick={() => onReplace(slot)}>替换</button></div>
      </div>;
    })}
  </section>;
}

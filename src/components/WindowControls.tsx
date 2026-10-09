import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isDesktopRuntime } from "../native";

export function WindowControls({ busy, onError, onCloseBlocked }: { busy: boolean; onError: (message: string) => void; onCloseBlocked: () => void }) {
  const [maximized, setMaximized] = useState(false);
  const latest = useRef({ busy, onError, onCloseBlocked });
  latest.current = { busy, onError, onCloseBlocked };
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const window = getCurrentWindow();
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const attach = (promise: Promise<() => void>) => void promise.then(unlisten => disposed ? unlisten() : unlisteners.push(unlisten)).catch(reason => latest.current.onError(String(reason)));
    const sync = () => void window.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(reason => latest.current.onError(String(reason)));
    sync();
    attach(window.onResized(sync));
    attach(window.onCloseRequested(event => {
      if (latest.current.busy) { event.preventDefault(); latest.current.onCloseBlocked(); }
    }));
    return () => { disposed = true; for (const unlisten of unlisteners) unlisten(); };
  }, []);
  if (!isDesktopRuntime()) return null;
  const run = (operation: () => Promise<unknown>) => void operation().catch(reason => onError(`窗口操作失败：${String(reason)}`));
  return <div className="window-controls" role="group" aria-label="窗口操作">
    <button type="button" aria-label="最小化" title="最小化" onClick={() => run(() => getCurrentWindow().minimize())}><svg viewBox="0 0 16 16"><path d="M3 8h10" /></svg></button>
    <button type="button" aria-label={maximized ? "还原窗口" : "最大化"} title={maximized ? "还原窗口" : "最大化"} onClick={() => run(() => getCurrentWindow().toggleMaximize())}><svg viewBox="0 0 16 16">{maximized ? <path d="M5 3h8v8M3 5h8v8H3z" /> : <path d="M3 3h10v10H3z" />}</svg></button>
    <button className="window-close" type="button" aria-label="关闭窗口" title="关闭窗口" onClick={() => busy ? onCloseBlocked() : run(() => getCurrentWindow().close())}><svg viewBox="0 0 16 16"><path d="m3 3 10 10M13 3 3 13" /></svg></button>
  </div>;
}

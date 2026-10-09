import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icons } from "../icons";
import type { ImportBatch } from "../native";
import type { TransferProgress } from "../types";

export function Modal({ title, children, footer, onClose, locked = false }: {
  title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; locked?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  const close = () => { if (!locked) setClosing(true); };
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => closeRef.current(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 130);
    return () => window.clearTimeout(timer);
  }, [closing]);
  return createPortal(<dialog ref={dialog} className={`modal ${closing ? "closing" : ""}`} aria-labelledby={titleId}
    aria-busy={locked} onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget || locked) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }}>
    <header className="modal-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭弹窗" disabled={locked} onClick={close}><Icons.reject /></button></header>
    <div className="modal-body">{children}</div>
    {footer && <footer className="modal-actions">{footer}</footer>}
  </dialog>, document.body);
}

export function Toast({ message, error = false, onClose }: { message: string; error?: boolean; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (error || paused) return;
    const timer = window.setTimeout(() => closeRef.current(), 4500);
    return () => window.clearTimeout(timer);
  }, [message, error, paused]);
  return <div className={`toast ${error ? "error-toast" : "notice-toast"}`} role={error ? "alert" : "status"}
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    {error ? <Icons.info size={18} /> : <Icons.check size={18} />}<span>{message}</span>
    <button type="button" aria-label="关闭提示" onClick={onClose}><Icons.reject size={16} /></button>
  </div>;
}

export const bytesLabel = (value: number) => value < 1_000_000 ? `${(value / 1000).toFixed(1)} KB` : value < 1_000_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${(value / 1_000_000_000).toFixed(2)} GB`;

export function Progress({ detail, label }: { detail: TransferProgress | null; label?: string }) {
  const committing = detail?.phase === "committing";
  const total = detail ? committing ? detail.totalFiles : detail.totalBytes : 0;
  const done = detail ? committing ? detail.filesCompleted : detail.bytesProcessed : 0;
  const percent = total > 0 ? Math.min(100, done / total * 100) : null;
  return <section className="transfer-progress" aria-label="导入进度">
    <div className="progress-heading"><strong>{label ?? (detail?.phase === "copying" ? "复制原片" : committing ? "提交已校验文件" : "BLAKE3 回读校验")}</strong><span>{percent === null ? "等待进度" : `${Math.floor(percent)}%`}</span></div>
    <div className="progress-track" role="progressbar" aria-label={label ?? "当前阶段进度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <i style={{ transform: `scaleX(${percent === null ? 0 : percent / 100})` }} />
    </div>
    {detail && <><p className="progress-file" title={detail.fileName}>{detail.fileName}</p><div className="progress-details"><span>{detail.filesCompleted} / {detail.totalFiles} 个文件</span>{!committing && <span>{bytesLabel(detail.bytesProcessed)} / {bytesLabel(detail.totalBytes)}</span>}</div>
      {!committing && <p className="progress-speed">{detail.speedBytesPerSecond > 0 ? `${bytesLabel(detail.speedBytesPerSecond)} / s` : "正在准备…"}{detail.phase === "verifying" ? " · 目标端读取" : " · 复制与来源校验"}</p>}</>}
  </section>;
}

export function ImportResult({ batch, onContinue, onResults, onClose }: {
  batch: ImportBatch; onContinue: () => void; onResults: () => void; onClose: () => void;
}) {
  return <Modal title="导入完成" onClose={onClose} footer={<><button className="secondary" type="button" onClick={onResults}>查看结果</button><button className="primary" type="button" onClick={onContinue} autoFocus>继续导入</button></>}>
    <div className="result-summary"><Icons.check size={28} /><p><strong>{batch.files.length} 个文件已安全导入</strong><span>{batch.captureIds.length} 次拍摄 · 目标端 BLAKE3 校验通过</span></p></div>
    <p className="result-path">{batch.destination}</p><p>已完成记录会保留。可以继续选择当前来源中的照片，或打开新的来源。</p>
  </Modal>;
}

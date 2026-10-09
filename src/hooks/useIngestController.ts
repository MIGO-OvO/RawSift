import { useCallback, useEffect, useRef, useState } from "react";
import { cancelTransfer, discardBatch, isDesktopRuntime, removeTransferState, saveTransferUpdate, stageCapture, unstageCapture } from "../native";
import type { Capture, ImportMode, ReviewStatus, TransferState } from "../types";

interface Context {
  sessionId: string; sourceRoot: string; destinationRoot: string | null;
  importMode: ImportMode; ready: boolean; captures: Capture[];
  reviews: Record<string, ReviewStatus>; onError: (message: string) => void;
  pendingBatchId: string; onBatchChange: (id: string) => void;
}
interface Job { key: string; id: string; captureId: string; sessionId: string; revoked: boolean }

// One worker, immutable job context, and identity checks at every async boundary.
// Configuration changes can never make an old verification valid for a new target.
export function useIngestController(context: Context) {
  const [transfers, setTransfers] = useState<Record<string, TransferState>>({});
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const batchId = useRef(context.pendingBatchId);
  const active = useRef<Job | null>(null);
  const cleanup = useRef<Promise<void> | null>(null);
  const key = `${context.sessionId}\0${context.sourceRoot}\0${context.destinationRoot}\0${context.importMode}`;
  const latest = useRef({ context, key, transfers, paused });
  latest.current = { context, key, transfers, paused };
  const previousKey = useRef(key);
  const mounted = useRef(true);

  const persist = useCallback((session: string, id: string, state: TransferState | null) => {
    const task = state ? saveTransferUpdate(session, id, state) : removeTransferState(session, id);
    void task.catch(reason => latest.current.context.onError(`队列记录保存失败：${String(reason)}`));
  }, []);

  const updateTransfer = useCallback((id: string, state: TransferState | null) => {
    const session = latest.current.context.sessionId;
    if (active.current?.captureId === id && (!state || state.status === "queued")) {
      active.current.revoked = true;
      void cancelTransfer(active.current.id).catch(reason => latest.current.context.onError(String(reason)));
    }
    if (!state && latest.current.context.destinationRoot && isDesktopRuntime()) {
      const destination = latest.current.context.destinationRoot;
      const batch = batchId.current;
      const pending = (cleanup.current ?? Promise.resolve()).then(() => unstageCapture(id, destination, batch))
        .catch(reason => latest.current.context.onError(`移除暂存失败，可在下次导入时重试：${String(reason)}`))
        .finally(() => {
          if (cleanup.current === pending) cleanup.current = null;
          if (mounted.current) setRevision(value => value + 1);
        });
      cleanup.current = pending;
    }
    setTransfers(value => {
      const next = { ...value };
      if (state) next[id] = state; else delete next[id];
      return next;
    });
    persist(session, id, state);
  }, [persist]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void cancelTransfer(active.current.id).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (previousKey.current === key) return;
    const sourceChanged = previousKey.current.split("\0")[0] !== context.sessionId;
    const oldKey = previousKey.current.split("\0");
    const oldBatch = batchId.current;
    previousKey.current = key;
    batchId.current = sourceChanged ? context.pendingBatchId : crypto.randomUUID();
    context.onBatchChange(batchId.current);
    setPaused(false);
    if (active.current) void cancelTransfer(active.current.id).catch(reason => context.onError(String(reason)));
    if (!sourceChanged && oldKey[2] && oldKey[2] !== "null") {
      void discardBatch(oldKey[2], oldBatch).catch(reason => context.onError(`旧批次暂存清理失败：${String(reason)}`));
    }
    setTransfers(value => Object.fromEntries(Object.entries(value).map(([id, state]) => [id,
      state.status === "committed" ? state : { status: "queued", progress: 0 } as TransferState,
    ]).filter(([id]) => !sourceChanged || context.captures.some(capture => capture.id === id))));
  }, [key, context.sessionId, context.captures, context.onError]);

  useEffect(() => {
    const job = active.current;
    if (job && (paused || context.reviews[job.captureId] !== "keep" || job.key !== key)) {
      if (!job.revoked) { job.revoked = true; void cancelTransfer(job.id).catch(reason => context.onError(String(reason))); }
    }
    if (active.current || cleanup.current || paused || !context.ready || !context.destinationRoot || !isDesktopRuntime()) return;
    const capture = context.captures.find(item => context.reviews[item.id] === "keep"
      && (!transfers[item.id] || transfers[item.id]?.status === "queued"));
    if (!capture) return;
    const jobContext = context;
    const nextJob: Job = { key, id: crypto.randomUUID(), captureId: capture.id, sessionId: context.sessionId, revoked: false };
    active.current = nextJob;
    const valid = () => mounted.current && latest.current.key === key
      && latest.current.context.reviews[capture.id] === "keep" && active.current === nextJob && !nextJob.revoked && !latest.current.paused;
    const update = (state: TransferState) => {
      if (!valid()) return;
      setTransfers(value => ({ ...value, [capture.id]: state }));
      // Byte ticks are transient; persist only recoverable lifecycle boundaries.
      if (state.status !== "copying" && state.status !== "verifying") persist(nextJob.sessionId, capture.id, state);
    };
    update({ status: "copying", progress: 0 });
    void (async () => {
      try {
        await stageCapture({ captureId: capture.id, destinationRoot: jobContext.destinationRoot!,
          sessionId: batchId.current, operationId: nextJob.id, sourceRoot: jobContext.sourceRoot,
          importMode: jobContext.importMode }, detail => {
          if (detail.operationId !== nextJob.id || detail.captureId !== capture.id) return;
          update({ status: detail.phase === "verifying" ? "verifying" : "copying",
            progress: detail.totalBytes ? Math.min(1, detail.bytesProcessed / detail.totalBytes) : 0,
            speedBytesPerSecond: detail.speedBytesPerSecond, detail });
        });
        update({ status: "verified", progress: 1 });
      } catch (reason) {
        update({ status: "failed", progress: 0, error: String(reason) });
        if (valid()) jobContext.onError(`${capture.stem} 导入失败：${String(reason)}。可在导入清单中重试。`);
      } finally {
        if (active.current === nextJob) active.current = null;
        if (mounted.current) {
          if (latest.current.key === key && latest.current.context.reviews[capture.id] === "keep"
            && latest.current.paused) updateTransfer(capture.id, { status: "cancelled", progress: 0 });
          setRevision(value => value + 1);
        }
      }
    })();
  }, [context, key, paused, persist, revision, transfers, updateTransfer]);

  const retry = useCallback(() => {
    setPaused(false);
    setTransfers(value => Object.fromEntries(Object.entries(value).map(([id, state]) => [id,
      state.status === "failed" || state.status === "cancelled" ? { status: "queued", progress: 0 } : state,
    ])));
  }, []);
  const nextBatch = useCallback(() => {
    const oldBatch = batchId.current;
    if (active.current) {
      active.current.revoked = true;
      void cancelTransfer(active.current.id).catch(reason => latest.current.context.onError(String(reason)));
    }
    batchId.current = crypto.randomUUID();
    latest.current.context.onBatchChange(batchId.current);
    // Other dates may already be staged. Their verification belongs to the old
    // batch, so restage them under the new identity before another commit.
    setTransfers(value => Object.fromEntries(Object.entries(value).map(([id, state]) => [id,
      state.status === "committed" ? state : { status: "queued", progress: 0 },
    ])));
    const destination = latest.current.context.destinationRoot;
    if (destination) void discardBatch(destination, oldBatch).catch(reason => latest.current.context.onError(`暂存清理失败：${String(reason)}`));
  }, []);
  return { transfers, setTransfers, updateTransfer, paused, pause: () => setPaused(true), retry, batchId, nextBatch, workerBusy: active.current !== null || cleanup.current !== null };
}

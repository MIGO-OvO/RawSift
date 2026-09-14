import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PhotoPreview } from "./PhotoPreview";
import { demoScan } from "./demo";
import { histogramFromImageUrl, histogramPaths } from "./histogram";
import { Icons } from "./icons";
import {
  chooseAndScanSource,
  chooseDestination,
  commitSession,
  confirmCommit,
  discoverPhotoDevices,
  imageUrl,
  isDesktopRuntime,
  loadLastSession,
  loadPreviewHistogram,
  removeTransferState,
  saveReviewUpdate,
  saveSessionSnapshot,
  saveTransferUpdate,
  scanLocalSource,
  stageCapture,
  unstageCapture,
} from "./native";
import type { PhotoDevice } from "./native";
import type {
  Capture,
  ImportMode,
  PreviewHistogram,
  ReviewStatus,
  ScanResult,
  StatusFilter,
  TransferState,
  WorkspaceMode,
} from "./types";

const histogramCache = new Map<string, PreviewHistogram>();
let histogramWork: Promise<unknown> = Promise.resolve();
const normalizeSource = (path: string) => path.replace(/^\\\\\?\\/, "").replace(/\//g, "\\").replace(/\\$/, "").toLowerCase();
const deviceContainsSource = (device: PhotoDevice, source: string) => device.root !== null
  && (normalizeSource(source) === normalizeSource(device.root) || normalizeSource(source).startsWith(`${normalizeSource(device.root)}\\`));

function readRotations(): Record<string, number> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("rawsift-rotations") ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => [0, 90, 180, 270].includes(value)));
  } catch { return {}; }
}

const formatBytes = (bytes: number) => {
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
};

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));

function StatusMark({ status }: { status: ReviewStatus }) {
  if (status === "keep") return <span className="status-mark keep"><Icons.check size={14} />保留</span>;
  if (status === "reject") return <span className="status-mark reject"><Icons.reject size={14} />淘汰</span>;
  return <span className="status-mark unreviewed">未审阅</span>;
}

function Histogram({ data, loading }: { data: PreviewHistogram | null; loading: boolean }) {
  const [mode, setMode] = useState<"rgb" | "luminance">("rgb");
  const [logarithmic, setLogarithmic] = useState(false);
  const paths = useMemo(() => (data ? histogramPaths(data, logarithmic, mode) : null), [data, logarithmic, mode]);
  const clipping = (bin: number) => data?.sampleCount ? `${((data.luminance[bin] ?? 0) / data.sampleCount * 100).toFixed(2)}%` : "—";

  return (
    <div className="histogram-panel">
      <div className="histogram-controls">
        <div role="group" aria-label="直方图通道">
          <button aria-pressed={mode === "rgb"} onClick={() => setMode("rgb")} type="button">RGB</button>
          <button aria-pressed={mode === "luminance"} onClick={() => setMode("luminance")} type="button">亮度</button>
        </div>
        <button aria-pressed={logarithmic} onClick={() => setLogarithmic(value => !value)} title="切换线性或对数纵轴，对数可放大较少的像素分布" type="button">{logarithmic ? "对数" : "线性"}</button>
      </div>
      <div className={`histogram ${loading ? "loading" : ""}`} role="img" aria-label={`JPEG 预览的 256 级${mode === "rgb" ? " RGB" : "亮度"}直方图，${logarithmic ? "对数" : "线性"}纵轴`}>
        <svg preserveAspectRatio="none" viewBox="0 0 256 100" aria-hidden="true">
          <path className="histogram-grid" d="M64 0V100 M128 0V100 M192 0V100 M0 25H256 M0 50H256 M0 75H256" />
          {paths && (mode === "rgb" ? <g>
            <path className="histogram-red" d={paths[0]} />
            <path className="histogram-green" d={paths[1]} />
            <path className="histogram-blue" d={paths[2]} />
          </g> : <path className="histogram-luminance" d={paths[3]} />)}
        </svg>
        {!data && <span>{loading ? "正在分析预览…" : "没有可用直方图"}</span>}
      </div>
      <div className="histogram-axis"><span>0 · 黑</span><span>128</span><span>白 · 255</span></div>
      <div className="histogram-clipping" title="缩小 JPEG 预览中亮度为 0 或 255 的采样占比，不代表 RAW 传感器剪切"><span>黑位 {clipping(0)}</span><span>白位 {clipping(255)}</span></div>
      <p className="histogram-note">JPEG 预览采样 · 非 RAW 数据</p>
    </div>
  );
}

function ExifStrip({ capture, position }: { capture: Capture; position?: string }) {
  const exif = capture.exif;
  const megapixels = exif?.width && exif.height
    ? `${((exif.width * exif.height) / 1_000_000).toFixed(1)} MP`
    : null;
  const details = [
    exif?.exposureTime,
    exif?.aperture,
    exif?.iso ? `ISO ${exif.iso}` : null,
    exif?.focalLength,
    megapixels,
  ].filter((value): value is string => Boolean(value));
  const equipment = [exif?.cameraModel, exif?.lensModel].filter(Boolean).join(" · ");

  return (
    <div className="exif-strip" title={equipment || "未读取到机身或镜头信息"}>
      <strong>{capture.stem}</strong>
      {position && <span className="frame-position">{position}</span>}
      <span>{formatTime(capture.capturedAt)}</span>
      {details.length > 0
        ? details.map((detail) => <span key={detail}>{detail}</span>)
        : <span>无可用 EXIF</span>}
    </div>
  );
}

function useHistogram(capture: Capture | null, previewUrl: string | null, enabled: boolean) {
  const [result, setResult] = useState<{ captureId: string; data: PreviewHistogram } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !capture?.jpeg || !previewUrl) return;
    const cacheKey = `${capture.id}:${capture.jpeg.sizeBytes}:${capture.capturedAt}`;
    const cached = histogramCache.get(cacheKey);
    if (cached) {
      setResult({ captureId: capture.id, data: cached });
      setLoadingId(null);
      return;
    }

    let cancelled = false;
    setLoadingId(capture.id);
    // Wait for navigation to settle, then serialize decoding. Skipped frames never read the card.
    const timer = window.setTimeout(() => {
      histogramWork = histogramWork.catch(() => {}).then(async () => {
        if (cancelled) return;
        try {
          const data = await (isDesktopRuntime() ? loadPreviewHistogram(capture.id) : histogramFromImageUrl(previewUrl));
          if (histogramCache.size >= 128) histogramCache.delete(histogramCache.keys().next().value!);
          histogramCache.set(cacheKey, data);
          if (!cancelled) setResult({ captureId: capture.id, data });
        } catch {
          if (!cancelled) setResult(null);
        } finally {
          if (!cancelled) setLoadingId(null);
        }
      });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [capture, enabled, previewUrl]);

  return {
    data: result && result.captureId === capture?.id ? result.data : null,
    loading: loadingId === capture?.id,
  };
}

function DeviceList({ devices, warning, busy, onOpen }: { devices: PhotoDevice[]; warning: string | null; busy: boolean; onOpen: (root?: string) => void }) {
  return <div className="device-list" aria-label="已连接设备">
    <p role="status">{warning || (devices.length ? `已检测到 ${devices.length} 个设备` : "正在等待相机或存储卡连接…")}</p>
    {devices.map(device => <div className="device-row" key={device.id}>
      {device.root ? <button type="button" disabled={busy} onClick={() => onOpen(device.root!)}><Icons.camera size={16} /><span>{device.name}</span><span>打开</span></button>
        : <p><strong>{device.name} · MTP / 便携设备</strong><br />当前不能直接读取此设备。请将相机 USB 连接模式设为 MSC（大容量存储）后重新连接，或使用读卡器。</p>}
    </div>)}
  </div>;
}

function EmptyWorkspace({ onOpen, busy, children }: { onOpen: () => void; busy: boolean; children: React.ReactNode }) {
  return (
    <main className="empty-workspace">
      <div className="empty-icon" aria-hidden="true"><Icons.camera size={28} /></div>
      <h1>连接相机，开始审片</h1>
      <p>Sony α6700、读卡器或本地文件夹均可。RawSift 只读取来源，不会改动原片。</p>
      <button className="primary large" disabled={busy} onClick={onOpen} type="button">
        <Icons.folder />{busy ? "正在扫描…" : "打开照片来源"}
      </button>
      {children}
      <div className="empty-specs">
        <span><Icons.check size={15} />按拍摄日期整理</span>
        <span><Icons.check size={15} />JPG 审片，RAW 导入</span>
        <span><Icons.check size={15} />复制后自动校验</span>
      </div>
    </main>
  );
}

function App() {
  const [scan, setScan] = useState<ScanResult | null>(() => (isDesktopRuntime() ? null : demoScan));
  const [busy, setBusy] = useState(() => isDesktopRuntime());
  const [sessionReady, setSessionReady] = useState(() => !isDesktopRuntime());
  const [sessionCommitted, setSessionCommitted] = useState(false);
  const [activeDate, setActiveDate] = useState<string>(() => demoScan.dateGroups[0]?.dateKey ?? "");
  const [currentId, setCurrentId] = useState<string | null>(() => demoScan.captures[0]?.id ?? null);
  const [reviews, setReviews] = useState<Record<string, ReviewStatus>>({});
  const [transfers, setTransfers] = useState<Record<string, TransferState>>({});
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("single");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [importMode, setImportMode] = useState<ImportMode>("raw");
  const [showInfo, setShowInfo] = useState(true);
  const [showHistogram, setShowHistogram] = useState(true);
  const [focusCheck, setFocusCheck] = useState(false);
  const [rotations, setRotations] = useState<Record<string, number>>(readRotations);
  const [fullScreen, setFullScreen] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devices, setDevices] = useState<PhotoDevice[]>([]);
  const [deviceWarning, setDeviceWarning] = useState<string | null>(null);
  const [showDevices, setShowDevices] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const sourceOperation = useRef(false);
  const commitInFlight = useRef(false);
  const pendingSource = useRef<string | null>(null);
  const attemptedDevices = useRef(new Set<string>());
  const activeDevice = useRef<{ source: string; id: string } | null>(null);
  const [sourceDisconnected, setSourceDisconnected] = useState(false);
  const [destinationRoot, setDestinationRoot] = useState<string | null>(() =>
    isDesktopRuntime() ? null : "D:\\Photos",
  );
  const [shootName, setShootName] = useState(() => (isDesktopRuntime() ? "" : "上海街拍"));
  const undoStack = useRef<Array<{ id: string; previous: ReviewStatus }>>([]);
  const reviewsRef = useRef(reviews);
  const sessionId = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    reviewsRef.current = reviews;
  }, [reviews]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = await loadLastSession();
        if (cancelled) return;
        if (!saved) return;
        pendingSource.current = saved.sourceRoot;
        const restoredScan = await scanLocalSource(saved.sourceRoot, saved.recursive);
        if (cancelled) return;
        pendingSource.current = null;

        const captureIds = new Set(restoredScan.captures.map((capture) => capture.id));
        const restoredReviews = Object.fromEntries(
          Object.entries(saved.reviews).filter(([captureId]) => captureIds.has(captureId)),
        );
        const restoredTransfers: Record<string, TransferState> = {};
        for (const [captureId, status] of Object.entries(restoredReviews)) {
          if (status !== "keep") continue;
          restoredTransfers[captureId] = saved.transfers[captureId]?.status === "committed"
            ? { status: "committed", progress: 1 }
            : { status: "queued", progress: 0 };
        }
        const restoredDate = restoredScan.dateGroups.some((group) => group.dateKey === saved.activeDate)
          ? saved.activeDate
          : restoredScan.dateGroups[0]?.dateKey ?? "";
        const restoredCurrent = saved.currentCaptureId
          && restoredScan.captures.some((capture) => capture.id === saved.currentCaptureId && capture.dateKey === restoredDate)
          ? saved.currentCaptureId
          : restoredScan.captures.find((capture) => capture.dateKey === restoredDate)?.id ?? null;

        sessionId.current = saved.sessionId;
        reviewsRef.current = restoredReviews;
        setScan(restoredScan);
        setActiveDate(restoredDate);
        setCurrentId(restoredCurrent);
        setDestinationRoot(saved.destinationRoot);
        setShootName(saved.shootName);
        setImportMode(saved.importMode);
        setShowInfo(saved.showInfo);
        setShowHistogram(saved.showHistogram);
        setAutoAdvance(saved.autoAdvance);
        setReviews(restoredReviews);
        setTransfers(restoredTransfers);
        setNotice(`已恢复 ${restoredDate} 的审片会话。`);
      } catch (reason) {
        if (!cancelled) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          setError(`上次会话已保留，但来源当前不可用：${detail}`);
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
          setSessionReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const result = await discoverPhotoDevices();
        if (cancelled) return;
        setDevices(result.devices);
        setDeviceWarning(result.warning);
        const connected = new Set(result.devices.map(device => device.id));
        for (const id of attemptedDevices.current) if (!connected.has(id)) attemptedDevices.current.delete(id);
      } catch (reason) {
        if (!cancelled) setDeviceWarning(`设备检测失败，将自动重试；也可手动打开来源。${String(reason)}`);
      } finally {
        // Schedule after completion: slow devices never build up overlapping probes.
        if (!cancelled) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  const capturesForDate = useMemo(
    () => scan?.captures.filter((capture) => capture.dateKey === activeDate) ?? [],
    [scan, activeDate],
  );

  const statusFor = useCallback((id: string): ReviewStatus => reviews[id] ?? "unreviewed", [reviews]);

  const visibleCaptures = useMemo(() => {
    if (filter === "all") return capturesForDate;
    if (filter === "failed") {
      return capturesForDate.filter((capture) => transfers[capture.id]?.status === "failed");
    }
    return capturesForDate.filter((capture) => statusFor(capture.id) === filter);
  }, [capturesForDate, filter, statusFor, transfers]);

  const currentIndex = Math.max(0, visibleCaptures.findIndex((capture) => capture.id === currentId));
  const current = visibleCaptures[currentIndex] ?? visibleCaptures[0] ?? null;

  const rotateCurrent = useCallback((delta: number) => {
    if (!current?.previewPath) return;
    const next = { ...rotations, [current.id]: ((rotations[current.id] ?? 0) + delta + 360) % 360 };
    setRotations(next);
    setFocusCheck(false);
    try { localStorage.setItem("rawsift-rotations", JSON.stringify(next)); }
    catch { setError("旋转已应用，但本地记录保存失败，重启后可能无法保留。"); }
  }, [current, rotations]);

  useEffect(() => {
    if (current && current.id !== currentId) setCurrentId(current.id);
  }, [current, currentId]);

  const counts = useMemo(() => {
    const result = { all: capturesForDate.length, unreviewed: 0, keep: 0, reject: 0, failed: 0 };
    for (const capture of capturesForDate) {
      result[statusFor(capture.id)] += 1;
      if (transfers[capture.id]?.status === "failed") result.failed += 1;
    }
    return result;
  }, [capturesForDate, statusFor, transfers]);

  const kept = useMemo(
    () => capturesForDate.filter((capture) => statusFor(capture.id) === "keep"),
    [capturesForDate, statusFor],
  );

  const queuedBytes = useMemo(
    () => kept.reduce((sum, capture) => {
      if (importMode === "jpeg") return sum + (capture.jpeg?.sizeBytes ?? 0);
      if (importMode === "raw") return sum + (capture.raw?.sizeBytes ?? 0);
      return sum + (capture.jpeg?.sizeBytes ?? 0) + (capture.raw?.sizeBytes ?? 0);
    }, 0),
    [importMode, kept],
  );

  const relativeFolder = useMemo(() => {
    const year = activeDate.slice(0, 4) || new Date().getFullYear().toString();
    const safeName = shootName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
    return `${year}\\${activeDate}${safeName ? `_${safeName}` : ""}`;
  }, [activeDate, shootName]);

  const finalPath = destinationRoot ? `${destinationRoot.replace(/[\\/]$/, "")}\\${relativeFolder}` : null;

  useEffect(() => {
    if (!isDesktopRuntime() || !sessionReady || sessionCommitted || !scan) return;
    const timer = window.setTimeout(() => {
      void saveSessionSnapshot({
        sessionId: sessionId.current,
        sourceRoot: scan.sourceRoot,
        recursive: true,
        activeDate,
        currentCaptureId: currentId,
        destinationRoot,
        shootName,
        importMode,
        showInfo,
        showHistogram,
        autoAdvance,
        reviews: {},
        transfers: {},
      }).catch((reason) => {
        setError(`会话状态保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    activeDate,
    autoAdvance,
    currentId,
    destinationRoot,
    importMode,
    scan,
    sessionCommitted,
    sessionReady,
    shootName,
    showHistogram,
    showInfo,
  ]);

  const openSource = useCallback(async (root?: string) => {
    if (sourceOperation.current || commitInFlight.current) return;
    if (Object.values(transfers).some(transfer => transfer.status === "copying" || transfer.status === "verifying")) {
      setError("照片正在复制或校验，请等待完成后再切换来源。");
      return;
    }
    sourceOperation.current = true;
    setBusy(true);
    setSessionReady(false);
    setError(null);
    try {
      const result = root ? await scanLocalSource(root, true) : await chooseAndScanSource(true);
      if (!result) return;
      pendingSource.current = null;
      setShowDevices(false);
      setFilter("all");
      const newSessionId = crypto.randomUUID();
      const firstDate = result.dateGroups[0]?.dateKey ?? "";
      const firstCaptureId = result.captures.find((capture) => capture.dateKey === firstDate)?.id ?? null;
      sessionId.current = newSessionId;
      setScan(result);
      setActiveDate(firstDate);
      setCurrentId(firstCaptureId);
      reviewsRef.current = {};
      setReviews({});
      setTransfers({});
      setShootName("");
      setSessionCommitted(false);
      undoStack.current = [];
      await saveSessionSnapshot({
        sessionId: newSessionId,
        sourceRoot: result.sourceRoot,
        recursive: true,
        activeDate: firstDate,
        currentCaptureId: firstCaptureId,
        destinationRoot,
        shootName: "",
        importMode,
        showInfo,
        showHistogram,
        autoAdvance,
        reviews: {},
        transfers: {},
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      sourceOperation.current = false;
      setBusy(false);
      setSessionReady(true);
    }
  }, [autoAdvance, destinationRoot, importMode, showHistogram, showInfo, transfers]);

  useEffect(() => {
    if (!scan) return;
    if (activeDevice.current?.source !== scan.sourceRoot) activeDevice.current = null;
    const match = devices.find(device => deviceContainsSource(device, scan.sourceRoot));
    if (!activeDevice.current && match) activeDevice.current = { source: scan.sourceRoot, id: match.id };
    setSourceDisconnected(Boolean(activeDevice.current && !devices.some(device => device.id === activeDevice.current!.id)));
  }, [devices, scan]);

  useEffect(() => {
    if (!sessionReady || busy || scan || sourceOperation.current) return;
    const readable = devices.filter(device => device.root);
    if (pendingSource.current) {
      const match = readable.find(device => deviceContainsSource(device, pendingSource.current!));
      if (match && !attemptedDevices.current.has(match.id)) {
        attemptedDevices.current.add(match.id);
        setBusy(true);
        setSessionReady(false);
        setError(null);
        setRestoreAttempt(value => value + 1);
      }
      return; // Never replace an unavailable saved session with an unrelated card.
    }
    if (readable.length !== 1 || attemptedDevices.current.has(readable[0]!.id)) return;
    attemptedDevices.current.add(readable[0]!.id);
    void openSource(readable[0]!.root!);
  }, [devices, busy, sessionReady, scan, openSource]);

  const navigate = useCallback((delta: number) => {
    if (!visibleCaptures.length) return;
    const next = Math.max(0, Math.min(visibleCaptures.length - 1, currentIndex + delta));
    setCurrentId(visibleCaptures[next]!.id);
  }, [currentIndex, visibleCaptures]);

  const updateTransfer = useCallback((captureId: string, transfer: TransferState | null) => {
    setTransfers((value) => {
      const next = { ...value };
      if (transfer) next[captureId] = transfer;
      else delete next[captureId];
      return next;
    });
    const persistence = transfer
      ? saveTransferUpdate(sessionId.current, captureId, transfer)
      : removeTransferState(sessionId.current, captureId);
    void persistence.catch((reason) => {
      setError(`队列状态保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    });
  }, []);

  const stageOne = useCallback(async (capture: Capture, requestedMode: ImportMode = importMode) => {
    updateTransfer(capture.id, { status: "copying", progress: 0.35 });
    if (!destinationRoot) {
      updateTransfer(capture.id, { status: "queued", progress: 0 });
      return;
    }
    if (!isDesktopRuntime()) {
      window.setTimeout(() => {
        if (reviewsRef.current[capture.id] === "keep") {
          updateTransfer(capture.id, { status: "verified", progress: 1 });
        }
      }, 480);
      return;
    }
    try {
      await stageCapture({
        captureId: capture.id,
        destinationRoot,
        sessionId: sessionId.current,
        importMode: requestedMode,
      });
      if (reviewsRef.current[capture.id] === "keep") {
        updateTransfer(capture.id, { status: "verified", progress: 1 });
      }
    } catch (reason) {
      updateTransfer(capture.id, {
        status: "failed",
        progress: 0,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [destinationRoot, importMode, updateTransfer]);

  const unstageOne = useCallback(async (capture: Capture) => {
    updateTransfer(capture.id, null);
    if (!destinationRoot || !isDesktopRuntime()) return;
    try {
      await unstageCapture(capture.id, destinationRoot, sessionId.current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [destinationRoot, updateTransfer]);

  const mark = useCallback((status: ReviewStatus) => {
    if (!current || !sessionReady || sessionCommitted) return;
    const previous = statusFor(current.id);
    if (previous === status) return;
    undoStack.current.push({ id: current.id, previous });
    const nextReviews = { ...reviewsRef.current, [current.id]: status };
    reviewsRef.current = nextReviews;
    setReviews(nextReviews);
    void saveReviewUpdate(sessionId.current, current.id, status).catch((reason) => {
      setError(`审片状态保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    if (status === "keep") {
      updateTransfer(current.id, { status: "queued", progress: 0 });
      void stageOne(current);
    } else {
      void unstageOne(current);
    }
    if (autoAdvance && status !== "unreviewed") navigate(1);
  }, [autoAdvance, current, navigate, sessionCommitted, sessionReady, stageOne, statusFor, unstageOne, updateTransfer]);

  const undo = useCallback(() => {
    if (!sessionReady || sessionCommitted) return;
    const latest = undoStack.current.pop();
    if (!latest) return;
    const nextReviews = { ...reviewsRef.current, [latest.id]: latest.previous };
    reviewsRef.current = nextReviews;
    setReviews(nextReviews);
    void saveReviewUpdate(sessionId.current, latest.id, latest.previous).catch((reason) => {
      setError(`审片状态保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    setCurrentId(latest.id);
    const capture = scan?.captures.find((item) => item.id === latest.id);
    if (capture && latest.previous === "keep") {
      updateTransfer(capture.id, { status: "queued", progress: 0 });
      void stageOne(capture);
    } else if (capture) {
      void unstageOne(capture);
    }
  }, [scan, sessionCommitted, sessionReady, stageOne, unstageOne, updateTransfer]);

  const pickDestination = useCallback(async () => {
    try {
      const selected = await chooseDestination();
      if (!selected) return;
      setDestinationRoot(selected);
      setNotice("目标目录已设置，保留照片将开始后台暂存。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!destinationRoot || !sessionReady || sessionCommitted) return;
    for (const capture of kept) {
      if (!transfers[capture.id] || transfers[capture.id]?.status === "queued") {
        void stageOne(capture);
      }
    }
  }, [destinationRoot, kept, sessionCommitted, sessionReady, stageOne, transfers]);

  const changeImportMode = useCallback((mode: ImportMode) => {
    if (commitInFlight.current) return;
    if (mode === importMode || sessionCommitted) return;
    setImportMode(mode);
    for (const capture of kept) {
      updateTransfer(capture.id, { status: "queued", progress: 0 });
      void stageOne(capture, mode);
    }
  }, [importMode, kept, sessionCommitted, stageOne, updateTransfer]);

  const finishImport = useCallback(async () => {
    if (commitInFlight.current || sessionCommitted || !kept.length || !kept.every(capture => transfers[capture.id]?.status === "verified")) return;
    if (!destinationRoot) {
      await pickDestination();
      return;
    }
    if (!isDesktopRuntime()) {
      setNotice(`演示会话已就绪：${kept.length} 次拍摄将提交到 ${finalPath}`);
      return;
    }
    commitInFlight.current = true;
    setFinishing(true);
    setSessionReady(false);
    setError(null);
    try {
      if (!await confirmCommit(kept.length, finalPath ?? destinationRoot)) return;
      const result = await commitSession(
        destinationRoot,
        sessionId.current,
        relativeFolder,
        kept.map((capture) => capture.id),
        importMode,
      );
      for (const capture of kept) updateTransfer(capture.id, { status: "committed", progress: 1 });
      setSessionCommitted(true);
      setNotice(`导入完成：${result.files.length} 个文件已提交并验证。`);
      if (result.persistenceWarning) setError(result.persistenceWarning);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      commitInFlight.current = false;
      setFinishing(false);
      setSessionReady(true);
    }
  }, [destinationRoot, finalPath, importMode, kept, pickDestination, relativeFolder, updateTransfer, sessionCommitted, transfers]);

  const preview = imageUrl(current?.previewPath ?? null);
  const histogram = useHistogram(current, preview, showHistogram);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (commitInFlight.current) return;
      const target = event.target;
      if (event.isComposing || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))) return;
      if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat && event.code !== "Space") return;
      if (event.code === "ArrowLeft") navigate(-1);
      else if (event.code === "ArrowRight") navigate(1);
      else if (event.key.toLowerCase() === "p") mark("keep");
      else if (event.key.toLowerCase() === "x") mark("reject");
      else if (event.key.toLowerCase() === "u") mark("unreviewed");
      else if (event.key.toLowerCase() === "g") setWorkspaceMode((mode) => (mode === "grid" ? "single" : "grid"));
      else if (event.key.toLowerCase() === "c") setWorkspaceMode((mode) => (mode === "compare" ? "single" : "compare"));
      else if (event.key.toLowerCase() === "i") setShowInfo((value) => !value);
      else if (event.key.toLowerCase() === "h") setShowHistogram((value) => !value);
      else if (event.key.toLowerCase() === "f") setFullScreen((value) => !value);
      else if (event.key.toLowerCase() === "r") { event.preventDefault(); rotateCurrent(event.shiftKey ? -90 : 90); }
      else if (event.code === "Space") {
        event.preventDefault();
        setFocusCheck(true);
      }
    };
    const release = (event: KeyboardEvent) => {
      if (event.code === "Space") setFocusCheck(false);
    };
    const blur = () => setFocusCheck(false);
    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
    };
  }, [mark, navigate, rotateCurrent, undo]);

  if (!scan) {
    return (
      <div className="app-shell empty-shell">
        <header className="topbar empty-header"><Brand /><button aria-label="设置" className="icon-button" title="设置" type="button"><Icons.settings /></button></header>
        <EmptyWorkspace busy={busy} onOpen={() => void openSource()}>
          <DeviceList devices={devices} warning={deviceWarning} busy={busy} onOpen={openSource} />
        </EmptyWorkspace>
        {error && <div className="toast error-toast">{error}</div>}
      </div>
    );
  }

  const nextCapture = visibleCaptures[Math.min(currentIndex + 1, visibleCaptures.length - 1)] ?? null;
  const allKeptVerified = kept.length > 0 && kept.every((capture) => transfers[capture.id]?.status === "verified");

  return (
    <div className={`app-shell ${fullScreen ? "is-fullscreen" : ""}`} inert={finishing}>
      <header className="topbar">
        <Brand />
        <button className="source-control" disabled={busy} aria-expanded={showDevices} onClick={() => setShowDevices(value => !value)} type="button">
          <Icons.camera size={17} />
          <span><strong>{scan.sourceName}</strong><small>{scan.scannedFiles} 个文件 · {devices.length} 个设备</small></span>
          <Icons.chevronRight className="source-chevron" size={14} />
        </button>
        {showDevices && <div className="device-menu">
          <DeviceList devices={devices} warning={deviceWarning} busy={busy} onOpen={openSource} />
          <button className="primary" disabled={busy} onClick={() => void openSource()} type="button">打开本地文件夹…</button>
        </div>}
        <div className="top-actions">
          <div className="view-switch" aria-label="视图模式">
            <button aria-label="单张视图" aria-pressed={workspaceMode === "single"} className={workspaceMode === "single" ? "active" : ""} onClick={() => setWorkspaceMode("single")} title="单张视图" type="button"><Icons.aperture /></button>
            <button aria-label="网格视图" aria-pressed={workspaceMode === "grid"} className={workspaceMode === "grid" ? "active" : ""} onClick={() => setWorkspaceMode("grid")} title="网格视图 (G)" type="button"><Icons.grid /></button>
            <button aria-label="双图比较" aria-pressed={workspaceMode === "compare"} className={workspaceMode === "compare" ? "active" : ""} onClick={() => setWorkspaceMode("compare")} title="双图比较 (C)" type="button"><Icons.compare /></button>
          </div>
          <span className="top-divider" />
          <button aria-pressed={showInfo} className={showInfo ? "top-tool active" : "top-tool"} onClick={() => setShowInfo((value) => !value)} title="显示照片信息 (I)" type="button"><Icons.info size={17} /><span>信息</span></button>
          <button aria-pressed={showHistogram} className={showHistogram ? "top-tool active" : "top-tool"} onClick={() => setShowHistogram((value) => !value)} title="显示直方图 (H)" type="button"><Icons.histogram size={17} /><span>直方图</span></button>
          <button aria-label="设置" className="icon-button" title="设置" type="button"><Icons.settings /></button>
        </div>
      </header>

      <aside className="source-sidebar">
        <div className="panel-heading"><span>拍摄日期</span><small>{scan.dateGroups.length}</small></div>
        <div className="date-list">
          {scan.dateGroups.map((group) => (
            <button
              className={group.dateKey === activeDate ? "date-card active" : "date-card"}
              key={group.dateKey}
              onClick={() => {
                setActiveDate(group.dateKey);
                setCurrentId(scan.captures.find((capture) => capture.dateKey === group.dateKey)?.id ?? null);
              }}
              type="button"
            >
              <span className="date-day">{group.dateKey.slice(8)}</span>
              <span className="date-copy"><strong>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(`${group.dateKey}T12:00:00`))}</strong><small>{group.captureCount} 张 · {formatBytes(group.totalBytes)}</small></span>
              <span className="pair-count">{group.pairedCount}<small>组</small></span>
            </button>
          ))}
        </div>
        <div className="scan-summary">
          <div><span>照片来源</span><strong>{scan.sourceRoot}</strong></div>
          {scan.unsupportedFiles > 0 && <div><span>已忽略</span><strong>{scan.unsupportedFiles} 个不支持的文件</strong></div>}
          <div className="read-only"><Icons.check size={16} /><span><strong>原片保持只读</strong><small>不会修改来源中的文件</small></span></div>
        </div>
      </aside>

      <main className="workspace">
        <div className="filterbar">
          {(["all", "unreviewed", "keep", "reject", "failed"] as StatusFilter[]).map((item) => {
            const labels: Record<StatusFilter, string> = { all: "全部", unreviewed: "未审阅", keep: "保留", reject: "淘汰", failed: "失败" };
            return <button className={filter === item ? "active" : ""} key={item} onClick={() => setFilter(item)} type="button">{labels[item]}<span>{counts[item]}</span></button>;
          })}
          <span className="review-progress">已审 {counts.keep + counts.reject} / {counts.all}</span>
        </div>

        {workspaceMode === "grid" ? (
          <GridView captures={visibleCaptures} currentId={current?.id ?? null} onOpen={(id) => { setCurrentId(id); setWorkspaceMode("single"); }} statusFor={statusFor} rotations={rotations} />
        ) : workspaceMode === "compare" ? (
          <CompareView first={current} second={nextCapture} statusFor={statusFor} rotations={rotations} />
        ) : (
          <section className={`viewer ${focusCheck ? "focus-check" : ""}`}>
            <div className="viewer-stage">
              {current && preview ? <PhotoPreview capture={current} rotation={rotations[current.id]} focus={focusCheck} /> : <div className="no-preview"><Icons.aperture size={38} /><span>暂无可用预览</span></div>}
              {current && preview && <div className="viewer-tools" role="group" aria-label="照片显示操作">
                <span aria-live="polite">{focusCheck ? "100% · 松开空格适应窗口" : (rotations[current.id] ?? 0) ? `本地旋转 ${rotations[current.id]}°` : "自动方向 · 适应窗口"}</span>
                <button onClick={() => rotateCurrent(-90)} title="向左旋转 90° (Shift+R)，仅本地显示，不修改原片" aria-label="向左旋转" type="button"><Icons.rotate className="rotate-left" /><span>左转</span></button>
                <button onClick={() => rotateCurrent(90)} title="向右旋转 90° (R)，仅本地显示，不修改原片" aria-label="向右旋转" type="button"><Icons.rotate /><span>右转</span><kbd>R</kbd></button>
              </div>}
              <button className="nav-arrow left" disabled={currentIndex === 0} onClick={() => navigate(-1)} title="上一张" type="button"><Icons.chevronLeft /></button>
              <button className="nav-arrow right" disabled={currentIndex >= visibleCaptures.length - 1} onClick={() => navigate(1)} title="下一张" type="button"><Icons.chevronRight /></button>
            </div>
          </section>
        )}

        {current && workspaceMode === "single" && <ExifStrip capture={current} position={`${currentIndex + 1} / ${visibleCaptures.length}`} />}
        <Filmstrip captures={capturesForDate} currentId={current?.id ?? null} onSelect={setCurrentId} statusFor={statusFor} rotations={rotations} />
        {current && (
          <div className="decision-bar">
            <button className="decision reject" disabled={sessionCommitted} onClick={() => mark("reject")} type="button"><Icons.reject /><span>淘汰</span><kbd>X</kbd></button>
            <button className="decision reset" disabled={sessionCommitted} onClick={() => mark("unreviewed")} type="button"><span>重置</span><kbd>U</kbd></button>
            <StatusMark status={statusFor(current.id)} />
            <button className="decision keep" disabled={sessionCommitted} onClick={() => mark("keep")} type="button"><Icons.check /><span>保留</span><kbd>P</kbd></button>
          </div>
        )}
      </main>

      <aside className="queue-sidebar">
        <div className="panel-heading queue-title"><span>导入</span><small>{kept.length} 张</small></div>
        <div className="inspector-scroll">
          <section className="inspector-section import-settings">
            <h2>文件格式</h2>
            <div className="import-mode" role="group" aria-label="导入模式">
              {(["jpeg", "raw", "jpeg+raw"] as ImportMode[]).map((mode) => <button aria-pressed={importMode === mode} className={importMode === mode ? "active" : ""} disabled={sessionCommitted} key={mode} onClick={() => changeImportMode(mode)} type="button">{mode === "jpeg+raw" ? "JPG + RAW" : mode.toUpperCase()}</button>)}
            </div>
          </section>
          <section className="inspector-section destination-card">
            <h2>保存位置</h2>
            <button className="destination-path" disabled={sessionCommitted} onClick={pickDestination} title="选择保存位置" type="button">
              <Icons.folder size={16} /><span>{finalPath ?? "选择目标目录"}</span><Icons.chevronRight size={14} />
            </button>
            <label className="shoot-name">
              <span>子文件夹名称</span>
              <input disabled={sessionCommitted} maxLength={80} onChange={(event) => setShootName(event.target.value)} placeholder="例如：上海街拍" value={shootName} />
            </label>
          </section>
          {current && showInfo && (
            <section className="inspector-section photo-information">
              <h2>照片信息</h2>
              <dl>
                <div><dt>文件名</dt><dd>{current.stem}</dd></div>
                <div><dt>相机</dt><dd>{current.exif?.cameraModel ?? "未知"}</dd></div>
                <div><dt>镜头</dt><dd>{current.exif?.lensModel ?? "未知"}</dd></div>
                <div><dt>尺寸</dt><dd>{current.exif?.width && current.exif.height ? `${current.exif.width} × ${current.exif.height}` : "未知"}</dd></div>
                <div><dt>快门 / 光圈</dt><dd>{current.exif?.exposureTime ?? "—"} · {current.exif?.aperture ?? "—"}</dd></div>
                <div><dt>ISO / 焦距</dt><dd>{current.exif?.iso ?? "—"} · {current.exif?.focalLength ?? "—"}</dd></div>
                <div><dt>拍摄时间</dt><dd>{current.dateKey} {formatTime(current.capturedAt)}</dd></div>
                <div><dt>原始文件</dt><dd>{[current.jpeg, current.raw].filter(asset => asset !== null).map(asset => `${asset.kind.toUpperCase()} ${formatBytes(asset.sizeBytes)}`).join(" · ")}</dd></div>
              </dl>
            </section>
          )}
          {current && showHistogram && (
            <section className="inspector-section histogram-section">
              <h2>直方图</h2>
              <Histogram data={histogram.data} loading={histogram.loading} />
            </section>
          )}
          <section className="inspector-section queue-section">
            <h2><span>预导入清单</span><small>{kept.length}</small></h2>
            <div className="queue-list">
              {kept.length === 0 ? (
                <div className="queue-empty"><Icons.list size={24} /><strong>尚未选择照片</strong><span>按 P 将当前照片加入清单。</span></div>
              ) : kept.map((capture) => {
                const transfer = transfers[capture.id]?.status ?? "queued";
                const transferLabels = { queued: "等待目标", copying: "正在复制", verifying: "正在校验", verified: "已校验", committed: "已导入", failed: "失败" };
                return (
                  <button className={capture.id === current?.id ? "queue-row active" : "queue-row"} key={capture.id} onClick={() => setCurrentId(capture.id)} type="button">
                    <PhotoPreview capture={capture} rotation={rotations[capture.id]} lazy />
                    <span><strong>{capture.stem}</strong><small>{importMode === "raw" ? formatBytes(capture.raw?.sizeBytes ?? 0) : importMode === "jpeg" ? formatBytes(capture.jpeg?.sizeBytes ?? 0) : formatBytes((capture.jpeg?.sizeBytes ?? 0) + (capture.raw?.sizeBytes ?? 0))}</small></span>
                    <span className={`transfer-state ${transfer}`}><i />{transferLabels[transfer]}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
        <div className="queue-footer">
          <div className="import-total"><span>预计导入</span><strong>{formatBytes(queuedBytes)}</strong></div>
          <div><span>选择后自动前进</span><button className={autoAdvance ? "switch on" : "switch"} aria-label="选择后自动前进" aria-pressed={autoAdvance} onClick={() => setAutoAdvance((value) => !value)} type="button"><i /></button></div>
          <button className="primary finish" disabled={!allKeptVerified || sessionCommitted || finishing} onClick={finishImport} type="button"><span>{finishing ? "正在完成导入…" : sessionCommitted ? "导入已完成" : "完成导入"}</span><small>{sessionCommitted ? `${kept.length} 次拍摄` : `已验证 ${kept.filter((capture) => transfers[capture.id]?.status === "verified").length} / ${kept.length}`}</small></button>
        </div>
      </aside>

      <footer className="statusbar">
        <div><Icons.check size={13} />来源只读</div>
        <div className="shortcut-hints"><span><kbd>P</kbd>保留</span><span><kbd>X</kbd>淘汰</span><span><kbd>R</kbd>右转 · Shift 左转</span><span><kbd>Space</kbd>100% 检查</span><span><kbd>G</kbd>网格</span><span><kbd>F</kbd>全屏</span></div>
        <div role="status">{sourceDisconnected ? "来源已断开，请重新连接同一设备；审片记录仍保留" : scan.sourceName}</div>
      </footer>
      {error && <div className="toast error-toast">{error}</div>}
      {notice && <button className="toast notice-toast" onClick={() => setNotice(null)} type="button">{notice}</button>}
    </div>
  );
}

function Brand() {
  return <div className="brand"><strong>RawSift</strong></div>;
}

function GridView({ captures, currentId, onOpen, statusFor, rotations }: { captures: Capture[]; currentId: string | null; onOpen: (id: string) => void; statusFor: (id: string) => ReviewStatus; rotations: Record<string, number> }) {
  return (
    <section className="grid-view">
      {captures.map((capture, index) => {
        return (
          <button className={`grid-cell ${capture.id === currentId ? "active" : ""}`} key={capture.id} onDoubleClick={() => onOpen(capture.id)} onClick={() => onOpen(capture.id)} type="button">
            <PhotoPreview capture={capture} rotation={rotations[capture.id]} lazy />
            <span className="grid-index">{String(index + 1).padStart(3, "0")}</span>
            <StatusMark status={statusFor(capture.id)} />
            <span className="grid-name">{capture.stem}<small>{capture.jpeg && capture.raw ? "J+R" : capture.raw ? "RAW" : "JPG"}</small></span>
          </button>
        );
      })}
    </section>
  );
}

function CompareView({ first, second, statusFor, rotations }: { first: Capture | null; second: Capture | null; statusFor: (id: string) => ReviewStatus; rotations: Record<string, number> }) {
  return (
    <section className="compare-view">
      {[first, second].map((capture, index) => {
        return (
          <div className="compare-pane" key={index}>
            {capture ? <PhotoPreview capture={capture} rotation={rotations[capture.id]} /> : <div className="no-preview"><Icons.aperture size={36} /></div>}
            {capture && <div className="compare-caption"><span>{index === 0 ? "A" : "B"}</span><strong>{capture.stem}</strong><StatusMark status={statusFor(capture.id)} /></div>}
          </div>
        );
      })}
      <div className="sync-badge">同步查看</div>
    </section>
  );
}

function Filmstrip({ captures, currentId, onSelect, statusFor, rotations }: { captures: Capture[]; currentId: string | null; onSelect: (id: string) => void; statusFor: (id: string) => ReviewStatus; rotations: Record<string, number> }) {
  const currentIndex = captures.findIndex((capture) => capture.id === currentId);
  const start = Math.max(0, currentIndex - 6);
  const visible = captures.slice(start, start + 14);
  return (
    <nav className="filmstrip" aria-label="照片胶片条">
      {visible.map((capture, index) => {
        return (
          <button className={`film-frame ${capture.id === currentId ? "active" : ""} ${statusFor(capture.id)}`} key={capture.id} onClick={() => onSelect(capture.id)} title={capture.stem} type="button">
            <PhotoPreview capture={capture} rotation={rotations[capture.id]} lazy />
            <small>{start + index + 1}</small>
          </button>
        );
      })}
    </nav>
  );
}

export default App;

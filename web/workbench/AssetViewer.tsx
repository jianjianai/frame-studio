import { useCallback, useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";

/** What src/preview/asset.ts says about the file it shows (same origin). */
interface AssetInfo {
  kind: "model" | "lottie" | "environment" | "font";
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  frames?: number;
  animations?: { name: string; duration: number }[];
  triangles?: number;
  meshes?: number;
  materials?: number;
  textures?: number;
  skinned?: boolean;
  dimensions?: [number, number, number];
}
interface PageApi {
  ready: boolean;
  error?: string;
  info: AssetInfo | null;
  show(options: { time?: number; animation?: string }): Promise<void>;
}

/** One line on what the file holds. */
export function assetSummary(info: AssetInfo) {
  if (info.kind === "model")
    return [
      `三维模型`,
      `${(info.triangles ?? 0).toLocaleString()} 个三角形`,
      info.dimensions && `尺寸 ${info.dimensions.join(" × ")}`,
      info.skinned && "带骨骼",
      info.animations?.length ? `${info.animations.length} 个动画` : "没有动画",
    ]
      .filter(Boolean)
      .join(" · ");
  if (info.kind === "lottie") return `Lottie 动画 · ${info.width}×${info.height} · ${info.fps} fps · ${info.duration} 秒`;
  if (info.kind === "environment") return `全景图 · ${info.width}×${info.height}（三维场景的环境光）`;
  return "字体";
}

/**
 * A model, Lottie animation, HDR/EXR panorama or font in an editor tab, drawn by the engine
 * (src/preview/asset.ts): models turn with the mouse and play their animations, Lottie plays.
 * `src` is an asset address under `assetBase` (films/<work>/… or materials/<library>/…).
 */
export function AssetViewer({ assetBase, src, version }: { assetBase: string; src: string; version?: string | number }) {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [page, setPage] = useState<PageApi | null>(null);
  const [failure, setFailure] = useState("");
  const [animation, setAnimation] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const url = `/preview/asset.html?${new URLSearchParams({ assetBase, src, ...(version !== undefined ? { v: String(version) } : {}) })}`;

  // The page opens the file; wait until it says it is ready (or why not).
  const attach = useCallback(() => {
    setPage(null);
    setFailure("");
    const started = Date.now();
    const timer = setInterval(() => {
      const found = (frame?.contentWindow as unknown as { __FRAME_ASSET__?: PageApi } | null)?.__FRAME_ASSET__;
      if (found?.ready) {
        clearInterval(timer);
        setPage(found);
      } else if (found?.error) {
        clearInterval(timer);
        setFailure(found.error);
      } else if (Date.now() - started > 60000) {
        clearInterval(timer);
        setFailure("加载超时");
      }
    }, 100);
    return () => clearInterval(timer);
  }, [frame]);

  const info = page?.info ?? null;
  const clip = info?.kind === "model" ? (info.animations?.find((item) => item.name === animation) ?? info.animations?.[0]) : undefined;
  const duration = info?.kind === "lottie" ? (info.duration ?? 0) : (clip?.duration ?? 0);
  useEffect(() => {
    if (!page) return;
    let current = true;
    page.show({ time, animation: clip?.name }).then(
      () => current && setFailure(""),
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [page, time, clip?.name]);
  // Playing: time runs in real time and loops.
  useEffect(() => {
    if (!playing || !duration) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setTime((value) => (value + (now - last) / 1000) % duration);
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  return (
    <div className="resource-viewer">
      <div className="resource-body">
        <div className="resource-stage">
          <iframe key={url} ref={setFrame} src={url} title="素材预览" onLoad={attach} />
          {failure && <div className="resource-error">{failure}</div>}
        </div>
      </div>
      {info && (
        <div className="asset-viewer-bar">
          {duration > 0 && (
            <>
              <button className="icon-btn" onClick={() => setPlaying(!playing)} title={playing ? "暂停" : "播放"}>
                {playing ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <input type="range" min={0} max={duration} step={0.01} value={Math.min(time, duration)} onChange={(event) => (setPlaying(false), setTime(Number(event.target.value)))} />
              <span className="mono small-text">{time.toFixed(2)}s</span>
            </>
          )}
          {info.kind === "model" && (info.animations?.length ?? 0) > 1 && (
            <select className="input small" value={clip?.name ?? ""} onChange={(event) => (setAnimation(event.target.value), setTime(0))} title="动画">
              {info.animations!.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}（{item.duration.toFixed(2)} 秒）
                </option>
              ))}
            </select>
          )}
          <span className="faint small-text ellipsis grow">
            {assetSummary(info)}
            {info.kind === "model" ? " · 拖动旋转，双击复原" : ""}
          </span>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { formatBytes, useServerEvent } from "../lib/api";
import { onPrecacheProgress, requestPrecache, type PrecacheProgress } from "../lib/precache";
import { useToast } from "../lib/ui";
import { useWorkbench } from "./store";

/** Thin loading bar along the top of the window while the work's assets are being cached. */
export function PrecacheBar() {
  const { work } = useWorkbench();
  const toast = useToast();
  const key = `${work.repo}/${work.id}`;
  const [progress, setProgress] = useState<PrecacheProgress | null>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<number>(undefined);

  useEffect(() => {
    setProgress(null);
    const stop = onPrecacheProgress((next) => {
      if (next.key !== key) return;
      setProgress(next);
      window.clearTimeout(timer.current);
      if (next.state === "running" && next.doneBytes < next.totalBytes) setVisible(true);
      // Let the bar reach the end before it fades out.
      else timer.current = window.setTimeout(() => setVisible(false), next.state === "error" ? 4000 : 500);
      if (next.state === "error") toast("素材缓存未完成：" + (next.error || "未知错误"), "error");
    });
    void requestPrecache(work.repo, work.id).catch(() => {});
    return () => {
      stop();
      window.clearTimeout(timer.current);
    };
  }, [key, work.repo, work.id, toast]);

  // Changed or added files are cached again (only those whose version changed).
  const debounce = useRef<number>(undefined);
  useServerEvent((event) => {
    if (event.type !== "work-files" || event.work !== work.id || event.repo !== work.repo) return;
    if (!(event.files as string[]).some((file) => /^projects\/[^/]+\/public\//.test(file))) return;
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void requestPrecache(work.repo, work.id).catch(() => {}), 400);
  });

  if (!progress) return null;
  const ratio = progress.totalBytes ? progress.doneBytes / progress.totalBytes : 1;
  const title =
    progress.state === "error"
      ? `素材缓存未完成：${progress.error ?? ""}`
      : `正在缓存播放素材：${progress.doneFiles}/${progress.totalFiles} 个文件，${formatBytes(progress.doneBytes)} / ${formatBytes(progress.totalBytes)}`;
  return (
    <div
      className={`precache-bar ${visible ? "visible" : ""} ${progress.state === "error" ? "error" : ""}`}
      role="progressbar"
      aria-label="素材缓存进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      title={title}
    >
      <div style={{ width: `${Math.max(2, ratio * 100)}%` }} />
    </div>
  );
}

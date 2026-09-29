import type { AudioTransport } from "../engine/audio";
import type { AnimationProject } from "../engine/types";
import type { ExportProgress } from "../engine/browser-export";
import { downloadBlob } from "../engine/download";
interface PlayerExportOptions {
  loading: boolean;
  reportExport: (
    id: string | undefined,
    result: Record<string, unknown>,
  ) => void;
  lastExport: { current: Blob | null };
  project: AnimationProject;
  transport: { current: AudioTransport | null };
  exportAbort: { current: AbortController | null };
  publish: () => void;
  setError: (error: string) => void;
  setExporting: (value: boolean) => void;
  setExportOpen: (value: boolean) => void;
  setExportProgress: (value: ExportProgress | null) => void;
  exportToDisk: boolean;
  exportWidth: number;
  exportFps: number;
  subtitleRef: { current: boolean };
}

export async function exportPlayerVideo(
  {
    project,
    transport,
    exportAbort,
    publish,
    setError,
    setExporting,
    setExportOpen,
    setExportProgress,
    exportToDisk,
    exportWidth,
    exportFps,
    subtitleRef,
    loading,
    reportExport,
    lastExport,
  }: PlayerExportOptions,
  options?: {
    requestId: string;
    width: number;
    fps: number;
    start?: number;
    end?: number;
    subtitles: boolean;
  },
) {
  const sound = transport.current;
  if (!sound || loading || exportAbort.current) {
    reportExport(options?.requestId, {
      state: "failed",
      error: "播放器未就绪或已有导出正在进行",
    });
    return;
  }
  if (
    options &&
    (!Number.isInteger(options.width) ||
      options.width < 2 ||
      options.width % 2 !== 0 ||
      options.width > 3840 ||
      !Number.isInteger(options.fps) ||
      options.fps < 1 ||
      options.fps > 120 ||
      typeof options.subtitles !== "boolean")
  ) {
    reportExport(options.requestId, {
      state: "failed",
      error: "导出参数无效",
    });
    return;
  }
  lastExport.current = null;
  const abort = new AbortController();
  exportAbort.current = abort;
  sound.pause();
  publish();
  setError("");
  setExporting(true);
  setExportOpen(false);
  setExportProgress({ phase: "preparing", completed: 0, total: 0 });
  reportExport(options?.requestId, {
    state: "running",
    progress: { phase: "preparing", completed: 0, total: 0 },
  });
  try {
    type FileWriter = {
      write(chunk: unknown): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    };
    const picker = (
      window as unknown as {
        showSaveFilePicker?: (
          options: unknown,
        ) => Promise<{ createWritable(): Promise<FileWriter> }>;
      }
    ).showSaveFilePicker;
    const writer =
      !options && exportToDisk && picker
        ? await (
            await picker.call(window, {
              suggestedName: project.id + ".webm",
              types: [
                {
                  description: "WebM 视频",
                  accept: { "video/webm": [".webm"] },
                },
              ],
            })
          ).createWritable()
        : undefined;
    let blob: Blob | null;
    try {
      const { exportWebm } = await import("../engine/browser-export");
      blob = await exportWebm(project, {
        width: options?.width ?? exportWidth,
        fps: options?.fps ?? exportFps,
        start: options?.start,
        end: options?.end,
        subtitles: options?.subtitles ?? subtitleRef.current,
        controls: options ? undefined : new Map(sound.controls),
        volume: options ? 1 : sound.muted ? 0 : sound.volume,
        signal: abort.signal,
        onProgress: (progress) => {
          setExportProgress(progress);
          reportExport(options?.requestId, { state: "running", progress });
        },
        writable: writer
          ? new WritableStream({ write: (chunk) => writer.write(chunk) })
          : undefined,
      });
      if (abort.signal.aborted) throw abort.signal.reason;
      await writer?.close();
    } catch (error) {
      await writer?.abort().catch(() => {});
      throw error;
    }
    if (blob && !abort.signal.aborted) {
      lastExport.current = blob;
      downloadBlob(blob, project.id + ".webm");
    }
    reportExport(options?.requestId, {
      state: "succeeded",
      filename: project.id + ".webm",
      bytes: blob?.size || 0,
      blob,
    });
  } catch (error) {
    if (!abort.signal.aborted) setError("逐帧导出失败：" + String(error));
    reportExport(options?.requestId, {
      state: abort.signal.aborted ? "cancelled" : "failed",
      ...(!abort.signal.aborted ? { error: String(error) } : {}),
    });
  } finally {
    if (exportAbort.current === abort) {
      exportAbort.current = null;
      setExporting(false);
      setExportProgress(null);
    }
  }
}

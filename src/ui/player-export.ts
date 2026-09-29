import type { AudioTransport } from "../engine/audio";
import type { AnimationProject } from "../engine/types";
import type { ExportProgress } from "../engine/browser-export";
import { downloadBlob } from "../engine/download";
interface PlayerExportOptions {
  project: AnimationProject; transport: {current: AudioTransport | null};
  exportAbort: {current: AbortController | null}; publish: () => void;
  setError: (error: string) => void; setExporting: (value: boolean) => void;
  setExportOpen: (value: boolean) => void; setExportProgress: (value: ExportProgress | null) => void;
  exportToDisk: boolean; exportWidth: number; exportFps: number; subtitleRef: {current: boolean};
}
/** A separately cancellable export owns its file writer and encoder lifecycle. */
export async function exportPlayerVideo({ project, transport, exportAbort, publish, setError, setExporting, setExportOpen, setExportProgress, exportToDisk, exportWidth, exportFps, subtitleRef }: PlayerExportOptions) {
    const sound = transport.current;
    if (!sound || exportAbort.current) return;
    const abort = new AbortController();
    exportAbort.current = abort;
    sound.pause();
    publish();
    setError("");
    setExporting(true);
    setExportOpen(false);
    setExportProgress({ phase: "preparing", completed: 0, total: 0 });
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
        exportToDisk && picker
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
          width: exportWidth,
          fps: exportFps,
          subtitles: subtitleRef.current,
          controls: new Map(sound.controls),
          volume: sound.muted ? 0 : sound.volume,
          signal: abort.signal,
          onProgress: setExportProgress,
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
      if (blob && !abort.signal.aborted)
        downloadBlob(blob, project.id + ".webm");
    } catch (error) {
      if (!abort.signal.aborted) setError("逐帧导出失败：" + String(error));
    } finally {
      if (exportAbort.current === abort) {
        exportAbort.current = null;
        setExporting(false);
        setExportProgress(null);
      }
    }
  }

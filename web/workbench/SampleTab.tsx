import { useEffect, useMemo } from "react";
import { Clapperboard, FileCode2 } from "lucide-react";
import { formatTime } from "../lib/api";
import { exportTarget } from "../views/ExportView";
import { StagePane } from "./PreviewPane";
import { StageController, useObservable, useWorkbench } from "./store";

/** Exports createScene: a module that can play on its own (as the explorer tells from the tree). */
export const playable = (code: string | undefined) =>
  Boolean(code && /export\s+(?:async\s+)?function\s+createScene\b|export\s+(?:const|let)\s+createScene\b|export\s*\{[^}]*\bcreateScene\b/.test(code));

/**
 * A module of the work played on its own (a sample, a sheet) on a stage of its own, beside the
 * film's. The tab keeps its stage while it is open, so going back to it does not load the work
 * again; hidden, it pauses. In front, the shortcuts and the AI's view follow it.
 */
export function SampleTab({ file, active }: { file: string; active: boolean }) {
  const { work, openFile, openTool, focusStage } = useWorkbench();
  const stage = useMemo(() => new StageController(), []);
  useEffect(() => () => stage.dispose(), [stage]);
  const src = useMemo(() => {
    let quality = "standard";
    try {
      quality = JSON.parse(localStorage.getItem("frame:quality") || '"standard"');
    } catch {}
    const params = new URLSearchParams({
      work: work.id,
      module: work.preview.module,
      assetBase: work.preview.assetBase,
      scene: work.preview.module.replace(/project\.ts$/, file),
      quality,
    });
    return `/preview/stage.html?${params}`;
    // The stage hot-reloads itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.id, work.repo, file]);
  useEffect(() => {
    if (!active) return void stage.pause();
    focusStage({ stage, path: file });
    return () => focusStage(null);
  }, [active, stage, file, focusStage]);
  const project = useObservable(stage.status).project;
  const sample = project?.sample;
  const note = !project
    ? ""
    : sample
      ? `样片 ${formatTime(project.duration)} · ${sample.audioFrom !== undefined ? `声音从作品的 ${formatTime(sample.audioFrom)} 接着放` : "没有声音"}`
      : `单独播放 · 按作品时长 ${formatTime(project.duration)}，没有声音（模块导出 sample 可以定时长和声音）`;
  return (
    <>
      <div className="editor-toolbar">
        <span className="faint small-text ellipsis grow" title={note ? `${file} · ${note}` : file}>
          {file}
          {note && ` · ${note}`}
        </span>
        <button className="btn small" title="打开这个模块的代码" onClick={() => openFile(file)}>
          <FileCode2 size={13} /> 代码
        </button>
        <button
          className="btn small"
          title="只导出这个样片"
          onClick={() => {
            exportTarget.set(file);
            openTool("export");
          }}
        >
          <Clapperboard size={13} /> 导出视频
        </button>
      </div>
      <StagePane stage={stage} src={src} title={`样片 ${file}`} scene={file} />
    </>
  );
}

import { useEffect, useMemo } from "react";
import { Clapperboard, FileCode2 } from "lucide-react";
import { formatTime, sampleName } from "../lib/api";
import { exportTarget } from "../views/ExportView";
import { StagePane, sampleStageSrc } from "./PreviewPane";
import { registerPlayer, stagePlayer } from "./players";
import { StageController, useObservable, useWorkbench } from "./store";

/** Exports createScene: a module that can play on its own (as the explorer tells from the tree). */
export const playable = (code: string | undefined) =>
  Boolean(code && /export\s+(?:async\s+)?function\s+createScene\b|export\s+(?:const|let)\s+createScene\b|export\s*\{[^}]*\bcreateScene\b/.test(code));

/**
 * A module of the work played on its own (a sample, a sheet) on a stage of its own, beside the
 * film's. It keeps its stage while its tab is open, wherever the tab is moved, so showing it again
 * does not load the work again; out of sight (`visible` false) it pauses. In the focused group the
 * shortcuts and the AI's view follow it.
 */
export function SampleTab({ file, visible, focused }: { file: string; visible: boolean; focused: boolean }) {
  const { work, openFile, openTool, focusStage } = useWorkbench();
  const stage = useMemo(() => new StageController(), []);
  useEffect(() => () => stage.dispose(), [stage]);
  useEffect(() => registerPlayer(`sample:${file}`, stagePlayer(stage, sampleName(file))), [stage, file]);
  const src = useMemo(
    () => sampleStageSrc(work, file),
    // The stage hot-reloads itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [work.id, work.repo, file],
  );
  useEffect(() => {
    stage.visible = visible;
    if (!visible) stage.pause();
  }, [visible, stage]);
  useEffect(() => {
    if (!focused) return;
    focusStage({ stage, path: file });
    return () => focusStage(null);
  }, [focused, stage, file, focusStage]);
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

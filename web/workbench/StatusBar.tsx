import { useEffect, useState } from "react";
import { GitBranch, ArrowUp, ArrowDown, CircleDot, CheckCircle2, AlertCircle, Loader2, Wifi, WifiOff, Sparkles, Cloud, CloudOff, CloudDownload, AlertTriangle } from "lucide-react";
import { formatTime, onConnection, useServerEvent, workPath } from "../lib/api";
import { useRemoteState, type RemoteState } from "./RemoteBar";
import type { WorkStatus } from "../lib/types";
import { useObservable, useWorkbench } from "./store";

export function StatusBar({ status, version, onOpenView }: { status: WorkStatus | null; version: string; onOpenView: (view: string) => void }) {
  const { stage, check, showPanel, work } = useWorkbench();
  const playback = useObservable(stage.playback);
  const stageStatus = useObservable(stage.status);
  const fps = useObservable(stage.fps);
  const [online, setOnline] = useState(true);
  const [aiSessions, setAiSessions] = useState<Record<string, string>>({});
  useEffect(() => onConnection(setOnline), []);
  useServerEvent((event) => {
    if (event.type !== "ai-session") return;
    const session = event.session as { work: string; status: string; id: string };
    if (session.work !== work.id) return;
    setAiSessions((map) => ({ ...map, [session.id]: session.status }));
  });
  const [remote] = useRemoteState(`${workPath(work.repo, work.id)}/remote`, work.repo, work.id);
  const errors = check?.problems.filter((problem) => problem.severity === "error").length ?? 0;
  const project = stageStatus.project;
  return (
    <footer className="statusbar">
      <button onClick={() => onOpenView("versions")} title="版本与同步">
        <GitBranch size={13} /> {work.branch}
        {status && status.files.length > 0 && (
          <span>
            <CircleDot size={11} /> {status.files.length}
          </span>
        )}
        {status && status.ahead > 0 && (
          <span>
            <ArrowUp size={11} />
            {status.ahead}
          </span>
        )}
        {status && status.behind > 0 && (
          <span>
            <ArrowDown size={11} />
            {status.behind}
          </span>
        )}
      </button>
      <RemoteStatus state={remote} onClick={() => onOpenView("versions")} />
      <button onClick={() => showPanel("problems")} title="问题">
        {check ? errors ? <AlertCircle size={13} className="danger-text" /> : <CheckCircle2 size={13} /> : <CircleDot size={13} />}
        {check ? (errors ? `${errors} 个错误` : "检查通过") : "未检查"}
      </button>
      {stageStatus.updating && (
        <span>
          <Loader2 size={13} className="spin" /> 正在更新预览
        </span>
      )}
      {Object.values(aiSessions).some((value) => value !== "idle") && (
        <span>
          <Sparkles size={13} /> AI 工作中
        </span>
      )}
      <span className="grow" />
      {project && (
        <span className="mono">
          {formatTime(playback.time)} / {formatTime(project.duration)}
        </span>
      )}
      {project && (
        <span>
          {project.width}×{project.height} · {project.fps} fps{playback.playing && fps ? ` · 预览 ${fps} fps` : ""}
        </span>
      )}
      <span title={online ? "已连接" : "连接已断开，正在重连"}>{online ? <Wifi size={13} /> : <WifiOff size={13} className="danger-text" />}</span>
      <span className="faint">FRAME {version}</span>
    </footer>
  );
}

/** Where the work stands against GitHub (automatic pushes, newer versions there, conflicts). */
function RemoteStatus({ state, onClick }: { state: RemoteState | null; onClick: () => void }) {
  if (!state || state.state === "local" || state.state === "unknown") return null;
  const view = {
    synced: { icon: <Cloud size={13} />, text: "已同步到 GitHub", tone: "" },
    pushing: { icon: <Loader2 size={13} className="spin" />, text: "正在推送到 GitHub", tone: "" },
    behind: { icon: <CloudDownload size={13} />, text: `GitHub 有 ${state.behind ?? ""} 个更新`, tone: "warn-text" },
    diverged: { icon: <AlertTriangle size={13} />, text: "和 GitHub 冲突", tone: "danger-text" },
    conflict: { icon: <AlertTriangle size={13} />, text: "和 GitHub 冲突", tone: "danger-text" },
    error: { icon: <CloudOff size={13} />, text: "同步失败", tone: "warn-text" },
  }[state.state];
  return (
    <button className={view.tone} onClick={onClick} title={state.message || view.text}>
      {view.icon} {view.text}
    </button>
  );
}

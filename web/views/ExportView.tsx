import { useEffect, useState } from "react";
import { Clapperboard, Download, Trash2, Image as ImageIcon, Captions, Play, Loader2, CircleStop } from "lucide-react";
import { api, del, formatBytes, formatTime, timeAgo, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, Dialog } from "../lib/ui";
import type { Task } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { ViewHeader } from "./ViewHeader";

interface ExportFile {
  name: string;
  size: number;
  createdAt: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function ExportView() {
  const { work, stage } = useWorkbench();
  const meta = work.meta;
  const composition = meta?.composition ?? { width: 1920, height: 1080 };
  const [longEdge, setLongEdge] = useState(Math.min(1920, Math.max(composition.width, composition.height)));
  const [fps, setFps] = useState(meta?.fps ?? 30);
  const [range, setRange] = useState<"all" | "custom">("all");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(meta?.duration ?? 10);
  const [subtitles, setSubtitles] = useState(true);
  const [files, setFiles] = useState<ExportFile[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [local, setLocal] = useState<{ done: number; total: number; abort: AbortController } | null>(null);
  const [run] = useAction();
  const confirm = useConfirm();
  const base = workPath(work.repo, work.id);
  const scale = longEdge / Math.max(composition.width, composition.height);
  const width = even(composition.width * scale);
  const load = () => api<ExportFile[]>(`${base}/exports`).then(setFiles, () => {});
  useEffect(() => {
    void load();
    void api<Task[]>(`/api/tasks?work=${work.id}`).then((list) => setTask(list.find((item) => item.kind === "export" && item.status === "running") ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useServerEvent((event) => {
    if (event.type === "task") {
      const next = event.task as Task;
      if (next.work === work.id && next.kind === "export") setTask(next);
    }
    if (event.type === "exports" && event.work === work.id) void load();
  });

  const startExport = () =>
    run(async () => {
      const created = await api<Task>(`${base}/exports`, { body: { width, fps, subtitles, ...(range === "custom" ? { start, end } : {}) } });
      setTask(created);
    });
  const exportInBrowser = () =>
    run(async () => {
      const abort = new AbortController();
      setLocal({ done: 0, total: 1, abort });
      try {
        const blob = await stage.exportWebm({
          width,
          fps,
          subtitles,
          signal: abort.signal,
          ...(range === "custom" ? { start, end } : {}),
          onProgress: (done, total) => setLocal({ done, total, abort }),
        });
        if (!blob) return;
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `${meta?.title ?? work.id}.webm`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 60000);
      } finally {
        setLocal(null);
      }
    });
  const downloadFrame = () =>
    run(async () => {
      const url = await stage.capture();
      const link = document.createElement("a");
      link.href = url;
      link.download = `${meta?.title ?? work.id}-${formatTime(stage.playback.get().time).replace(":", "m")}s.png`;
      link.click();
    });
  const downloadSrt = () => {
    const stamp = (seconds: number) => {
      const ms = Math.round(seconds * 1000);
      const pad = (value: number, size = 2) => String(value).padStart(size, "0");
      return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
    };
    const text = (meta?.subtitles ?? []).map((item, index) => `${index + 1}\n${stamp(item.start)} --> ${stamp(item.end)}\n${item.text}\n`).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = `${meta?.title ?? work.id}.srt`;
    link.click();
  };
  const running = task?.status === "running";

  return (
    <div className="view">
      <ViewHeader title="导出" />
      <section className="view-section">
        <h3>
          <Clapperboard size={14} /> 视频（MP4）
        </h3>
        <label className="field">
          <span>分辨率</span>
          <select className="select" value={longEdge} onChange={(event) => setLongEdge(Number(event.target.value))}>
            {[640, 1280, 1920, 2560, 3840].map((value) => (
              <option key={value} value={value}>
                {even(composition.width * (value / Math.max(composition.width, composition.height)))}×
                {even(composition.height * (value / Math.max(composition.width, composition.height)))}
              </option>
            ))}
          </select>
        </label>
        <div className="field-grid">
          <label className="field">
            <span>帧率</span>
            <select className="select" value={fps} onChange={(event) => setFps(Number(event.target.value))}>
              {[24, 25, 30, 50, 60].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>范围</span>
            <select className="select" value={range} onChange={(event) => setRange(event.target.value as "all")}>
              <option value="all">全片</option>
              <option value="custom">自定义</option>
            </select>
          </label>
        </div>
        {range === "custom" && (
          <div className="field-grid">
            <label className="field">
              <span>开始（秒）</span>
              <input className="input" type="number" min={0} step={0.1} value={start} onChange={(event) => setStart(Number(event.target.value))} />
            </label>
            <label className="field">
              <span>结束（秒）</span>
              <input className="input" type="number" min={0} step={0.1} value={end} onChange={(event) => setEnd(Number(event.target.value))} />
            </label>
          </div>
        )}
        <label className="row" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={subtitles} onChange={(event) => setSubtitles(event.target.checked)} /> 把字幕烧录进画面
        </label>
        {running ? (
          <div className="export-progress">
            <div className="row">
              <Loader2 size={14} className="spin" />
              <span className="grow ellipsis">{task.message || "正在导出"}</span>
              <span className="mono">{Math.round((task.progress ?? 0) * 100)}%</span>
              <button className="icon-btn" title="取消" onClick={() => api(`/api/tasks/${task.id}/cancel`, { method: "POST" })}>
                <CircleStop size={14} />
              </button>
            </div>
            <div className="progress">
              <div style={{ width: `${Math.round((task.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        ) : (
          <button className="btn primary" style={{ width: "100%" }} onClick={startExport}>
            导出 MP4
          </button>
        )}
        {task?.status === "failed" && <p className="form-error small-text">导出失败：{task.error}</p>}
        {local ? (
          <div className="export-progress" style={{ marginTop: 8 }}>
            <div className="row">
              <Loader2 size={14} className="spin" />
              <span className="grow">
                浏览器编码 {local.done}/{local.total} 帧
              </span>
              <button className="icon-btn" title="取消" onClick={() => local.abort.abort()}>
                <CircleStop size={14} />
              </button>
            </div>
            <div className="progress">
              <div style={{ width: `${Math.round((local.done / Math.max(1, local.total)) * 100)}%` }} />
            </div>
          </div>
        ) : (
          <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={exportInBrowser}>
            在浏览器中导出 WebM（使用本机显卡，更快）
          </button>
        )}
        <p className="view-hint">MP4 在服务器上用点击时的作品快照导出，期间可以继续修改。浏览器导出需要保持此页面打开。</p>
      </section>
      <section className="view-section">
        <h3>其他</h3>
        <div className="row">
          <button className="btn small" onClick={downloadFrame}>
            <ImageIcon size={13} /> 当前帧 PNG
          </button>
          <button className="btn small" disabled={!meta?.subtitles.length} onClick={downloadSrt}>
            <Captions size={13} /> 字幕 SRT
          </button>
        </div>
      </section>
      <section className="view-section">
        <h3>已导出</h3>
        {!files.length && <p className="view-hint">还没有导出过。</p>}
        {files.map((file) => (
          <div key={file.name} className="export-row">
            <button className="icon-btn" title="播放" onClick={() => setPlaying(file.name)}>
              <Play size={14} />
            </button>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" title={file.name}>
                {file.name}
              </div>
              <div className="faint small-text">
                {file.width ? `${file.width}×${file.height} · ` : ""}
                {file.duration ? `${formatTime(file.duration, false)} · ` : ""}
                {formatBytes(file.size)} · {timeAgo(file.createdAt)}
              </div>
            </div>
            <a className="icon-btn" title="下载" href={`${base}/exports/${encodeURIComponent(file.name)}?download=1`}>
              <Download size={14} />
            </a>
            <button
              className="icon-btn"
              title="删除"
              onClick={async () =>
                (await confirm(`删除 ${file.name}？`, { danger: true, confirm: "删除" })) &&
                run(() => del(`${base}/exports/${encodeURIComponent(file.name)}`).then(load))
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </section>
      {playing && (
        <Dialog title={playing} onClose={() => setPlaying(null)} width={960}>
          <video className="export-video" src={`${base}/exports/${encodeURIComponent(playing)}`} controls autoPlay />
        </Dialog>
      )}
    </div>
  );
}

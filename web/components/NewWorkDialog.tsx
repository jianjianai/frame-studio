import { useEffect, useState } from "react";
import { Sparkles, PenLine } from "lucide-react";
import { api } from "../lib/api";
import { Dialog, useToast } from "../lib/ui";
import type { Repo } from "../lib/types";
import { navigate } from "../App";

const SIZES = [
  { label: "横屏 16:9", width: 1920, height: 1080 },
  { label: "竖屏 9:16", width: 1080, height: 1920 },
  { label: "方形 1:1", width: 1080, height: 1080 },
  { label: "宽银幕 21:9", width: 2560, height: 1080 },
  { label: "4:3", width: 1440, height: 1080 },
];

/** Create a work by hand (blank) or let AI start from a description. */
export function NewWorkDialog({ onClose, defaultRepo = "local" }: { onClose: () => void; defaultRepo?: string }) {
  const toast = useToast();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repo, setRepo] = useState(defaultRepo);
  const [size, setSize] = useState(0);
  const [duration, setDuration] = useState(15);
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Repo[]>("/api/repos").then(setRepos);
  }, []);
  const create = async () => {
    setBusy(true);
    try {
      const finalTitle =
        title.trim() ||
        description
          .trim()
          .split(/[\n。！？.!?：:，,（(]/)[0]
          .slice(0, 16) ||
        "未命名作品";
      const { width, height } = SIZES[size];
      const work = await api<{ id: string; repo: string }>("/api/works", {
        body: { repo, title: finalTitle, description: description.trim(), width, height, duration, fps },
      });
      if (mode === "ai" && description.trim())
        sessionStorage.setItem(
          `frame:initial-prompt:${work.repo}/${work.id}`,
          `请根据下面的需求制作这个视频作品（${width}×${height}，${duration} 秒，${fps} fps）。先给出简短的制作计划，然后直接开始制作，完成后用 storyboard 检查整体效果。${title.trim() ? "" : "作品名称是自动截取的，请用 work_update 起一个简短的标题。"}\n\n需求：\n${description.trim()}`,
        );
      onClose();
      navigate(`/work/${encodeURIComponent(work.repo)}/${encodeURIComponent(work.id)}`);
    } catch (error) {
      toast((error as Error).message, "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="新建作品"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || (mode === "ai" ? !description.trim() : !title.trim())} onClick={create}>
            {busy && <span className="spinner" />}
            {mode === "ai" ? "创建并交给 AI" : "创建空白作品"}
          </button>
        </>
      }
    >
      <div className="mode-switch">
        <button className={mode === "ai" ? "active" : ""} onClick={() => setMode("ai")}>
          <Sparkles size={16} /> AI 制作
        </button>
        <button className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}>
          <PenLine size={16} /> 空白作品
        </button>
      </div>
      {mode === "ai" && (
        <label className="field">
          <span>想做一个什么样的视频？</span>
          <textarea
            className="textarea"
            rows={5}
            autoFocus
            placeholder="例如：一段 15 秒的产品开场动画，深色背景，金色粒子汇聚成 LOGO，配轻快的电子音乐。"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>作品名称{mode === "ai" ? "（可留空，之后可改）" : ""}</span>
        <input className="input" autoFocus={mode === "manual"} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="未命名作品" />
      </label>
      <div className="field-grid">
        <label className="field">
          <span>画幅</span>
          <select className="select" value={size} onChange={(event) => setSize(Number(event.target.value))}>
            {SIZES.map((item, index) => (
              <option key={item.label} value={index}>
                {item.label}（{item.width}×{item.height}）
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>时长（秒）</span>
          <input className="input" type="number" min={1} max={3600} value={duration} onChange={(event) => setDuration(Number(event.target.value) || 1)} />
        </label>
        <label className="field">
          <span>帧率</span>
          <select className="select" value={fps} onChange={(event) => setFps(Number(event.target.value))}>
            {[24, 25, 30, 50, 60].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>作品库</span>
          <select className="select" value={repo} onChange={(event) => setRepo(event.target.value)}>
            {repos.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Dialog>
  );
}

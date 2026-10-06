import { useEffect, useState } from "react";
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

/** Create a blank work; the AI is asked from the workbench's chat afterwards. */
export function NewWorkDialog({ onClose, defaultRepo = "local" }: { onClose: () => void; defaultRepo?: string }) {
  const toast = useToast();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState(defaultRepo);
  const [size, setSize] = useState(0);
  const [duration, setDuration] = useState(15);
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Repo[]>("/api/repos").then(setRepos);
  }, []);
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { width, height } = SIZES[size];
      const work = await api<{ id: string; repo: string }>("/api/works", { body: { repo, title: title.trim(), width, height, duration, fps } });
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
          <button className="btn primary" disabled={busy || !title.trim()} onClick={create}>
            {busy && <span className="spinner" />}
            创建
          </button>
        </>
      }
    >
      <label className="field">
        <span>作品名称</span>
        <input
          className="input"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !event.nativeEvent.isComposing && void create()}
          placeholder="例如：彩虹是怎么形成的"
        />
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

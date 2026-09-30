import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "./ui/Player";
import { createLivePreviewClient, type LivePreviewManifest, type LivePreviewStatus } from "./engine/live-preview-client";
import type { AnimationProject } from "./engine/types";
import { installAiBrowser } from "./engine/ai-browser";
import "./styles.css";
import "./work-preview.css";
import "./ui/player-workspace.css";

class LiveBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children; }
}
type Candidate = { project: AnimationProject; manifest: LivePreviewManifest; signal: AbortSignal };
function LivePreview() {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [status, setStatus] = useState<LivePreviewStatus | null>(null);
  const [acceptedTitle, setAcceptedTitle] = useState("");
  const pending = useRef(new Map<number, { project: AnimationProject; resolve: () => void; reject: (error: Error) => void }>());
  const ai = useRef<ReturnType<typeof installAiBrowser> | null>(null);
  const client = useRef<ReturnType<typeof createLivePreviewClient> | null>(null);
  const aiMode = new URLSearchParams(location.search).get("ai") === "1";
  useEffect(() => {
    const config = window.__FRAME_LIVE_PREVIEW__;
    if (!config) {
      setStatus({ state: "error", sessionId: "", error: "Missing live preview connection" });
      return;
    }
    const connection = createLivePreviewClient(config, {
      onProject: (project, manifest, signal, onCommit) => new Promise<void>((resolve, reject) => {
        const abort = () => {
          pending.current.delete(manifest.revision);
          reject(new Error("Superseded live revision"));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.current.set(manifest.revision, {
          project,
          resolve: () => { signal.removeEventListener("abort", abort); onCommit(); resolve(); },
          reject: error => { signal.removeEventListener("abort", abort); reject(error); },
        });
        setCandidate({ project, manifest, signal });
      }),
      onStatus: value => {
        setStatus(value);
        if (parent !== window) {
          const { sessionId: _session, ...message } = value;
          parent.postMessage({ type: "frame-live-preview", ...message }, "*");
        }
      },
    });
    client.current = connection;
    const retry = (event: MessageEvent) => {
      if (event.source === parent && event.data?.type === "frame-live-retry") void connection.retry();
    };
    window.addEventListener("message", retry);
    return () => {
      window.removeEventListener("message", retry);
      connection.dispose(); client.current = null;
    };
  }, []);
  useEffect(() => {
    if (parent === window) return;
    const observer = new ResizeObserver(() => parent.postMessage({
      type: "frame-preview-height", height: Math.ceil(document.body.getBoundingClientRect().height),
    }, "*"));
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
  const applied = (result: { revision: number; success: boolean; error?: string }) => {
    const waiting = pending.current.get(result.revision);
    if (!waiting) return;
    pending.current.delete(result.revision);
    if (result.success) {
      setAcceptedTitle(waiting.project.title);
      if (aiMode) {
        if (ai.current) ai.current.updateProject(waiting.project);
        else ai.current = installAiBrowser(waiting.project);
      }
      waiting.resolve();
    } else waiting.reject(new Error(result.error || "Live scene initialization failed"));
  };
  return <>
    {aiMode && <section className="ai-browser-header">
      <div><h1>{acceptedTitle || "实时预览"} · AI 审片</h1><p>画面与声音在浏览器持续运行。控制台入口：<code>await FRAME_AI.ready()</code></p></div>
      <button onClick={() => void window.FRAME_AI?.play()}>启用声音并播放</button>
    </section>}
    {status?.error && <div className="live-preview-notice" role="alert">
      <span>{status.error}</span><button onClick={() => void client.current?.retry()}>重试连接</button>
    </div>}
    {candidate ? <Player project={candidate.project} embedded
      liveUpdate={{ revision: candidate.manifest.revision, changes: candidate.manifest.changes, signal: candidate.signal }}
      onLiveUpdate={applied} /> : <p role="status">正在连接实时预览…</p>}
  </>;
}
document.body.classList.add("work-preview");
document.documentElement.dataset.previewAudio = "0";
createRoot(document.getElementById("root")!).render(<LiveBoundary><LivePreview /></LiveBoundary>);

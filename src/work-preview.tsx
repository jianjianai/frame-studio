import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { projects } from "./projects";
import { Player } from "./ui/Player";
import "./styles.css";
import "./work-preview.css";
import { installAiBrowser } from "./engine/ai-browser";

class PreviewBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <p role="alert">{this.state.error}</p>
    ) : (
      this.props.children
    );
  }
}
document.body.classList.add("work-preview");
if (parent !== window) {
  const observer = new ResizeObserver(() =>
    parent.postMessage(
      {
        type: "frame-preview-height",
        height: Math.ceil(document.body.getBoundingClientRect().height),
      },
      "*",
    ),
  );
  observer.observe(document.body);
  window.addEventListener("pagehide", () => observer.disconnect(), {
    once: true,
  });
}
const project = projects[0];
const aiMode = new URLSearchParams(location.search).get("ai") === "1";
if (project && aiMode) installAiBrowser(project);
createRoot(document.getElementById("root")!).render(
  <PreviewBoundary>
    {project ? (
      <>
        {aiMode && (
          <section className="ai-browser-header">
            <div>
              <h1>{project.title} · AI 审片</h1>
              <p>
                画面、声音与导出在当前浏览器运行。控制台入口：
                <code>await FRAME_AI.ready()</code> ·{" "}
                <code>FRAME_AI.help()</code>
              </p>
            </div>
            <button onClick={() => void window.FRAME_AI?.play()}>
              启用声音并播放
            </button>
            <details>
              <summary>控制台调用示例</summary>
              <pre>{JSON.stringify(window.FRAME_AI?.help(), null, 2)}</pre>
            </details>
          </section>
        )}
        <Player project={project} embedded />
      </>
    ) : (
      <p role="alert">作品预览暂不可用</p>
    )}
  </PreviewBoundary>,
);

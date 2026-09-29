import { Component, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "./ui/Player";
import { findProject } from "./projects";
import { RenderPage } from "./ui/RenderPage";
import "./styles.css";
import "./ui/player-workspace.css";
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <main className="empty-state">
          <h1>工作台遇到了问题</h1>
          <p role="alert">{this.state.error}</p>
          <button onClick={() => location.reload()}>重新载入</button>
        </main>
      );
    return this.props.children;
  }
}
const renderId = new URLSearchParams(location.search).get("render");
const renderProject = renderId ? findProject(renderId) : undefined;
function StandalonePreview() {
  const selected = () =>
    new URLSearchParams(location.search).get("work") ||
    location.hash.match(/^#\/film\/([^/]+)$/)?.[1];
  const [id, setId] = useState(selected);
  useEffect(() => {
    const change = () => setId(selected());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const project = id ? findProject(id) : undefined;
  return project ? (
    <Player key={id} project={project} />
  ) : (
    <p>请在 FRAME 作品库中打开作品。</p>
  );
}
if (renderId) document.body.classList.add("render-mode");
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    {renderId ? (
      renderProject ? (
        <RenderPage project={renderProject} />
      ) : (
        <p role="alert">Unknown project: {renderId}</p>
      )
    ) : (
      <StandalonePreview />
    )}
  </ErrorBoundary>,
);

document.getElementById("frame-boot")?.remove();

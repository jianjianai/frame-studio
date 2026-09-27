import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { findProject } from "./projects";
import { RenderPage } from "./ui/RenderPage";
import "./styles.css";
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
      <App />
    )}
  </ErrorBoundary>,
);

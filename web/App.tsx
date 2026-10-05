import { Component, useEffect, useState, type ReactNode } from "react";
import { api } from "./lib/api";
import { ToastProvider, ConfirmProvider, PromptProvider } from "./lib/ui";
import { Login } from "./pages/Login";
import { Welcome } from "./pages/Welcome";
import { Workbench } from "./workbench/Workbench";

export function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const change = () => setPath(location.pathname);
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  return path;
}

class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" style={{ marginTop: "20vh" }}>
        <h2>界面出现错误</h2>
        <p className="mono">{this.state.error}</p>
        <button className="btn" onClick={() => location.reload()}>
          重新载入
        </button>
      </div>
    );
  }
}

export function App() {
  const path = useRoute();
  const [state, setState] = useState<{ authRequired: boolean; authenticated: boolean; version: string } | null>(null);
  useEffect(() => {
    const load = () => api<{ authRequired: boolean; authenticated: boolean; version: string }>("/api/state").then(setState);
    void load();
    window.addEventListener("frame:unauthorized", load);
    return () => window.removeEventListener("frame:unauthorized", load);
  }, []);
  if (!state) return null;
  const work = /^\/work\/([^/]+)\/([^/]+)/.exec(path);
  return (
    <Boundary>
      <ToastProvider>
        <ConfirmProvider>
          <PromptProvider>
            {!state.authenticated ? (
              <Login onDone={() => api<typeof state>("/api/state").then(setState)} />
            ) : work ? (
              <Workbench key={work[1] + "/" + work[2]} repo={decodeURIComponent(work[1])} id={decodeURIComponent(work[2])} version={state.version} />
            ) : (
              <Welcome version={state.version} />
            )}
          </PromptProvider>
        </ConfirmProvider>
      </ToastProvider>
    </Boundary>
  );
}

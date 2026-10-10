import { Component, useEffect, useState, type ReactNode } from "react";
import { api, onConnection } from "./lib/api";
import { ToastProvider, ConfirmProvider, PromptProvider } from "./lib/ui";
import { Login } from "./pages/Login";
import { Welcome } from "./pages/Welcome";
import { Workbench } from "./workbench/Workbench";
import { ComparePage } from "./reviews/ComparePage";

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

type State = { authRequired: boolean; authenticated: boolean; version: string; build?: string };

export function App() {
  const path = useRoute();
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    const load = () => api<State>("/api/state").then(setState);
    void load();
    window.addEventListener("frame:unauthorized", load);
    return () => window.removeEventListener("frame:unauthorized", load);
  }, []);
  // A deploy restarts the server: when the page reconnects to a newer build, offer a reload
  // (an open page keeps running the code it was loaded with).
  const [outdated, setOutdated] = useState(false);
  const build = state?.build;
  useEffect(() => {
    if (!build) return;
    return onConnection((connected) => {
      if (connected)
        void api<State>("/api/state").then(
          (next) => setOutdated(Boolean(next.build && next.build !== build)),
          () => {},
        );
    });
  }, [build]);
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
            ) : path === "/reviews" ? (
              <ComparePage />
            ) : (
              <Welcome version={state.version} />
            )}
            {outdated && (
              <div className="update-bar" role="status">
                FRAME 已更新到新版本，刷新页面后生效。
                <button className="btn small primary" onClick={() => location.reload()}>
                  刷新
                </button>
                <button className="btn small ghost" onClick={() => setOutdated(false)}>
                  稍后
                </button>
              </div>
            )}
          </PromptProvider>
        </ConfirmProvider>
      </ToastProvider>
    </Boundary>
  );
}

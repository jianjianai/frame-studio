import { randomUUID } from "../src/browser/uuid.mjs";
import { Component, lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { clearRetiredChatStorage } from "./ai-session.mjs";
import {
  Film,
  FolderGit2,
  Images,
  Settings2,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  X,
  Square,
  ArrowUpRight,
} from "lucide-react";
import {
  request,
  api,
  useQuery,
  useAction,
  Button,
  ErrorNote,
  Loading,
  Empty,
  go,
  states,
  kinds,
  Notification,
} from "./ui";
const WorkLibrary = lazy(() =>
  import("./library").then((module) => ({ default: module.WorkLibrary })),
);
const Repositories = lazy(() =>
  import("./library").then((module) => ({ default: module.Repositories })),
);
const Creation = lazy(() =>
  import("./creation").then((module) => ({ default: module.Creation })),
);
const Materials = lazy(() =>
  import("./materials").then((module) => ({ default: module.Materials })),
);
const Settings = lazy(() =>
  import("./accounts").then((module) => ({ default: module.Settings })),
);
import "./workbench.css";
import "./workspace.css";
import "./work-tools.css";

class PageBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <section role="alert">
        <h2>页面暂时无法打开</h2>
        <p>
          服务器更新或网络中断可能使页面资源暂时不可用。创作任务仍保存在服务器，刷新前请保留尚未提交的输入。
        </p>
        <Button onClick={() => location.reload()}>重新加载页面</Button>
      </section>
    ) : (
      this.props.children
    );
  }
}

function NativeActivityBadges({ activity }) {
  const native = activity?.native;
  if (!native) return null;
  return (
    <>
      {!!native.activeThreads?.length && (
        <span className="badge running">T3 Code · {native.activeThreads.length} 个对话正在运行</span>
      )}
      {!!native.activeTerminals && (
        <span className="badge running">终端 · {native.activeTerminals} 项正在运行</span>
      )}
      {!!native.pendingPermissions && (
        <span className="badge queued">T3 Code · 等待权限确认</span>
      )}
      {native.incomplete && (
        <span className="badge failed">T3 Code · 连接状态待核对</span>
      )}
    </>
  );
}

function Background({ notify, localMode }) {
  const query = useQuery("works_background", {}, 2000),
    [run, busy] = useAction(notify);
  return (
    <>
      <div className="page-heading">
        <h1>后台项目</h1>
        <p>
          {localMode
            ? "这些作品正在这台电脑上制作。收起到托盘后会继续运行。"
            : "这些作品仍在服务器上制作，关闭浏览器不会中断。"}
        </p>
      </div>
      <ErrorNote error={query.error} />
      {query.data?.map((w) => (
        <article className="background-project panel" key={w.id}>
          <div>
            <a href={"#/work/" + w.id} target="_blank" rel="noopener">
              <h2>
                {w.title} <ArrowUpRight size={16} />
              </h2>
            </a>
            <p>{w.storage_name}</p>
            <div className="row">
              <NativeActivityBadges activity={w.nativeActivity} />
              {w.tasks.map((t) => (
                <span className={"badge " + t.state} key={t.id}>
                  {kinds[t.kind]} · {states[t.state]}
                </span>
              ))}
            </div>
          </div>
          <div className="row">
            <a
              className="button"
              href={"#/work/" + w.id}
              target="_blank"
              rel="noopener"
            >
              打开作品 ↗
            </a>
            <Button
              icon={Square}
              disabled={
                busy ||
                (!w.nativeActivity && !w.tasks.some((t) =>
                  ["queued", "running", "cancelling"].includes(t.state),
                ))
              }
              onClick={() =>
                run(async () => {
                  await api("works_stop", { id: w.id });
                  query.refresh();
                })
              }
            >
              停止
            </Button>
          </div>
        </article>
      ))}
      {!query.loading && !query.data?.length && (
        <Empty>当前没有在后台运行的项目。</Empty>
      )}
    </>
  );
}
function RepositoryWorks({ id, notify, localMode }) {
  const [repo, setRepo] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    api("repositories_get", { repo: id })
      .then((found) => {
        if (!cancelled) setRepo(found);
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return error ? (
    <ErrorNote error={error} />
  ) : repo ? (
    <WorkLibrary repo={repo} notify={notify} localMode={localMode} />
  ) : (
    <Loading />
  );
}
function App() {
  const [me, setMe] = useState(undefined),
    [route, setRoute] = useState(() =>
      location.hash.replace(/^#\/?/, "").split("/"),
    ),
    [collapsed, setCollapsed] = useState(
      () => localStorage.getItem("frame.nav-collapsed") === "true",
    ),
    [notice, setNotice] = useState(null),
    [loginError, setLoginError] = useState(""),
    [logging, setLogging] = useState(false);
  useEffect(() => {
    clearRetiredChatStorage([localStorage, sessionStorage]);
    request("/api/me")
      .then(setMe)
      .catch((error) => {
        setLoginError(error.message);
        setMe(null);
      });
    const listener = () =>
      setRoute(location.hash.replace(/^#\/?/, "").split("/"));
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    const expired = () => setMe(null);
    window.addEventListener("frame-auth-required", expired);
    return () => window.removeEventListener("frame-auth-required", expired);
  }, []);
  useEffect(() => {
    localStorage.setItem("frame.nav-collapsed", String(collapsed));
  }, [collapsed]);
  useEffect(() => {
    if (!me?.localMode) return;
    sessionStorage.setItem("frame.local-mode", "1");
    const session = randomUUID();
    // Use the same protection as browser navigation, including editors, forms and exports.
    const report = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      void request("/api/desktop/activity", {
        method: "POST",
        body: JSON.stringify({ session, dirty: event.defaultPrevented }),
      }).catch(() => {});
    };
    const release = () =>
      navigator.sendBeacon(
        "/api/desktop/activity",
        new Blob([JSON.stringify({ session, dirty: false })], {
          type: "application/json",
        }),
      );
    const changed = () => setTimeout(report, 0);
    report();
    const timer = setInterval(report, 5000);
    window.addEventListener("pagehide", release);
    window.addEventListener("pageshow", report);
    document.addEventListener("visibilitychange", report);
    document.addEventListener("input", changed);
    return () => {
      clearInterval(timer);
      release();
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", report);
      document.removeEventListener("visibilitychange", report);
      document.removeEventListener("input", changed);
    };
  }, [me?.localMode]);
  useEffect(() => {
    if (!notice || notice.type === "error") return;
    const timer = setTimeout(
      () => setNotice(null),
      notice.type === "error" ? 15000 : 6000,
    );
    return () => clearTimeout(timer);
  }, [notice]);
  const notify = (text, type = "success") =>
    setNotice({ text, type, id: Date.now() });
  if (me === undefined) return <Loading />;
  if (!me && sessionStorage.getItem("frame.local-mode") === "1")
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand">
            <Film size={28} /> FRAME
          </div>
          <h1>工作台正在恢复连接</h1>
          <p>
            本机服务暂时没有响应。你的作品仍保存在这台电脑。可从托盘打开 Windows
            控制中心检查运行状态。
          </p>
          <ErrorNote error={loginError} />
          <Button className="primary" onClick={() => location.reload()}>
            重新连接
          </Button>
        </section>
      </main>
    );
  if (!me)
    return (
      <main className="login-page">
        <form
          className="login-card"
          onSubmit={async (e) => {
            e.preventDefault();
            const password = new FormData(e.currentTarget).get("password");
            setLogging(true);
            try {
              await request("/api/login", {
                method: "POST",
                body: JSON.stringify({ password }),
              });
              setMe(await request("/api/me"));
              setLoginError("");
            } catch (error) {
              setLoginError(error.message);
            } finally {
              setLogging(false);
            }
          }}
        >
          <div className="brand">
            <Film size={28} /> FRAME
          </div>
          <h1>让想法成为作品</h1>
          <p>AI 创作，随时审片与调整。</p>
          <label className="field">
            <span>登录密码</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </label>
          <ErrorNote error={loginError} />
          <Button className="primary" disabled={logging}>
            {logging ? "登录中…" : "进入工作台"}
          </Button>
        </form>
      </main>
    );
  const section = route[0] || "library",
    isWork = section === "work",
    navigation = [
      ["library", Film, "作品库"],
      ["repositories", FolderGit2, "作品仓库"],
      ["background", Film, "后台项目"],
      ["materials", Images, "素材库"],
      ["settings", Settings2, "设置"],
    ];
  return (
    <div
      className={
        "workbench " +
        (isWork ? "work-focus" : collapsed ? "nav-collapsed" : "")
      }
    >
      {!isWork && (
        <aside className="navigation">
          <a className="brand" href="#/library">
            <Film size={25} />
            <span>FRAME</span>
          </a>
          <nav>
            {navigation.map(([id, Icon, label]) => (
              <a
                href={"#/" + id}
                key={id}
                title={label}
                className={
                  section === id ||
                  (id === "library" && section === "recent") ||
                  (id === "repositories" &&
                    ["repository", "work"].includes(section))
                    ? "selected"
                    : ""
                }
              >
                <Icon size={20} />
                <span>{label}</span>
              </a>
            ))}
          </nav>
          <footer>
            <Button
              icon={collapsed ? PanelLeftOpen : PanelLeftClose}
              aria-label={collapsed ? "展开导航" : "收起导航"}
              onClick={() => setCollapsed(!collapsed)}
            >
              <span>{collapsed ? "展开" : "收起导航"}</span>
            </Button>
            {!me.localMode && (
              <Button
                icon={LogOut}
                aria-label="退出登录"
                onClick={async () => {
                  await request("/api/logout", { method: "POST" });
                  setMe(null);
                }}
              >
                <span>退出登录</span>
              </Button>
            )}
          </footer>
        </aside>
      )}
      <main className={isWork ? "workspace" : "page"}>
        <PageBoundary key={section + ":" + (route[1] || "")}>
          <Suspense fallback={<Loading />}>
            {section === "work" ? (
              <Creation key={route[1]} id={route[1]} notify={notify} />
            ) : section === "repository" ? (
              <RepositoryWorks
                key={route[1]}
                id={route[1]}
                notify={notify}
                localMode={me.localMode}
              />
            ) : section === "repositories" ? (
              <Repositories
                notify={notify}
                onOpen={(r) => go("repository/" + r.id)}
              />
            ) : section === "background" ? (
              <Background notify={notify} localMode={me.localMode} />
            ) : section === "materials" ? (
              <Materials notify={notify} />
            ) : section === "settings" ? (
              <Settings notify={notify} localMode={!!me.localMode} />
            ) : (
              <WorkLibrary
                key={section}
                recent={section === "recent"}
                notify={notify}
                localMode={me.localMode}
              />
            )}
          </Suspense>
        </PageBoundary>
      </main>
      <Notification notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);

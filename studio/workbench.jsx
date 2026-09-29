import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Film,
  Clock3,
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
import { WorkLibrary, Repositories } from "./library";
import { Creation } from "./creation";
import { Materials } from "./work-panels";
import { Settings } from "./accounts";
import "./workbench.css";
import "./workspace.css";

function Background({ notify }) {
  const query = useQuery("works_background", {}, 2000),
    [run, busy] = useAction(notify);
  return (
    <>
      <div className="page-heading">
        <h1>后台项目</h1>
        <p>这些作品仍在服务器上制作，关闭浏览器不会中断。</p>
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
              {w.tasks.map((t) => (
                <span className={"badge " + t.state} key={t.id}>
                  {kinds[t.kind]} · {states[t.state]}
                </span>
              ))}
            </div>
          </div>
          <div className="row">
            <a className="button" href={"#/work/" + w.id} target="_blank" rel="noopener">打开作品 ↗</a>
            <Button
              icon={Square}
              disabled={busy}
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
function RepositoryWorks({ id, notify }) {
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
    <WorkLibrary repo={repo} notify={notify} />
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
    request("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
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
  const section = route[0] || "recent",
    isWork = section === "work",
    navigation = [
      ["recent", Clock3, "最近打开"],
      ["repositories", FolderGit2, "作品仓库"],
      ["background", Film, "后台项目"],
      ["materials", Images, "素材库"],
      ["settings", Settings2, "设置"],
    ];
  return (
    <div className={"workbench " + (isWork ? "work-focus" : collapsed ? "nav-collapsed" : "")}>
      {!isWork && <aside className="navigation">
        <a className="brand" href="#/recent">
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
        </footer>
      </aside>}
      <main className={isWork ? "workspace" : "page"}>
        {section === "work" ? (
          <Creation
            key={route[1]}
            id={route[1]}
            notify={notify}
          />
        ) : section === "repository" ? (
          <RepositoryWorks key={route[1]} id={route[1]} notify={notify} />
        ) : section === "repositories" ? (
          <Repositories
            notify={notify}
            onOpen={(r) => go("repository/" + r.id)}
          />
        ) : section === "background" ? (
          <Background notify={notify} />
        ) : section === "materials" ? (
          <Materials notify={notify} />
        ) : section === "settings" ? (
          <Settings notify={notify} />
        ) : (
          <WorkLibrary recent notify={notify} />
        )}
      </main>
      <Notification notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);

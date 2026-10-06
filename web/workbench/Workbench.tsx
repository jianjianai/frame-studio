import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Files,
  Image as ImageIcon,
  AudioLines,
  GitBranch,
  Clapperboard,
  Settings as SettingsIcon,
  PanelLeft,
  PanelBottom,
  PanelRight,
  Home,
  Sparkles,
  Sun,
  Moon,
  SlidersHorizontal,
  BookOpen,
} from "lucide-react";
import { api, workPath, experiencePath, useServerEvent, sendEvent } from "../lib/api";
import { Sash, usePersistent, useToast, Dialog } from "../lib/ui";
import type { CheckResult, WorkInfo, WorkStatus } from "../lib/types";
import { navigate } from "../App";
import { StageController, WorkbenchContext, useWorkbench, type ChatAttachment, type Selection, type WorkbenchContextValue } from "./store";
import { useTimelineHistory } from "./timelineHistory";
import { PropertiesView } from "../views/PropertiesView";
import { ExperienceView } from "../views/ExperienceView";
import { EditorArea, type EditorHandle } from "./EditorArea";
import { PrecacheBar } from "./PrecacheBar";
import { BottomPanel } from "./BottomPanel";
import { StatusBar } from "./StatusBar";
import { ExplorerView } from "../views/ExplorerView";
import { AssetsView } from "../views/AssetsView";
import { AudioView } from "../views/AudioView";
import { VersionsView } from "../views/VersionsView";
import { ExportView } from "../views/ExportView";
import { ChatPanel, type ChatHandle } from "../chat/ChatPanel";
import { SettingsView } from "../settings/SettingsView";
import "./workbench.css";

const VIEWS = [
  { id: "explorer", label: "资源管理器", icon: Files, component: ExplorerView },
  { id: "assets", label: "素材", icon: ImageIcon, component: AssetsView },
  { id: "properties", label: "属性", icon: SlidersHorizontal, component: PropertiesView },
  { id: "experience", label: "经验", icon: BookOpen, component: ExperienceView },
  { id: "audio", label: "音频与配音", icon: AudioLines, component: AudioView },
  { id: "versions", label: "版本与同步", icon: GitBranch, component: VersionsView },
  { id: "export", label: "导出", icon: Clapperboard, component: ExportView },
] as const;

export function Workbench({ repo, id, version }: { repo: string; id: string; version: string }) {
  const toast = useToast();
  const [work, setWork] = useState<WorkInfo | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = usePersistent<string>("view", "explorer");
  const [sidebar, setSidebar] = usePersistent("sidebar", { visible: true, width: 260 });
  const [panel, setPanel] = usePersistent("panel", { visible: true, height: 240, tab: "timeline" });
  const [chat, setChat] = usePersistent("chat", { visible: true, width: 400 });
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "");
  const stage = useMemo(() => new StageController(), []);
  const narrow = useMediaQuery("(max-width: 900px)");
  // On small screens side bar and chat are overlays and start closed.
  useEffect(() => {
    if (!narrow) return;
    setSidebar((value) => ({ ...value, visible: false }));
    setChat((value) => ({ ...value, visible: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
  const editor = useRef<EditorHandle>(null);
  const chatRef = useRef<ChatHandle>(null);
  const base = workPath(repo, id);

  const reload = useCallback(async () => {
    try {
      const info = await api<WorkInfo>(base + "?touch=1");
      setWork(info);
      document.title = `${info.meta?.title ?? id} · FRAME Studio`;
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [base, id]);
  const history = useTimelineHistory(base, reload);
  const reloadStatus = useCallback(() => api<WorkStatus>(base + "/status").then(setStatus, () => {}), [base]);
  // Unsaved changes of the experience libraries, for the badge on the 经验 icon.
  const [experienceChanges, setExperienceChanges] = useState(0);
  const reloadExperience = useCallback(
    () =>
      api<WorkStatus>(experiencePath(repo) + "/status").then(
        (next) => setExperienceChanges(next.files.length),
        () => {},
      ),
    [repo],
  );
  useEffect(() => void reloadExperience(), [reloadExperience]);
  useServerEvent(
    (event) => {
      if ((event.type === "experience-files" && event.repo === repo) || (event.type === "work-versions" && event.work === `experience-${repo}`))
        void reloadExperience();
    },
    [repo],
  );
  useEffect(() => {
    void reload();
    void reloadStatus();
    void api<CheckResult | null>(base + "/check").then(setCheck);
  }, [reload, reloadStatus, base]);

  useServerEvent(
    (event) => {
      if (event.work !== id) return;
      if (event.type === "work-files" || event.type === "preview-update") {
        void reload();
        void reloadStatus();
      }
      if (event.type === "work-versions") void reloadStatus();
      if (event.type === "work-check") setCheck(event.result as CheckResult);
    },
    [id],
  );

  // Tell the server (and so the AI) where the user is looking.
  useEffect(() => {
    let last = "";
    const publish = () => {
      const snapshot = stage.playback.get();
      const key = `${snapshot.time.toFixed(1)}:${snapshot.playing}:${JSON.stringify(selection)}`;
      if (key === last) return;
      last = key;
      sendEvent({ type: "preview-state", work: id, repo, time: snapshot.time, playing: snapshot.playing, selection });
    };
    const timer = setInterval(publish, 1000);
    return () => clearInterval(timer);
  }, [stage, id, repo, selection]);

  const runCheck = useCallback(async () => {
    try {
      const result = await api<CheckResult>(base + "/check", { body: {} });
      setCheck(result);
      if (!result.ok) setPanel((value) => ({ ...value, visible: true, tab: "problems" }));
      toast(result.ok ? "检查通过" : `发现 ${result.problems.length} 个问题`, result.ok ? "ok" : "error");
    } catch (failure) {
      toast((failure as Error).message, "error");
    }
  }, [base, setPanel, toast]);

  const context: WorkbenchContextValue | null = work && {
    work,
    reload,
    stage,
    check,
    runCheck,
    openFile: (path, options) => editor.current?.openFile(path, options),
    openExperience: (path, options) => editor.current?.openExperience(path, options),
    openDiff: (title, query, options) => editor.current?.openDiff(title, query, options),
    addToChat: (attachment: ChatAttachment, prompt?: string) => {
      setChat((value) => ({ ...value, visible: true }));
      setTimeout(() => chatRef.current?.attach(attachment, prompt), 0);
    },
    askAi: (prompt, attachments = []) => {
      setChat((value) => ({ ...value, visible: true }));
      setTimeout(() => chatRef.current?.send(prompt, attachments), 0);
    },
    selection,
    select: setSelection,
    showPanel: (tab) => setPanel((value) => ({ ...value, visible: true, tab })),
    showView: (next) => {
      setView(next);
      setSidebar((value) => ({ ...value, visible: true }));
    },
    openSettings: (section) => setSettingsOpen(section || "ai"),
    history,
  };

  // Global shortcuts.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable || target.closest(".cm-editor");
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "b" && !event.altKey) {
        event.preventDefault();
        setSidebar((value) => ({ ...value, visible: !value.visible }));
      } else if (mod && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setPanel((value) => ({ ...value, visible: !value.visible }));
      } else if (mod && event.key.toLowerCase() === "i") {
        event.preventDefault();
        setChat((value) => ({ ...value, visible: true }));
        setTimeout(() => chatRef.current?.focus(), 0);
      } else if (!typing && event.key === " ") {
        event.preventDefault();
        stage.toggle();
      } else if (!typing && event.key === "ArrowLeft") {
        event.preventDefault();
        void (event.shiftKey ? stage.seek(stage.playback.get().time - 1) : stage.step(-1));
      } else if (!typing && event.key === "ArrowRight") {
        event.preventDefault();
        void (event.shiftKey ? stage.seek(stage.playback.get().time + 1) : stage.step(1));
      } else if (!typing && event.key === "Home") stage.seek(0);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setSidebar, setPanel, setChat, stage]);

  if (error)
    return (
      <div className="empty" style={{ marginTop: "20vh" }}>
        <h2>无法打开作品</h2>
        <p>{error}</p>
        <button className="btn" onClick={() => navigate("/")}>
          返回首页
        </button>
      </div>
    );
  if (!work || !context) return <div className="wb-loading">正在打开作品…</div>;

  const ActiveView = VIEWS.find((item) => item.id === view)?.component ?? ExplorerView;
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("frame:theme", next);
    setTheme(next);
  };

  return (
    <WorkbenchContext.Provider value={context}>
      <div className="wb">
        <PrecacheBar />
        <header className="wb-title">
          <button className="icon-btn" title="返回首页" onClick={() => navigate("/")}>
            <Home size={16} />
          </button>
          <div className="wb-title-name">
            <TitleEditor />
            <span className="faint ellipsis">
              {work.repo === "local" ? "本地" : work.repo} · {work.branch}
            </span>
          </div>
          <div className="wb-title-actions">
            <button
              className={`icon-btn ${sidebar.visible ? "active" : ""}`}
              title="侧边栏 (Ctrl+B)"
              onClick={() => setSidebar({ ...sidebar, visible: !sidebar.visible })}
            >
              <PanelLeft size={16} />
            </button>
            <button
              className={`icon-btn ${panel.visible ? "active" : ""}`}
              title="底部面板 (Ctrl+J)"
              onClick={() => setPanel({ ...panel, visible: !panel.visible })}
            >
              <PanelBottom size={16} />
            </button>
            <button
              className={`icon-btn ${chat.visible ? "active" : ""}`}
              title="AI 聊天 (Ctrl+I)"
              onClick={() => setChat({ ...chat, visible: !chat.visible })}
            >
              <PanelRight size={16} />
            </button>
            <button className="btn small primary" onClick={() => context.showView("export")}>
              <Clapperboard size={14} /> 导出
            </button>
          </div>
        </header>
        <div className="wb-body">
          <nav className="wb-activity" aria-label="视图">
            {VIEWS.map((item) => {
              // Like VS Code's Source Control: the number of unsaved changes on the versions icon.
              const changes = item.id === "versions" ? (status?.files.length ?? 0) : item.id === "experience" ? experienceChanges : 0;
              return (
                <button
                  key={item.id}
                  className={view === item.id && sidebar.visible ? "active" : ""}
                  title={changes ? `${item.label}（${changes} 个未保存的修改）` : item.label}
                  onClick={() =>
                    view === item.id ? setSidebar({ ...sidebar, visible: !sidebar.visible }) : (setView(item.id), setSidebar({ ...sidebar, visible: true }))
                  }
                >
                  <item.icon size={22} strokeWidth={1.6} />
                  {changes > 0 && <span className="activity-badge">{changes > 99 ? "99+" : changes}</span>}
                </button>
              );
            })}
            <span className="grow" />
            <button title="AI 聊天" className={chat.visible ? "active-soft" : ""} onClick={() => setChat({ ...chat, visible: !chat.visible })}>
              <Sparkles size={21} strokeWidth={1.6} />
            </button>
            <button title="切换主题" onClick={toggleTheme}>
              {theme === "light" ? <Moon size={20} strokeWidth={1.6} /> : <Sun size={20} strokeWidth={1.6} />}
            </button>
            <button title="设置" onClick={() => setSettingsOpen("ai")}>
              <SettingsIcon size={21} strokeWidth={1.6} />
            </button>
          </nav>
          {sidebar.visible && (
            <>
              <aside className={`wb-sidebar ${narrow ? "overlay" : ""}`} style={{ width: narrow ? undefined : sidebar.width }}>
                <ActiveView />
              </aside>
              {!narrow && (
                <Sash
                  direction="vertical"
                  onDrag={(delta) => setSidebar((value) => ({ ...value, width: Math.max(180, Math.min(600, value.width + delta)) }))}
                />
              )}
            </>
          )}
          <main className="wb-center">
            <div className="wb-editor">
              <EditorArea ref={editor} />
            </div>
            {panel.visible && (
              <>
                <Sash
                  direction="horizontal"
                  onDrag={(delta) => setPanel((value) => ({ ...value, height: Math.max(120, Math.min(innerHeight - 200, value.height - delta)) }))}
                />
                <section className="wb-panel" style={{ height: panel.height }}>
                  <BottomPanel tab={panel.tab} setTab={(tab) => setPanel({ ...panel, tab })} onClose={() => setPanel({ ...panel, visible: false })} />
                </section>
              </>
            )}
          </main>
          {narrow && (sidebar.visible || chat.visible) && (
            <div className="wb-scrim" onClick={() => (setSidebar({ ...sidebar, visible: false }), setChat({ ...chat, visible: false }))} />
          )}
          {chat.visible && (
            <>
              {!narrow && (
                <Sash direction="vertical" onDrag={(delta) => setChat((value) => ({ ...value, width: Math.max(300, Math.min(900, value.width - delta)) }))} />
              )}
              <aside className={`wb-chat ${narrow ? "overlay" : ""}`} style={{ width: narrow ? undefined : chat.width }}>
                <ChatPanel ref={chatRef} onClose={() => setChat({ ...chat, visible: false })} />
              </aside>
            </>
          )}
        </div>
        <StatusBar status={status} version={version} onOpenView={context.showView} />
      </div>
      {settingsOpen && (
        <Dialog title="设置" onClose={() => setSettingsOpen(null)} width={920}>
          <SettingsView initial={settingsOpen} />
        </Dialog>
      )}
    </WorkbenchContext.Provider>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const change = () => setMatches(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return matches;
}

function TitleEditor() {
  const { work, reload } = useWorkbench();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const toast = useToast();
  const title = work.meta?.title ?? work.id;
  const save = async () => {
    setEditing(false);
    if (!value.trim() || value.trim() === title) return;
    try {
      await api(workPath(work.repo, work.id), { method: "PATCH", body: { title: value.trim() } });
      await reload();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  return editing ? (
    <input
      className="input title-input"
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => (event.key === "Enter" ? save() : event.key === "Escape" && setEditing(false))}
    />
  ) : (
    <strong
      className="ellipsis"
      title="双击重命名"
      onDoubleClick={() => {
        setValue(title);
        setEditing(true);
      }}
    >
      {title}
    </strong>
  );
}

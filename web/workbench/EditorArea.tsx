import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from "react";
import { X, MonitorPlay, FileCode2, FileImage, FileAudio, FileVideo, File as FileIcon, Circle, Sparkles, FileDiff, BookOpen, Pencil, Eye } from "lucide-react";
import { api, formatTime, workPath, experiencePath, useServerEvent } from "../lib/api";
import { Markdown } from "../chat/Markdown";
import { useToast, useConfirm } from "../lib/ui";
import { useWorkbench } from "./store";
import { PreviewPane } from "./PreviewPane";
import { CodeEditor } from "./CodeEditor";
import { DiffEditor } from "./DiffEditor";

export interface EditorHandle {
  openFile(path: string, options?: { line?: number; preview?: boolean }): void;
  /** A document of the work's experience libraries (path relative to the experience branch). */
  openExperience(path: string, options?: { preview?: boolean }): void;
  /** Show changes in a diff tab; `query` is the /diff query (file=…, commit=… or empty). */
  openDiff(title: string, query: string, options?: { preview?: boolean; source?: Source }): void;
}
type Source = "work" | "experience";
interface Tab {
  /** Unique key: the work file path, `exp:<path>` for experience documents, `diff:…` for diffs. */
  path: string;
  /** Path inside its source (sent to the source's file API). */
  file: string;
  source: Source;
  kind: "text" | "image" | "audio" | "video" | "file" | "diff";
  title?: string;
  diff?: string;
  content?: string;
  saved?: string;
  hash?: string | null;
  external?: boolean;
  line?: number;
  /** VS Code preview tab: the next preview replaces it until it is kept. */
  preview?: boolean;
  /** Markdown shown rendered instead of as source. */
  rendered?: boolean;
}

const kindOf = (path: string): Tab["kind"] =>
  /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(path)
    ? "image"
    : /\.(wav|mp3|m4a|ogg|opus|flac|aac|weba)$/i.test(path)
      ? "audio"
      : /\.(mp4|webm|mov|m4v)$/i.test(path)
        ? "video"
        : /\.(ts|tsx|js|mjs|jsx|json|md|txt|css|html|glsl|frag|vert|srt|vtt|csv|ya?ml|toml)$/i.test(path)
          ? "text"
          : "file";

export const fileIcon = (path: string, size = 14) => {
  const kind = kindOf(path);
  return kind === "image" ? (
    <FileImage size={size} />
  ) : kind === "audio" ? (
    <FileAudio size={size} />
  ) : kind === "video" ? (
    <FileVideo size={size} />
  ) : kind === "text" ? (
    <FileCode2 size={size} />
  ) : (
    <FileIcon size={size} />
  );
};

/**
 * One editor group like VS Code: the preview is the first (fixed) tab and opened files
 * are tabs next to it. `active === null` shows the preview. The preview stays mounted
 * while another tab is shown, so playback, the timeline and AI captures keep working.
 * Tabs come from the work or from the repository's experience libraries.
 */
export function EditorArea({ ref, onActiveChange }: { ref?: Ref<EditorHandle>; onActiveChange?: (label: string | null) => void }) {
  const { work, readOnly } = useWorkbench();
  const toast = useToast();
  const confirm = useConfirm();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const apis: Record<Source, string> = { work: workPath(work.repo, work.id), experience: experiencePath(work.repo) };

  const load = useCallback(
    async (tab: Pick<Tab, "file" | "source">) => {
      const file = await api<{ content: string; hash: string }>(`${apis[tab.source]}/file?path=${encodeURIComponent(tab.file)}`);
      return { content: file.content, saved: file.content, hash: file.hash };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apis.work, apis.experience],
  );

  /** Show a tab: an open one is activated (and kept unless opened as preview); a new preview replaces the old one. */
  const place = useCallback(
    (tab: Tab, options: { line?: number; preview?: boolean }) => {
      setActive(tab.path);
      if (tabs.some((item) => item.path === tab.path)) {
        setTabs((list) =>
          list.map((item) => (item.path === tab.path ? { ...item, line: options.line ?? item.line, preview: options.preview ? item.preview : false } : item)),
        );
        return false;
      }
      setTabs((list) => {
        const reuse = options.preview ? list.findIndex((item) => item.preview && item.content === item.saved) : -1;
        return reuse >= 0 ? list.map((item, index) => (index === reuse ? tab : item)) : [...list, tab];
      });
      return true;
    },
    [tabs],
  );

  const openTab = useCallback(
    async (tab: Tab, options: { line?: number; preview?: boolean }) => {
      if (!place(tab, options)) return;
      if (tab.kind !== "text") return;
      try {
        const loaded = await load(tab);
        setTabs((list) => list.map((item) => (item.path === tab.path ? { ...item, ...loaded } : item)));
      } catch (error) {
        toast((error as Error).message, "error");
        setTabs((list) => list.filter((item) => item.path !== tab.path));
      }
    },
    [place, load, toast],
  );
  const openFile = useCallback(
    (path: string, options: { line?: number; preview?: boolean } = {}) =>
      openTab({ path, file: path, source: "work", kind: kindOf(path), line: options.line, preview: Boolean(options.preview) }, options),
    [openTab],
  );
  const openExperience = useCallback(
    (path: string, options: { preview?: boolean } = {}) =>
      // Experience documents open rendered: they are read more often than edited.
      openTab(
        { path: `exp:${path}`, file: path, source: "experience", kind: kindOf(path), preview: Boolean(options.preview), rendered: /\.md$/i.test(path) },
        options,
      ),
    [openTab],
  );
  const openDiff = useCallback(
    (title: string, query: string, options: { preview?: boolean; source?: Source } = {}) => {
      const preview = options.preview ?? true;
      const source = options.source ?? "work";
      place({ path: `diff:${source}:${query}`, file: "", source, kind: "diff", title, diff: query, preview }, { preview });
    },
    [place],
  );
  useImperativeHandle(
    ref,
    () => ({ openFile: (path, options) => void openFile(path, options), openExperience: (path, options) => void openExperience(path, options), openDiff }),
    [openFile, openExperience, openDiff],
  );

  // Files changed by the AI or other tools: refresh clean tabs, flag dirty ones.
  const refresh = (matches: (tab: Tab) => boolean) => {
    for (const tab of tabs) {
      if (tab.kind !== "text" || !matches(tab)) continue;
      void load(tab).then(
        (loaded) =>
          setTabs((list) =>
            list.map((item) => {
              if (item.path !== tab.path || loaded.hash === item.hash) return item;
              return item.content === item.saved ? { ...item, ...loaded, external: false } : { ...item, external: true };
            }),
          ),
        () => {},
      );
    }
  };
  useServerEvent(
    (event) => {
      if (event.type === "work-files" && event.work === work.id) {
        const changed = new Set((event.files as string[]).map((file) => file.replace(/^projects\/[^/]+\//, "")));
        refresh((tab) => tab.source === "work" && changed.has(tab.file));
      } else if (event.type === "experience-files" && event.repo === work.repo) {
        // A renamed library or document: its open tabs follow it.
        const moved = event.moved as { from: string; to: string } | undefined;
        if (moved) {
          const follow = (file: string) => (file === moved.from || file.startsWith(moved.from + "/") ? moved.to + file.slice(moved.from.length) : null);
          setTabs((list) =>
            list.map((tab) => {
              const file = tab.source === "experience" && tab.kind !== "diff" ? follow(tab.file) : null;
              return file ? { ...tab, file, path: `exp:${file}` } : tab;
            }),
          );
          setActive((current) => {
            const file = current?.startsWith("exp:") ? follow(current.slice(4)) : null;
            return file ? `exp:${file}` : current;
          });
        }
        const changed = event.files as string[];
        refresh((tab) => tab.source === "experience" && (!changed.length || changed.some((file) => tab.file === file || tab.file.startsWith(file + "/"))));
      }
    },
    [tabs, work.id, work.repo],
  );

  const save = async (path: string) => {
    const tab = tabs.find((item) => item.path === path);
    if (!tab || tab.content === undefined) return;
    try {
      const result = await api<{ hash: string }>(`${apis[tab.source]}/file`, {
        method: "PUT",
        body: { path: tab.file, content: tab.content, expectedHash: tab.external ? undefined : tab.hash },
      });
      setTabs((list) => list.map((item) => (item.path === path ? { ...item, saved: tab.content, hash: result.hash, external: false } : item)));
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const close = async (path: string) => {
    const tab = tabs.find((item) => item.path === path);
    if (tab && tab.content !== tab.saved && !(await confirm(`${tab.file} 有未保存的修改，确定关闭？`, { confirm: "不保存并关闭", danger: true }))) return;
    const index = tabs.findIndex((item) => item.path === path);
    const next = tabs.filter((item) => item.path !== path);
    setTabs(next);
    if (active === path) setActive(next[Math.min(index, next.length - 1)]?.path ?? null);
  };
  const current = tabs.find((tab) => tab.path === active) ?? null;
  // The AI is told which file the user has open ("这个文件").
  const activeLabel = !current
    ? null
    : current.kind === "diff"
      ? `改动「${current.title}」`
      : current.source === "experience"
        ? `经验库文档 ${current.file.split("/").slice(1).join("/")}`
        : current.file;
  useEffect(() => onActiveChange?.(activeLabel), [activeLabel, onActiveChange]);
  const update = (path: string, change: Partial<Tab>) => setTabs((list) => list.map((item) => (item.path === path ? { ...item, ...change } : item)));
  const tooltip = (tab: Tab) =>
    `${tab.kind === "diff" ? `改动：${tab.title}` : tab.source === "experience" ? `经验库：${tab.file}` : tab.file}${tab.preview ? "（预览，双击保持打开）" : ""}`;

  return (
    <div className="editor-area">
      <div className="editor-group">
        <div className="editor-tabs">
          <div className={`editor-tab ${current ? "" : "active"}`} title="作品预览" onClick={() => setActive(null)}>
            <MonitorPlay size={14} /> 预览
          </div>
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={`editor-tab ${tab.path === active ? "active" : ""} ${tab.preview ? "is-preview" : ""}`}
              title={tooltip(tab)}
              onClick={() => setActive(tab.path)}
              onDoubleClick={() => update(tab.path, { preview: false })}
              onMouseDown={(event) => event.button === 1 && (event.preventDefault(), void close(tab.path))}
            >
              {tab.kind === "diff" ? <FileDiff size={14} /> : tab.source === "experience" ? <BookOpen size={14} /> : fileIcon(tab.file)}
              <span className="ellipsis">{tab.title ?? tab.file.split("/").pop()}</span>
              <button
                className="tab-close"
                aria-label="关闭"
                onClick={(event) => {
                  event.stopPropagation();
                  void close(tab.path);
                }}
              >
                {tab.content !== tab.saved ? <Circle size={9} fill="currentColor" /> : <X size={13} />}
              </button>
            </div>
          ))}
        </div>
        <div className="editor-stack">
          <div className={`editor-layer ${current ? "covered" : ""}`} aria-hidden={Boolean(current)}>
            <PreviewPane />
          </div>
          {current && (
            <div className="editor-layer editor-content">
              {current.external && (
                <div className="editor-banner">
                  这个文件已被 AI 或其他程序修改。
                  <button className="btn small" onClick={() => load(current).then((loaded) => update(current.path, { ...loaded, external: false }))}>
                    载入新版本（丢弃我的修改）
                  </button>
                  <button className="btn small" onClick={() => save(current.path)}>
                    用我的版本覆盖
                  </button>
                </div>
              )}
              {current.kind === "text" && /\.md$/i.test(current.file) && current.content !== undefined && (
                <div className="editor-toolbar">
                  <span className="faint small-text ellipsis grow">{current.source === "experience" ? `经验库 · ${current.file}` : current.file}</span>
                  <div className="segmented">
                    <button className={current.rendered ? "" : "active"} onClick={() => update(current.path, { rendered: false })}>
                      <Pencil size={12} /> 编辑
                    </button>
                    <button className={current.rendered ? "active" : ""} onClick={() => update(current.path, { rendered: true })}>
                      <Eye size={12} /> 预览
                    </button>
                  </div>
                </div>
              )}
              {current.kind === "diff" ? (
                <DiffEditor query={current.diff!} source={current.source} />
              ) : current.kind === "text" ? (
                current.content === undefined ? (
                  <div className="empty">正在读取…</div>
                ) : current.rendered ? (
                  <div className="markdown-page" onDoubleClick={() => update(current.path, { rendered: false })} title="双击编辑">
                    <Markdown text={current.content} />
                  </div>
                ) : (
                  <CodeEditor
                    key={current.path}
                    path={current.file}
                    value={current.content}
                    line={current.line}
                    onChange={(content) => update(current.path, { content, preview: false })}
                    onSave={() => save(current.path)}
                    readOnly={readOnly && current.source !== "experience"}
                  />
                )
              ) : (
                <MediaViewer path={current.file} kind={current.kind} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MediaViewer({ path, kind }: { path: string; kind: Tab["kind"] }) {
  const { work, addToChat } = useWorkbench();
  const [version, setVersion] = useState(0);
  const [info, setInfo] = useState("");
  useEffect(() => {
    setVersion(Date.now());
    setInfo("");
  }, [path]);
  const url = `${workPath(work.repo, work.id)}/raw?path=${encodeURIComponent(path)}&v=${version}`;
  // Assets are referenced from code as films/<slug>/<path under public/>.
  const reference = path.startsWith("public/") ? `films/${work.slug}/${path.slice(7)}` : null;
  const media = (element: HTMLVideoElement | HTMLAudioElement) =>
    setInfo([element instanceof HTMLVideoElement && `${element.videoWidth}×${element.videoHeight}`, formatTime(element.duration)].filter(Boolean).join(" · "));
  return (
    <div className="media-viewer">
      {kind === "image" && <img src={url} alt={path} onLoad={(event) => setInfo(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)} />}
      {kind === "audio" && <audio src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
      {kind === "video" && <video src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
      {kind === "file" && <div className="empty">无法在这里预览这种文件</div>}
      <div className="media-info">
        <span className="faint mono ellipsis">{path}</span>
        {info && <span className="faint">{info}</span>}
        {reference && (
          <button className="btn small" onClick={() => addToChat({ type: "asset", url: reference, path })}>
            <Sparkles size={13} /> 引用到 AI 聊天
          </button>
        )}
      </div>
      {reference && kind !== "file" && <div className="faint small-text">拖动左侧「素材」中的这个文件到时间轴即可使用</div>}
    </div>
  );
}

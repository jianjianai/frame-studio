import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from "react";
import { X, MonitorPlay, FileCode2, FileImage, FileAudio, FileVideo, File as FileIcon, Circle, Sparkles, FileDiff } from "lucide-react";
import { api, formatTime, workPath, useServerEvent } from "../lib/api";
import { useToast, useConfirm } from "../lib/ui";
import { useWorkbench } from "./store";
import { PreviewPane } from "./PreviewPane";
import { CodeEditor } from "./CodeEditor";
import { DiffEditor } from "./DiffEditor";

export interface EditorHandle {
  openFile(path: string, options?: { line?: number; preview?: boolean }): void;
  /** Show changes in a diff tab; `query` is the /diff query (file=…, commit=… or empty). */
  openDiff(title: string, query: string, options?: { preview?: boolean }): void;
}
interface Tab {
  /** File path, or `diff:<query>` for a diff tab. */
  path: string;
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
 */
export function EditorArea({ ref }: { ref?: Ref<EditorHandle> }) {
  const { work } = useWorkbench();
  const toast = useToast();
  const confirm = useConfirm();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const base = workPath(work.repo, work.id);

  const load = useCallback(
    async (path: string) => {
      const file = await api<{ content: string; hash: string }>(`${base}/file?path=${encodeURIComponent(path)}`);
      return { content: file.content, saved: file.content, hash: file.hash };
    },
    [base],
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

  const openFile = useCallback(
    async (path: string, options: { line?: number; preview?: boolean } = {}) => {
      const kind = kindOf(path);
      if (!place({ path, kind, line: options.line, preview: Boolean(options.preview) }, options)) return;
      if (kind === "text") {
        try {
          const loaded = await load(path);
          setTabs((list) => list.map((item) => (item.path === path ? { ...item, ...loaded } : item)));
        } catch (error) {
          toast((error as Error).message, "error");
          setTabs((list) => list.filter((item) => item.path !== path));
        }
      }
    },
    [place, load, toast],
  );
  const openDiff = useCallback(
    (title: string, query: string, options: { preview?: boolean } = {}) => {
      const preview = options.preview ?? true;
      place({ path: `diff:${query}`, kind: "diff", title, diff: query, preview }, { preview });
    },
    [place],
  );
  useImperativeHandle(ref, () => ({ openFile: (path, options) => void openFile(path, options), openDiff }), [openFile, openDiff]);

  // Files changed by AI or other tools: refresh clean tabs, flag dirty ones.
  useServerEvent(
    (event) => {
      if (event.type !== "work-files" || event.work !== work.id) return;
      const changed = new Set((event.files as string[]).map((file) => file.replace(/^projects\/[^/]+\//, "")));
      for (const tab of tabs) {
        if (tab.kind !== "text" || !changed.has(tab.path)) continue;
        void load(tab.path).then(
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
    },
    [tabs, work.id],
  );

  const save = async (path: string) => {
    const tab = tabs.find((item) => item.path === path);
    if (!tab || tab.content === undefined) return;
    try {
      const result = await api<{ hash: string }>(`${base}/file`, {
        method: "PUT",
        body: { path, content: tab.content, expectedHash: tab.external ? undefined : tab.hash },
      });
      setTabs((list) => list.map((item) => (item.path === path ? { ...item, saved: tab.content, hash: result.hash, external: false } : item)));
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const close = async (path: string) => {
    const tab = tabs.find((item) => item.path === path);
    if (tab && tab.content !== tab.saved && !(await confirm(`${path} 有未保存的修改，确定关闭？`, { confirm: "不保存并关闭", danger: true }))) return;
    const index = tabs.findIndex((item) => item.path === path);
    const next = tabs.filter((item) => item.path !== path);
    setTabs(next);
    if (active === path) setActive(next[Math.min(index, next.length - 1)]?.path ?? null);
  };
  const current = tabs.find((tab) => tab.path === active) ?? null;

  const keep = (path: string) => setTabs((list) => list.map((item) => (item.path === path ? { ...item, preview: false } : item)));

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
              title={`${tab.kind === "diff" ? `改动：${tab.title}` : tab.path}${tab.preview ? "（预览，双击保持打开）" : ""}`}
              onClick={() => setActive(tab.path)}
              onDoubleClick={() => keep(tab.path)}
              onMouseDown={(event) => event.button === 1 && (event.preventDefault(), void close(tab.path))}
            >
              {tab.kind === "diff" ? <FileDiff size={14} /> : fileIcon(tab.path)}
              <span className="ellipsis">{tab.title ?? tab.path.split("/").pop()}</span>
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
                  <button
                    className="btn small"
                    onClick={() =>
                      load(current.path).then((loaded) =>
                        setTabs((list) => list.map((item) => (item.path === current.path ? { ...item, ...loaded, external: false } : item))),
                      )
                    }
                  >
                    载入新版本（丢弃我的修改）
                  </button>
                  <button className="btn small" onClick={() => save(current.path)}>
                    用我的版本覆盖
                  </button>
                </div>
              )}
              {current.kind === "diff" ? (
                <DiffEditor query={current.diff!} />
              ) : current.kind === "text" ? (
                current.content === undefined ? (
                  <div className="empty">正在读取…</div>
                ) : (
                  <CodeEditor
                    key={current.path}
                    path={current.path}
                    value={current.content}
                    line={current.line}
                    onChange={(content) => setTabs((list) => list.map((item) => (item.path === current.path ? { ...item, content, preview: false } : item)))}
                    onSave={() => save(current.path)}
                  />
                )
              ) : (
                <MediaViewer path={current.path} kind={current.kind} />
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

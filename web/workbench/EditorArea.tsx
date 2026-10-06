import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from "react";
import { X, MonitorPlay, FileCode2, FileImage, FileAudio, FileVideo, File as FileIcon, Circle, Sparkles, FileDiff, BookOpen, Pencil, Eye } from "lucide-react";
import { api, formatTime, workPath, experiencePath, useServerEvent, materialsPath } from "../lib/api";
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
  /** A file of the repository's material libraries (`<library>/<path>`): viewed, not edited here. */
  openMaterial(ref: string, options?: { preview?: boolean }): void;
  /** Show changes in a diff tab; `query` is the /diff query (file=…, commit=… or empty). */
  openDiff(title: string, query: string, options?: { preview?: boolean; source?: Source }): void;
}
type Source = "work" | "experience" | "materials";
interface Tab {
  /** Unique key: the work file path, `exp:<path>` for experience documents, `mat:<ref>` for material files, `diff:…` for diffs. */
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
  const apis: Record<Source, string> = { work: workPath(work.repo, work.id), experience: experiencePath(work.repo), materials: materialsPath(work.repo) };

  const load = useCallback(
    async (tab: Pick<Tab, "file" | "source">) => {
      const file = await api<{ content: string; hash: string }>(`${apis[tab.source]}/file?path=${encodeURIComponent(tab.file)}`);
      return { content: file.content, saved: file.content, hash: file.hash };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apis.work, apis.experience, apis.materials],
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
      // Material files are read by their viewer (raw, current or locked version).
      if (tab.kind !== "text" || tab.source === "materials") return;
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
  const openMaterial = useCallback(
    (ref: string, options: { preview?: boolean } = {}) =>
      openTab({ path: `mat:${ref}`, file: ref, source: "materials", kind: kindOf(ref), preview: Boolean(options.preview) }, options),
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
    () => ({
      openFile: (path, options) => void openFile(path, options),
      openExperience: (path, options) => void openExperience(path, options),
      openMaterial: (ref, options) => void openMaterial(ref, options),
      openDiff,
    }),
    [openFile, openExperience, openMaterial, openDiff],
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
        : current.source === "materials"
          ? `素材库文件 materials/${current.file}`
          : current.file;
  useEffect(() => onActiveChange?.(activeLabel), [activeLabel, onActiveChange]);
  const update = (path: string, change: Partial<Tab>) => setTabs((list) => list.map((item) => (item.path === path ? { ...item, ...change } : item)));
  const tooltip = (tab: Tab) =>
    `${tab.kind === "diff" ? `改动：${tab.title}` : tab.source === "experience" ? `经验库：${tab.file}` : tab.source === "materials" ? `素材库：materials/${tab.file}` : tab.file}${tab.preview ? "（预览，双击保持打开）" : ""}`;

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
              ) : current.source === "materials" ? (
                <MaterialViewer key={current.file} fileRef={current.file} kind={current.kind} />
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

interface MaterialUse {
  ref: string;
  used: boolean;
  locked: string | null;
  outdated: boolean;
}

/**
 * A file of the material libraries: as the library has it now, or, when the library has a
 * newer version than the one this work locked, the version the work uses.
 */
function MaterialViewer({ fileRef, kind }: { fileRef: string; kind: Tab["kind"] }) {
  const { work, addToChat, readOnly } = useWorkbench();
  const toast = useToast();
  const [use, setUse] = useState<MaterialUse | null>(null);
  const [lockedVersion, setLockedVersion] = useState(false);
  const [version, setVersion] = useState(() => Date.now());
  const [info, setInfo] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const status = useCallback(
    () =>
      api<{ files: MaterialUse[] }>(`${workPath(work.repo, work.id)}/materials`).then(
        (result) => setUse(result.files.find((item) => item.ref === fileRef) ?? null),
        () => {},
      ),
    [work.repo, work.id, fileRef],
  );
  useEffect(() => void status(), [status]);
  useServerEvent(
    (event) => {
      if (event.type === "materials" && event.repo === work.repo) {
        // A change of its library (or a sync of all of them): show the file anew.
        const paths = (event.paths as string[] | undefined) ?? [];
        if (!paths.length || paths.some((item) => fileRef === item || fileRef.startsWith(item + "/"))) setVersion(Date.now());
        void status();
      }
      if (event.type === "work-materials" && event.work === work.id) void status();
    },
    [work.repo, work.id, fileRef, status],
  );
  const showLocked = lockedVersion && Boolean(use?.outdated);
  const url = showLocked
    ? `${work.preview.assetBase}materials/${fileRef.split("/").map(encodeURIComponent).join("/")}?v=${use?.locked}`
    : `${materialsPath(work.repo)}/file?path=${encodeURIComponent(fileRef)}&v=${version}`;
  const missing = "文件不存在（可能已在素材库中移动或删除）";
  useEffect(() => {
    setInfo("");
    setFailed("");
    if (kind !== "text") return;
    setText(null);
    let current = true;
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? missing : `读取失败（${response.status}）`);
        const content = await response.text();
        if (current) setText(content);
      })
      .catch((error: Error) => current && setFailed(error.message));
    return () => {
      current = false;
    };
  }, [url, kind]);
  const media = (element: HTMLVideoElement | HTMLAudioElement) =>
    setInfo([element instanceof HTMLVideoElement && element.videoWidth && `${element.videoWidth}×${element.videoHeight}`, formatTime(element.duration)].filter(Boolean).join(" · "));
  const update = () =>
    api(`${workPath(work.repo, work.id)}/materials/lock`, { body: { refs: [fileRef], update: true } }).then(
      () => (setLockedVersion(false), toast("本作品已改用素材库里的最新版本", "ok")),
      (error: Error) => toast(error.message, "error"),
    );
  const state = !use?.locked
    ? use?.used
      ? "本作品用到了它，保存版本时会锁定这个版本"
      : ""
    : use.outdated
      ? showLocked
        ? "本作品使用的版本（素材库里已有新版本）"
        : "素材库里的最新版本，本作品仍使用锁定的旧版本"
      : "本作品已锁定这个版本";
  return (
    <>
      <div className="editor-toolbar material-toolbar">
        <span className="faint small-text ellipsis grow" title={`materials/${fileRef}`}>
          素材库 · materials/{fileRef}
          {info && ` · ${info}`}
        </span>
        {use?.outdated && (
          <div className="segmented">
            <button className={showLocked ? "" : "active"} onClick={() => setLockedVersion(false)}>
              最新版本
            </button>
            <button className={showLocked ? "active" : ""} onClick={() => setLockedVersion(true)}>
              本作品的版本
            </button>
          </div>
        )}
        {use?.outdated && !readOnly && (
          <button className="btn small" onClick={update}>
            更新到最新版本
          </button>
        )}
        <button className="btn small" onClick={() => addToChat({ type: "asset", url: `materials/${fileRef}` })}>
          <Sparkles size={13} /> 引用到 AI 聊天
        </button>
      </div>
      {state && <div className={`material-state ${use?.outdated ? "warn-text" : "faint"}`}>{state}</div>}
      {kind === "text" ? (
        text === null ? (
          <div className="empty">{failed || "正在读取…"}</div>
        ) : (
          <CodeEditor key={url} path={fileRef} value={text} onChange={() => {}} onSave={() => {}} readOnly />
        )
      ) : (
        <div className="media-viewer">
          {kind === "image" && (
            <img key={url} src={url} alt={fileRef} onLoad={(event) => setInfo(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)} onError={() => setFailed(missing)} />
          )}
          {kind === "audio" && <audio key={url} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} onError={() => setFailed(missing)} />}
          {kind === "video" && <video key={url} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} onError={() => setFailed(missing)} />}
          {kind === "file" && <div className="empty">无法在这里预览这种文件</div>}
          {failed && <div className="danger-text small-text">{failed}</div>}
          {kind !== "file" && !failed && <div className="faint small-text">引用了这个素材库的作品，可以把左侧「素材 → 素材库」中的这个文件拖到时间轴使用</div>}
        </div>
      )}
    </>
  );
}

import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Ref } from "react";
import { X, MonitorPlay, FileCode2, FileImage, FileAudio, FileVideo, File as FileIcon, Circle, Sparkles, FileDiff, BookOpen, Pencil, Eye, Shapes, BarChart3, Box, Globe2, Type, Clapperboard, Play, ExternalLink, Download } from "lucide-react";
import { api, ApiError, formatTime, sampleName, workPath, experiencePath, useServerEvent, materialsPath } from "../lib/api";
import { reviewsPath } from "../lib/reviews";
import { RawViewer } from "../reviews/RawViewer";
import { Markdown } from "../chat/Markdown";
import { useToast, useConfirm } from "../lib/ui";
import { useWorkbench, type Tool, type VersionSource } from "./store";
import { ToolTab, TOOL_TITLES, toolIcon } from "./ToolTab";
import { PreviewPane } from "./PreviewPane";
import { CodeEditor } from "./CodeEditor";
import { DiffEditor } from "./DiffEditor";
import { ResourceViewer } from "./ResourceViewer";
import { AssetViewer } from "./AssetViewer";
import { SampleTab, playable } from "./SampleTab";
import { PageViewer, usePageUrl } from "./PageViewer";
import { isLottieText } from "../views/media";

export interface EditorHandle {
  openFile(path: string, options?: { line?: number; preview?: boolean }): void;
  /** A module of the work played on its own (a sample, a sheet). */
  openSample(path: string, options?: { preview?: boolean }): void;
  /** A document of the work's experience libraries (path relative to the experience branch). */
  openExperience(path: string, options?: { preview?: boolean }): void;
  /** A file of the repository's material libraries (`<library>/<path>`): viewed, not edited here. */
  openMaterial(ref: string, options?: { preview?: boolean }): void;
  /** A resource or sound of the material libraries (`<library>/<file>#<name>`), previewed. */
  openResource(id: string, options?: { preview?: boolean; title?: string }): void;
  /** A file of a work's review (`<work id>/<path>`): documents are edited, original files viewed. */
  openReview(path: string, options?: { preview?: boolean }): void;
  /** Show changes in a diff tab; `query` is the /diff query (file=…, commit=… or empty). */
  openDiff(title: string, query: string, options?: { preview?: boolean; source?: VersionSource }): void;
  /** A tool in its own tab (export, reviews, resources, library management). */
  openTool(tool: Tool): void;
  /** Bring the film's preview to the front. */
  showPreview(): void;
}
type Source = "work" | "experience" | "materials" | "resource" | "reviews";
interface Tab {
  /** Unique key: the work file path, `sample:<path>` for a module played on its own, `exp:<path>` for experience documents, `mat:<ref>` for material files, `rev:<path>` for review files, `diff:…` for diffs, `tool:<tool>` for tools. */
  path: string;
  /** Path inside its source (sent to the source's file API). */
  file: string;
  source: Source;
  kind: "text" | "image" | "audio" | "video" | "model" | "environment" | "font" | "file" | "diff" | "resource" | "raw" | "tool" | "sample";
  title?: string;
  diff?: string;
  content?: string;
  saved?: string;
  hash?: string | null;
  external?: boolean;
  line?: number;
  /** VS Code preview tab: the next preview replaces it until it is kept. */
  preview?: boolean;
  /** Markdown, an HTML page or a Lottie animation shown rendered instead of as source. */
  rendered?: boolean;
  /** Why the text cannot be opened (too large): the tab stays and says so. */
  unreadable?: string;
  /** When the file last changed on disk: a page shown rendered loads it again. */
  stamp?: number;
}

const isPage = (path: string) => /\.html?$/i.test(path);

const kindOf = (path: string): Tab["kind"] =>
  /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(path)
    ? "image"
    : /\.(wav|mp3|m4a|ogg|opus|flac|aac|weba)$/i.test(path)
      ? "audio"
      : /\.(mp4|webm|mov|m4v)$/i.test(path)
        ? "video"
        : /\.(glb|gltf|fbx|obj)$/i.test(path)
          ? "model"
          : /\.(hdr|exr)$/i.test(path)
            ? "environment"
            : /\.(ttf|otf|woff2?)$/i.test(path)
              ? "font"
              : /\.(ts|tsx|js|mjs|jsx|json|md|txt|css|html|glsl|frag|vert|srt|vtt|csv|ya?ml|toml|mtl)$/i.test(path)
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
  ) : kind === "model" ? (
    <Box size={size} />
  ) : kind === "environment" ? (
    <Globe2 size={size} />
  ) : kind === "font" ? (
    <Type size={size} />
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
  const apis: Record<Source, string> = {
    work: workPath(work.repo, work.id),
    experience: experiencePath(work.repo),
    materials: materialsPath(work.repo),
    resource: "",
    reviews: reviewsPath(work.repo),
  };

  const load = useCallback(
    async (tab: Pick<Tab, "file" | "source">) => {
      const file = await api<{ content: string; hash: string }>(`${apis[tab.source]}/file?path=${encodeURIComponent(tab.file)}`);
      return { content: file.content, saved: file.content, hash: file.hash };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apis.work, apis.experience, apis.materials, apis.reviews],
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

  /** Read a text tab's content; a file too large for the editor keeps its tab, which says so. */
  const fill = useCallback(
    async (tab: Tab) => {
      try {
        const loaded = await load(tab);
        setTabs((list) => list.map((item) => (item.path === tab.path ? { ...item, ...loaded, unreadable: undefined } : item)));
      } catch (error) {
        if (error instanceof ApiError && error.status === 413) return setTabs((list) => list.map((item) => (item.path === tab.path ? { ...item, unreadable: error.message } : item)));
        toast((error as Error).message, "error");
        setTabs((list) => list.filter((item) => item.path !== tab.path));
      }
    },
    [load, toast],
  );
  const openTab = useCallback(
    async (tab: Tab, options: { line?: number; preview?: boolean }) => {
      if (!place(tab, options)) return;
      // Material files are read by their viewer (raw, current or locked version); a page shown
      // rendered is read when its code is asked for (it may be too large for the editor).
      if (tab.kind !== "text" || tab.source === "materials" || (tab.rendered && isPage(tab.file))) return;
      await fill(tab);
    },
    [place, fill],
  );
  const openFile = useCallback(
    (path: string, options: { line?: number; preview?: boolean } = {}) =>
      // An HTML file opens as the page it is.
      openTab({ path, file: path, source: "work", kind: kindOf(path), line: options.line, preview: Boolean(options.preview), rendered: isPage(path) && options.line === undefined }, options),
    [openTab],
  );
  const openSample = useCallback(
    (path: string, options: { preview?: boolean } = {}) =>
      place({ path: `sample:${path}`, file: path, source: "work", kind: "sample", title: sampleName(path), preview: Boolean(options.preview) }, options),
    [place],
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
  const openResource = useCallback(
    (id: string, options: { preview?: boolean; title?: string } = {}) =>
      place({ path: `res:${id}`, file: id, source: "resource", kind: "resource", title: options.title, preview: Boolean(options.preview) }, options),
    [place],
  );
  const openReview = useCallback(
    (path: string, options: { preview?: boolean } = {}) => {
      // Review documents open rendered like experience documents; original files in their viewer.
      const document = /\.(md|txt)$/i.test(path) && !/^[^/]+\/raw\//.test(path);
      return openTab(
        { path: `rev:${path}`, file: path, source: "reviews", kind: document ? "text" : "raw", preview: Boolean(options.preview), rendered: /\.md$/i.test(path) },
        options,
      );
    },
    [openTab],
  );
  const openDiff = useCallback(
    (title: string, query: string, options: { preview?: boolean; source?: VersionSource } = {}) => {
      const preview = options.preview ?? true;
      const source = options.source ?? "work";
      place({ path: `diff:${source}:${query}`, file: "", source, kind: "diff", title, diff: query, preview }, { preview });
    },
    [place],
  );
  const openTool = useCallback(
    (tool: Tool) => void place({ path: `tool:${tool}`, file: tool, source: "work", kind: "tool", title: TOOL_TITLES[tool] }, { preview: false }),
    [place],
  );
  useImperativeHandle(
    ref,
    () => ({
      openFile: (path, options) => void openFile(path, options),
      openSample,
      openExperience: (path, options) => void openExperience(path, options),
      openMaterial: (ref, options) => void openMaterial(ref, options),
      openResource,
      openReview: (path, options) => void openReview(path, options),
      openDiff,
      openTool,
      showPreview: () => setActive(null),
    }),
    [openFile, openSample, openExperience, openMaterial, openResource, openReview, openDiff, openTool],
  );

  // Files changed by the AI or other tools: refresh clean tabs, flag dirty ones.
  const refresh = (matches: (tab: Tab) => boolean) => {
    for (const tab of tabs) {
      if (tab.kind !== "text" || tab.content === undefined || !matches(tab)) continue;
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
        const stamp = Date.now();
        setTabs((list) => (list.some((tab) => tab.source === "work" && changed.has(tab.file)) ? list.map((tab) => (tab.source === "work" && changed.has(tab.file) ? { ...tab, stamp } : tab)) : list));
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
      } else if ((event.type === "reviews" && event.repo === work.repo) || (event.type === "work-versions" && event.work === `reviews-${work.repo}`)) {
        refresh((tab) => tab.source === "reviews" && (!event.work || tab.file.startsWith(`${event.work}/`)));
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
  // A Lottie animation among the work's files (public/) can be played as well as read.
  const lottie = useMemo(
    () => Boolean(current && current.source === "work" && current.kind === "text" && /^public\/.+\.json$/i.test(current.file) && isLottieText(current.content)),
    [current?.source, current?.kind, current?.file, current?.content],
  );
  const page = Boolean(current && current.kind === "text" && isPage(current.file));
  // The AI is told which file the user has open ("这个文件").
  const activeLabel = !current
    ? null
    : current.kind === "sample"
      ? `样片 ${current.file}（单独播放，不在时间轴上）`
    : current.kind === "tool"
      ? `「${current.title}」选项卡`
    : current.kind === "diff"
      ? `改动「${current.title}」`
      : current.kind === "resource"
        ? `素材库资源预览 ${current.file}`
        : current.source === "experience"
        ? `经验库文档 ${current.file.split("/").slice(1).join("/")}`
        : current.source === "reviews"
        ? `复盘资料 ${current.file.split("/").slice(1).join("/")}`
        : current.source === "materials"
          ? `素材库文件 materials/${current.file}`
          : current.file;
  useEffect(() => onActiveChange?.(activeLabel), [activeLabel, onActiveChange]);
  const update = (path: string, change: Partial<Tab>) => setTabs((list) => list.map((item) => (item.path === path ? { ...item, ...change } : item)));
  const tooltip = (tab: Tab) =>
    `${tab.kind === "sample" ? `样片：${tab.file}` : tab.kind === "tool" ? (tab.title ?? "") : tab.kind === "diff" ? `改动：${tab.title}` : tab.kind === "resource" ? `资源：${tab.file}` : tab.source === "experience" ? `经验库：${tab.file}` : tab.source === "reviews" ? `复盘：${tab.file}` : tab.source === "materials" ? `素材库：materials/${tab.file}` : tab.file}${tab.preview ? "（预览，双击保持打开）" : ""}`;

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
              {tab.kind === "sample" ? (
                <Clapperboard size={14} />
              ) : tab.kind === "tool" ? (
                toolIcon(tab.file as Tool)
              ) : tab.kind === "diff" ? (
                <FileDiff size={14} />
              ) : tab.kind === "resource" ? (
                <Shapes size={14} />
              ) : tab.source === "experience" ? (
                <BookOpen size={14} />
              ) : tab.source === "reviews" ? (
                <BarChart3 size={14} />
              ) : (
                fileIcon(tab.file)
              )}
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
          {/* Like the film's preview, a sample keeps its stage while its tab is open. */}
          {tabs
            .filter((tab) => tab.kind === "sample")
            .map((tab) => (
              <div key={tab.path} className={`editor-layer editor-content ${tab.path === active ? "" : "covered"}`} aria-hidden={tab.path !== active}>
                <SampleTab file={tab.file} active={tab.path === active} />
              </div>
            ))}
          {current && current.kind !== "sample" && (
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
              {current.kind === "text" && (((/\.md$/i.test(current.file) || lottie) && current.content !== undefined) || (page && current.source === "work")) && (
                <div className="editor-toolbar">
                  <span className="faint small-text ellipsis grow">
                    {current.source === "experience" ? `经验库 · ${current.file}` : current.source === "reviews" ? `复盘 · ${current.file}` : current.file}
                    {lottie ? " · Lottie 动画" : ""}
                  </span>
                  {page && current.rendered && <PageLink file={current.file} version={current.stamp} />}
                  <div className="segmented">
                    <button
                      className={current.rendered ? "" : "active"}
                      onClick={() => {
                        update(current.path, { rendered: false });
                        if (current.content === undefined && !current.unreadable) void fill(current);
                      }}
                    >
                      <Pencil size={12} /> {lottie || page ? "代码" : "编辑"}
                    </button>
                    <button className={current.rendered ? "active" : ""} onClick={() => update(current.path, { rendered: true })}>
                      <Eye size={12} /> {lottie ? "动画" : page ? "页面" : "预览"}
                    </button>
                  </div>
                </div>
              )}
              {current.kind === "text" && current.source === "work" && !current.rendered && playable(current.content) && !/^(scene|project)\.ts$/.test(current.file) && (
                <div className="editor-toolbar">
                  <span className="faint small-text ellipsis grow">{current.file} 导出了 createScene，可以不放进时间轴单独播放</span>
                  <button className="btn small" onClick={() => openSample(current.file)}>
                    <Play size={13} /> {/export\s+const\s+sample\b/.test(current.content ?? "") ? "播放样片" : "单独播放"}
                  </button>
                </div>
              )}
              {current.kind === "tool" ? (
                <ToolTab key={current.file} tool={current.file as Tool} />
              ) : current.kind === "resource" ? (
                <ResourceViewer key={current.file} id={current.file} />
              ) : current.kind === "raw" ? (
                <RawViewer key={current.file} fileRef={current.file} />
              ) : current.kind === "diff" ? (
                <DiffEditor query={current.diff!} source={current.source === "resource" ? "materials" : current.source} />
              ) : current.source === "materials" ? (
                <MaterialViewer key={current.file} fileRef={current.file} kind={current.kind} />
              ) : current.kind === "text" ? (
                current.rendered && page && current.source === "work" ? (
                  <PageViewer work={work} file={current.file} version={current.stamp} />
                ) : current.unreadable ? (
                  <TooLarge path={current.file} message={current.unreadable} onPage={page ? () => update(current.path, { rendered: true }) : undefined} />
                ) : current.content === undefined ? (
                  <div className="empty">正在读取…</div>
                ) : current.rendered && lottie ? (
                  <AssetViewer assetBase={work.preview.assetBase} src={`films/${work.slug}/${current.file.slice("public/".length)}`} version={current.hash ?? undefined} />
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
                    // Published works keep their libraries and reviews editable: they are not the work.
                    readOnly={readOnly && current.source === "work"}
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

/** Open the page in a browser tab of its own (still sandboxed by the server). */
function PageLink({ file, version }: { file: string; version?: number }) {
  const { work } = useWorkbench();
  const { url } = usePageUrl(work, file, version);
  return (
    <a className={`btn small ${url ? "" : "disabled"}`} href={url ?? undefined} target="_blank" rel="noopener" title="在浏览器的新标签页里打开这个页面">
      <ExternalLink size={13} /> 新标签页
    </a>
  );
}

/** A text file too large for the editor: it can still be downloaded (and an HTML file seen as a page). */
function TooLarge({ path, message, onPage }: { path: string; message: string; onPage?: () => void }) {
  const { work } = useWorkbench();
  return (
    <div className="empty">
      <p>{message}</p>
      <div className="row">
        {onPage && (
          <button className="btn small" onClick={onPage}>
            <Eye size={13} /> 看页面
          </button>
        )}
        <a className="btn small" href={`${workPath(work.repo, work.id)}/raw?path=${encodeURIComponent(path)}`} download={path.split("/").pop()}>
          <Download size={13} /> 下载
        </a>
      </div>
    </div>
  );
}

function MediaViewer({ path, kind }: { path: string; kind: Tab["kind"] }) {
  const { work, addToChat } = useWorkbench();
  const drawn = kind === "model" || kind === "environment" || kind === "font";
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
  if (drawn && reference)
    return (
      <>
        <div className="editor-toolbar material-toolbar">
          <span className="faint small-text ellipsis grow">{path}</span>
          <button className="btn small" onClick={() => addToChat({ type: "asset", url: reference, path })}>
            <Sparkles size={13} /> 引用到 AI 聊天
          </button>
        </div>
        <AssetViewer assetBase={work.preview.assetBase} src={reference} version={version} />
      </>
    );
  return (
    <div className="media-viewer">
      {kind === "image" && <img src={url} alt={path} onLoad={(event) => setInfo(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`)} />}
      {kind === "audio" && <audio src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
      {kind === "video" && <video src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
      {(kind === "file" || drawn) && <div className="empty">无法在这里预览这种文件{drawn ? "（只有 public/ 里的素材能预览）" : ""}</div>}
      <div className="media-info">
        <span className="faint mono ellipsis">{path}</span>
        {info && <span className="faint">{info}</span>}
        {reference && (
          <button className="btn small" onClick={() => addToChat({ type: "asset", url: reference, path })}>
            <Sparkles size={13} /> 引用到 AI 聊天
          </button>
        )}
      </div>
      {reference && kind !== "file" && <div className="faint small-text">把「素材」侧栏里的这个文件拖到时间轴即可使用（触屏上长按它选「添加到画面」）</div>}
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
  const [source, setSource] = useState(false);
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
  const lottie = useMemo(() => /\.json$/i.test(fileRef) && isLottieText(text ?? undefined), [fileRef, text]);
  // Drawn by the engine: as the library has it now, or at the version this work locked.
  const assetBase = showLocked ? work.preview.assetBase : (work.preview.library?.assetBase ?? `/files/${encodeURIComponent(work.repo)}/-/`);
  const drawn = kind === "model" || kind === "environment" || kind === "font" || (lottie && !source);
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
        {lottie && (
          <div className="segmented">
            <button className={source ? "" : "active"} onClick={() => setSource(false)}>
              动画
            </button>
            <button className={source ? "active" : ""} onClick={() => setSource(true)}>
              源码
            </button>
          </div>
        )}
        <button className="btn small" onClick={() => addToChat({ type: "asset", url: `materials/${fileRef}` })}>
          <Sparkles size={13} /> 引用到 AI 聊天
        </button>
      </div>
      {state && <div className={`material-state ${use?.outdated ? "warn-text" : "faint"}`}>{state}</div>}
      {drawn ? (
        <AssetViewer key={`${assetBase}|${fileRef}`} assetBase={assetBase} src={`materials/${fileRef}`} version={showLocked ? (use?.locked ?? undefined) : version} />
      ) : kind === "text" ? (
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
          {kind !== "file" && !failed && <div className="faint small-text">把「素材 → 素材库」或「素材库」选项卡里的这个文件拖到时间轴即可使用（触屏上长按它选「添加到画面」）</div>}
        </div>
      )}
    </>
  );
}

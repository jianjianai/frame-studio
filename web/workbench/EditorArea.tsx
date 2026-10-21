import { Fragment, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  X,
  MonitorPlay,
  FileCode2,
  FileImage,
  FileAudio,
  FileVideo,
  File as FileIcon,
  Circle,
  Sparkles,
  FileDiff,
  BookOpen,
  Pencil,
  Eye,
  Shapes,
  BarChart3,
  Puzzle,
  Box,
  Globe2,
  Type,
  Clapperboard,
  Play,
  ExternalLink,
  Download,
  Columns2,
  Link2,
  PanelLeft,
  PanelRight,
  PanelTop,
  PanelBottom,
  ArrowRightLeft,
  PenTool,
  Code2,
  Save,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api, ApiError, formatTime, sampleName, workPath, experiencePath, useServerEvent, materialsPath, skillsPath } from "../lib/api";
import { reviewsPath } from "../lib/reviews";
import { keptText, useKeptFile } from "../lib/precache";
import { RawViewer } from "../reviews/RawViewer";
import { Markdown } from "../chat/Markdown";
import { coarsePointer } from "../lib/touch";
import { Sash, useConfirm, useContextMenu, useToast, type MenuItem } from "../lib/ui";
import { Observable, TabVisible, useObservable, useTabVisible, useWorkbench, type Tool, type VersionSource } from "./store";
import { ToolTab, TOOL_TITLES, toolIcon } from "./ToolTab";
import { PreviewPane } from "./PreviewPane";
import { CodeEditor } from "./CodeEditor";
import { DiffEditor } from "./DiffEditor";
import { ResourceViewer } from "./ResourceViewer";
import { AssetViewer } from "./AssetViewer";
import { ZoomImage } from "./ZoomImage";
import { SampleTab, playable } from "./SampleTab";
import { PageViewer, usePageUrl } from "./PageViewer";
import { SvgEditor } from "./SvgEditor";
import { isLottieText } from "../views/media";
import {
  activate,
  closeEditor,
  dropZone,
  evenSplit,
  groupOrder,
  groupsWith,
  initialState,
  moveEditor,
  openEditor,
  renameKey,
  resizeSplit,
  splitGroup,
  updateEditor,
  visibleEditors,
  type Editor,
  type EditorState,
  type Group,
  type Layout,
  type Side,
  type Zone,
} from "./editorGroups";
import { mediaPlayer, players, registerPlayer, stagePlayer } from "./players";
import { TimelineSync } from "./timelineSync";

/** Where opened editors go: a group (the focused one by default), or a new group split off beside it. */
export interface OpenAt {
  group?: string;
  split?: Side;
}
export interface EditorHandle {
  openFile(path: string, options?: { line?: number } & OpenAt): void;
  /** A module of the work played on its own (a sample, a sheet). */
  openSample(path: string, options?: OpenAt): void;
  /** A document of the work's experience libraries (path relative to the experience branch). */
  openExperience(path: string): void;
  /** A file of the repository's material libraries (`<library>/<path>`): viewed, not edited here. */
  openMaterial(ref: string): void;
  /** A resource or sound of the material libraries (`<library>/<file>#<name>`), previewed. */
  openResource(id: string, options?: { title?: string }): void;
  /** A file of a work's review (`<work id>/<path>`): documents are edited, original files viewed. */
  openReview(path: string): void;
  /** A file of the repository's skills (`<skill>/<path>`), edited like a work file. */
  openSkill(path: string, options?: { edit?: boolean }): void;
  /** Show changes in a diff tab; `query` is the /diff query (file=…, commit=… or empty). */
  openDiff(title: string, query: string, options?: { source?: VersionSource; library?: string }): void;
  /** A tool in its own tab (export, reviews, resources, library management). */
  openTool(tool: Tool): void;
  /** Split the focused group's tab off to a side (Ctrl+\). */
  split(side: Side): void;
}
type Source = "work" | "experience" | "materials" | "resource" | "reviews" | "skills";
type Kind = "preview" | "text" | "image" | "audio" | "video" | "model" | "environment" | "font" | "file" | "diff" | "resource" | "raw" | "tool" | "sample";
/** What an editor shows. Several editors (in different groups) can show one document; they share its text. */
interface Doc {
  /** The work file path, "preview" for the film's preview, `sample:<path>` for a module played on its own, `exp:<path>` for experience documents, `mat:<ref>` for material files, `rev:<path>` for review files, `skill:<path>` for skill files, `diff:…` for diffs, `tool:<tool>` for tools. */
  key: string;
  /** Path inside its source (sent to the source's file API). */
  file: string;
  source: Source;
  kind: Kind;
  title?: string;
  diff?: string;
  content?: string;
  saved?: string;
  hash?: string | null;
  external?: boolean;
  /** Why the text cannot be opened (too large): the tab stays and says so. */
  unreadable?: string;
  /** When the file last changed on disk: a page shown rendered loads it again. */
  stamp?: number;
  /** What is selected in the SVG editor, for the AI. */
  selection?: string[];
}

const PREVIEW: Doc = { key: "preview", file: "", source: "work", kind: "preview", title: "预览" };
/** Shown by one editor at a time (a stage, a tool): opening it again shows it where it is, splitting moves it. */
const single = (doc: Doc | undefined) => doc?.kind === "preview" || doc?.kind === "sample" || doc?.kind === "tool";
const dirty = (doc: Doc | undefined) => Boolean(doc && doc.content !== doc.saved);

const isPage = (path: string) => /\.html?$/i.test(path);
/** SVG files of the work and of the material libraries open in the SVG editor (their code a click away). */
const isSvg = (path: string) => /\.svg$/i.test(path);
/** A document's frontmatter (a skill's SKILL.md: name, description) reads as the block it is, not as a heading. */
const frontmatterAsCode = (text: string) => text.replace(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/, (_, yaml: string) => "```yaml\n" + yaml + "\n```\n\n");

const kindOf = (path: string): Kind =>
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

const docIcon = (doc: Doc) =>
  doc.kind === "preview" ? (
    <MonitorPlay size={14} />
  ) : doc.kind === "sample" ? (
    <Clapperboard size={14} />
  ) : doc.kind === "tool" ? (
    toolIcon(doc.file as Tool)
  ) : doc.kind === "diff" ? (
    <FileDiff size={14} />
  ) : doc.kind === "resource" ? (
    <Shapes size={14} />
  ) : doc.source === "experience" ? (
    <BookOpen size={14} />
  ) : doc.source === "reviews" ? (
    <BarChart3 size={14} />
  ) : doc.source === "skills" ? (
    <Puzzle size={14} />
  ) : (
    fileIcon(doc.file)
  );

/** How the AI is told what an editor shows ("这个文件"). */
const labelOf = (doc: Doc) => {
  const label = documentLabel(doc);
  const selected = doc.selection?.slice(0, 8).join("、");
  // Only while something is selected in it does the AI hear of the SVG editor (and where to read about it).
  return selected ? `${label}（SVG 编辑器里选中了 ${selected}${(doc.selection?.length ?? 0) > 8 ? " 等" : ""}；一起改 SVG 见 frame_guide svg）` : label;
};
const documentLabel = (doc: Doc) =>
  doc.kind === "preview"
    ? "成片预览"
    : doc.kind === "sample"
      ? `样片 ${doc.file}（单独播放，不在时间轴上）`
      : doc.kind === "tool"
        ? `「${doc.title}」选项卡`
        : doc.kind === "diff"
          ? `改动「${doc.title}」`
          : doc.kind === "resource"
            ? `素材库资源预览 ${doc.file}`
            : doc.source === "experience"
              ? `经验库文档 ${doc.file.split("/").slice(1).join("/")}`
              : doc.source === "reviews"
                ? `复盘资料 ${doc.file.split("/").slice(1).join("/")}`
                : doc.source === "skills"
                  ? `技能文件 .claude/skills/${doc.file}`
                  : doc.source === "materials"
                  ? `素材库文件 materials/${doc.file}`
                  : doc.file;

const tooltipOf = (doc: Doc) =>
  doc.kind === "preview"
    ? "作品预览"
    : doc.kind === "sample"
      ? `样片：${doc.file}`
      : doc.kind === "tool"
        ? (doc.title ?? "")
        : doc.kind === "diff"
          ? `改动：${doc.title}`
          : doc.kind === "resource"
            ? `资源：${doc.file}`
            : doc.source === "experience"
              ? `经验库：${doc.file}`
              : doc.source === "reviews"
                ? `复盘：${doc.file}`
                : doc.source === "skills"
                  ? `技能：${doc.file}`
                  : doc.source === "materials"
                    ? `素材库：materials/${doc.file}`
                    : doc.file;

/** The id a document's player is known by: stages by document, media files by editor (one element each). */
const playerIdOf = (doc: Doc | undefined, editor: Editor) =>
  !doc ? null : doc.kind === "preview" || doc.kind === "sample" ? doc.key : doc.kind === "video" || doc.kind === "audio" ? editor.id : null;

/** What is being dragged: a tab, or a file from the explorer. */
export type EditorDrag = { type: "editor"; group: string; editor: string } | { type: "file"; path: string; sample: boolean };
export const editorDrag = new Observable<EditorDrag | null>(null);

let ids = 0;
const newId = (prefix: string) => `${prefix}${++ids}`;

/** A work's tabs as the browser keeps them for a reload: the groups, the documents (without their text) and unsaved text. */
interface SavedTabs {
  state: EditorState;
  docs: (Pick<Doc, "key" | "file" | "source" | "kind" | "title" | "diff"> & { draft?: string; base?: string | null })[];
}
type Draft = { content: string; base: string | null };
const tabsKey = (repo: string, id: string) => `frame:tabs:${repo}/${id}`;
function savedTabs(repo: string, id: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(tabsKey(repo, id)) || "null") as SavedTabs | null;
    if (!saved?.state?.groups || !saved.state.layout || !Array.isArray(saved.docs)) return null;
    const docs: Record<string, Doc> = { preview: PREVIEW };
    const drafts: Record<string, Draft> = {};
    for (const { draft, base, ...doc } of saved.docs) {
      if (!doc?.key || doc.key === "preview") continue;
      docs[doc.key] = doc;
      if (typeof draft === "string") drafts[doc.key] = { content: draft, base: base ?? null };
    }
    const groups = groupOrder(saved.state.layout).map((group) => saved.state.groups[group]);
    if (!groups.length || groups.some((group) => !Array.isArray(group?.editors)) || !saved.state.groups[saved.state.focus]) return null;
    const editors = groups.flatMap((group) => group.editors);
    if (editors.some((editor) => !docs[editor.key]) || !editors.some((editor) => editor.key === "preview")) return null;
    // New tabs and groups must not take a restored id.
    for (const item of [...groups, ...editors]) ids = Math.max(ids, Number(item.id.slice(1)) || 0);
    return { state: saved.state, docs, drafts };
  } catch {
    return null;
  }
}
const sideLabels: Record<Side, string> = { right: "向右拆分", down: "向下拆分", left: "向左拆分", up: "向上拆分" };
const sideIcons: Record<Side, ReactNode> = {
  right: <PanelRight size={14} />,
  down: <PanelBottom size={14} />,
  left: <PanelLeft size={14} />,
  up: <PanelTop size={14} />,
};

type Rect = { left: number; top: number; width: number; height: number };

/**
 * The editor area, like VS Code's: editor groups in a grid, each with its tabs. Tabs are dragged
 * to another group, to a side of one (which splits it), or along a tab bar; the explorer's files
 * can be dragged in too. The film's preview is one of the tabs; it and the samples keep their
 * stages loaded and running wherever their tabs go (they are drawn in a layer over the group
 * that shows them), so playback, the timeline and AI captures keep working. With two or more
 * players on screen their timelines can be synced.
 */
export function EditorArea({ ref, onActiveChange }: { ref?: Ref<EditorHandle>; onActiveChange?: (label: string | null) => void }) {
  const { work, stage, readOnly } = useWorkbench();
  const toast = useToast();
  const confirm = useConfirm();
  // The tabs open before the page was reloaded come back, with text not saved yet.
  const [restored] = useState(() => savedTabs(work.repo, work.id));
  const [docs, setDocs] = useState<Record<string, Doc>>(() => restored?.docs ?? { preview: PREVIEW });
  const [state, setState] = useState<EditorState>(() => restored?.state ?? initialState("g0", { id: "e0", key: "preview" }));
  const drafts = useRef<Record<string, Draft>>(restored?.drafts ?? {});
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Keep the tabs for a reload: a moment after changes, and at once when the page goes away. */
  const keepTabs = useCallback(() => {
    const groups = Object.fromEntries(
      Object.entries(stateRef.current.groups).map(([id, group]) => [id, { ...group, editors: group.editors.map(({ line: _line, ...editor }) => editor) }]),
    );
    const docs = Object.values(docsRef.current)
      .filter((doc) => doc.key !== "preview")
      .map((doc) => {
        const draft = dirty(doc) ? { content: doc.content!, base: doc.hash ?? null } : drafts.current[doc.key];
        return {
          key: doc.key,
          file: doc.file,
          source: doc.source,
          kind: doc.kind,
          title: doc.title,
          diff: doc.diff,
          ...(draft && { draft: draft.content, base: draft.base }),
        };
      });
    const saved: SavedTabs = { state: { ...stateRef.current, groups }, docs };
    try {
      localStorage.setItem(tabsKey(work.repo, work.id), JSON.stringify(saved));
    } catch {
      // Too large for the browser's storage: the tabs without their unsaved text.
      try {
        localStorage.setItem(tabsKey(work.repo, work.id), JSON.stringify({ ...saved, docs: docs.map(({ draft: _draft, base: _base, ...doc }) => doc) }));
      } catch {}
    }
  }, [work.repo, work.id]);
  useEffect(() => {
    const timer = window.setTimeout(keepTabs, 300);
    return () => window.clearTimeout(timer);
  }, [state, docs, keepTabs]);
  useEffect(() => {
    window.addEventListener("pagehide", keepTabs);
    return () => {
      window.removeEventListener("pagehide", keepTabs);
      // Leaving the work without a reload (home page, another work).
      keepTabs();
    };
  }, [keepTabs]);
  const apis: Record<Source, string> = {
    work: workPath(work.repo, work.id),
    experience: experiencePath(work.repo),
    materials: materialsPath(work.repo),
    resource: "",
    reviews: reviewsPath(work.repo),
    skills: skillsPath(work.repo),
  };
  const apisRef = useRef(apis);
  apisRef.current = apis;

  /** Where a document's text is read and saved (a library's raw files are elsewhere). */
  const textApi = (source: Source) => (source === "materials" ? `${apisRef.current.materials}/text` : `${apisRef.current[source]}/file`);
  const workRef = useRef(work);
  workRef.current = work;
  /**
   * A document's text, `cached`: a playback file the browser keeps is read from there (a library
   * file only as the library has it now, which is what saving builds on).
   */
  const load = useCallback(async (doc: Pick<Doc, "file" | "source">, { cached = false } = {}) => {
    const { repo, id, slug } = workRef.current;
    const address =
      doc.source === "work" && doc.file.startsWith("public/")
        ? `films/${slug}/${doc.file.slice("public/".length)}`
        : doc.source === "materials"
          ? `materials/${doc.file}`
          : null;
    const kept = cached && address ? await keptText(repo, id, address, { current: doc.source === "materials" }).catch(() => null) : null;
    const file = kept ?? (await api<{ content: string; hash: string }>(`${textApi(doc.source)}?path=${encodeURIComponent(doc.file)}`));
    return { content: file.content, saved: file.content, hash: file.hash };
  }, []);
  const updateDoc = useCallback((key: string, change: Partial<Doc>) => setDocs((all) => (all[key] ? { ...all, [key]: { ...all[key], ...change } } : all)), []);
  const closeDoc = useCallback((key: string) => {
    setState((current) => {
      let next = current;
      for (const id of groupOrder(next.layout))
        for (const editor of next.groups[id]?.editors ?? []) if (editor.key === key) next = closeEditor(next, id, editor.id);
      return next;
    });
  }, []);
  /** Read a document's text; a file too large for the editor keeps its tabs, which say so. */
  const loading = useRef(new Set<string>());
  const fill = useCallback(
    async (doc: Doc) => {
      if (loading.current.has(doc.key)) return;
      loading.current.add(doc.key);
      try {
        const loaded = await load(doc, { cached: true });
        // Text left unsaved before a reload: changed on disk since, it asks which version to keep.
        const draft = drafts.current[doc.key];
        delete drafts.current[doc.key];
        const kept = draft && draft.content !== loaded.content ? { content: draft.content, external: draft.base !== loaded.hash } : {};
        updateDoc(doc.key, { ...loaded, ...kept, unreadable: undefined });
      } catch (error) {
        delete drafts.current[doc.key];
        if (error instanceof ApiError && error.status === 413) updateDoc(doc.key, { unreadable: error.message });
        else {
          toast((error as Error).message, "error");
          closeDoc(doc.key);
        }
      } finally {
        loading.current.delete(doc.key);
      }
    },
    [load, updateDoc, closeDoc, toast],
  );

  /**
   * Open a document: in the focused group (or `at`), activating its tab there if it has one. One
   * shown by a single editor (a stage, a tool) is shown where it is instead.
   */
  const open = useCallback((doc: Doc, options: { line?: number; rendered?: boolean } & OpenAt = {}) => {
    if (!docsRef.current[doc.key]) setDocs((all) => (all[doc.key] ? all : { ...all, [doc.key]: doc }));
    setState((current) => {
      const where = single(doc) ? groupsWith(current, doc.key)[0] : undefined;
      if (where && !options.split && !options.group) {
        const editor = current.groups[where].editors.find((item) => item.key === doc.key)!;
        return activate(current, where, editor.id);
      }
      let next = current;
      let target = options.group && next.groups[options.group] ? options.group : next.focus;
      if (options.split) {
        const id = newId("g");
        next = splitGroup(next, target, options.split, id);
        target = id;
      }
      if (where) {
        const editor = next.groups[where].editors.find((item) => item.key === doc.key)!;
        return moveEditor(next, where, editor.id, target);
      }
      const editor: Editor = { id: newId("e"), key: doc.key, rendered: options.rendered, line: options.line };
      return openEditor(next, target, editor);
    });
  }, []);
  const openFile = useCallback(
    (path: string, options: { line?: number } & OpenAt = {}) =>
      // An HTML file opens as the page it is, an SVG in the SVG editor.
      open(
        { key: path, file: path, source: "work", kind: isSvg(path) ? "text" : kindOf(path) },
        { ...options, rendered: (isPage(path) || isSvg(path)) && options.line === undefined },
      ),
    [open],
  );
  const openSample = useCallback(
    (path: string, options: OpenAt = {}) => open({ key: `sample:${path}`, file: path, source: "work", kind: "sample", title: sampleName(path) }, options),
    [open],
  );
  const openExperience = useCallback(
    // Experience documents open rendered: they are read more often than edited.
    (path: string) => open({ key: `exp:${path}`, file: path, source: "experience", kind: kindOf(path) }, { rendered: /\.md$/i.test(path) }),
    [open],
  );
  const openMaterial = useCallback(
    (ref: string) => open({ key: `mat:${ref}`, file: ref, source: "materials", kind: isSvg(ref) ? "text" : kindOf(ref) }, { rendered: isSvg(ref) }),
    [open],
  );
  const openResource = useCallback(
    (id: string, options: { title?: string } = {}) => open({ key: `res:${id}`, file: id, source: "resource", kind: "resource", title: options.title }),
    [open],
  );
  const openReview = useCallback(
    (path: string) => {
      // Review documents open rendered like experience documents; original files in their viewer.
      const document = /\.(md|txt)$/i.test(path) && !/^[^/]+\/raw\//.test(path);
      open({ key: `rev:${path}`, file: path, source: "reviews", kind: document ? "text" : "raw" }, { rendered: /\.md$/i.test(path) });
    },
    [open],
  );
  const openSkill = useCallback(
    (path: string, { edit }: { edit?: boolean } = {}) => {
      // Skills hold instructions and scripts (.py, .sh…), opened as text; pictures, sound and video are shown.
      const media = kindOf(path);
      const kind = media === "image" || media === "audio" || media === "video" ? media : "text";
      open({ key: `skill:${path}`, file: path, source: "skills", kind }, { rendered: !edit && /\.md$/i.test(path) });
    },
    [open],
  );
  const openDiff = useCallback(
    (title: string, query: string, options: { source?: VersionSource; library?: string } = {}) => {
      const source = options.source ?? "work";
      const library = options.library;
      open({ key: `diff:${source}:${library ?? ""}:${query}`, file: library ?? "", source, kind: "diff", title, diff: query });
    },
    [open],
  );
  const openTool = useCallback((tool: Tool) => open({ key: `tool:${tool}`, file: tool, source: "work", kind: "tool", title: TOOL_TITLES[tool] }), [open]);

  /** Split an editor off to a side of its group: a copy, or the editor itself when it is shown by a single one. */
  const splitEditor = useCallback((groupId: string, editorId: string, side: Side) => {
    setState((current) => {
      const group = current.groups[groupId];
      const editor = group?.editors.find((item) => item.id === editorId);
      if (!editor) return current;
      const moves = single(docsRef.current[editor.key]);
      // A group with only this stage or tool in it has nothing to split off.
      if (moves && group.editors.length === 1) return current;
      const id = newId("g");
      return moveEditor(splitGroup(current, groupId, side, id), groupId, editorId, id, { copy: moves ? undefined : newId("e") });
    });
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      openFile,
      openSample,
      openExperience,
      openMaterial,
      openResource,
      openReview,
      openSkill,
      openDiff,
      openTool,
      split: (side) => {
        const current = stateRef.current;
        const active = current.groups[current.focus]?.active;
        if (active) splitEditor(current.focus, active, side);
      },
    }),
    [openFile, openSample, openExperience, openMaterial, openResource, openReview, openSkill, openDiff, openTool, splitEditor],
  );

  // Documents without editors are forgotten (the preview stays).
  useEffect(() => {
    const used = new Set(Object.values(state.groups).flatMap((group) => group.editors.map((editor) => editor.key)));
    setDocs((all) =>
      Object.keys(all).every((key) => used.has(key) || key === "preview")
        ? all
        : Object.fromEntries(Object.entries(all).filter(([key]) => used.has(key) || key === "preview")),
    );
  }, [state.groups]);

  // Files changed by the AI or other tools: refresh clean documents, flag dirty ones.
  const refresh = (matches: (doc: Doc) => boolean) => {
    for (const doc of Object.values(docsRef.current)) {
      if (doc.kind !== "text" || doc.content === undefined || !matches(doc)) continue;
      void load(doc).then(
        (loaded) =>
          setDocs((all) => {
            const item = all[doc.key];
            if (!item || loaded.hash === item.hash) return all;
            return { ...all, [doc.key]: item.content === item.saved ? { ...item, ...loaded, external: false } : { ...item, external: true } };
          }),
        () => {},
      );
    }
  };
  useServerEvent(
    (event) => {
      if (event.type === "work-files" && event.work === work.id) {
        const changed = new Set((event.files as string[]).map((file) => file.replace(/^projects\/[^/]+\//, "")));
        refresh((doc) => doc.source === "work" && changed.has(doc.file));
        const stamp = Date.now();
        setDocs((all) =>
          Object.values(all).some((doc) => doc.source === "work" && changed.has(doc.file))
            ? Object.fromEntries(Object.entries(all).map(([key, doc]) => [key, doc.source === "work" && changed.has(doc.file) ? { ...doc, stamp } : doc]))
            : all,
        );
      } else if (event.type === "experience-files" && event.repo === work.repo) {
        // A moved document: its open tabs follow it.
        const moved = event.moved as { from: string; to: string } | undefined;
        if (moved) {
          const follow = (file: string) => (file === moved.from || file.startsWith(moved.from + "/") ? moved.to + file.slice(moved.from.length) : null);
          const renames = Object.values(docsRef.current).flatMap((doc) => {
            const file = doc.source === "experience" && doc.kind !== "diff" ? follow(doc.file) : null;
            return file ? [{ from: doc.key, to: `exp:${file}`, file }] : [];
          });
          if (renames.length) {
            setDocs((all) => {
              const next = { ...all };
              for (const { from, to, file } of renames) {
                if (!next[from]) continue;
                next[to] = { ...next[from], key: to, file };
                delete next[from];
              }
              return next;
            });
            setState((current) => renames.reduce((next, { from, to }) => renameKey(next, from, to), current));
          }
        }
        const changed = event.files as string[];
        refresh((doc) => doc.source === "experience" && (!changed.length || changed.some((file) => doc.file === file || doc.file.startsWith(file + "/"))));
      } else if (event.type === "work-versions" && String(event.work).startsWith("experience/")) {
        // A library's branch moved (GitHub's versions brought in): its open documents follow.
        const library = String(event.work).slice("experience/".length);
        refresh((doc) => doc.source === "experience" && doc.file.startsWith(library + "/"));
      } else if ((event.type === "reviews" && event.repo === work.repo) || (event.type === "work-versions" && event.work === `reviews-${work.repo}`)) {
        refresh((doc) => doc.source === "reviews" && (!event.work || doc.file.startsWith(`${event.work}/`)));
      } else if ((event.type === "skills" && event.repo === work.repo) || (event.type === "work-versions" && event.work === `skills-${work.repo}`)) {
        // A skill's documents are also open as an experience library's (skill:<skill>/…).
        refresh((doc) => doc.source === "skills" || (doc.source === "experience" && doc.file.startsWith("skill:")));
      } else if (event.type === "materials" && event.repo === work.repo) {
        // A library changed (paths: its id), or all of them.
        const libraries = (event.paths as string[] | undefined) ?? [];
        refresh((doc) => doc.source === "materials" && (!libraries.length || libraries.some((id) => doc.file.startsWith(id + "/"))));
      }
    },
    [work.id, work.repo],
  );

  /** A library file this work locked at an older version: edited and saved here, the work goes on with it as it is now. */
  const followMaterial = async (ref: string) => {
    const { files } = await api<{ files: { ref: string; outdated: boolean }[] }>(`${apis.work}/materials`);
    if (files.find((item) => item.ref === ref)?.outdated) await api(`${apis.work}/materials/lock`, { body: { refs: [ref], update: true } });
  };
  const save = async (key: string) => {
    const doc = docsRef.current[key];
    if (!doc || doc.content === undefined) return;
    try {
      const result = await api<{ hash: string }>(textApi(doc.source), {
        method: "PUT",
        body: { path: doc.file, content: doc.content, expectedHash: doc.external ? undefined : doc.hash },
      });
      updateDoc(key, { saved: doc.content, hash: result.hash, external: false });
      if (doc.source === "materials" && !readOnly) await followMaterial(doc.file);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  /** Editors of documents that would lose changes if these editors closed (their last editors). */
  const losing = (closing: { group: string; editor: Editor }[]) => {
    const gone = new Set(closing.map(({ editor }) => editor.id));
    const keys = new Set(closing.map(({ editor }) => editor.key));
    return [...keys].filter((key) => {
      if (!dirty(docsRef.current[key])) return false;
      const left = Object.values(stateRef.current.groups).some((group) => group.editors.some((editor) => editor.key === key && !gone.has(editor.id)));
      return !left;
    });
  };
  const closeEditors = async (groupId: string, editorIds: string[]) => {
    const group = stateRef.current.groups[groupId];
    const closing = (group?.editors ?? [])
      .filter((editor) => editorIds.includes(editor.id) && editor.key !== "preview")
      .map((editor) => ({ group: groupId, editor }));
    if (!closing.length) return;
    const lost = losing(closing);
    if (lost.length) {
      const names = lost.map((key) => docsRef.current[key]?.file || key).join("、");
      if (!(await confirm(`${names} 有未保存的修改，确定关闭？`, { confirm: "不保存并关闭", danger: true }))) return;
    }
    setState((current) => closing.reduce((next, { group: id, editor }) => closeEditor(next, id, editor.id), current));
  };

  // ---- what is on screen ----
  const visible = visibleEditors(state);
  const focusedGroup = state.groups[state.focus];
  const focusedEditor = focusedGroup?.editors.find((editor) => editor.id === focusedGroup.active);
  const shownIn = (key: string) => visible.find(({ editor }) => editor.key === key)?.group;
  const previewGroup = shownIn("preview");
  useEffect(() => {
    stage.visible = Boolean(previewGroup);
  }, [stage, previewGroup]);

  // The AI is told what the user has open, and what is beside it.
  const activeLabel = useMemo(() => {
    const focused = focusedEditor && docs[focusedEditor.key];
    const others = visible.filter(({ group }) => group !== state.focus).flatMap(({ editor }) => (docs[editor.key] ? [labelOf(docs[editor.key])] : []));
    if (!focused) return null;
    if (!others.length) return focused.kind === "preview" ? null : labelOf(focused);
    return `${labelOf(focused)}（分屏同时显示着：${others.join("、")}）`;
  }, [focusedEditor, docs, visible, state.focus]);
  useEffect(() => onActiveChange?.(activeLabel), [activeLabel, onActiveChange]);

  // ---- group bodies, measured: the stages are laid over the one that shows them ----
  const area = useRef<HTMLDivElement>(null);
  const bodies = useRef(new Map<string, HTMLElement>());
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const measure = useCallback(() => {
    const box = area.current?.getBoundingClientRect();
    if (!box) return;
    const next: Record<string, Rect> = {};
    for (const [id, element] of bodies.current) {
      const rect = element.getBoundingClientRect();
      next[id] = { left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height };
    }
    setRects((current) => {
      const same =
        Object.keys(current).length === Object.keys(next).length &&
        Object.entries(next).every(([id, rect]) => {
          const old = current[id];
          return (
            old &&
            Math.abs(old.left - rect.left) < 0.5 &&
            Math.abs(old.top - rect.top) < 0.5 &&
            Math.abs(old.width - rect.width) < 0.5 &&
            Math.abs(old.height - rect.height) < 0.5
          );
        });
      return same ? current : next;
    });
  }, []);
  const observer = useMemo(() => (typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure())), [measure]);
  useEffect(() => () => observer?.disconnect(), [observer]);
  useLayoutEffect(measure);
  const bodyRefs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const bodyRef = (id: string) => {
    let callback = bodyRefs.current.get(id);
    if (!callback) {
      callback = (element) => {
        const old = bodies.current.get(id);
        if (old && old !== element) observer?.unobserve(old);
        if (element) {
          bodies.current.set(id, element);
          observer?.observe(element);
        } else bodies.current.delete(id);
      };
      bodyRefs.current.set(id, callback);
    }
    return callback;
  };
  if (area.current) observer?.observe(area.current);

  const focusGroup = useCallback(
    (id: string) => setState((current) => (current.focus === id || !current.groups[id] ? current : { ...current, focus: id })),
    [],
  );
  // A click inside a frame (a stage, a page) gives the group that shows it the focus.
  useEffect(() => {
    const blur = () =>
      setTimeout(() => {
        const frame = document.activeElement;
        if (!(frame instanceof HTMLIFrameElement) || !area.current?.contains(frame)) return;
        const group = (frame.closest("[data-group]") as HTMLElement | null)?.dataset.group;
        if (group) focusGroup(group);
      }, 0);
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [focusGroup]);

  // ---- players on screen, and their synced timeline ----
  const registry = useObservable(players);
  useEffect(() => registerPlayer("preview", stagePlayer(stage, "成片")), [stage]);
  const onScreen = visible.flatMap(({ group, editor }) => {
    const id = playerIdOf(docs[editor.key], editor);
    const player = id ? registry.get(id) : undefined;
    return id && player ? [{ group, id, player }] : [];
  });
  const [sync, setSync] = useState<TimelineSync | null>(null);
  const onScreenIds = onScreen.map((item) => item.id).join("|");
  useEffect(() => {
    if (!sync) return;
    const shown = new Set(onScreenIds.split("|"));
    let left = sync.ids.length;
    for (const id of sync.ids) if (!shown.has(id)) left = sync.remove(id);
    if (left < 2) {
      sync.stop();
      setSync(null);
    }
  }, [sync, onScreenIds]);
  useEffect(() => () => sync?.stop(), [sync]);
  /** Sync the players on screen at their times now (again, when one was not in it); `off` ends it. */
  const toggleSync = (off: boolean) => {
    sync?.stop();
    setSync(off ? null : new TimelineSync(onScreen.map(({ id, player }) => ({ id, player }))));
  };
  const syncTitle = (member: boolean) =>
    member && sync
      ? `已同步：${sync.bases.map(({ label, base }) => `${label} ${formatTime(base)}`).join(" ↔ ")}（这些时刻对齐）。点击取消同步`
      : `以现在各自的时间对齐（${onScreen.map(({ player }) => `${player.label} ${formatTime(player.time())}`).join(" ↔ ")}），之后播放、暂停、拖动进度和变速都一起动${sync ? "；会替换现在的同步" : ""}`;

  // ---- dragging tabs and explorer files ----
  const drag = useObservable(editorDrag);
  const [dropAt, setDropAt] = useState<{ group: string; zone: Zone } | null>(null);
  useEffect(() => {
    if (!drag) setDropAt(null);
  }, [drag]);
  const canSplitDrop = (groupId: string) => {
    if (drag?.type !== "editor") return true;
    // A group's only tab cannot split its own group.
    return !(drag.group === groupId && stateRef.current.groups[groupId]?.editors.length === 1);
  };
  /** Drop what is dragged into a group (`index` in its tab bar), or to a side of it. */
  const drop = (target: EditorDrag, groupId: string, zone: Zone, options: { index?: number; copy?: boolean } = {}) => {
    editorDrag.set(null);
    if (target.type === "file") {
      const at: OpenAt = zone === "center" ? { group: groupId } : { group: groupId, split: zone };
      if (target.sample) openSample(target.path, at);
      else openFile(target.path, at);
      return;
    }
    setState((current) => {
      const source = current.groups[target.group]?.editors.find((editor) => editor.id === target.editor);
      if (!source || !current.groups[groupId]) return current;
      const copy = options.copy && !single(docsRef.current[source.key]) ? newId("e") : undefined;
      let next = current;
      let into = groupId;
      if (zone !== "center") {
        into = newId("g");
        next = splitGroup(next, groupId, zone, into);
      }
      return moveEditor(next, target.group, target.editor, into, { index: options.index, copy });
    });
  };

  const [openMenu, menu] = useContextMenu();
  const tabMenu = (event: React.MouseEvent, groupId: string, editor: Editor) => {
    const group = stateRef.current.groups[groupId];
    const index = group.editors.findIndex((item) => item.id === editor.id);
    const order = groupOrder(stateRef.current.layout);
    const others = order.filter((id) => id !== groupId);
    const isPreview = editor.key === "preview";
    openMenu(event, [
      { label: "关闭", icon: <X size={14} />, disabled: isPreview, onClick: () => void closeEditors(groupId, [editor.id]) },
      {
        label: "关闭其他",
        onClick: () =>
          void closeEditors(
            groupId,
            group.editors.filter((item) => item.id !== editor.id).map((item) => item.id),
          ),
      },
      {
        label: "关闭右侧",
        onClick: () =>
          void closeEditors(
            groupId,
            group.editors.slice(index + 1).map((item) => item.id),
          ),
      },
      {
        label: "全部关闭",
        onClick: () =>
          void closeEditors(
            groupId,
            group.editors.map((item) => item.id),
          ),
      },
      "separator",
      ...(["right", "down", "left", "up"] as Side[]).map((side) => ({
        label: sideLabels[side],
        icon: sideIcons[side],
        onClick: () => splitEditor(groupId, editor.id, side),
      })),
      ...(others.length
        ? ([
            "separator",
            ...others.map((id) => ({
              label: `移到编辑组 ${order.indexOf(id) + 1}`,
              icon: <ArrowRightLeft size={14} />,
              onClick: () => setState((current) => moveEditor(current, groupId, editor.id, id)),
            })),
          ] as MenuItem[])
        : []),
    ]);
  };

  const several = groupOrder(state.layout).length > 1;
  const renderGroup = (groupId: string) => {
    const group = state.groups[groupId];
    const active = group.editors.find((editor) => editor.id === group.active);
    const activeDoc = active && docs[active.key];
    const player = onScreen.find((item) => item.group === groupId);
    const member = Boolean(player && sync?.ids.includes(player.id));
    return (
      <GroupView
        key={groupId}
        group={group}
        docs={docs}
        focused={several && state.focus === groupId}
        number={groupOrder(state.layout).indexOf(groupId) + 1}
        bodyRef={bodyRef(groupId)}
        onFocus={() => focusGroup(groupId)}
        onActivate={(editorId) => setState((current) => activate(current, groupId, editorId))}
        onClose={(editorId) => void closeEditors(groupId, [editorId])}
        onMenu={(event, editor) => tabMenu(event, groupId, editor)}
        onDrop={(target, index, copy) => drop(target, groupId, "center", { index, copy })}
        onSplit={(side) => active && splitEditor(groupId, active.id, side)}
        canSplit={Boolean(active && !(single(activeDoc) && group.editors.length === 1))}
        sync={
          player && onScreen.length >= 2 ? (
            <button className={`btn small sync-btn ${member ? "active" : ""}`} title={syncTitle(member)} onClick={() => toggleSync(member)}>
              <Link2 size={13} />
              <span className="sync-label">{member ? "已同步" : "同步时间轴"}</span>
            </button>
          ) : null
        }
      >
        {/* Every tab stays mounted until it is closed: switching tabs shows it again as it was. In
            order of opening, so reordering tabs moves no element (a moved frame would reload). */}
        {[...group.editors]
          .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
          .map((editor) => {
            const doc = docs[editor.key];
            if (!doc || doc.kind === "preview" || doc.kind === "sample") return null;
            const shown = editor.id === group.active;
            return (
              <TabVisible.Provider key={editor.id} value={shown}>
                <EditorContent
                  doc={doc}
                  editor={editor}
                  hidden={!shown}
                  onDoc={(change) => updateDoc(doc.key, change)}
                  onEditor={(change) => setState((current) => updateEditor(current, groupId, editor.id, change))}
                  onSave={() => save(doc.key)}
                  onReload={() => load(doc).then((loaded) => updateDoc(doc.key, { ...loaded, external: false }))}
                  onNeedText={() => void fill(doc)}
                  onSample={() => openSample(doc.file)}
                />
              </TabVisible.Provider>
            );
          })}
      </GroupView>
    );
  };

  const samples = Object.values(docs).filter((doc) => doc.kind === "sample");
  const hostStyle = (group: string | undefined) => (group && rects[group] ? rects[group] : undefined);
  return (
    <div className="editor-area" ref={area}>
      <GridView
        node={state.layout}
        path={[]}
        renderGroup={renderGroup}
        onResize={(path, index, delta, min) => setState((current) => resizeSplit(current, path, index, delta, min))}
        onEven={(path) => setState((current) => evenSplit(current, path))}
      />
      {/* Stages stay loaded and running wherever their tabs go: laid over the group that shows them. */}
      <div className="editor-hosts">
        <div
          className={`editor-host ${previewGroup ? "" : "covered"}`}
          style={hostStyle(previewGroup)}
          data-group={previewGroup}
          aria-hidden={!previewGroup}
          onPointerDownCapture={() => previewGroup && focusGroup(previewGroup)}
        >
          <PreviewPane />
        </div>
        {samples.map((doc) => {
          const group = shownIn(doc.key);
          return (
            <div
              key={doc.key}
              className={`editor-host ${group ? "" : "covered"}`}
              style={hostStyle(group)}
              data-group={group}
              aria-hidden={!group}
              onPointerDownCapture={() => group && focusGroup(group)}
            >
              <SampleTab file={doc.file} visible={Boolean(group)} focused={Boolean(group && group === state.focus)} />
            </div>
          );
        })}
      </div>
      {drag && (
        <div className="editor-drop-layer">
          {groupOrder(state.layout).map((id) => {
            const rect = rects[id];
            if (!rect) return null;
            const zone = dropAt?.group === id ? dropAt.zone : null;
            return (
              <div
                key={id}
                className="editor-drop"
                style={rect}
                onDragOver={(event) => {
                  event.preventDefault();
                  const copy = drag.type === "editor" && (event.ctrlKey || event.altKey);
                  event.dataTransfer.dropEffect = drag.type === "file" || copy ? "copy" : "move";
                  const box = event.currentTarget.getBoundingClientRect();
                  const next = dropZone(event.clientX - box.left, event.clientY - box.top, box.width, box.height, canSplitDrop(id));
                  if (dropAt?.group !== id || dropAt.zone !== next) setDropAt({ group: id, zone: next });
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt((current) => (current?.group === id ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const box = event.currentTarget.getBoundingClientRect();
                  drop(drag, id, dropZone(event.clientX - box.left, event.clientY - box.top, box.width, box.height, canSplitDrop(id)), {
                    copy: event.ctrlKey || event.altKey,
                  });
                }}
              >
                {zone && <div className={`editor-drop-hint ${zone}`} />}
              </div>
            );
          })}
        </div>
      )}
      {menu}
    </div>
  );
}

/** The grid of groups: splits side by side or one above the other, with borders to drag. */
function GridView({
  node,
  path,
  renderGroup,
  onResize,
  onEven,
}: {
  node: Layout;
  path: number[];
  renderGroup: (id: string) => ReactNode;
  onResize: (path: number[], index: number, delta: number, min: number) => void;
  onEven: (path: number[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  if ("group" in node) return <>{renderGroup(node.group)}</>;
  const row = node.direction === "row";
  return (
    <div ref={box} className={`editor-split split-${node.direction}`}>
      {node.children.map((child, index) => (
        <Fragment key={"group" in child ? child.group : `split-${index}`}>
          {index > 0 && (
            <Sash
              direction={row ? "vertical" : "horizontal"}
              onDrag={(delta) => {
                const size = row ? box.current?.clientWidth : box.current?.clientHeight;
                // At least 160 px on each side, as far as the split has room.
                if (size) onResize(path, index - 1, delta / size, 160 / size);
              }}
              onDoubleClick={() => onEven(path)}
            />
          )}
          <div className="editor-cell" style={{ flex: `${node.sizes[index]} 1 0` }}>
            <GridView node={child} path={[...path, index]} renderGroup={renderGroup} onResize={onResize} onEven={onEven} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** One group: its tab bar (tabs to click, drag and drop, its actions) and the active tab's content. */
function GroupView({
  group,
  docs,
  focused,
  number,
  bodyRef,
  onFocus,
  onActivate,
  onClose,
  onMenu,
  onDrop,
  onSplit,
  canSplit,
  sync,
  children,
}: {
  group: Group;
  docs: Record<string, Doc>;
  /** The focused one of several groups: its active tab is marked. */
  focused: boolean;
  number: number;
  bodyRef: (element: HTMLElement | null) => void;
  onFocus: () => void;
  onActivate: (editorId: string) => void;
  onClose: (editorId: string) => void;
  onMenu: (event: React.MouseEvent, editor: Editor) => void;
  onDrop: (target: EditorDrag, index: number, copy: boolean) => void;
  onSplit: (side: Side) => void;
  canSplit: boolean;
  sync: ReactNode;
  children: ReactNode;
}) {
  const drag = useObservable(editorDrag);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!drag) setDropIndex(null);
  }, [drag]);
  const tabs = useRef<HTMLDivElement>(null);
  // Fingers get the tab menu (a long press) instead of dragging.
  const draggable = !coarsePointer();
  /** The place in the tab bar a drop at `x` takes: before the tab under it, or after its middle. */
  const indexAt = (x: number) => {
    const items = [...(tabs.current?.querySelectorAll<HTMLElement>("[data-index]") ?? [])];
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) return Number(item.dataset.index);
    }
    return group.editors.length;
  };
  // Tabs that do not fit, even shrunk, are paged through (or scrolled with the wheel or a finger).
  const [paging, setPaging] = useState<{ back: boolean; forward: boolean } | null>(null);
  const measure = useCallback(() => {
    const bar = tabs.current;
    if (!bar) return;
    const over = bar.scrollWidth > bar.clientWidth + 1;
    const box = bar.getBoundingClientRect();
    const items = bar.querySelectorAll<HTMLElement>("[data-index]");
    const back = (items[0]?.getBoundingClientRect().left ?? 0) < box.left - 1;
    const forward = (items[items.length - 1]?.getBoundingClientRect().right ?? 0) > box.right + 1;
    setPaging((current) => (!over ? null : current?.back === back && current.forward === forward ? current : { back, forward }));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const bar = tabs.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [measure]);
  // The active tab comes into sight when it changes, is opened again, or the page buttons take room.
  useLayoutEffect(() => {
    const bar = tabs.current;
    const item = bar?.querySelector<HTMLElement>(`[data-editor="${group.active}"]`);
    if (!bar || !item) return;
    const box = bar.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.left < box.left) bar.scrollLeft += rect.left - box.left;
    else if (rect.right > box.right) bar.scrollLeft += Math.min(rect.right - box.right, rect.left - box.left);
  }, [group.active, group.editors, paging !== null]);
  /** The next page: the first tab cut off at that side moves to the other side. */
  const page = (direction: 1 | -1) => {
    const bar = tabs.current;
    if (!bar) return;
    const box = bar.getBoundingClientRect();
    const rects = [...bar.querySelectorAll<HTMLElement>("[data-index]")].map((item) => item.getBoundingClientRect());
    const cut = direction > 0 ? rects.find((rect) => rect.right > box.right + 1) : rects.reverse().find((rect) => rect.left < box.left - 1);
    const offset = cut ? (direction > 0 ? cut.left - box.left : cut.right - box.right) : 0;
    // A tab wider than the bar turns a whole page.
    bar.scrollBy({ left: offset * direction > 1 ? offset : direction * box.width });
  };
  return (
    <div className={`editor-group ${focused ? "focused" : ""}`} data-group={group.id} onPointerDownCapture={onFocus}>
      <div className="editor-tabbar">
        <div
          ref={tabs}
          className={`editor-tabs ${dropIndex === group.editors.length ? "drop-end" : ""}`}
          role="tablist"
          aria-label={`编辑组 ${number}`}
          onDragOver={(event) => {
            if (!drag) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = drag.type === "file" || event.ctrlKey || event.altKey ? "copy" : "move";
            const index = indexAt(event.clientX);
            if (index !== dropIndex) setDropIndex(index);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (drag) onDrop(drag, indexAt(event.clientX), event.ctrlKey || event.altKey);
            setDropIndex(null);
          }}
          onScroll={measure}
          onWheel={(event) => {
            // A mouse wheel turns the tabs sideways.
            if (!event.deltaX && event.deltaY) event.currentTarget.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 20 : 1);
          }}
        >
          {group.editors.map((editor, index) => {
            const doc = docs[editor.key];
            if (!doc) return null;
            const isPreview = doc.kind === "preview";
            return (
              <div
                key={editor.id}
                data-index={index}
                data-editor={editor.id}
                role="tab"
                aria-selected={editor.id === group.active}
                className={`editor-tab ${editor.id === group.active ? "active" : ""} ${isPreview ? "stage" : ""} ${
                  dropIndex === index ? "drop-before" : ""
                } ${drag?.type === "editor" && drag.editor === editor.id ? "dragging" : ""}`}
                title={tooltipOf(doc)}
                draggable={draggable}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copyMove";
                  event.dataTransfer.setData("text/plain", doc.file || doc.title || "");
                  editorDrag.set({ type: "editor", group: group.id, editor: editor.id });
                }}
                onDragEnd={() => editorDrag.set(null)}
                onClick={() => onActivate(editor.id)}
                onMouseDown={(event) => event.button === 1 && !isPreview && (event.preventDefault(), onClose(editor.id))}
                onContextMenu={(event) => onMenu(event, editor)}
              >
                {docIcon(doc)}
                <span className="ellipsis">{doc.title ?? doc.file.split("/").pop()}</span>
                {!isPreview && (
                  <button
                    className="tab-close"
                    aria-label="关闭"
                    draggable={false}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(editor.id);
                    }}
                  >
                    {dirty(doc) ? <Circle size={9} fill="currentColor" /> : <X size={13} />}
                  </button>
                )}
              </div>
            );
          })}
          <div className="editor-tabs-fill" />
        </div>
        {paging && (
          <div className="editor-paging">
            {([-1, 1] as const).map((direction) => (
              <button
                key={direction}
                className="icon-btn"
                title={direction < 0 ? "上一页标签" : "下一页标签"}
                aria-label={direction < 0 ? "上一页标签" : "下一页标签"}
                disabled={direction < 0 ? !paging.back : !paging.forward}
                onClick={() => page(direction)}
                // A dragged tab held over the button scrolls the tabs toward that side.
                onDragOver={() => drag && tabs.current?.scrollBy({ left: direction * 24 })}
              >
                {direction < 0 ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
              </button>
            ))}
          </div>
        )}
        <div className="editor-actions">
          {sync}
          <button
            className="icon-btn"
            title="向右拆分（Ctrl+\）；按住 Alt 向下拆分。也可以把标签页拖到编辑区的一侧"
            disabled={!canSplit}
            onClick={(event) => onSplit(event.altKey ? "down" : "right")}
          >
            <Columns2 size={15} />
          </button>
        </div>
      </div>
      <div className="editor-body" ref={bodyRef}>
        {children}
      </div>
    </div>
  );
}

/** The content of a tab that is not a stage: an editor, a viewer, a tool. */
function EditorContent({
  doc,
  editor,
  hidden,
  onDoc,
  onEditor,
  onSave,
  onReload,
  onNeedText,
  onSample,
}: {
  doc: Doc;
  editor: Editor;
  /** Another tab of the group is shown. */
  hidden: boolean;
  onDoc: (change: Partial<Doc>) => void;
  onEditor: (change: Partial<Editor>) => void;
  onSave: () => void;
  onReload: () => void;
  onNeedText: () => void;
  onSample: () => void;
}) {
  const { work, readOnly, addToChat } = useWorkbench();
  // A Lottie animation among the work's files (public/) can be played as well as read.
  const lottie = useMemo(
    () => doc.source === "work" && doc.kind === "text" && /^public\/.+\.json$/i.test(doc.file) && isLottieText(doc.content),
    [doc.source, doc.kind, doc.file, doc.content],
  );
  const page = doc.kind === "text" && isPage(doc.file);
  const svg = doc.kind === "text" && isSvg(doc.file) && (doc.source === "work" || doc.source === "materials");
  const rendered = Boolean(editor.rendered);
  // Published works keep their libraries and reviews editable: they are not the work.
  const locked = readOnly && doc.source === "work";
  // A page shown rendered is read when its code is asked for (it may be too large for the editor).
  const wantsText = doc.kind === "text" && (doc.source !== "materials" || svg) && !(rendered && page && doc.source === "work");
  useEffect(() => {
    if (wantsText && doc.content === undefined && !doc.unreadable) onNeedText();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsText, doc.content, doc.unreadable]);
  return (
    <div className="editor-content" hidden={hidden}>
      {doc.external && (
        <div className="editor-banner">
          这个文件已被 AI 或其他程序修改。
          <button className="btn small" onClick={onReload}>
            载入新版本（丢弃我的修改）
          </button>
          <button className="btn small" onClick={onSave}>
            用我的版本覆盖
          </button>
        </div>
      )}
      {doc.kind === "text" && (((/\.md$/i.test(doc.file) || lottie) && doc.content !== undefined) || (page && doc.source === "work")) && (
        <div className="editor-toolbar">
          <span className="faint small-text ellipsis grow">
            {doc.source === "experience" ? `经验库 · ${doc.file}` : doc.source === "reviews" ? `复盘 · ${doc.file}` : doc.source === "skills" ? `技能 · ${doc.file}` : doc.file}
            {lottie ? " · Lottie 动画" : ""}
          </span>
          {page && rendered && <PageLink file={doc.file} version={doc.stamp} />}
          <div className="segmented">
            <button className={rendered ? "" : "active"} onClick={() => onEditor({ rendered: false })}>
              <Pencil size={12} /> {lottie || page ? "代码" : "编辑"}
            </button>
            <button className={rendered ? "active" : ""} onClick={() => onEditor({ rendered: true })}>
              <Eye size={12} /> {lottie ? "动画" : page ? "页面" : "预览"}
            </button>
          </div>
        </div>
      )}
      {svg && <SvgToolbar doc={doc} rendered={rendered} locked={locked} onEditor={onEditor} onSave={onSave} onChat={addToChat} />}
      {doc.kind === "text" && doc.source === "work" && !rendered && playable(doc.content) && !/^(scene|project)\.ts$/.test(doc.file) && (
        <div className="editor-toolbar">
          <span className="faint small-text ellipsis grow">{doc.file} 导出了 createScene，可以不放进时间轴单独播放</span>
          <button className="btn small" onClick={onSample}>
            <Play size={13} /> {/export\s+const\s+sample\b/.test(doc.content ?? "") ? "播放样片" : "单独播放"}
          </button>
        </div>
      )}
      {doc.kind === "tool" ? (
        <ToolTab key={doc.file} tool={doc.file as Tool} />
      ) : doc.kind === "resource" ? (
        <ResourceViewer key={doc.file} id={doc.file} />
      ) : doc.kind === "raw" ? (
        <RawViewer key={doc.file} fileRef={doc.file} />
      ) : doc.kind === "diff" ? (
        <DiffEditor query={doc.diff!} source={doc.source === "resource" ? "materials" : doc.source} library={doc.file || undefined} />
      ) : svg && doc.content !== undefined && !doc.unreadable && rendered ? (
        locked ? (
          <div className="media-viewer image">
            <ZoomImage src={`${workPath(work.repo, work.id)}/raw?path=${encodeURIComponent(doc.file)}&v=${doc.hash}`} alt={doc.file} />
          </div>
        ) : (
          <SvgEditor
            key={doc.key}
            value={doc.content}
            onChange={(content) => onDoc({ content })}
            onSave={onSave}
            onSelection={(selection) => onDoc({ selection })}
          />
        )
      ) : doc.source === "materials" && !svg ? (
        <MaterialViewer key={doc.file} fileRef={doc.file} kind={doc.kind} playerId={editor.id} />
      ) : doc.source === "skills" && doc.kind !== "text" ? (
        <SkillMediaViewer key={doc.file} path={doc.file} kind={doc.kind} playerId={editor.id} />
      ) : doc.kind === "text" ? (
        rendered && page && doc.source === "work" ? (
          <PageViewer work={work} file={doc.file} version={doc.stamp} />
        ) : doc.unreadable ? (
          <TooLarge path={doc.file} message={doc.unreadable} onPage={page ? () => onEditor({ rendered: true }) : undefined} />
        ) : doc.content === undefined ? (
          <div className="empty">正在读取…</div>
        ) : rendered && lottie ? (
          <AssetViewer assetBase={work.preview.assetBase} src={`films/${work.slug}/${doc.file.slice("public/".length)}`} version={doc.hash ?? undefined} />
        ) : rendered ? (
          <div className="markdown-page" onDoubleClick={() => onEditor({ rendered: false })} title="双击编辑">
            <Markdown text={frontmatterAsCode(doc.content)} />
          </div>
        ) : (
          <CodeEditor path={doc.file} value={doc.content} line={editor.line} onChange={(content) => onDoc({ content })} onSave={onSave} readOnly={locked} />
        )
      ) : (
        <MediaViewer path={doc.file} kind={doc.kind} playerId={editor.id} />
      )}
    </div>
  );
}

/** A video or audio element made known as a player (for the synced timeline) while it is mounted; it pauses out of sight. */
function useMediaPlayer(id: string, label: string) {
  const [element, setElement] = useState<HTMLMediaElement | null>(null);
  const visible = useTabVisible();
  useEffect(() => (element ? registerPlayer(id, mediaPlayer(element, label)) : undefined), [id, element, label]);
  useEffect(() => {
    if (!visible) element?.pause();
  }, [visible, element]);
  return setElement;
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

/** An SVG's tab: drawn in the SVG editor or as code, saved from here on a touch screen, quoted to the AI. */
function SvgToolbar({
  doc,
  rendered,
  locked,
  onEditor,
  onSave,
  onChat,
}: {
  doc: Doc;
  rendered: boolean;
  locked: boolean;
  onEditor: (change: Partial<Editor>) => void;
  onSave: () => void;
  onChat: ReturnType<typeof useWorkbench>["addToChat"];
}) {
  const { work } = useWorkbench();
  // Assets are referenced from code as films/<slug>/<path under public/>, library files as materials/<ref>.
  const reference =
    doc.source === "materials" ? `materials/${doc.file}` : doc.file.startsWith("public/") ? `films/${work.slug}/${doc.file.slice("public/".length)}` : null;
  return (
    <div className="editor-toolbar">
      <span className="faint small-text ellipsis grow" title={doc.source === "materials" ? "保存的是素材库里的这个文件（在「版本与同步」中保存为素材库的版本）" : undefined}>
        {doc.source === "materials" ? `素材库 · materials/${doc.file}` : doc.file}
        {locked ? " · 已发布，只能查看" : ""}
      </span>
      {reference && (
        <button className="btn small" onClick={() => onChat({ type: "asset", url: reference, path: doc.source === "work" ? doc.file : undefined })}>
          <Sparkles size={13} /> 引用到 AI 聊天
        </button>
      )}
      {!locked && (
        <button className="btn small" disabled={!dirty(doc)} onClick={onSave} title="保存（Ctrl+S）">
          <Save size={13} /> 保存
        </button>
      )}
      <div className="segmented">
        <button className={rendered ? "active" : ""} onClick={() => onEditor({ rendered: true })}>
          <PenTool size={12} /> 图形
        </button>
        <button className={rendered ? "" : "active"} onClick={() => onEditor({ rendered: false })}>
          <Code2 size={12} /> 代码
        </button>
      </div>
    </div>
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

function MediaViewer({ path, kind, playerId }: { path: string; kind: Kind; playerId: string }) {
  const { work, addToChat } = useWorkbench();
  const player = useMediaPlayer(playerId, path.split("/").pop()!);
  const drawn = kind === "model" || kind === "environment" || kind === "font";
  const [version, setVersion] = useState(0);
  const [info, setInfo] = useState("");
  useEffect(() => {
    setVersion(Date.now());
    setInfo("");
  }, [path]);
  // Assets are referenced from code as films/<slug>/<path under public/>.
  const reference = path.startsWith("public/") ? `films/${work.slug}/${path.slice(7)}` : null;
  // A file the browser keeps for playback is shown from there (and anew when it changes).
  const kept = useKeptFile(work.repo, work.id, reference);
  const url = kept === undefined ? null : (kept?.url ?? `${workPath(work.repo, work.id)}/raw?path=${encodeURIComponent(path)}&v=${version}`);
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
    <div className={`media-viewer ${kind === "image" ? "image" : ""}`}>
      {!url && kind !== "file" && !drawn && <div className="empty">正在读取…</div>}
      {url && kind === "image" && <ZoomImage src={url} alt={path} onLoad={(image) => setInfo(`${image.naturalWidth}×${image.naturalHeight}`)} />}
      {url && kind === "audio" && <audio ref={player} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
      {url && kind === "video" && <video ref={player} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
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

/** A picture, sound or video in one of the repository's skills, as the skill has it now. */
function SkillMediaViewer({ path, kind, playerId }: { path: string; kind: Kind; playerId: string }) {
  const { work, addToChat } = useWorkbench();
  const player = useMediaPlayer(playerId, path.split("/").pop()!);
  const [version, setVersion] = useState(() => Date.now());
  const [info, setInfo] = useState("");
  useServerEvent(
    (event) => {
      if ((event.type === "skills" && event.repo === work.repo) || (event.type === "work-versions" && event.work === `skills-${work.repo}`)) setVersion(Date.now());
    },
    [work.repo],
  );
  const url = `${skillsPath(work.repo)}/raw?path=${encodeURIComponent(path)}&v=${version}`;
  const media = (element: HTMLVideoElement | HTMLAudioElement) =>
    setInfo([element instanceof HTMLVideoElement && `${element.videoWidth}×${element.videoHeight}`, formatTime(element.duration)].filter(Boolean).join(" · "));
  return (
    <div className={`media-viewer ${kind === "image" ? "image" : ""}`}>
      {kind === "image" && <ZoomImage src={url} alt={path} onLoad={(image) => setInfo(`${image.naturalWidth}×${image.naturalHeight}`)} />}
      {kind === "audio" && <audio ref={player} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
      {kind === "video" && <video ref={player} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} />}
      <div className="media-info">
        <span className="faint mono ellipsis">技能 · {path}</span>
        {info && <span className="faint">{info}</span>}
        <button className="btn small" onClick={() => addToChat({ type: "skill", path })}>
          <Sparkles size={13} /> 引用到 AI 聊天
        </button>
      </div>
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
function MaterialViewer({ fileRef, kind, playerId }: { fileRef: string; kind: Kind; playerId: string }) {
  const { work, addToChat, readOnly } = useWorkbench();
  const player = useMediaPlayer(playerId, fileRef.split("/").pop()!);
  const toast = useToast();
  // Undefined until known; null when the work neither uses nor locked it.
  const [use, setUse] = useState<MaterialUse | null>();
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
        () => setUse((known) => known ?? null),
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
  // A file the work plays is kept by the browser as the work has it: the library's file as it
  // is now, unless the work locked an older version (whether it did is known with `use`).
  const kept = useKeptFile(work.repo, work.id, `materials/${fileRef}`);
  const waiting = kept === undefined || (kept?.version.startsWith("git-") && use === undefined);
  const workCopy = kept && (showLocked || !use?.outdated) ? kept : null;
  const url = waiting
    ? null
    : workCopy
      ? workCopy.url
      : showLocked
        ? `${work.preview.assetBase}materials/${fileRef.split("/").map(encodeURIComponent).join("/")}?v=${use?.locked}`
        : `${materialsPath(work.repo)}/file?path=${encodeURIComponent(fileRef)}&v=${version}`;
  const missing = "文件不存在（可能已在素材库中移动或删除）";
  useEffect(() => {
    setInfo("");
    setFailed("");
    if (kind !== "text" || !url) return;
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
    setInfo(
      [element instanceof HTMLVideoElement && element.videoWidth && `${element.videoWidth}×${element.videoHeight}`, formatTime(element.duration)]
        .filter(Boolean)
        .join(" · "),
    );
  const update = () =>
    api(`${workPath(work.repo, work.id)}/materials/lock`, { body: { refs: [fileRef], update: true } }).then(
      () => (setLockedVersion(false), toast("本作品已改用素材库里的最新版本", "ok")),
      (error: Error) => toast(error.message, "error"),
    );
  const lottie = useMemo(() => /\.json$/i.test(fileRef) && isLottieText(text ?? undefined), [fileRef, text]);
  // Drawn by the engine: the work's copy (the version it locked, or kept by the browser), else the library as it is now.
  const assetBase = showLocked || workCopy ? work.preview.assetBase : (work.preview.library?.assetBase ?? `/files/${encodeURIComponent(work.repo)}/-/`);
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
      {waiting && kind !== "text" && kind !== "file" ? (
        <div className="empty">正在读取…</div>
      ) : drawn ? (
        <AssetViewer
          key={`${assetBase}|${fileRef}`}
          assetBase={assetBase}
          src={`materials/${fileRef}`}
          version={workCopy ? workCopy.version : showLocked ? (use?.locked ?? undefined) : version}
        />
      ) : kind === "text" ? (
        text === null ? (
          <div className="empty">{failed || "正在读取…"}</div>
        ) : (
          <CodeEditor key={url} path={fileRef} value={text} onChange={() => {}} onSave={() => {}} readOnly />
        )
      ) : (
        <div className={`media-viewer ${kind === "image" ? "image" : ""}`}>
          {kind === "image" && url && (
            <ZoomImage
              key={url}
              src={url}
              alt={fileRef}
              onLoad={(image) => setInfo(`${image.naturalWidth}×${image.naturalHeight}`)}
              onError={() => setFailed(missing)}
            />
          )}
          {kind === "audio" && url && (
            <audio ref={player} key={url} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} onError={() => setFailed(missing)} />
          )}
          {kind === "video" && url && (
            <video ref={player} key={url} src={url} controls onLoadedMetadata={(event) => media(event.currentTarget)} onError={() => setFailed(missing)} />
          )}
          {kind === "file" && <div className="empty">无法在这里预览这种文件</div>}
          {failed && <div className="danger-text small-text">{failed}</div>}
          {kind !== "file" && !failed && (
            <div className="faint small-text">把「素材 → 素材库」或「素材库」选项卡里的这个文件拖到时间轴即可使用（触屏上长按它选「添加到画面」）</div>
          )}
        </div>
      )}
    </>
  );
}

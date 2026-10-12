import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FilePlus,
  Upload,
  RefreshCw,
  Sparkles,
  Trash2,
  Pencil,
  ChevronsDownUp,
  GitBranch,
  Library,
  BookOpen,
  BarChart3,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
} from "lucide-react";
import { api, del, timeAgo, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePersistent, usePrompt, type MenuItem } from "../lib/ui";
import type { FileEntry, WorkStatus } from "../lib/types";
import { useWorkbench, type VersionSource } from "../workbench/store";
import { fileIcon } from "../workbench/EditorArea";
import { useRemoteState } from "../workbench/RemoteBar";
import { ViewHeader } from "./ViewHeader";
import { uploadFiles } from "./upload";
import { SOURCE_NAMES, versionsBase } from "./VersionsView";

export interface Node {
  name: string;
  path: string;
  type: "file" | "dir";
  children: Node[];
}

export function buildTree(entries: FileEntry[]) {
  const root: Node = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  for (const entry of entries) {
    const parent = dirs.get(entry.path.split("/").slice(0, -1).join("/")) ?? root;
    const node: Node = { name: entry.path.split("/").pop()!, path: entry.path, type: entry.type, children: [] };
    parent.children.push(node);
    if (entry.type === "dir") dirs.set(entry.path, node);
  }
  return root.children;
}

export function ExplorerView() {
  const { work, openFile, addToChat, readOnly } = useWorkbench();
  const [sections, setSections] = usePersistent("explorer-sections", { files: true, versions: true });
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set(["scenes"]));
  const [run] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [openMenu, menu] = useContextMenu();
  const base = workPath(work.repo, work.id);
  const load = () => api<FileEntry[]>(`${base}/tree`).then(setEntries, () => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useServerEvent((event) => {
    if ((event.type === "work-files" || event.type === "assets") && event.work === work.id) void load();
  });
  const tree = useMemo(() => buildTree(entries), [entries]);

  const newFile = async (dir = "") => {
    const name = await prompt("新文件（可包含子目录）", dir ? dir + "/" : "scenes/new-scene.ts");
    if (!name) return;
    await run(async () => {
      await api(`${base}/file`, { method: "PUT", body: { path: name, content: "", expectedHash: null } });
      await load();
      openFile(name);
    });
  };
  const rename = async (node: Node) => {
    const to = await prompt("重命名 / 移动到", node.path);
    if (!to || to === node.path) return;
    await run(() => api(`${base}/move`, { body: { from: node.path, to } }).then(load), "已重命名。如有代码引用请同步修改。");
  };
  const remove = async (node: Node) => {
    if (!(await confirm(`删除 ${node.path}？可以从版本历史中恢复。`, { confirm: "删除", danger: true }))) return;
    await run(() => del(`${base}/file?path=${encodeURIComponent(node.path)}`).then(load));
  };
  const menuFor = (event: React.MouseEvent, node: Node) =>
    openMenu(event, [
      ...(node.type === "file"
        ? [{ label: "打开", onClick: () => openFile(node.path) }]
        : readOnly
          ? []
          : [{ label: "新建文件", icon: <FilePlus size={14} />, onClick: () => newFile(node.path) }]),
      ...(readOnly
        ? []
        : ([
            { label: "引用到 AI 聊天", icon: <Sparkles size={14} />, onClick: () => addToChat({ type: "file", path: node.path }) },
            "separator",
            { label: "重命名 / 移动", icon: <Pencil size={14} />, onClick: () => rename(node), disabled: node.path === "project.ts" },
            { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => remove(node), disabled: node.path === "project.ts" },
          ] as MenuItem[])),
    ]);

  const renderNodes = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.path}>
        <div
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() =>
            node.type === "dir"
              ? setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              : // Like VS Code: a click previews the file, a double-click (or an edit) keeps the tab.
                openFile(node.path, { preview: true })
          }
          onDoubleClick={() => node.type === "file" && openFile(node.path)}
          onContextMenu={(event) => menuFor(event, node)}
          title={node.path}
        >
          {node.type === "dir" ? (
            <>
              {open.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {open.has(node.path) ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" />}
            </>
          ) : (
            <>
              <span style={{ width: 14 }} />
              {fileIcon(node.path)}
            </>
          )}
          <span className="ellipsis">{node.name}</span>
        </div>
        {node.type === "dir" && open.has(node.path) && renderNodes(node.children, depth + 1)}
      </div>
    ));

  return (
    <div className="view">
      <ViewHeader title="资源管理器">
        {!readOnly && (
          <>
            <button className="icon-btn" title="新建文件" onClick={() => newFile()}>
              <FilePlus size={15} />
            </button>
            <button className="icon-btn" title="上传素材到 public/" onClick={() => uploadFiles(work, "public").then(load)}>
              <Upload size={15} />
            </button>
          </>
        )}
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw size={15} />
        </button>
        <button className="icon-btn" title="全部折叠" onClick={() => setOpen(new Set())}>
          <ChevronsDownUp size={15} />
        </button>
      </ViewHeader>
      <div className="library-group" onClick={() => setSections({ ...sections, files: !sections.files })}>
        {sections.files ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="ellipsis">文件 · {work.meta?.title ?? work.slug}</span>
      </div>
      {sections.files && (
        <>
          <div className="tree">{renderNodes(tree, 0)}</div>
          <p className="view-hint">作品代码与素材都在这里。大部分修改交给 AI；也可以直接编辑文件，保存后预览立即更新。</p>
        </>
      )}
      <div className="library-group explorer-versions-head" onClick={() => setSections({ ...sections, versions: !sections.versions })}>
        {sections.versions ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        版本与同步
      </div>
      {sections.versions && <VersionsSummary />}
      {menu}
    </div>
  );
}

const SOURCE_ICONS: Record<VersionSource, typeof GitBranch> = { work: GitBranch, materials: Library, experience: BookOpen, reviews: BarChart3 };

/**
 * Where each branch stands: the work, and the repository's material, experience and review
 * branches. A click opens its versions tab (save, changes, history, GitHub).
 */
function VersionsSummary() {
  const { work } = useWorkbench();
  return (
    <div className="versions-summary">
      {(["work", "experience", "materials", "reviews"] as const).map((source) => (
        <VersionsRow key={source} source={source} />
      ))}
      <p className="view-hint">作品和经验库的修改由你保存为版本；素材库和复盘资料每次修改都自动保存。{work.repo === "local" ? "" : "保存后自动同步到 GitHub。"}</p>
    </div>
  );
}

function VersionsRow({ source }: { source: VersionSource }) {
  const { work, openTool } = useWorkbench();
  const base = versionsBase(source, work.repo, work.id);
  const scope = source === "work" ? work.id : `${source}-${work.repo}`;
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [remote] = useRemoteState(`${base}/remote`, work.repo, scope);
  const load = () => api<WorkStatus>(`${base}/status`).then(setStatus, () => setStatus(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useServerEvent((event) => {
    if ((event.type === "work-files" || event.type === "work-versions") && event.work === scope) void load();
    if (source === "experience" && event.type === "experience-files" && event.repo === work.repo) void load();
    if (source === "materials" && event.type === "materials" && event.repo === work.repo) void load();
    if (source === "reviews" && event.type === "reviews" && event.repo === work.repo) void load();
  });
  // No review data yet: no branch to show.
  if (!status || (source === "reviews" && !status.head && !status.files.length)) return null;
  const Icon = SOURCE_ICONS[source];
  const changes = status.files.length;
  const trouble = remote && ["behind", "diverged", "conflict", "error"].includes(remote.state);
  return (
    <div
      className="versions-summary-row"
      title={`${SOURCE_NAMES[source]}的版本与同步：单击打开`}
      onClick={() => openTool(`versions:${source}`)}
    >
      <Icon size={14} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{SOURCE_NAMES[source]}</div>
        <div className="faint small-text ellipsis">
          {changes ? `${changes} 个未保存的修改` : status.head ? `${timeAgo(status.head.date)}保存 · ${status.head.message}` : "还没有版本"}
        </div>
      </div>
      {changes > 0 && <span className="badge accent">{changes}</span>}
      {status.ahead > 0 && (
        <span className="faint small-text" title="还没推送到 GitHub 的版本">
          <ArrowUp size={11} />
          {status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span className="faint small-text" title="GitHub 上更新的版本">
          <ArrowDown size={11} />
          {status.behind}
        </span>
      )}
      {trouble && <AlertTriangle size={14} className="warn-text" aria-label="和 GitHub 不同步" />}
    </div>
  );
}

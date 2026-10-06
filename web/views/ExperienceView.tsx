import { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, FilePlus, FolderPlus, Pencil, RefreshCw, Sparkles, Trash2, FileText, Link2, Unlink } from "lucide-react";
import { api, del, experiencePath, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt } from "../lib/ui";
import type { FileEntry, WorkStatus } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { buildTree, type Node } from "./ExplorerView";
import { VersionsPanel } from "./VersionsView";
import { ViewHeader } from "./ViewHeader";

interface Library {
  id: string;
  title: string;
  files: number;
  /** Earlier names (works may still link them). */
  aliases?: string[];
}

const ORGANIZE = (titles: string[]) =>
  `请整理经验库${titles.map((title) => `「${title}」`).join("")}：回顾我们这次的对话和作品的修改，把在同类作品里值得复用的做法、我明确表达过的偏好、踩过的坑和解决办法整理进去${titles.length > 1 ? "（按内容放进最合适的经验库）" : ""}。先阅读现有内容，按主题合并到已有文档，不要重复，过时的说法直接改掉；改完简单告诉我改了哪些文档。`;

/**
 * Experience libraries of the work's repository: Markdown documents shared by works of the
 * same kind. The work links one library, which the AI reads before working and keeps
 * organized; documents open as editor tabs; versions are saved like a work's.
 */
export function ExperienceView() {
  const { work, reload, openExperience, addToChat, askAi, readOnly } = useWorkbench();
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [changes, setChanges] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showVersions, setShowVersions] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [openMenu, menu] = useContextMenu();
  const base = experiencePath(work.repo);
  // The work links libraries by name; renamed ones are found through their earlier names.
  const linkedNames = useMemo(() => work.meta?.experiences ?? [], [work.meta?.experiences]);
  const libraryOfName = (name: string) => libraries.find((item) => item.id === name || item.aliases?.includes(name));
  const linkedIds = new Set(linkedNames.map((name) => libraryOfName(name)?.id).filter((id): id is string => Boolean(id)));
  const linkedLibraries = libraries.filter((item) => linkedIds.has(item.id));
  const missingNames = libraries.length ? linkedNames.filter((name) => !libraryOfName(name)) : [];

  const load = () =>
    Promise.all([api<Library[]>(`${base}/libraries`), api<FileEntry[]>(`${base}/tree`), api<WorkStatus>(`${base}/status`)]).then(
      ([nextLibraries, nextEntries, status]) => {
        setLibraries(nextLibraries);
        setEntries(nextEntries);
        setChanges(status.files.length);
      },
      () => {},
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  const linkedKey = [...linkedIds].join("|");
  useEffect(() => {
    if (linkedKey) setOpen((current) => new Set([...current, ...linkedKey.split("|")]));
  }, [linkedKey]);
  useServerEvent((event) => {
    if (event.type === "experience-files" && event.repo === work.repo) void load();
    if (event.type === "work-versions" && event.work === `experience-${work.repo}`) void load();
  });

  // Only the libraries (top-level folders); root files explain the branch itself.
  const tree = useMemo(
    () => buildTree(entries.filter((entry) => !entry.path.split("/").some((part) => part.startsWith(".")))).filter((node) => node.type === "dir"),
    [entries],
  );
  const titleOf = (id: string) => libraries.find((item) => item.id === id)?.title ?? id;

  const setLinks = (names: string[], message: string) =>
    run(async () => {
      await api(workPath(work.repo, work.id), { method: "PATCH", body: { experiences: names } });
      await reload();
    }, message);
  const link = (id: string) => setLinks([...linkedNames.filter((name) => libraryOfName(name)?.id !== id), id], `已关联经验库「${titleOf(id)}」`);
  const unlink = (id: string) => setLinks(linkedNames.filter((name) => libraryOfName(name)?.id !== id), `已取消关联「${titleOf(id)}」`);
  const createLibrary = () =>
    run(async () => {
      const name = (await prompt("新经验库的名称", "", "例如：知识类视频、音乐视频"))?.trim();
      if (!name) return;
      const created = await api<{ id: string; title: string }>(`${base}/libraries`, { body: { name } });
      await load();
      setOpen((current) => new Set([...current, created.id]));
      if (!readOnly && (await confirm(`把经验库「${created.title}」关联到当前作品？`, { confirm: "关联" }))) await link(created.id);
      openExperience(`${created.id}/README.md`);
    });
  const renameLibrary = (id: string) =>
    run(async () => {
      const name = (await prompt("重命名经验库", titleOf(id)))?.trim();
      if (!name || name === titleOf(id)) return;
      const renamed = await api<{ id: string; title: string }>(`${base}/libraries/${encodeURIComponent(id)}/rename`, { body: { name } });
      setOpen((current) => new Set([...current].map((item) => (item === id ? renamed.id : item))));
      await load();
      await reload(); // the work's description shows the library's title
    }, "已重命名。保存版本后会同步；关联它的作品不受影响");
  const removeLibrary = (id: string) =>
    run(async () => {
      if (
        !(await confirm(`删除经验库「${titleOf(id)}」及其中所有文档？保存版本前可以在「版本」中撤销，保存后也能从历史恢复。`, {
          confirm: "删除",
          danger: true,
        }))
      )
        return;
      await del(`${base}/libraries/${encodeURIComponent(id)}`);
    });
  const newDocument = (folder: string) =>
    run(async () => {
      const name = (await prompt("新文档（可以包含子文件夹）", "新经验.md"))?.trim();
      if (!name) return;
      const file = `${folder}/${/\.(md|txt)$/i.test(name) ? name : name + ".md"}`;
      const title = name
        .replace(/\.(md|txt)$/i, "")
        .split("/")
        .pop();
      await api(`${base}/file`, { method: "PUT", body: { path: file, content: `# ${title}\n\n`, expectedHash: null } });
      openExperience(file);
    });
  const rename = (node: Node) =>
    run(async () => {
      const library = node.path.split("/")[0];
      const relative = node.path.slice(library.length + 1);
      const next = (await prompt("重命名 / 移动到（经验库内的路径）", relative))?.trim();
      if (!next || next === relative) return;
      await api(`${base}/move`, { body: { from: node.path, to: `${library}/${next}` } });
    });
  const remove = (node: Node) =>
    run(async () => {
      if (!(await confirm(`删除 ${node.path}？保存版本前可以撤销。`, { confirm: "删除", danger: true }))) return;
      await del(`${base}/file?path=${encodeURIComponent(node.path)}`);
    });

  const menuFor = (event: React.MouseEvent, node: Node, depth: number) => {
    const library = node.path.split("/")[0];
    const isLibrary = depth === 0;
    const folder = node.type === "dir" ? node.path : node.path.split("/").slice(0, -1).join("/");
    openMenu(event, [
      ...(node.type === "file" ? [{ label: "打开", icon: <FileText size={14} />, onClick: () => openExperience(node.path) }] : []),
      { label: "新建文档", icon: <FilePlus size={14} />, onClick: () => newDocument(folder) },
      ...(isLibrary && !readOnly
        ? [
            linkedIds.has(library)
              ? { label: "不再用于当前作品", icon: <Unlink size={14} />, onClick: () => unlink(library) }
              : { label: "关联到当前作品", icon: <Link2 size={14} />, onClick: () => link(library) },
          ]
        : []),
      ...(isLibrary ? [{ label: "重命名", icon: <Pencil size={14} />, onClick: () => renameLibrary(library) }] : []),
      ...(linkedIds.has(library)
        ? [
            ...(node.type === "file"
              ? [
                  {
                    label: "引用到 AI 聊天",
                    icon: <Sparkles size={14} />,
                    onClick: () => addToChat({ type: "experience" as const, library, path: node.path.slice(library.length + 1) }),
                  },
                ]
              : []),
            { label: "让 AI 整理这个经验库", icon: <Sparkles size={14} />, onClick: () => askAi(ORGANIZE([titleOf(library)])) },
          ]
        : []),
      "separator",
      ...(isLibrary
        ? [{ label: "删除经验库", icon: <Trash2 size={14} />, danger: true, onClick: () => removeLibrary(library) }]
        : [
            { label: "重命名 / 移动", icon: <Pencil size={14} />, onClick: () => rename(node) },
            { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => remove(node), disabled: node.path === `${library}/README.md` },
          ]),
    ]);
  };

  const renderNodes = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.path}>
        <div
          className={`tree-row ${depth === 0 && linkedIds.has(node.path) ? "linked" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={depth === 0 ? `${titleOf(node.path)}（${node.path}）` : node.path}
          onClick={() =>
            node.type === "dir"
              ? setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              : openExperience(node.path, { preview: true })
          }
          onDoubleClick={() => node.type === "file" && openExperience(node.path)}
          onContextMenu={(event) => menuFor(event, node, depth)}
        >
          {node.type === "dir" ? (
            <>
              {open.has(node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {depth === 0 && <BookOpen size={14} className="folder-icon" />}
            </>
          ) : (
            <>
              <span style={{ width: 14 }} />
              <FileText size={14} />
            </>
          )}
          <span className="ellipsis grow">{depth === 0 ? titleOf(node.path) : node.name}</span>
          {depth === 0 && linkedIds.has(node.path) && <span className="badge accent">本作品</span>}
        </div>
        {node.type === "dir" && open.has(node.path) && renderNodes(node.children, depth + 1)}
      </div>
    ));

  return (
    <div className="view">
      <ViewHeader title="经验">
        <button className="icon-btn" title="新建经验库" onClick={createLibrary}>
          <FolderPlus size={15} />
        </button>
        <button
          className="icon-btn"
          title={linkedLibraries.length > 1 ? "作品关联了多个经验库：右键其中一个新建文档" : "在当前作品的经验库中新建文档"}
          disabled={linkedLibraries.length !== 1}
          onClick={() => newDocument(linkedLibraries[0].id)}
        >
          <FilePlus size={15} />
        </button>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      {busy && <div className="view-progress" />}
      <section className="view-section">
        <h3>当前作品使用的经验库</h3>
        {libraries.map((library) => (
          <label key={library.id} className="check-row" title={readOnly ? "作品已发布，不能更改关联" : undefined}>
            <input
              type="checkbox"
              checked={linkedIds.has(library.id)}
              disabled={readOnly || busy}
              onChange={(event) => (event.target.checked ? link(library.id) : unlink(library.id))}
            />
            <span className="ellipsis grow">{library.title}</span>
            <span className="faint small-text">{library.files} 篇</span>
          </label>
        ))}
        {missingNames.map((name) => (
          <p key={name} className="view-hint">
            关联的经验库「{name}」已不存在。
            {!readOnly && (
              <button className="link-btn" onClick={() => setLinks(linkedNames.filter((item) => item !== name), "已移除")}>
                移除
              </button>
            )}
          </p>
        ))}
        {linkedLibraries.length ? (
          <div className="row">
            <button
              className="btn small grow"
              title="AI 回顾本次对话和作品修改，把经验整理进经验库"
              onClick={() => askAi(ORGANIZE(linkedLibraries.map((library) => library.title)))}
            >
              <Sparkles size={13} /> 让 AI 整理经验
            </button>
          </div>
        ) : (
          <p className="view-hint">
            {libraries.length
              ? "勾选要用的经验库（可以多个）。AI 制作这个作品前会先阅读它们，并把新的经验整理进去。"
              : "还没有经验库。点上方「新建经验库」，例如“知识类视频”“音乐视频”。"}
          </p>
        )}
      </section>
      <div className="tree">{renderNodes(tree, 0)}</div>
      <section className="view-section experience-versions">
        <h3 className="clickable" onClick={() => setShowVersions(!showVersions)}>
          {showVersions ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 版本 {changes > 0 && <span className="badge accent">{changes} 个未保存</span>}
        </h3>
      </section>
      {showVersions && <VersionsPanel source="experience" />}
      {menu}
    </div>
  );
}

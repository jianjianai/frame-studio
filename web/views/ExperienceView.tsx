import { useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, FilePlus, FileText, Library, Pencil, RefreshCw, Settings2, Sparkles, Trash2, Undo2, Unlink } from "lucide-react";
import { api, del, experiencePath, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt, type MenuItem } from "../lib/ui";
import type { FileEntry } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { buildTree, type Node } from "./ExplorerView";
import { ViewHeader } from "./ViewHeader";
import type { LibraryInfo, TrashedLibrary } from "./libraryShared";

export const ORGANIZE = (titles: string[]) =>
  `请整理经验库${titles.map((title) => `「${title}」`).join("")}：回顾我们这次的对话和作品的修改，把在同类作品里值得复用的做法、我明确表达过的偏好、踩过的坑和解决办法整理进去${titles.length > 1 ? "（按内容放进最合适的经验库）" : ""}。先阅读现有内容，按主题合并到已有文档，不要重复，过时的说法直接改掉；改完简单告诉我改了哪些文档。`;

/**
 * The experience libraries the work uses, each with its documents (opened as editor tabs).
 * Finding, linking, creating and deleting libraries happens in the 经验库 tab (管理…); their
 * versions are in 版本与同步.
 */
export function ExperienceView() {
  const { work, reload, openExperience, openTool, addToChat, askAi, readOnly } = useWorkbench();
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [trash, setTrash] = useState<TrashedLibrary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [trees, setTrees] = useState<Record<string, FileEntry[]>>({});
  // Libraries the user folded; folders inside them the user opened (as "+<path>").
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [openMenu, menu] = useContextMenu();
  const base = experiencePath(work.repo);
  const enc = encodeURIComponent;
  // The work links libraries by name; renamed ones are found through their earlier names.
  const linkedNames = useMemo(() => work.meta?.experiences ?? [], [work.meta?.experiences]);
  const libraryOfName = (name: string) => libraries.find((item) => item.id === name || item.aliases?.includes(name));
  const linked = [...new Set(linkedNames.map((name) => libraryOfName(name)).filter((item): item is LibraryInfo => Boolean(item)))];
  const missingNames = loaded ? linkedNames.filter((name) => !libraryOfName(name)) : [];

  const load = () =>
    Promise.all([api<LibraryInfo[]>(`${base}/libraries`), api<TrashedLibrary[]>(`${base}/trash`)]).then(
      ([nextLibraries, nextTrash]) => {
        setLibraries(nextLibraries);
        setTrash(nextTrash);
        setLoaded(true);
      },
      () => {},
    );
  const loadTree = (id: string) => api<FileEntry[]>(`${base}/tree?library=${enc(id)}`).then((list) => setTrees((map) => ({ ...map, [id]: list })), () => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, work.id]);
  const openKey = linked
    .filter((library) => !toggled.has(library.id))
    .map((library) => library.id)
    .join("|");
  useEffect(() => {
    for (const id of openKey.split("|").filter(Boolean)) void loadTree(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, libraries]);
  useServerEvent((event) => {
    if (event.type === "experience-files" && event.repo === work.repo) void load();
    if (event.type === "work-versions" && event.work === `experience-${work.repo}`) void load();
  });

  const titleOf = (id: string) => libraries.find((item) => item.id === id)?.title ?? id;
  const setLinks = (names: string[], message: string) =>
    run(async () => {
      await api(workPath(work.repo, work.id), { method: "PATCH", body: { experiences: names } });
      await reload();
    }, message);
  const unlink = (id: string) => setLinks(linkedNames.filter((name) => libraryOfName(name)?.id !== id), `已取消关联「${titleOf(id)}」`);
  const restore = (item: TrashedLibrary) =>
    run(async () => {
      await api(`${base}/trash/${enc(item.key)}/restore`, { method: "POST" });
      await load();
    }, `已恢复经验库「${item.title}」`);
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
  const rename = (node: Pick<Node, "path">) =>
    run(async () => {
      const library = node.path.split("/")[0];
      const relative = node.path.slice(library.length + 1);
      const next = (await prompt("重命名 / 移动到（经验库内的路径）", relative))?.trim();
      if (!next || next === relative) return;
      await api(`${base}/move`, { body: { from: node.path, to: `${library}/${next}` } });
    });
  const remove = (node: Pick<Node, "path">) =>
    run(async () => {
      if (!(await confirm(`删除 ${node.path}？保存版本前可以撤销。`, { confirm: "删除", danger: true }))) return;
      await del(`${base}/file?path=${enc(node.path)}`);
    });

  const menuFor = (event: React.MouseEvent, node: Pick<Node, "path" | "type">, depth: number) => {
    const library = node.path.split("/")[0];
    const folder = node.type === "dir" ? node.path : node.path.split("/").slice(0, -1).join("/");
    const items: MenuItem[] = [
      ...(node.type === "file" ? [{ label: "打开", icon: <FileText size={14} />, onClick: () => openExperience(node.path) }] : []),
      { label: "新建文档", icon: <FilePlus size={14} />, onClick: () => newDocument(folder) },
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
    ];
    if (depth === 0) {
      items.push({ label: "管理经验库…", icon: <Library size={14} />, onClick: () => openTool("libraries:experiences") });
      if (!readOnly) items.push("separator", { label: "不再用于当前作品", icon: <Unlink size={14} />, onClick: () => unlink(library) });
    } else
      items.push(
        "separator",
        { label: "重命名 / 移动", icon: <Pencil size={14} />, onClick: () => rename(node) },
        { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => remove(node), disabled: node.path === `${library}/README.md` },
      );
    openMenu(event, items);
  };

  const flip = (key: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const renderNodes = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.path}>
        <div
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          title={node.path}
          onClick={() => (node.type === "dir" ? flip("+" + node.path) : openExperience(node.path, { preview: true }))}
          onDoubleClick={() => node.type === "file" && openExperience(node.path)}
          onContextMenu={(event) => menuFor(event, node, depth)}
        >
          {node.type === "dir" ? (
            toggled.has("+" + node.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <>
              <span style={{ width: 14 }} />
              <FileText size={14} />
            </>
          )}
          <span className="ellipsis grow">{node.name}</span>
        </div>
        {node.type === "dir" && toggled.has("+" + node.path) && renderNodes(node.children, depth + 1)}
      </div>
    ));

  return (
    <div className="view library-panel">
      <ViewHeader title="经验">
        <button className="icon-btn" title="管理经验库：查找、关联、新建、删除" onClick={() => openTool("libraries:experiences")}>
          <Settings2 size={15} />
        </button>
        <button
          className="icon-btn"
          title={linked.length > 1 ? "作品关联了多个经验库：右键（或长按）其中一个新建文档" : "在当前作品的经验库中新建文档"}
          disabled={linked.length !== 1}
          onClick={() => newDocument(linked[0].id)}
        >
          <FilePlus size={15} />
        </button>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      {busy && <div className="view-progress" />}
      <div className="library-group" title={readOnly ? "作品已发布，不能更改关联" : undefined}>
        本作品使用的经验库 <span className="count">{linked.length}</span>
        <span className="grow" />
        <button className="link-btn" title="查找、关联、新建或删除经验库" onClick={() => openTool("libraries:experiences")}>
          <Settings2 size={13} /> 管理…
        </button>
      </div>
      <div className="tree">
        {linked.map((library) => (
          <div key={library.id}>
            <div
              className="tree-row linked"
              style={{ paddingLeft: 8 }}
              title={`${library.title}（${library.id}）${library.about ? `\n${library.about}` : ""}\n${library.files} 篇${library.works ? ` · ${library.works} 个作品在用` : ""}`}
              onClick={() => flip(library.id)}
              onContextMenu={(event) => menuFor(event, { path: library.id, type: "dir" }, 0)}
            >
              {toggled.has(library.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <BookOpen size={14} className="folder-icon" />
              <span className="ellipsis grow">{library.title}</span>
              <span className="faint small-text">{library.files} 篇</span>
            </div>
            {!toggled.has(library.id) && (trees[library.id] ? renderNodes(buildTree(trees[library.id]), 1) : <div className="library-more">读取中…</div>)}
          </div>
        ))}
      </div>
      <section className="view-section">
        {missingNames.map((name) => {
          const bin = trash.find((item) => item.id === name);
          return (
            <p key={name} className="view-hint">
              关联的经验库「{name}」{bin ? "在回收站里。" : "已不存在。"}
              {bin && (
                <button className="link-btn" onClick={() => restore(bin)}>
                  <Undo2 size={12} /> 恢复
                </button>
              )}
              {!bin && !readOnly && (
                <button className="link-btn" onClick={() => setLinks(linkedNames.filter((item) => item !== name), "已移除")}>
                  移除
                </button>
              )}
            </p>
          );
        })}
        {linked.length ? (
          <div className="row">
            <button
              className="btn small grow"
              title="AI 回顾本次对话和作品修改，把经验整理进经验库"
              onClick={() => askAi(ORGANIZE(linked.map((library) => library.title)))}
            >
              <Sparkles size={13} /> 让 AI 整理经验
            </button>
          </div>
        ) : (
          loaded && (
            <p className="view-hint">
              还没有关联经验库。AI 制作这个作品前会先阅读关联的经验库（可以多个），并把新的经验整理进去。
              <button className="link-btn" onClick={() => openTool("libraries:experiences")}>
                {readOnly ? "查看经验库…" : libraries.length ? "关联经验库…" : "新建经验库…"}
              </button>
            </p>
          )
        )}
      </section>
      {menu}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FolderPlus,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  FileText,
  Link2,
  ListChecks,
  Unlink,
  X,
} from "lucide-react";
import { api, del, experiencePath, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt, useToast } from "../lib/ui";
import type { FileEntry, WorkStatus } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { buildTree, type Node } from "./ExplorerView";
import { VersionsPanel } from "./VersionsView";
import { ViewHeader } from "./ViewHeader";
import { LibraryPicker, LibrarySuggestions, Marked, libraryMatches, type LibraryInfo } from "./LibraryPicker";

const ORGANIZE = (titles: string[]) =>
  `请整理经验库${titles.map((title) => `「${title}」`).join("")}：回顾我们这次的对话和作品的修改，把在同类作品里值得复用的做法、我明确表达过的偏好、踩过的坑和解决办法整理进去${titles.length > 1 ? "（按内容放进最合适的经验库）" : ""}。先阅读现有内容，按主题合并到已有文档，不要重复，过时的说法直接改掉；改完简单告诉我改了哪些文档。`;

/** Libraries past this many get a search box, and the ones the work does not use start folded. */
const MANY = 6;

/**
 * Experience libraries of the work's repository: Markdown documents shared by works of the
 * same kind. The work's own libraries come first, each with its documents; the others are
 * folded away and found by name or document; the picker chooses among many. The AI reads the
 * work's libraries before working and keeps them organized; documents open as editor tabs;
 * versions are saved like a work's.
 */
export function ExperienceView() {
  const { work, reload, openExperience, addToChat, askAi, readOnly } = useWorkbench();
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [trees, setTrees] = useState<Record<string, FileEntry[]>>({});
  const [changes, setChanges] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [othersOpen, setOthersOpen] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [documents, setDocuments] = useState<{ library: string; path: string; title: string }[]>([]);
  const [picker, setPicker] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = experiencePath(work.repo);
  const enc = encodeURIComponent;
  // The work links libraries by name; renamed ones are found through their earlier names.
  const linkedNames = useMemo(() => work.meta?.experiences ?? [], [work.meta?.experiences]);
  const libraryOfName = (name: string) => libraries.find((item) => item.id === name || item.aliases?.includes(name));
  const linkedIds = linkedNames.map((name) => libraryOfName(name)?.id).filter((id): id is string => Boolean(id));
  const linkedSet = new Set(linkedIds);
  const linkedLibraries = linkedIds.map((id) => libraries.find((item) => item.id === id)!).filter((item, index, list) => list.indexOf(item) === index);
  const missingNames = loaded ? linkedNames.filter((name) => !libraryOfName(name)) : [];
  const others = libraries.filter((item) => !linkedSet.has(item.id));
  const titleOf = (id: string) => libraries.find((item) => item.id === id)?.title ?? id;

  const load = () =>
    Promise.all([api<LibraryInfo[]>(`${base}/libraries?work=${enc(work.id)}`), api<WorkStatus>(`${base}/status`)]).then(
      ([nextLibraries, status]) => {
        setLibraries(nextLibraries);
        setChanges(status.files.length);
        setLoaded(true);
      },
      () => {},
    );
  const loadTree = (id: string) =>
    api<FileEntry[]>(`${base}/tree?library=${enc(id)}`).then(
      (list) => setTrees((map) => ({ ...map, [id]: list })),
      () => {},
    );
  // Open libraries' documents (a library id has no "/", folders inside one do).
  const openLibraries = [...open].filter((key) => !key.includes("/") && libraries.some((item) => item.id === key));
  const openKey = openLibraries.join("|");
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, work.id]);
  useEffect(() => {
    for (const id of openLibraries) void loadTree(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, libraries]);
  // The work's libraries start open.
  const linkedKey = linkedIds.join("|");
  useEffect(() => {
    if (linkedKey) setOpen((current) => new Set([...current, ...linkedKey.split("|")]));
  }, [linkedKey]);
  useServerEvent((event) => {
    if (event.type === "experience-files" && event.repo === work.repo) void load();
    if (event.type === "work-versions" && event.work === `experience-${work.repo}`) void load();
  });
  // Documents of every library matching the search (by file name and title), shortly after typing.
  useEffect(() => {
    if (!query.trim()) return setDocuments([]);
    const timer = setTimeout(() => void api<typeof documents>(`${base}/find?q=${enc(query.trim())}`).then(setDocuments, () => setDocuments([])), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, base, libraries]);

  const setLinks = (names: string[], message: string) =>
    run(async () => {
      await api(workPath(work.repo, work.id), { method: "PATCH", body: { experiences: names } });
      await reload();
      await load();
    }, message);
  const link = (id: string) => setLinks([...linkedNames.filter((name) => libraryOfName(name)?.id !== id), id], `已关联经验库「${titleOf(id)}」`);
  const unlink = (id: string) =>
    setLinks(
      linkedNames.filter((name) => libraryOfName(name)?.id !== id),
      `已取消关联「${titleOf(id)}」`,
    );
  /** The picker's choice (errors keep it open); links to deleted libraries stay until removed on their own. */
  const choose = async (ids: string[]) => {
    const kept = linkedNames.filter((name) => !libraryOfName(name));
    await api(workPath(work.repo, work.id), { method: "PATCH", body: { experiences: [...ids, ...kept] } });
    await reload();
    await load();
    const added = ids.filter((id) => !linkedSet.has(id)).length;
    const removed = linkedIds.filter((id) => !ids.includes(id)).length;
    toast([added ? `关联了 ${added} 个经验库` : "", removed ? `取消关联 ${removed} 个` : ""].filter(Boolean).join("，") || "已更新", "ok");
  };
  const createNamed = async (name: string): Promise<LibraryInfo> => {
    const created = await api<{ id: string; title: string }>(`${base}/libraries`, { body: { name } });
    await load();
    return { ...created, files: 1, works: 0 };
  };
  const createLibrary = () =>
    run(async () => {
      const name = (await prompt("新经验库的名称", "", "例如：知识类视频、音乐视频"))?.trim();
      if (!name) return;
      const created = await createNamed(name);
      setOpen((current) => new Set([...current, created.id]));
      if (!readOnly && (await confirm(`把经验库「${created.title}」关联到当前作品？`, { confirm: "关联" }))) await link(created.id);
      openExperience(`${created.id}/README.md`);
    });
  const renameLibrary = (id: string) =>
    run(async () => {
      const name = (await prompt("重命名经验库", titleOf(id)))?.trim();
      if (!name || name === titleOf(id)) return;
      const renamed = await api<{ id: string; title: string }>(`${base}/libraries/${enc(id)}/rename`, { body: { name } });
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
      await del(`${base}/libraries/${enc(id)}`);
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
    const isLibrary = depth === 0;
    const folder = node.type === "dir" ? node.path : node.path.split("/").slice(0, -1).join("/");
    openMenu(event, [
      ...(node.type === "file" ? [{ label: "打开", icon: <FileText size={14} />, onClick: () => openExperience(node.path) }] : []),
      { label: "新建文档", icon: <FilePlus size={14} />, onClick: () => newDocument(folder) },
      ...(isLibrary && !readOnly
        ? [
            linkedSet.has(library)
              ? { label: "不再用于当前作品", icon: <Unlink size={14} />, onClick: () => unlink(library) }
              : { label: "关联到当前作品", icon: <Link2 size={14} />, onClick: () => link(library) },
          ]
        : []),
      ...(isLibrary ? [{ label: "重命名", icon: <Pencil size={14} />, onClick: () => renameLibrary(library) }] : []),
      ...(linkedSet.has(library)
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

  const flip = (key: string) =>
    setOpen((current) => {
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
          onClick={() => (node.type === "dir" ? flip(node.path) : openExperience(node.path, { preview: true }))}
          onDoubleClick={() => node.type === "file" && openExperience(node.path)}
          onContextMenu={(event) => menuFor(event, node, depth)}
        >
          {node.type === "dir" ? (
            open.has(node.path) ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <>
              <span style={{ width: 14 }} />
              <FileText size={14} />
            </>
          )}
          <span className="ellipsis grow">{node.name}</span>
        </div>
        {node.type === "dir" && open.has(node.path) && renderNodes(node.children, depth + 1)}
      </div>
    ));
  /** A library: its row (unlink button for the work's own) and, open, its documents. */
  const renderLibrary = (library: LibraryInfo) => {
    const linked = linkedSet.has(library.id);
    return (
      <div key={library.id}>
        <div
          className={`tree-row library-linked-row ${linked ? "linked" : ""}`}
          style={{ paddingLeft: 8 }}
          title={`${library.title}（${library.id}）${library.about ? `\n${library.about}` : ""}\n${library.files} 篇${library.works ? ` · ${library.works} 个作品在用` : ""}`}
          onClick={() => flip(library.id)}
          onContextMenu={(event) => menuFor(event, { path: library.id, type: "dir" }, 0)}
        >
          {open.has(library.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <BookOpen size={14} className="folder-icon" />
          <span className="ellipsis grow">
            <Marked text={library.title} query={query} />
          </span>
          {linked && query && <span className="badge accent">本作品</span>}
          <span className="faint small-text">{library.files} 篇</span>
          {linked && !readOnly && (
            <button
              className="icon-btn"
              title="不再用于当前作品"
              aria-label={`不再用「${library.title}」`}
              onClick={(event) => {
                event.stopPropagation();
                void unlink(library.id);
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
        {open.has(library.id) && (trees[library.id] ? renderNodes(buildTree(trees[library.id]), 1) : <div className="library-more">读取中…</div>)}
      </div>
    );
  };

  const searching = Boolean(query.trim());
  const found = searching
    ? libraries.filter((library) => libraryMatches(library, query)).sort((a, b) => Number(linkedSet.has(b.id)) - Number(linkedSet.has(a.id)))
    : [];
  const othersShown = othersOpen ?? others.length <= MANY;
  const hasMany = libraries.length > MANY;

  return (
    <div className="view library-panel">
      <ViewHeader title="经验">
        {!readOnly && libraries.length > 0 && (
          <button className="icon-btn" title="选择本作品使用的经验库" onClick={() => setPicker(true)}>
            <ListChecks size={15} />
          </button>
        )}
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
      {(hasMany || searching) && (
        <label className="library-panel-search">
          <Search size={13} />
          <input
            placeholder={`在 ${libraries.length} 个经验库里找经验库或文档`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
          />
          {query && (
            <button className="icon-btn" aria-label="清除搜索" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </label>
      )}
      {searching ? (
        <div className="tree">
          <div className="library-group">
            经验库 <span className="count">{found.length}</span>
          </div>
          {found.map(renderLibrary)}
          {!found.length && <p className="view-hint">没有名称或介绍符合的经验库。</p>}
          <div className="library-group">
            文档 <span className="count">{documents.length}</span>
          </div>
          {documents.map((doc) => (
            <div
              key={doc.path}
              className="library-doc-row"
              title={doc.path}
              onClick={() => openExperience(doc.path, { preview: true })}
              onDoubleClick={() => openExperience(doc.path)}
              onContextMenu={(event) => menuFor(event, { path: doc.path, type: "file" }, 1)}
            >
              <FileText size={14} />
              <span className="ellipsis grow">
                <Marked text={doc.title || doc.path.split("/").pop()!} query={query} />
              </span>
              <span className="faint small-text ellipsis">{titleOf(doc.library)}</span>
            </div>
          ))}
          {!documents.length && <p className="view-hint">没有文件名或标题符合的文档。要按内容找，可以问 AI。</p>}
        </div>
      ) : (
        <>
          <div className="library-group" title={readOnly ? "作品已发布，不能更改关联" : undefined}>
            本作品使用的经验库 <span className="count">{linkedLibraries.length}</span>
            <span className="grow" />
            {!readOnly && libraries.length > 0 && (
              <button className="link-btn" onClick={() => setPicker(true)}>
                选择…
              </button>
            )}
          </div>
          <div className="tree">{linkedLibraries.map(renderLibrary)}</div>
          <section className="view-section">
            {missingNames.map((name) => (
              <p key={name} className="view-hint">
                关联的经验库「{name}」已不存在。
                {!readOnly && (
                  <button
                    className="link-btn"
                    onClick={() =>
                      setLinks(
                        linkedNames.filter((item) => item !== name),
                        "已移除",
                      )
                    }
                  >
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
              <>
                {!readOnly && <LibrarySuggestions libraries={libraries} disabled={busy} onUse={link} />}
                <p className="view-hint">
                  {libraries.length ? (
                    <>
                      还没有选择。AI 制作这个作品前会先阅读选中的经验库（可以多个），并把新的经验整理进去。
                      {!readOnly && (
                        <button className="link-btn" onClick={() => setPicker(true)}>
                          选择经验库…
                        </button>
                      )}
                    </>
                  ) : (
                    "还没有经验库。点上方「新建经验库」，例如“知识类视频”“音乐视频”。"
                  )}
                </p>
              </>
            )}
          </section>
          {others.length > 0 && (
            <>
              <div className="library-group" onClick={() => setOthersOpen(!othersShown)}>
                {othersShown ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {linkedLibraries.length ? "其他经验库" : "全部经验库"} <span className="count">{others.length}</span>
              </div>
              {othersShown && <div className="tree">{others.map(renderLibrary)}</div>}
            </>
          )}
        </>
      )}
      <section className="view-section experience-versions">
        <h3 className="clickable" onClick={() => setShowVersions(!showVersions)}>
          {showVersions ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 版本 {changes > 0 && <span className="badge accent">{changes} 个未保存</span>}
        </h3>
      </section>
      {showVersions && <VersionsPanel source="experience" />}
      {picker && (
        <LibraryPicker
          kind="experiences"
          title="选择本作品使用的经验库"
          libraries={libraries}
          initial={linkedLibraries.map((library) => library.id)}
          confirm="使用选中的经验库"
          hint="AI 制作这个作品前会先阅读选中的经验库，并把新的经验整理进去。"
          onApply={choose}
          onCreate={createNamed}
          onClose={() => setPicker(false)}
        />
      )}
      {menu}
    </div>
  );
}

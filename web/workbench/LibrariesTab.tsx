import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  FolderPlus,
  History,
  Library,
  Link2,
  MoreHorizontal,
  Pencil,
  Puzzle,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Unlink,
  Upload,
  X,
} from "lucide-react";
import { api, del, experiencePath, materialsPath, timeAgo, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePersistent, usePrompt, useToast, type MenuItem } from "../lib/ui";
import type { FileEntry } from "../lib/types";
import { useWorkbench } from "./store";
import {
  Marked,
  NOUN,
  ORDER,
  SORTS,
  SUGGEST,
  libraryFacts,
  libraryMatches,
  looseName,
  type LibraryInfo,
  type LibraryKind,
  type LibrarySort,
  type TrashedLibrary,
} from "../views/libraryShared";
import { MaterialFileGrid, type MaterialFile, type MaterialStatus } from "../views/MaterialFiles";
import { ORGANIZE } from "../views/ExperienceView";

type Filter = "all" | "linked" | "suggested" | "trash";
/** Rows drawn at once; a search narrows the rest down. */
const SHOWN = 200;

/**
 * The material or experience libraries of the work's repository, as a tab: search by name,
 * introduction (and files or documents), sort, see why one suits the work; link and unlink
 * them for the work; look inside one; create, rename, delete them — deleted libraries wait in
 * the recycle bin, from where they come back or go for good.
 */
export function LibrariesTab({ kind }: { kind: LibraryKind }) {
  const { work, reload, readOnly, openExperience, openMaterial, askAi, showVersions, showView } = useWorkbench();
  const noun = NOUN[kind];
  const materials = kind === "materials";
  const base = materials ? materialsPath(work.repo) : experiencePath(work.repo);
  const enc = encodeURIComponent;
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [trash, setTrash] = useState<TrashedLibrary[]>([]);
  const [status, setStatus] = useState<MaterialStatus>({ libraries: [], missing: [], files: [] });
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = usePersistent<LibrarySort>("library-sort", "fit");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [contents, setContents] = useState<Record<string, MaterialFile[] | FileEntry[]>>({});
  const [found, setFound] = useState<{ files?: MaterialFile[]; documents?: { library: string; path: string; title: string }[] } | null>(null);
  const [run, busy] = useAction();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [openMenu, menu] = useContextMenu();

  // What the work links: libraries by id (their branch name), which renaming never changes.
  const linkedNames = useMemo(
    () => (materials ? (work.meta?.materials ?? []) : (work.meta?.experiences ?? [])),
    [materials, work.meta?.materials, work.meta?.experiences],
  );
  const libraryOfName = (name: string) => libraries.find((item) => item.id === name);
  const linkedIds = new Set(linkedNames.map((name) => libraryOfName(name)?.id).filter((id): id is string => Boolean(id)));
  const missing = loaded ? linkedNames.filter((name) => !libraryOfName(name)) : [];
  const uses = new Map(status.files.map((item) => [item.ref, item]));

  const load = () =>
    Promise.all([
      api<LibraryInfo[]>(`${base}/libraries?work=${enc(work.id)}`),
      api<TrashedLibrary[]>(`${base}/trash`),
      materials ? api<MaterialStatus>(`${workPath(work.repo, work.id)}/materials`) : Promise.resolve(null),
    ]).then(([nextLibraries, nextTrash, nextStatus]) => {
      setLibraries(nextLibraries);
      setTrash(nextTrash);
      if (nextStatus) setStatus(nextStatus);
      setLoaded(true);
    }, () => {});
  const loadContents = (id: string) =>
    (materials ? api<MaterialFile[]>(`${base}/libraries/${enc(id)}/files`) : api<FileEntry[]>(`${base}/tree?library=${enc(id)}`)).then(
      (list) => setContents((map) => ({ ...map, [id]: list })),
      () => {},
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, work.id]);
  const openKey = [...open].join("|");
  useEffect(() => {
    for (const id of open) if (libraries.some((library) => library.id === id)) void loadContents(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, libraries]);
  useServerEvent((event) => {
    if (materials && event.type === "materials" && event.repo === work.repo) void load();
    if (materials && (event.type === "work-materials" || event.type === "work-files") && event.work === work.id) void load();
    if (!materials && event.type === "experience-files" && event.repo === work.repo) void load();
    // Skills are listed as experience libraries too (their documents).
    if (!materials && event.type === "skills" && event.repo === work.repo) void load();
    if (event.type === "work-versions" && event.work === `${materials ? "materials" : "experience"}-${work.repo}`) void load();
  });
  // Files or documents of every library matching the search, shortly after typing.
  useEffect(() => {
    if (!query.trim() || filter === "trash") return setFound(null);
    const timer = setTimeout(
      () =>
        void api<unknown[]>(`${base}/find?q=${enc(query.trim())}`).then(
          (list) => setFound(materials ? { files: list as MaterialFile[] } : { documents: list as { library: string; path: string; title: string }[] }),
          () => setFound(null),
        ),
      200,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, base, filter, libraries]);

  const titleOf = (id: string) => libraries.find((item) => item.id === id)?.title ?? id;
  const saveLinks = (names: string[], message: string) =>
    run(async () => {
      await api(workPath(work.repo, work.id), { method: "PATCH", body: { [materials ? "materials" : "experiences"]: names } });
      await reload();
      await load();
    }, message);
  const link = (id: string) => saveLinks([...linkedNames.filter((name) => libraryOfName(name)?.id !== id), id], `已${materials ? "引用" : "关联"}${noun}「${titleOf(id)}」`);
  const unlink = (id: string) =>
    saveLinks(
      linkedNames.filter((name) => libraryOfName(name)?.id !== id),
      materials ? `已取消引用「${titleOf(id)}」（已经用到的文件仍按锁定的版本显示）` : `已取消关联「${titleOf(id)}」`,
    );
  const create = (initial = "") =>
    run(async () => {
      const name = (await prompt(`新${noun}的名称`, initial, materials ? "例如：品牌、音效、通用背景" : "例如：知识类视频、音乐视频"))?.trim();
      if (!name) return;
      const created = await api<{ id: string; title: string }>(`${base}/libraries`, { body: { name } });
      await load();
      setOpen((current) => new Set([...current, created.id]));
      setQuery("");
      setFilter("all");
      if (!readOnly && (await confirm(`${materials ? "在本作品中引用" : "把"}${noun}「${created.title}」${materials ? "？" : "关联到本作品？"}`, { confirm: materials ? "引用" : "关联" })))
        await link(created.id);
      if (!materials) openExperience(`${created.id}/README.md`);
    });
  const rename = (library: LibraryInfo) =>
    run(async () => {
      const name = (await prompt(`重命名${noun}（只改显示的名称，作品按 id「${library.id}」${materials ? "引用" : "关联"}它，不受影响）`, library.title))?.trim();
      if (!name || name === library.title) return;
      await api(`${base}/libraries/${enc(library.id)}/rename`, { body: { name } });
      await load();
      await reload(); // the work's description shows the library's title
    }, `已重命名。${materials ? "引用" : "关联"}它的作品不受影响`);
  const remove = (library: LibraryInfo) =>
    run(async () => {
      const users = library.works ?? 0;
      if (
        !(await confirm(
          `把${noun}「${library.title}」移到回收站？${users ? `有 ${users} 个作品在用它，在恢复之前它们${materials ? "只能用已经锁定的文件版本" : "读不到它"}。` : ""}可以随时从回收站恢复。`,
          { confirm: "移到回收站", danger: true },
        ))
      )
        return;
      await del(`${base}/libraries/${enc(library.id)}`);
      await load();
    }, `已把${noun}「${library.title}」移到回收站`);
  const restore = (item: TrashedLibrary) =>
    run(async () => {
      const result = await api<{ id: string; renamed: boolean }>(`${base}/trash/${enc(item.key)}/restore`, { method: "POST" });
      await load();
      setFilter("all");
      setOpen((current) => new Set([...current, result.id]));
      if (result.renamed) toast(`id「${item.id}」已被另一个${noun}占用，恢复后的 id 是「${result.id}」：按旧 id ${materials ? "引用" : "关联"}它的作品要重新${materials ? "引用" : "关联"}`);
      return result;
    }, `已恢复${noun}「${item.title}」`);
  const purge = (item?: TrashedLibrary) =>
    run(async () => {
      const what = item ? `「${item.title}」` : `回收站里的 ${trash.length} 个${noun}`;
      if (!(await confirm(`彻底删除${what}？它们的分支和全部版本都会删除（GitHub 上的也一起删除），不能找回。${materials ? "还有作品引用的素材库不能彻底删除。" : ""}`, { confirm: "彻底删除", danger: true })))
        return;
      await del(item ? `${base}/trash/${enc(item.key)}` : `${base}/trash`);
      await load();
    });
  const upload = (id: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () =>
      run(async () => {
        for (const file of input.files ?? []) await api(`${base}/libraries/${enc(id)}/upload?path=${enc(file.name)}`, { raw: file });
        setOpen((current) => new Set([...current, id]));
      }, "已添加到素材库（每次添加都会保存为一个版本）");
    input.click();
  };
  const newDocument = (id: string) =>
    run(async () => {
      const name = (await prompt("新文档（可以包含子文件夹）", "新经验.md"))?.trim();
      if (!name) return;
      const file = `${id}/${/\.(md|txt)$/i.test(name) ? name : name + ".md"}`;
      const title = name
        .replace(/\.(md|txt)$/i, "")
        .split("/")
        .pop();
      await api(`${base}/file`, { method: "PUT", body: { path: file, content: `# ${title}\n\n`, expectedHash: null } });
      openExperience(file);
    });

  const libraryMenu = (event: { clientX: number; clientY: number; preventDefault?: () => void }, library: LibraryInfo) => {
    const items: MenuItem[] = [];
    if (!readOnly)
      items.push(
        linkedIds.has(library.id)
          ? { label: materials ? "不再引用" : "不再用于本作品", icon: <Unlink size={14} />, onClick: () => unlink(library.id) }
          : { label: materials ? "在本作品中引用" : "关联到本作品", icon: <Link2 size={14} />, onClick: () => link(library.id) },
      );
    if (materials) items.push({ label: "上传文件", icon: <Upload size={14} />, onClick: () => upload(library.id) });
    else {
      items.push({ label: "新建文档", icon: <FilePlus size={14} />, onClick: () => newDocument(library.id) });
      if (linkedIds.has(library.id)) items.push({ label: "让 AI 整理这个经验库", icon: <Sparkles size={14} />, onClick: () => askAi(ORGANIZE([library.title])) });
    }
    if (library.skill) {
      // A skill's documents: the skill is renamed, deleted and versioned in 技能.
      items.push(
        { label: "打开 SKILL.md", icon: <FileText size={14} />, onClick: () => openExperience(`${library.id}/SKILL.md`) },
        { label: "技能的版本历史", icon: <History size={14} />, onClick: () => showVersions("skills") },
        { label: "在「技能」中管理…", icon: <Puzzle size={14} />, onClick: () => showView("skills") },
      );
      return openMenu(event, items);
    }
    items.push({
      label: "打开 README",
      icon: <FileText size={14} />,
      onClick: () => (materials ? openMaterial(`${library.id}/README.md`) : openExperience(`${library.id}/README.md`)),
    });
    items.push({ label: "重命名", icon: <Pencil size={14} />, onClick: () => rename(library) });
    // 版本与同步 lists the work's own libraries.
    if (linkedIds.has(library.id)) items.push({ label: "版本与同步", icon: <History size={14} />, onClick: () => showVersions(materials ? "materials" : "experience", library.id) });
    items.push("separator", { label: "删除（移到回收站）", icon: <Trash2 size={14} />, danger: true, onClick: () => remove(library) });
    openMenu(event, items);
  };
  const atButton = (event: React.MouseEvent) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    return { clientX: rect.left, clientY: rect.bottom + 2 };
  };

  // The rows: libraries matching the search and filter, the work's own first, in the chosen order.
  const suits = libraries.some((library) => (library.score ?? 0) > 0);
  const order = ORDER[sort === "fit" && !suits ? "used" : sort];
  const rows = libraries
    .filter((library) => libraryMatches(library, query))
    .filter((library) => (filter === "linked" ? linkedIds.has(library.id) : filter === "suggested" ? !linkedIds.has(library.id) && (library.score ?? 0) >= SUGGEST : true))
    .sort((a, b) => Number(linkedIds.has(b.id)) - Number(linkedIds.has(a.id)) || order(a, b));
  const trashRows = trash.filter((item) => !query.trim() || `${item.title} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const suggested = libraries.filter((library) => !linkedIds.has(library.id) && (library.score ?? 0) >= SUGGEST).length;
  const typed = query.trim();
  const canCreate = typed && filter !== "trash" && !libraries.some((library) => [library.id, library.title].some((name) => looseName(name) === looseName(typed)));
  const filters: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "全部", count: libraries.length },
    { id: "linked", label: "本作品", count: linkedIds.size },
    { id: "suggested", label: "推荐", count: suggested },
    { id: "trash", label: "回收站", count: trash.length },
  ];

  return (
    <div className="tool-page library-manager">
      <header className="tab-head">
        {materials ? <Library size={18} /> : <BookOpen size={18} />}
        <h2>{noun}</h2>
        <span className="faint small-text ellipsis">
          作品库 {work.repo === "local" ? "本地" : work.repo} · {libraries.length} 个{noun}
          {materials ? "：同一作品库里所有作品共用的素材和代码" : "：同类作品共用的制作经验，AI 动手前会先读作品关联的经验库"}
        </span>
        <span className="grow" />
        <button className="btn small" onClick={() => create()}>
          <FolderPlus size={13} /> 新建{noun}
        </button>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw size={15} />
        </button>
      </header>
      <div className="tab-bar">
        <label className="library-search">
          <Search size={14} />
          <input
            placeholder={materials ? "搜索素材库的名称、介绍，或所有素材库里的文件" : "搜索经验库的名称、介绍，或所有经验库里的文档"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
              if (event.key === "Enter" && canCreate && !rows.length) void create(typed);
            }}
          />
          {query && (
            <button className="icon-btn" aria-label="清除搜索" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </label>
        <div className="home-chips" role="radiogroup" aria-label="筛选">
          {filters.map((item) => (
            <button key={item.id} role="radio" aria-checked={filter === item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>
              {item.label}
              <span>{item.count}</span>
            </button>
          ))}
        </div>
        {filter !== "trash" && (
          <label className="library-sort" title="排序">
            <ArrowUpDown size={13} />
            <select value={sort} onChange={(event) => setSort(event.target.value as LibrarySort)}>
              {SORTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {busy && <div className="view-progress" />}
      {readOnly && <p className="tab-note">作品已发布，不能更改它{materials ? "引用" : "关联"}的{noun}；{noun}本身可以照常整理。</p>}
      {missing.map((name) => {
        const bin = trash.find((item) => item.id === name);
        return (
          <p key={name} className="tab-note warn">
            本作品{materials ? "引用" : "关联"}的{noun}「{name}」{bin ? "在回收站里" : "已不存在"}。
            {bin ? (
              <button className="link-btn" onClick={() => restore(bin)}>
                <Undo2 size={12} /> 恢复
              </button>
            ) : (
              !readOnly && (
                <button className="link-btn" onClick={() => saveLinks(linkedNames.filter((item) => item !== name), "已移除")}>
                  从本作品中移除
                </button>
              )
            )}
          </p>
        );
      })}
      <div className="tab-body">
        {filter === "trash" ? (
          <>
            {trashRows.length > 0 && (
              <div className="library-trash-head">
                <span className="faint small-text grow">删除的{noun}先放在这里，可以恢复；彻底删除后连同全部版本一起删除，不能找回。</span>
                <button className="btn small danger" disabled={busy} onClick={() => purge()}>
                  <Trash2 size={13} /> 清空回收站
                </button>
              </div>
            )}
            {trashRows.map((item) => (
              <div key={item.key} className="library-card trashed">
                <div className="library-card-main">
                  <div className="library-card-title">
                    <strong className="ellipsis">{item.title}</strong>
                    {item.title !== item.id && <span className="faint small-text">{item.id}</span>}
                  </div>
                  <div className="faint small-text">
                    {libraryFacts(kind, item)}
                    {item.deletedAt ? ` · ${timeAgo(item.deletedAt)}删除` : ""}
                  </div>
                </div>
                <div className="library-card-actions">
                  <button className="btn small" disabled={busy} onClick={() => restore(item)}>
                    <Undo2 size={13} /> 恢复
                  </button>
                  <button className="btn small danger" disabled={busy} onClick={() => purge(item)}>
                    彻底删除
                  </button>
                </div>
              </div>
            ))}
            {!trashRows.length && <p className="tab-empty">回收站是空的。</p>}
          </>
        ) : (
          <>
            {canCreate && (
              <button className="library-create" onClick={() => create(typed)}>
                <FolderPlus size={15} /> 新建{noun}「{typed}」
              </button>
            )}
            {rows.slice(0, SHOWN).map((library) => {
              const isLinked = linkedIds.has(library.id);
              const expanded = open.has(library.id);
              const inside = contents[library.id];
              return (
                <div key={library.id} className={`library-card ${isLinked ? "linked" : ""}`}>
                  <div
                    className="library-card-row"
                    onClick={() =>
                      setOpen((current) => {
                        const next = new Set(current);
                        if (next.has(library.id)) next.delete(library.id);
                        else next.add(library.id);
                        return next;
                      })
                    }
                    onContextMenu={(event) => libraryMenu(event, library)}
                  >
                    <span className="library-card-chevron">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                    <div className="library-card-main">
                      <div className="library-card-title">
                        <strong className="ellipsis">
                          <Marked text={library.title} query={query} />
                        </strong>
                        {library.title !== library.id && <span className="faint small-text ellipsis">{library.id}</span>}
                        {library.skill && (
                          <span className="badge" title="技能里的文档，就是技能的文件：改了就是改技能，每次改动保存为技能的一个版本">
                            <Puzzle size={11} /> 技能
                          </span>
                        )}
                        {isLinked && <span className="badge accent">本作品</span>}
                      </div>
                      {library.about && (
                        <div className="library-option-about">
                          <Marked text={library.about} query={query} />
                        </div>
                      )}
                      {!isLinked && library.why?.length ? (
                        <div className="library-option-why">
                          <Sparkles size={11} /> {library.why.join("；")}
                        </div>
                      ) : null}
                      <div className="faint small-text">
                        {libraryFacts(kind, library)}
                        {library.usedAt ? ` · 最近 ${timeAgo(library.usedAt)}用过` : ""}
                      </div>
                    </div>
                    <div className="library-card-actions" onClick={(event) => event.stopPropagation()}>
                      {!readOnly &&
                        (isLinked ? (
                          <button className="btn small" disabled={busy} onClick={() => unlink(library.id)}>
                            <Unlink size={13} /> {materials ? "不再引用" : "取消关联"}
                          </button>
                        ) : (
                          <button className="btn small primary" disabled={busy} onClick={() => link(library.id)}>
                            <Link2 size={13} /> {materials ? "引用" : "关联"}
                          </button>
                        ))}
                      <button className="icon-btn" aria-label="更多" title="更多操作" onClick={(event) => libraryMenu(atButton(event), library)}>
                        <MoreHorizontal size={16} />
                      </button>
                    </div>
                  </div>
                  {expanded && (
                    <div className="library-card-body">
                      {!inside ? (
                        <div className="tab-empty">读取中…</div>
                      ) : materials ? (
                        (inside as MaterialFile[]).length ? (
                          <MaterialFileGrid files={inside as MaterialFile[]} uses={uses} linked={linkedIds} titleOf={titleOf} />
                        ) : (
                          <div className="tab-empty">
                            还没有文件。
                            <button className="link-btn" onClick={() => upload(library.id)}>
                              <Upload size={12} /> 上传
                            </button>
                          </div>
                        )
                      ) : (
                        <div className="library-docs">
                          {(inside as FileEntry[])
                            .filter((entry) => entry.type === "file")
                            .map((entry) => (
                              <div
                                key={entry.path}
                                className="library-doc-row"
                                title={[entry.path, entry.title, entry.summary].filter(Boolean).join("\n")}
                                onClick={() => openExperience(entry.path)}
                              >
                                <FileText size={14} />
                                <span className="ellipsis grow">{entry.path.slice(library.id.length + 1)}</span>
                                {entry.title && <span className="faint small-text ellipsis">{entry.title}</span>}
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {rows.length > SHOWN && <p className="tab-empty">还有 {rows.length - SHOWN} 个，输入关键词缩小范围。</p>}
            {loaded && !rows.length && !canCreate && (
              <p className="tab-empty">
                {filter === "linked"
                  ? `本作品还没有${materials ? "引用" : "关联"}${noun}。`
                  : filter === "suggested"
                    ? "没有特别适合本作品的。"
                    : libraries.length
                      ? `没有名称或介绍符合的${noun}。`
                      : `还没有${noun}，点右上角「新建${noun}」。`}
              </p>
            )}
            {found?.files && found.files.length > 0 && (
              <section className="tab-section">
                <h3>
                  所有素材库里的文件 <span className="faint">{found.files.length >= 120 ? "120+" : found.files.length}</span>
                </h3>
                <MaterialFileGrid files={found.files} uses={uses} linked={linkedIds} query={query} label={(file) => file.ref} titleOf={titleOf} />
              </section>
            )}
            {found?.documents && found.documents.length > 0 && (
              <section className="tab-section">
                <h3>
                  所有经验库里的文档 <span className="faint">{found.documents.length}</span>
                </h3>
                <div className="library-docs">
                  {found.documents.map((doc) => (
                    <div key={doc.path} className="library-doc-row" title={doc.path} onClick={() => openExperience(doc.path)}>
                      <FileText size={14} />
                      <span className="ellipsis grow">
                        <Marked text={doc.title || doc.path.split("/").pop()!} query={query} />
                      </span>
                      <span className="faint small-text ellipsis">{titleOf(doc.library)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
      {menu}
    </div>
  );
}

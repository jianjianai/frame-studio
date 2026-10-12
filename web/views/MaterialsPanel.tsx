import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Film,
  FolderPlus,
  Link2,
  Lock,
  Music,
  Pencil,
  PlusSquare,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Unlink,
  Upload,
  X,
} from "lucide-react";
import { api, del, formatBytes, formatTime, materialsPath, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt, useToast } from "../lib/ui";
import type { Asset } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { assetDrag } from "../workbench/assetDrag";
import { VersionsPanel } from "./VersionsView";
import { KindIcon, KIND_NAMES, ServerThumb, isDrawn, isVisual } from "./media";
import { LibraryPicker, LibrarySuggestions, Marked, libraryFacts, libraryMatches, type LibraryInfo } from "./LibraryPicker";

interface MaterialFile {
  path: string;
  ref: string;
  url: string;
  kind: string;
  size: number;
  /** The file's current version (a new one gets a new thumbnail). */
  blob: string | null;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  animations?: { name: string; duration: number }[];
  triangles?: number;
  problem?: string;
}
interface Used {
  ref: string;
  url: string;
  used: boolean;
  locked: string | null;
  current: string | null;
  outdated: boolean;
}
interface Status {
  libraries: { id: string; title: string }[];
  missing: string[];
  files: Used[];
}

/** Libraries past this many get a search box, and the ones the work does not use start folded. */
const MANY = 6;

/**
 * The repository's material libraries in the assets view: the ones the work references first
 * (open, with their files: dragged onto the timeline or placed at the playhead, used directly
 * as materials/<library>/<path>), the others folded away; a search finds libraries and files
 * among many, the picker chooses which the work references. Shows the versions the work locked,
 * and the libraries' history.
 */
export function MaterialsPanel({ onPlace }: { onPlace: (asset: Asset, how: "layer" | "audio") => void }) {
  const { work, reload, addToChat, readOnly, openMaterial } = useWorkbench();
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [status, setStatus] = useState<Status>({ libraries: [], missing: [], files: [] });
  const [files, setFiles] = useState<Record<string, MaterialFile[]>>({});
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [othersOpen, setOthersOpen] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<MaterialFile[] | null>(null);
  const [picker, setPicker] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = materialsPath(work.repo);
  const linkedIds = status.libraries.map((item) => item.id);
  const linked = new Set(linkedIds);
  const locks = new Map(status.files.map((item) => [item.ref, item]));
  // Locks of files the work no longer uses go when it saves a version: not worth updating.
  const outdated = status.files.filter((item) => item.outdated && item.used);
  const enc = encodeURIComponent;
  const linkedLibraries = linkedIds.map((id) => libraries.find((item) => item.id === id)).filter((item): item is LibraryInfo => Boolean(item));
  const others = libraries.filter((item) => !linked.has(item.id));
  const titleOf = (id: string) => libraries.find((item) => item.id === id)?.title ?? id;
  // The libraries the work uses start open.
  const isOpen = (id: string) => (open ?? new Set(linkedIds)).has(id);

  const loadFiles = (id: string) =>
    api<MaterialFile[]>(`${base}/libraries/${enc(id)}/files`).then(
      (list) => setFiles((map) => ({ ...map, [id]: list })),
      () => {},
    );
  const load = () =>
    Promise.all([api<LibraryInfo[]>(`${base}/libraries?work=${enc(work.id)}`), api<Status>(`${workPath(work.repo, work.id)}/materials`)]).then(
      ([nextLibraries, nextStatus]) => {
        setLibraries(nextLibraries);
        setStatus(nextStatus);
      },
      () => {},
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, work.id]);
  const openKey = libraries
    .filter((library) => isOpen(library.id))
    .map((library) => library.id)
    .join("|");
  useEffect(() => {
    for (const id of openKey.split("|").filter(Boolean)) void loadFiles(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, libraries]);
  // Files of every library matching the search, shortly after typing.
  useEffect(() => {
    if (!query.trim()) return setFound(null);
    const timer = setTimeout(() => void api<MaterialFile[]>(`${base}/find?q=${enc(query.trim())}`).then(setFound, () => setFound([])), 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, base, libraries]);
  useServerEvent((event) => {
    if (event.type === "materials" && event.repo === work.repo) void load();
    if ((event.type === "work-materials" || event.type === "work-files") && event.work === work.id) void load();
  });

  const flip = (id: string) =>
    setOpen((current) => {
      const next = new Set(current ?? linkedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Errors propagate (the picker stays open on them). */
  const saveLinks = async (names: string[]) => {
    await api(workPath(work.repo, work.id), { method: "PATCH", body: { materials: names } });
    await reload();
    await load();
  };
  const setLinks = (names: string[], message: string) => run(() => saveLinks(names), message);
  const linkOne = (id: string) => setLinks([...new Set([...linkedIds, ...status.missing, id])], `已引用素材库「${titleOf(id)}」`);
  const unlinkOne = (id: string) =>
    setLinks(
      [...linkedIds, ...status.missing].filter((item) => item !== id),
      "已取消引用（已经用到的文件仍按锁定的版本显示）",
    );
  const choose = async (ids: string[]) => {
    await saveLinks([...ids, ...status.missing]);
    const added = ids.filter((id) => !linked.has(id)).length;
    const removed = linkedIds.filter((id) => !ids.includes(id)).length;
    toast(
      [added ? `引用了 ${added} 个素材库` : "", removed ? `取消引用 ${removed} 个（已经用到的文件仍按锁定的版本显示）` : ""].filter(Boolean).join("，") ||
        "已更新",
      "ok",
    );
  };
  const createNamed = async (name: string): Promise<LibraryInfo> => {
    const created = await api<{ id: string; title: string }>(`${base}/libraries`, { body: { name } });
    await load();
    return { ...created, files: 0, works: 0 };
  };
  const createLibrary = () =>
    run(async () => {
      const name = (await prompt("新素材库的名称", "", "例如：品牌、音效、通用背景"))?.trim();
      if (!name) return;
      const created = await createNamed(name);
      setOpen((current) => new Set([...(current ?? linkedIds), created.id]));
      if (!readOnly) await setLinks([...linkedIds, ...status.missing, created.id], `已新建并引用素材库「${created.title}」`);
    });
  const upload = (id: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () =>
      run(async () => {
        for (const file of input.files ?? []) await api(`${base}/libraries/${enc(id)}/upload?path=${enc(file.name)}`, { raw: file });
        setOpen((current) => new Set([...(current ?? linkedIds), id]));
      }, `已添加到素材库（每次添加都会保存为一个版本）`);
    input.click();
  };
  const removeLibrary = (library: LibraryInfo) =>
    run(async () => {
      if (!(await confirm(`删除素材库「${library.title}」？已经用到其中文件的作品仍能使用锁定的版本；也可以从历史恢复。`, { confirm: "删除", danger: true })))
        return;
      await del(`${base}/libraries/${enc(library.id)}`);
    });
  const lock = (refs: string[], update: boolean) =>
    run(() => api(`${workPath(work.repo, work.id)}/materials/lock`, { body: { refs, update } }), update ? "已更新到素材库里的最新版本" : "已锁定");

  const asAsset = (file: MaterialFile): Asset => ({
    path: file.ref,
    url: file.url,
    kind: file.kind,
    mime: "",
    size: file.size,
    width: file.width,
    height: file.height,
    duration: file.duration,
    animations: file.animations,
    fps: file.fps,
    problem: file.problem,
  });
  const fileMenu = (event: React.MouseEvent, library: string, file: MaterialFile) => {
    const used = locks.get(file.ref);
    // Using a file of a library the work does not reference yet references it on the way (server side).
    openMenu(event, [
      ...(!readOnly && isVisual(file.kind)
        ? [{ label: "添加到画面（播放头处）", icon: <PlusSquare size={14} />, onClick: () => onPlace(asAsset(file), "layer") }]
        : []),
      ...(!readOnly && (file.kind === "audio" || file.kind === "video")
        ? [{ label: "放到音轨（播放头处）", icon: <Music size={14} />, onClick: () => onPlace(asAsset(file), "audio") }]
        : []),
      ...(used?.outdated && !readOnly ? [{ label: "更新到最新版本", icon: <RefreshCw size={14} />, onClick: () => lock([file.ref], true) }] : []),
      { label: "打开", icon: <Eye size={14} />, onClick: () => openMaterial(file.ref) },
      { label: "引用到 AI 聊天", icon: <Sparkles size={14} />, onClick: () => addToChat({ type: "asset", url: file.url }) },
      {
        label: file.kind === "code" ? "复制导入语句" : "复制引用地址",
        icon: <Copy size={14} />,
        onClick: () =>
          navigator.clipboard
            .writeText(file.kind === "code" ? `import {  } from "@materials/${file.ref.replace(/\.(m?[jt]sx?)$/, "")}";` : `assetUrl("${file.url}")`)
            .then(() => toast("已复制")),
      },
      "separator",
      {
        label: "重命名 / 移动",
        icon: <Pencil size={14} />,
        onClick: () =>
          run(async () => {
            const to = (await prompt("新的路径（素材库内）", file.path))?.trim();
            if (!to || to === file.path) return;
            await api(`${base}/libraries/${enc(library)}/move`, { body: { from: file.path, to } });
          }, "已移动。用到旧地址的作品仍使用锁定的版本"),
      },
      {
        label: "从素材库删除",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () =>
          run(async () => {
            if (!(await confirm(`从素材库删除 ${file.path}？已经用到它的作品仍能使用锁定的版本。`, { confirm: "删除", danger: true }))) return;
            await del(`${base}/libraries/${enc(library)}/file?path=${enc(file.path)}`);
          }),
      },
    ]);
  };

  const fileCard = (library: string, file: MaterialFile, label = file.path) => {
    const used = locks.get(file.ref);
    const src = `${base}/file?path=${enc(file.ref)}&v=${file.blob ?? ""}`;
    const facts = [
      KIND_NAMES[file.kind],
      formatBytes(file.size),
      file.width ? `${file.width}×${file.height}` : "",
      file.duration ? formatTime(file.duration, false) : "",
      file.triangles ? `${file.triangles.toLocaleString()} 个三角形` : "",
      file.animations?.length ? `动画：${file.animations.map((item) => item.name).join("、")}` : "",
    ].filter(Boolean);
    return (
      <div
        key={file.ref}
        className="asset-card"
        draggable={!readOnly}
        onDragStart={(event) => assetDrag.start(event, asAsset(file))}
        onDragEnd={() => assetDrag.end()}
        onContextMenu={(event) => fileMenu(event, library, file)}
        // Like the work's own assets: a click opens a preview tab, a double-click keeps it open.
        onClick={() => openMaterial(file.ref, { preview: true })}
        onDoubleClick={() => openMaterial(file.ref)}
        title={`${file.url}\n${facts.join(" · ")}${file.problem ? `\n注意：${file.problem}` : ""}${used?.locked ? (used.outdated ? "\n作品锁定的是旧版本，素材库里有新版本" : "\n作品已锁定这个版本") : ""}${readOnly ? "\n单击查看" : linked.has(library) ? "\n单击查看，拖到时间轴使用，右键更多操作" : `\n单击查看；拖到时间轴使用时，作品会引用素材库「${titleOf(library)}」`}`}
      >
        {isDrawn(file.kind) ? (
          <ServerThumb
            src={`${base}/thumb?path=${enc(file.ref)}&v=${file.blob ?? ""}`}
            done={(event) => event.type === "asset-thumb" && event.repo === work.repo && event.ref === file.ref}
            icon={<KindIcon kind={file.kind} />}
            failedTitle="缩略图画不出来，单击打开看原因"
          >
            <FileBadges file={file} used={used} />
          </ServerThumb>
        ) : (
          <div className="asset-thumb">
            {file.kind === "image" ? (
              <img src={src} alt="" loading="lazy" />
            ) : file.kind === "video" ? (
              <video src={src + "#t=0.5"} preload="metadata" muted />
            ) : (
              <KindIcon kind={file.kind} />
            )}
            <FileBadges file={file} used={used} />
          </div>
        )}
        <div className="asset-name ellipsis">
          <Marked text={label} query={query} />
        </div>
        <button className="icon-btn asset-more" onClick={(event) => (event.stopPropagation(), fileMenu(event, library, file))} aria-label="更多">
          ⋯
        </button>
      </div>
    );
  };

  /** A library: its row (upload; reference or not) and, open, its files. */
  const librarySection = (library: LibraryInfo) => (
    <section key={library.id} className="materials-library">
      <div
        className="tree-row library-linked-row"
        title={`${library.title}（${library.id}）${library.about ? `\n${library.about}` : ""}\n${libraryFacts("materials", library)}`}
        onClick={() => flip(library.id)}
        onContextMenu={(event) =>
          openMenu(event, [
            { label: "上传文件到这个素材库", icon: <Upload size={14} />, onClick: () => upload(library.id) },
            ...(readOnly
              ? []
              : [
                  linked.has(library.id)
                    ? { label: "不再引用", icon: <Unlink size={14} />, onClick: () => unlinkOne(library.id) }
                    : { label: "引用到本作品", icon: <Link2 size={14} />, onClick: () => linkOne(library.id) },
                ]),
            "separator",
            { label: "删除素材库", icon: <Trash2 size={14} />, danger: true, onClick: () => removeLibrary(library) },
          ])
        }
      >
        {isOpen(library.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong className="ellipsis grow">
          <Marked text={library.title} query={query} />
        </strong>
        {query && linked.has(library.id) && <span className="badge accent">本作品</span>}
        <span className="faint small-text">{library.files}</span>
        <button
          className="icon-btn tiny"
          title="上传文件到这个素材库"
          onClick={(event) => {
            event.stopPropagation();
            upload(library.id);
          }}
        >
          <Upload size={13} />
        </button>
        {linked.has(library.id) && !readOnly && (
          <button
            className="icon-btn tiny"
            title="不再引用（已经用到的文件仍按锁定的版本显示）"
            aria-label={`不再引用「${library.title}」`}
            onClick={(event) => {
              event.stopPropagation();
              void unlinkOne(library.id);
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {isOpen(library.id) && (
        <div className="asset-grid">
          {(files[library.id] ?? []).map((file) => fileCard(library.id, file))}
          {files[library.id]?.length === 0 && <div className="empty small-text">还没有文件。点右上角的上传按钮添加。</div>}
          {!files[library.id] && <div className="empty small-text">读取中…</div>}
        </div>
      )}
    </section>
  );

  const searching = Boolean(query.trim());
  const matchedLibraries = searching
    ? libraries.filter((library) => libraryMatches(library, query)).sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)))
    : [];
  const othersShown = othersOpen ?? others.length <= MANY;

  return (
    <div className="materials library-panel">
      {busy && <div className="view-progress" />}
      {(libraries.length > MANY || searching) && (
        <label className="library-panel-search">
          <Search size={13} />
          <input
            placeholder={`在 ${libraries.length} 个素材库里找素材库或文件`}
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
        <>
          <div className="library-group">
            素材库 <span className="count">{matchedLibraries.length}</span>
          </div>
          {matchedLibraries.map(librarySection)}
          {!matchedLibraries.length && <p className="view-hint">没有名称或介绍符合的素材库。</p>}
          <div className="library-group">
            文件 <span className="count">{found ? (found.length >= 120 ? "120+" : found.length) : "…"}</span>
          </div>
          {found && found.length > 0 && <div className="asset-grid">{found.map((file) => fileCard(file.ref.split("/")[0], file, file.ref))}</div>}
          {found?.length === 0 && <p className="view-hint">没有路径符合的文件。按内容找角色、效果、音效，用「资源」，或者问 AI。</p>}
        </>
      ) : (
        <>
          <div className="library-group" title={readOnly ? "作品已发布，不能更改引用" : undefined}>
            本作品引用的素材库 <span className="count">{linkedLibraries.length}</span>
            <span className="grow" />
            {!readOnly && libraries.length > 0 && (
              <button className="link-btn" onClick={() => setPicker(true)}>
                选择…
              </button>
            )}
            <button className="icon-btn tiny" title="新建素材库" onClick={createLibrary}>
              <FolderPlus size={14} />
            </button>
          </div>
          {linkedLibraries.map(librarySection)}
          {(status.missing.length > 0 || !linkedLibraries.length || (outdated.length > 0 && !readOnly)) && (
            <section className="view-section">
              {status.missing.map((name) => (
                <p key={name} className="view-hint">
                  引用的素材库「{name}」不存在。
                  {!readOnly && (
                    <button
                      className="link-btn"
                      onClick={() =>
                        setLinks(
                          [...linkedIds, ...status.missing].filter((item) => item !== name),
                          "已移除",
                        )
                      }
                    >
                      移除
                    </button>
                  )}
                </p>
              ))}
              {!linkedLibraries.length && !readOnly && <LibrarySuggestions libraries={libraries} disabled={busy} onUse={linkOne} />}
              {!linkedLibraries.length && (
                <p className="view-hint">
                  {libraries.length ? (
                    <>
                      还没有引用素材库。素材库是同一作品库里所有作品共用的素材，作品引用后直接使用其中的文件，并锁定用到的版本；把其中的文件拖到时间轴也会自动引用。
                      {!readOnly && (
                        <button className="link-btn" onClick={() => setPicker(true)}>
                          选择素材库…
                        </button>
                      )}
                    </>
                  ) : (
                    "素材库是同一作品库里所有作品共用的素材（例如“品牌”“音效”）。作品引用后直接使用其中的文件，并锁定用到的版本。点右边的按钮新建一个。"
                  )}
                </p>
              )}
              {outdated.length > 0 && !readOnly && (
                <div className="materials-outdated">
                  <span className="grow">{outdated.length} 个用到的素材在素材库里有新版本，作品仍使用锁定的版本。</span>
                  <button
                    className="btn small"
                    onClick={() =>
                      lock(
                        outdated.map((item) => item.ref),
                        true,
                      )
                    }
                  >
                    全部更新
                  </button>
                </div>
              )}
            </section>
          )}
          {others.length > 0 && (
            <>
              <div className="library-group" onClick={() => setOthersOpen(!othersShown)}>
                {othersShown ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {linkedLibraries.length ? "其他素材库" : "全部素材库"} <span className="count">{others.length}</span>
              </div>
              {othersShown && others.map(librarySection)}
            </>
          )}
        </>
      )}
      <section className="view-section experience-versions">
        <h3 className="clickable" onClick={() => setShowVersions(!showVersions)}>
          {showVersions ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 素材库的版本与同步
        </h3>
      </section>
      {showVersions && <VersionsPanel source="materials" />}
      {picker && (
        <LibraryPicker
          kind="materials"
          title="选择本作品引用的素材库"
          libraries={libraries}
          initial={linkedIds}
          confirm="引用选中的素材库"
          hint="作品引用素材库后直接使用其中的文件，并锁定用到的版本。取消引用不影响已经用到的文件。"
          onApply={choose}
          onCreate={createNamed}
          onClose={() => setPicker(false)}
        />
      )}
      {menu}
    </div>
  );
}

/** What a library file's card says about it: length, kind, locked version, problems. */
function FileBadges({ file, used }: { file: MaterialFile; used?: Used }) {
  return (
    <>
      {file.duration ? <span className="asset-duration">{formatTime(file.duration, false)}</span> : null}
      {file.kind === "video" && <Film size={12} className="asset-kind" />}
      {file.kind === "model" && <span className="asset-tag">{file.animations?.length ? `3D · 动画 ${file.animations.length}` : "3D"}</span>}
      {file.kind === "lottie" && <span className="asset-tag">Lottie</span>}
      {file.kind === "environment" && <span className="asset-tag">HDR</span>}
      {file.problem && <AlertTriangle size={13} className="asset-problem" />}
      {used?.locked && (
        <span className={`material-lock ${used.outdated ? "outdated" : ""}`} title={used.outdated ? "有新版本" : "已锁定版本"}>
          {used.outdated ? <RefreshCw size={10} /> : <Lock size={10} />}
        </span>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import { AudioLines, ChevronDown, ChevronRight, Copy, Eye, FileCode2, FileQuestion, FileText, Film, FolderPlus, Lock, Music, Pencil, PlusSquare, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import { api, del, formatBytes, formatTime, materialsPath, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt, useToast } from "../lib/ui";
import type { Asset } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { assetDrag } from "../workbench/assetDrag";
import { VersionsPanel } from "./VersionsView";

interface Library {
  id: string;
  title: string;
  files: number;
  size: number;
}
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

/**
 * The repository's material libraries in the assets view: which ones the work references,
 * their files (dragged onto the timeline or placed at the playhead, used directly as
 * materials/<library>/<path>), the versions the work locked, and the libraries' history.
 */
export function MaterialsPanel({ onPlace }: { onPlace: (asset: Asset, how: "layer" | "audio") => void }) {
  const { work, reload, addToChat, readOnly, openMaterial } = useWorkbench();
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [status, setStatus] = useState<Status>({ libraries: [], missing: [], files: [] });
  const [files, setFiles] = useState<Record<string, MaterialFile[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showVersions, setShowVersions] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = materialsPath(work.repo);
  const linked = new Set(status.libraries.map((item) => item.id));
  const locks = new Map(status.files.map((item) => [item.ref, item]));
  // Locks of files the work no longer uses go when it saves a version: not worth updating.
  const outdated = status.files.filter((item) => item.outdated && item.used);
  const enc = encodeURIComponent;

  const loadFiles = (id: string) => api<MaterialFile[]>(`${base}/libraries/${enc(id)}/files`).then((list) => setFiles((map) => ({ ...map, [id]: list })), () => {});
  const load = () =>
    Promise.all([api<Library[]>(`${base}/libraries`), api<Status>(`${workPath(work.repo, work.id)}/materials`)]).then(([nextLibraries, nextStatus]) => {
      setLibraries(nextLibraries);
      setStatus(nextStatus);
      // The libraries the work uses start open.
      setOpen((current) => (current.size ? current : new Set(nextStatus.libraries.map((item) => item.id))));
    }, () => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(() => {
    for (const id of open) void loadFiles(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, libraries]);
  useServerEvent((event) => {
    if (event.type === "materials" && event.repo === work.repo) void load();
    if ((event.type === "work-materials" || event.type === "work-files") && event.work === work.id) void load();
  });

  const setLinks = (names: string[], message: string) =>
    run(async () => {
      await api(workPath(work.repo, work.id), { method: "PATCH", body: { materials: names } });
      await reload();
      await load();
    }, message);
  const toggle = (id: string, on: boolean) =>
    setLinks(on ? [...new Set([...status.libraries.map((item) => item.id), id])] : status.libraries.map((item) => item.id).filter((item) => item !== id), on ? "已引用素材库" : "已取消引用（已经用到的文件仍按锁定的版本显示）");
  const createLibrary = () =>
    run(async () => {
      const name = (await prompt("新素材库的名称", "", "例如：品牌、音效、通用背景"))?.trim();
      if (!name) return;
      const created = await api<{ id: string; title: string }>(`${base}/libraries`, { body: { name } });
      setOpen((current) => new Set([...current, created.id]));
      if (!readOnly) await setLinks([...status.libraries.map((item) => item.id), created.id], `已新建并引用素材库「${created.title}」`);
    });
  const upload = (id: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () =>
      run(async () => {
        for (const file of input.files ?? []) await api(`${base}/libraries/${enc(id)}/upload?path=${enc(file.name)}`, { raw: file });
        setOpen((current) => new Set([...current, id]));
      }, `已添加到素材库（每次添加都会保存为一个版本）`);
    input.click();
  };
  const removeLibrary = (library: Library) =>
    run(async () => {
      if (!(await confirm(`删除素材库「${library.title}」？已经用到其中文件的作品仍能使用锁定的版本；也可以从历史恢复。`, { confirm: "删除", danger: true }))) return;
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
  });
  const fileMenu = (event: React.MouseEvent, library: string, file: MaterialFile) => {
    const used = locks.get(file.ref);
    openMenu(event, [
      ...(linked.has(library) && !readOnly && (file.kind === "image" || file.kind === "video")
        ? [{ label: "添加到画面（播放头处）", icon: <PlusSquare size={14} />, onClick: () => onPlace(asAsset(file), "layer") }]
        : []),
      ...(linked.has(library) && !readOnly && (file.kind === "audio" || file.kind === "video")
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

  return (
    <div className="materials">
      {busy && <div className="view-progress" />}
      <section className="view-section">
        <h3>
          本作品引用的素材库
          <span className="grow" />
          <button className="icon-btn" title="新建素材库" onClick={createLibrary}>
            <FolderPlus size={14} />
          </button>
        </h3>
        {libraries.map((library) => (
          <label key={library.id} className="check-row" title={readOnly ? "作品已发布，不能更改引用" : undefined}>
            <input type="checkbox" checked={linked.has(library.id)} disabled={readOnly || busy} onChange={(event) => toggle(library.id, event.target.checked)} />
            <span className="ellipsis grow">{library.title}</span>
            <span className="faint small-text">
              {library.files} 个 · {formatBytes(library.size)}
            </span>
          </label>
        ))}
        {status.missing.map((name) => (
          <p key={name} className="view-hint">
            引用的素材库「{name}」不存在。
          </p>
        ))}
        {!libraries.length && <p className="view-hint">素材库是同一作品库里所有作品共用的素材（例如“品牌”“音效”）。作品引用后直接使用其中的文件，并锁定用到的版本。</p>}
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
      {libraries.map((library) => (
        <section key={library.id} className="materials-library">
          <div
            className="tree-row"
            onClick={() =>
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(library.id)) next.delete(library.id);
                else next.add(library.id);
                return next;
              })
            }
            onContextMenu={(event) =>
              openMenu(event, [
                { label: "上传文件到这个素材库", icon: <Upload size={14} />, onClick: () => upload(library.id) },
                "separator",
                { label: "删除素材库", icon: <Trash2 size={14} />, danger: true, onClick: () => removeLibrary(library) },
              ])
            }
          >
            {open.has(library.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <strong className="ellipsis grow">{library.title}</strong>
            {linked.has(library.id) && <span className="badge accent">本作品</span>}
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
          </div>
          {open.has(library.id) && (
            <div className="asset-grid">
              {(files[library.id] ?? []).map((file) => {
                const used = locks.get(file.ref);
                const src = `${base}/file?path=${enc(file.ref)}&v=${file.blob ?? ""}`;
                return (
                  <div
                    key={file.ref}
                    className="asset-card"
                    draggable={linked.has(library.id) && !readOnly}
                    onDragStart={(event) => assetDrag.start(event, asAsset(file))}
                    onDragEnd={() => assetDrag.end()}
                    onContextMenu={(event) => fileMenu(event, library.id, file)}
                    // Like the work's own assets: a click opens a preview tab, a double-click keeps it open.
                    onClick={() => openMaterial(file.ref, { preview: true })}
                    onDoubleClick={() => openMaterial(file.ref)}
                    title={`${file.url}\n${formatBytes(file.size)}${file.width ? ` · ${file.width}×${file.height}` : ""}${file.duration ? ` · ${formatTime(file.duration, false)}` : ""}${used?.locked ? (used.outdated ? "\n作品锁定的是旧版本，素材库里有新版本" : "\n作品已锁定这个版本") : ""}${linked.has(library.id) ? "\n单击查看，拖到时间轴使用，右键更多操作" : "\n单击查看；引用这个素材库后才能用在作品里"}`}
                  >
                    <div className="asset-thumb">
                      {file.kind === "image" ? (
                        <img src={src} alt="" loading="lazy" />
                      ) : file.kind === "video" ? (
                        <video src={src + "#t=0.5"} preload="metadata" muted />
                      ) : file.kind === "audio" ? (
                        <AudioLines size={26} />
                      ) : file.kind === "data" ? (
                        <FileText size={26} />
                      ) : file.kind === "code" ? (
                        <FileCode2 size={26} />
                      ) : (
                        <FileQuestion size={26} />
                      )}
                      {file.duration ? <span className="asset-duration">{formatTime(file.duration, false)}</span> : null}
                      {file.kind === "video" && <Film size={12} className="asset-kind" />}
                      {used?.locked && (
                        <span className={`material-lock ${used.outdated ? "outdated" : ""}`} title={used.outdated ? "有新版本" : "已锁定版本"}>
                          {used.outdated ? <RefreshCw size={10} /> : <Lock size={10} />}
                        </span>
                      )}
                    </div>
                    <div className="asset-name ellipsis">{file.path}</div>
                    <button className="icon-btn asset-more" onClick={(event) => (event.stopPropagation(), fileMenu(event, library.id, file))} aria-label="更多">
                      ⋯
                    </button>
                  </div>
                );
              })}
              {files[library.id]?.length === 0 && <div className="empty small-text">还没有文件。点右上角的上传按钮添加。</div>}
            </div>
          )}
        </section>
      ))}
      <section className="view-section experience-versions">
        <h3 className="clickable" onClick={() => setShowVersions(!showVersions)}>
          {showVersions ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 素材库的版本与同步
        </h3>
      </section>
      {showVersions && <VersionsPanel source="materials" />}
      {menu}
    </div>
  );
}

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Library, Settings2, Undo2, Unlink, Upload } from "lucide-react";
import { api, materialsPath, workPath, useServerEvent } from "../lib/api";
import { useAction, useContextMenu } from "../lib/ui";
import { useWorkbench } from "../workbench/store";
import { libraryFacts, type LibraryInfo, type TrashedLibrary } from "./libraryShared";
import { MaterialFileGrid, type MaterialFile, type MaterialStatus } from "./MaterialFiles";
import { SkillFiles } from "./SkillLibraries";

/**
 * The material libraries the work references, each with its files (dragged onto the timeline or
 * placed at the playhead, used as materials/<library>/<path>), and the versions the work locked.
 * Finding, referencing and deleting libraries happens in the 素材库 tab (管理…).
 */
export function MaterialsPanel() {
  const { work, reload, readOnly, openTool } = useWorkbench();
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [status, setStatus] = useState<MaterialStatus>({ libraries: [], missing: [], files: [] });
  const [trash, setTrash] = useState<TrashedLibrary[]>([]);
  const [files, setFiles] = useState<Record<string, MaterialFile[]>>({});
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [run, busy] = useAction();
  const [openMenu, menu] = useContextMenu();
  const base = materialsPath(work.repo);
  const enc = encodeURIComponent;
  const linkedIds = status.libraries.map((item) => item.id);
  const linked = new Set(linkedIds);
  const uses = new Map(status.files.map((item) => [item.ref, item]));
  // Locks of files the work no longer uses go when it saves a version: not worth updating.
  const outdated = status.files.filter((item) => item.outdated && item.used);
  const shown = status.libraries.map((item) => libraries.find((library) => library.id === item.id) ?? { ...item, files: 0 });

  const load = () =>
    Promise.all([api<LibraryInfo[]>(`${base}/libraries`), api<MaterialStatus>(`${workPath(work.repo, work.id)}/materials`), api<TrashedLibrary[]>(`${base}/trash`)]).then(
      ([nextLibraries, nextStatus, nextTrash]) => {
        setLibraries(nextLibraries);
        setStatus(nextStatus);
        setTrash(nextTrash);
        setLoaded(true);
      },
      () => {},
    );
  const loadFiles = (id: string) => api<MaterialFile[]>(`${base}/libraries/${enc(id)}/files`).then((list) => setFiles((map) => ({ ...map, [id]: list })), () => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, work.id]);
  const openKey = linkedIds.filter((id) => !folded.has(id)).join("|");
  useEffect(() => {
    for (const id of openKey.split("|").filter(Boolean)) void loadFiles(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, libraries]);
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
  const upload = (id: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () =>
      run(async () => {
        for (const file of input.files ?? []) await api(`${base}/libraries/${enc(id)}/upload?path=${enc(file.name)}`, { raw: file });
        setFolded((current) => new Set([...current].filter((item) => item !== id)));
      }, `已添加到素材库（在「版本与同步」中保存为版本）`);
    input.click();
  };
  const restore = (item: TrashedLibrary) =>
    run(async () => {
      await api(`${base}/trash/${enc(item.key)}/restore`, { method: "POST" });
      await load();
    }, `已恢复素材库「${item.title}」`);
  const lockAll = () =>
    run(
      () =>
        api(`${workPath(work.repo, work.id)}/materials/lock`, {
          body: { refs: outdated.map((item) => item.ref), update: true },
        }),
      "已更新到素材库里的最新版本",
    );

  return (
    <div className="materials library-panel">
      {busy && <div className="view-progress" />}
      <div className="library-group">
        本作品引用的素材库 <span className="count">{shown.length}</span>
        <span className="grow" />
        <button className="link-btn" title="查找、引用、新建或删除素材库" onClick={() => openTool("libraries:materials")}>
          <Settings2 size={13} /> 管理…
        </button>
      </div>
      {shown.map((library) => {
        const open = !folded.has(library.id);
        return (
          <section key={library.id} className="materials-library">
            <div
              className="tree-row"
              title={`${library.title}（${library.id}）${library.about ? `\n${library.about}` : ""}\n${libraryFacts("materials", library)}`}
              onClick={() =>
                setFolded((current) => {
                  const next = new Set(current);
                  if (next.has(library.id)) next.delete(library.id);
                  else next.add(library.id);
                  return next;
                })
              }
              onContextMenu={(event) =>
                openMenu(event, [
                  { label: "上传文件到这个素材库", icon: <Upload size={14} />, onClick: () => upload(library.id) },
                  { label: "管理素材库…", icon: <Library size={14} />, onClick: () => openTool("libraries:materials") },
                  ...(readOnly
                    ? []
                    : ([
                        "separator",
                        {
                          label: "不再引用",
                          icon: <Unlink size={14} />,
                          onClick: () =>
                            setLinks(
                              [...linkedIds, ...status.missing].filter((item) => item !== library.id),
                              "已取消引用（已经用到的文件仍按锁定的版本显示）",
                            ),
                        },
                      ] as const)),
                ])
              }
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <strong className="ellipsis grow">{library.title}</strong>
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
            </div>
            {open &&
              (files[library.id] ? (
                files[library.id].length ? (
                  <MaterialFileGrid files={files[library.id]} uses={uses} linked={linked} />
                ) : (
                  <div className="empty small-text">还没有文件。点标题右边的上传按钮添加。</div>
                )
              ) : (
                <div className="empty small-text">读取中…</div>
              ))}
          </section>
        );
      })}
      <SkillFiles />
      {loaded && (status.missing.length > 0 || !shown.length || (outdated.length > 0 && !readOnly)) && (
        <section className="view-section">
          {status.missing.map((name) => {
            const bin = trash.find((item) => item.id === name);
            return (
              <p key={name} className="view-hint">
                引用的素材库「{name}」{bin ? "在回收站里。" : "不存在。"}
                {bin && (
                  <button className="link-btn" onClick={() => restore(bin)}>
                    <Undo2 size={12} /> 恢复
                  </button>
                )}
                {!bin && !readOnly && (
                  <button className="link-btn" onClick={() => setLinks([...linkedIds, ...status.missing].filter((item) => item !== name), "已移除")}>
                    移除
                  </button>
                )}
              </p>
            );
          })}
          {!shown.length && (
            <p className="view-hint">
              还没有引用素材库。素材库是同一作品库里所有作品共用的素材，作品引用后直接使用其中的文件，并锁定用到的版本。
              <button className="link-btn" onClick={() => openTool("libraries:materials")}>
                {readOnly ? "查看素材库…" : "引用素材库…"}
              </button>
            </p>
          )}
          {outdated.length > 0 && !readOnly && (
            <div className="materials-outdated">
              <span className="grow">{outdated.length} 个用到的素材在素材库里有新版本，作品仍使用锁定的版本。</span>
              <button className="btn small" onClick={lockAll}>
                全部更新
              </button>
            </div>
          )}
        </section>
      )}
      {menu}
    </div>
  );
}

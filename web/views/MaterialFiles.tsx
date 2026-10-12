import { AlertTriangle, Copy, Eye, Film, Lock, Music, Pencil, PlusSquare, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { api, del, formatBytes, formatTime, materialsPath, workPath } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt, useToast } from "../lib/ui";
import type { Asset } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { assetDrag } from "../workbench/assetDrag";
import { KindIcon, KIND_NAMES, ServerThumb, isDrawn, isVisual } from "./media";
import { usePlacement } from "./placement";
import { Marked } from "./libraryShared";

/** A file of a material library as the libraries API lists it. */
export interface MaterialFile {
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
/** How the work uses a library file: the version it locked, and whether the library has a newer one. */
export interface MaterialUse {
  ref: string;
  url: string;
  used: boolean;
  locked: string | null;
  current: string | null;
  outdated: boolean;
}
/** The work's material libraries and the library files it uses. */
export interface MaterialStatus {
  libraries: { id: string; title: string }[];
  missing: string[];
  files: MaterialUse[];
}

export const asAsset = (file: MaterialFile): Asset => ({
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

/**
 * Library files as cards: a click opens a preview tab (a double-click keeps it), a drag puts the
 * file on the timeline, the menu (right click, long press, ⋯) places it at the playhead, updates
 * the work's locked version, copies its address, moves or deletes it in the library.
 */
export function MaterialFileGrid({
  files,
  uses,
  linked,
  query = "",
  label = (file) => file.path,
  titleOf = (id) => id,
}: {
  files: MaterialFile[];
  /** The work's uses of library files, by ref (locked version, newer one in the library). */
  uses: Map<string, MaterialUse>;
  /** Libraries the work references. */
  linked: Set<string>;
  query?: string;
  label?: (file: MaterialFile) => string;
  titleOf?: (id: string) => string;
}) {
  const { work, readOnly, openMaterial, addToChat } = useWorkbench();
  const { place } = usePlacement();
  const [run] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = materialsPath(work.repo);
  const enc = encodeURIComponent;
  const lock = (refs: string[]) =>
    run(() => api(`${workPath(work.repo, work.id)}/materials/lock`, { body: { refs, update: true } }), "已更新到素材库里的最新版本");

  const fileMenu = (event: { clientX: number; clientY: number; preventDefault?: () => void }, file: MaterialFile) => {
    const library = file.ref.split("/")[0];
    const used = uses.get(file.ref);
    openMenu(event, [
      ...(!readOnly && isVisual(file.kind) ? [{ label: "添加到画面（播放头处）", icon: <PlusSquare size={14} />, onClick: () => place(asAsset(file), "layer") }] : []),
      ...(!readOnly && (file.kind === "audio" || file.kind === "video")
        ? [{ label: "放到音轨（播放头处）", icon: <Music size={14} />, onClick: () => place(asAsset(file), "audio") }]
        : []),
      ...(used?.outdated && !readOnly ? [{ label: "更新到最新版本", icon: <RefreshCw size={14} />, onClick: () => lock([file.ref]) }] : []),
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
    <div className="asset-grid">
      {files.map((file) => {
        const library = file.ref.split("/")[0];
        const used = uses.get(file.ref);
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
            onContextMenu={(event) => fileMenu(event, file)}
            onClick={() => openMaterial(file.ref, { preview: true })}
            onDoubleClick={() => openMaterial(file.ref)}
            title={`${file.url}\n${facts.join(" · ")}${file.problem ? `\n注意：${file.problem}` : ""}${used?.locked ? (used.outdated ? "\n作品锁定的是旧版本，素材库里有新版本" : "\n作品已锁定这个版本") : ""}${readOnly ? "\n单击查看" : linked.has(library) ? "\n单击查看，拖到时间轴使用，右键或长按更多操作" : `\n单击查看；用到作品里时，作品会引用素材库「${titleOf(library)}」`}`}
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
              <Marked text={label(file)} query={query} />
            </div>
            <button
              className="icon-btn asset-more"
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                fileMenu({ clientX: rect.left, clientY: rect.bottom + 2 }, file);
              }}
              aria-label="更多"
            >
              ⋯
            </button>
          </div>
        );
      })}
      {menu}
    </div>
  );
}

/** What a library file's card says about it: length, kind, locked version, problems. */
function FileBadges({ file, used }: { file: MaterialFile; used?: MaterialUse }) {
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

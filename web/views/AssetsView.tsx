import { useEffect, useState } from "react";
import {
  Upload,
  Link2,
  RefreshCw,
  Sparkles,
  Trash2,
  Copy,
  Film,
  Library,
  PlusSquare,
  Music,
  Eye,
  AlertTriangle,
  Shapes,
} from "lucide-react";
import { api, del, formatBytes, formatTime, materialsPath, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, useToast, Dialog } from "../lib/ui";
import type { Asset } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { assetDrag } from "../workbench/assetDrag";
import { ViewHeader } from "./ViewHeader";
import { uploadBlobs, uploadFiles } from "./upload";
import { MaterialsPanel } from "./MaterialsPanel";
import { KindIcon, KIND_NAMES, ServerThumb, isDrawn, isVisual } from "./media";
import { LibraryPicker } from "./LibraryPicker";
import type { LibraryInfo } from "./libraryShared";
import { usePlacement } from "./placement";

export function AssetsView() {
  const { work, addToChat, openFile, openTool, readOnly } = useWorkbench();
  const toast = useToast();
  const { addLayer, placeAudio } = usePlacement();
  const [tab, setTab] = useState<"work" | "library">("work");
  // A published work's own files are view-only; the shared materials library is not part of it.
  const locked = readOnly && tab === "work";
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dragging, setDragging] = useState(false);
  const [urlDialog, setUrlDialog] = useState(false);
  // A file of the work on its way into a material library: the libraries to pick from.
  const [sharing, setSharing] = useState<{ asset: Asset; libraries: LibraryInfo[] } | null>(null);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const [openMenu, menu] = useContextMenu();
  const base = workPath(work.repo, work.id);
  const load = () => api<Asset[]>(`${base}/assets`).then(setAssets, () => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useServerEvent((event) => {
    if ((event.type === "assets" || event.type === "work-files") && event.work === work.id) void load();
  });

  const fileUrl = (asset: Asset) => `${work.preview.assetBase}${asset.url}`;
  /** Share one of the work's files with other works: copy it into a material library (picked, or made there). */
  const toLibrary = (asset: Asset) =>
    run(async () => setSharing({ asset, libraries: await api<LibraryInfo[]>(`${materialsPath(work.repo)}/libraries?work=${encodeURIComponent(work.id)}`) }));
  const share = async (asset: Asset, id: string) => {
    const saved = await api<{ ref: string }>(`${materialsPath(work.repo)}/libraries/${encodeURIComponent(id)}/import`, { body: { work: work.id, path: asset.path } });
    toast(`已存入素材库：materials/${saved.ref}`, "ok");
  };
  const remove = async (asset: Asset) => {
    if (await confirm(`删除素材 ${asset.path}？如果代码还在引用它，预览会报错。`, { confirm: "删除", danger: true }))
      await run(() => del(`${base}/file?path=${encodeURIComponent(asset.path)}`).then(load));
  };
  const assetMenu = (event: React.MouseEvent, asset: Asset) =>
    openMenu(event, readOnly ? [
      { label: "打开", icon: <Eye size={14} />, onClick: () => openFile(asset.path) },
      { label: "复制引用地址", icon: <Copy size={14} />, onClick: () => navigator.clipboard.writeText(`assetUrl("${asset.url}")`).then(() => toast("已复制")) },
      { label: "存入素材库", icon: <Library size={14} />, onClick: () => toLibrary(asset) },
    ] : [
      ...(isVisual(asset.kind) ? [{ label: "添加到画面（播放头处）", icon: <PlusSquare size={14} />, onClick: () => addLayer(asset) }] : []),
      ...(asset.kind === "audio" || asset.kind === "video"
        ? [{ label: "放到音轨（播放头处）", icon: <Music size={14} />, onClick: () => placeAudio(asset) }]
        : []),
      { label: "打开", icon: <Eye size={14} />, onClick: () => openFile(asset.path) },
      { label: "引用到 AI 聊天", icon: <Sparkles size={14} />, onClick: () => addToChat({ type: "asset", url: asset.url, path: asset.path }) },
      { label: "复制引用地址", icon: <Copy size={14} />, onClick: () => navigator.clipboard.writeText(`assetUrl("${asset.url}")`).then(() => toast("已复制")) },
      { label: "存入素材库", icon: <Library size={14} />, onClick: () => toLibrary(asset) },
      "separator",
      { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => remove(asset) },
    ]);

  const drop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    // Material libraries take files through their own upload buttons (which library is explicit).
    if (!files.length || locked || tab !== "work") return;
    await run(() => uploadBlobs(work, files, "public"), `已上传 ${files.length} 个文件`);
  };

  return (
    <div
      className={`view ${dragging ? "drop-active" : ""}`}
      onDragOver={(event) => !locked && tab === "work" && [...event.dataTransfer.types].includes("Files") && (event.preventDefault(), setDragging(true))}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <ViewHeader title="素材">
        {!locked && tab === "work" && (
          <button className="icon-btn" title="上传文件" onClick={() => run(() => uploadFiles(work, "public").then(load))}>
            <Upload size={15} />
          </button>
        )}
        {tab === "work" && !readOnly && (
          <button className="icon-btn" title="从网址导入" onClick={() => setUrlDialog(true)}>
            <Link2 size={15} />
          </button>
        )}
        <button className="icon-btn" title="资源：素材库里声明的角色、场景、效果、音效等（在选项卡中打开）" onClick={() => openTool("resources")}>
          <Shapes size={15} />
        </button>
        <button className="icon-btn" title="刷新" onClick={() => load()}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      <div className="view-tabs">
        <button className={tab === "work" ? "active" : ""} onClick={() => setTab("work")}>
          本作品 <span className="faint">{assets.length}</span>
        </button>
        <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>
          素材库 <span className="faint">{work.meta?.materials?.length || ""}</span>
        </button>
      </div>
      {busy && <div className="view-progress" />}
      {tab === "work" ? (
        <div className="asset-grid">
          {assets.map((asset) => (
            <div
              key={asset.path}
              className="asset-card"
              draggable
              onDragStart={(event) => assetDrag.start(event, asset)}
              onDragEnd={() => assetDrag.end()}
              onContextMenu={(event) => assetMenu(event, asset)}
              // Like VS Code: a click opens a preview tab, a double-click keeps it open.
              onClick={() => openFile(asset.path, { preview: true })}
              onDoubleClick={() => openFile(asset.path)}
              title={`${asset.path}\n${[KIND_NAMES[asset.kind], formatBytes(asset.size), asset.width ? `${asset.width}×${asset.height}` : "", asset.duration ? formatTime(asset.duration, false) : "", asset.animations?.length ? `动画：${asset.animations.map((item) => item.name).join("、")}` : ""].filter(Boolean).join(" · ")}${asset.problem ? `\n注意：${asset.problem}` : ""}\n单击查看，拖到时间轴使用，右键或长按更多操作`}
            >
              {isDrawn(asset.kind) ? (
                <ServerThumb
                  src={`${base}/assets/thumb?path=${encodeURIComponent(asset.path)}&v=${asset.version ?? ""}`}
                  done={(event) => event.type === "asset-thumb" && event.work === work.id && event.path === asset.path}
                  icon={<KindIcon kind={asset.kind} />}
                  failedTitle="缩略图画不出来，单击打开看原因"
                >
                  <AssetBadges asset={asset} />
                </ServerThumb>
              ) : (
                <div className="asset-thumb">
                  {asset.kind === "image" ? (
                    <img src={fileUrl(asset)} alt="" loading="lazy" />
                  ) : asset.kind === "video" ? (
                    <video src={fileUrl(asset) + "#t=0.5"} preload="metadata" muted />
                  ) : (
                    <KindIcon kind={asset.kind} />
                  )}
                  <AssetBadges asset={asset} />
                </div>
              )}
              <div className="asset-name ellipsis">{asset.path.replace(/^public\//, "")}</div>
              <button className="icon-btn asset-more" onClick={(event) => (event.stopPropagation(), assetMenu(event, asset))} aria-label="更多">
                ⋯
              </button>
            </div>
          ))}
          {!assets.length && <div className="empty">把图片、视频、音频、三维模型、Lottie 拖到这里，或点上方按钮上传。</div>}
        </div>
      ) : (
        <MaterialsPanel />
      )}
      {sharing && (
        <LibraryPicker
          kind="materials"
          title={`把 ${sharing.asset.path.split("/").pop()} 存入素材库`}
          libraries={sharing.libraries}
          pinned={work.meta?.materials ?? []}
          hint="存入后同一作品库的其他作品也能使用它（复制一份，作品里的这个文件不变）。"
          onApply={([id]) => share(sharing.asset, id)}
          onCreate={async (name) => ({ ...(await api<{ id: string; title: string }>(`${materialsPath(work.repo)}/libraries`, { body: { name } })), files: 0 })}
          onClose={() => setSharing(null)}
        />
      )}
      {urlDialog && (
        <UrlDialog
          onClose={() => setUrlDialog(false)}
          onImport={(url, name) => run(() => api(`${base}/assets/import`, { body: { url, name } }).then(load), "已导入")}
        />
      )}
      {menu}
    </div>
  );
}

/** What an asset's card says about it: length, kind, problems. */
function AssetBadges({ asset }: { asset: Asset }) {
  return (
    <>
      {asset.duration ? <span className="asset-duration">{formatTime(asset.duration, false)}</span> : null}
      {asset.kind === "video" && <Film size={12} className="asset-kind" />}
      {asset.kind === "model" && <span className="asset-tag">{asset.animations?.length ? `3D · 动画 ${asset.animations.length}` : "3D"}</span>}
      {asset.kind === "lottie" && <span className="asset-tag">Lottie</span>}
      {asset.kind === "environment" && <span className="asset-tag">HDR</span>}
      {asset.problem && <AlertTriangle size={13} className="asset-problem" />}
    </>
  );
}

function UrlDialog({ onClose, onImport }: { onClose: () => void; onImport: (url: string, name: string) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  return (
    <Dialog
      title="从网址导入素材"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!/^https?:\/\//.test(url)}
            onClick={() => {
              onImport(url, name);
              onClose();
            }}
          >
            导入
          </button>
        </>
      }
    >
      <label className="field">
        <span>文件网址</span>
        <input className="input" autoFocus placeholder="https://…/image.png" value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label className="field">
        <span>保存为（可选）</span>
        <input className="input" placeholder="自动使用网址中的文件名" value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <p className="muted small-text">请确认你有权使用这个素材。</p>
    </Dialog>
  );
}

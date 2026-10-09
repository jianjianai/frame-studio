import { useEffect, useState } from "react";
import {
  Upload,
  Link2,
  RefreshCw,
  Sparkles,
  Trash2,
  Copy,
  Film,
  AudioLines,
  Library,
  PlusSquare,
  Music,
  FileQuestion,
  Eye,
} from "lucide-react";
import { api, del, formatBytes, formatTime, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt, useToast, Dialog } from "../lib/ui";
import type { Asset, ResourceItem } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { assetDrag } from "../workbench/assetDrag";
import { ViewHeader } from "./ViewHeader";
import { uploadBlobs, uploadFiles } from "./upload";
import { MaterialsPanel } from "./MaterialsPanel";
import { ResourcesPanel } from "./ResourcesPanel";

export function AssetsView() {
  const { work, stage, addToChat, reload, openFile, readOnly } = useWorkbench();
  const toast = useToast();
  const [tab, setTab] = useState<"work" | "library" | "resources">("work");
  // A published work's own files are view-only; the shared materials library is not part of it.
  const locked = readOnly && tab === "work";
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dragging, setDragging] = useState(false);
  const [urlDialog, setUrlDialog] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
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
  const usesLayers = Boolean(work.meta?.visual);
  const addLayer = (asset: Asset) =>
    run(async () => {
      if (!usesLayers) throw new Error("这个作品的画面完全由代码绘制，没有图层文档。可以把素材引用给 AI，让它接入。");
      const start = stage.playback.get().time;
      const remaining = (work.meta?.duration ?? 10) - start;
      const length = Math.min(remaining, asset.kind === "video" && asset.duration ? asset.duration : 5);
      const id =
        asset.path
          .split("/")
          .pop()!
          .replace(/\.[^.]+$/, "")
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .replace(/^[^a-zA-Z]/, "m") +
        "_" +
        Math.random().toString(36).slice(2, 6);
      await api(`${base}/layers`, {
        body: {
          operations: [
            {
              op: "add",
              clip: {
                id,
                name: asset.path.split("/").pop(),
                source: { kind: asset.kind === "video" ? "video" : "image", src: asset.url },
                start,
                duration: Math.max(0.1, length),
                fit: "contain",
                ...(asset.kind === "video" ? { audio: { enabled: true } } : {}),
              },
            },
          ],
        },
      });
      await reload();
    }, "已添加到画面（时间轴最上层）");
  const placeAudio = (asset: Asset) =>
    run(async () => {
      await api(`${base}/audio/place`, {
        body: { src: asset.url, start: stage.playback.get().time, duration: asset.duration, track: "音效", name: asset.path.split("/").pop() },
      });
      await reload();
    }, "已放到「音效」音轨");
  const placeSound = (item: ResourceItem) =>
    run(async () => {
      await api(`${base}/audio/place`, { body: { sound: item.id, start: stage.playback.get().time, track: "音效", name: item.title } });
      await reload();
    }, `已把「${item.title}」放到「音效」音轨`);
  /** Share one of the work's files with other works: copy it into a material library. */
  const toLibrary = (asset: Asset) =>
    run(async () => {
      const libraries = await api<{ id: string }[]>(`/api/repos/${encodeURIComponent(work.repo)}/materials/libraries`);
      const name = (
        await prompt("存入哪个素材库（名称）", work.meta?.materials?.[0] ?? libraries[0]?.id ?? "", libraries.map((item) => item.id).join("、") || "先在「素材库」中新建一个")
      )?.trim();
      if (!name) return;
      await api(`/api/repos/${encodeURIComponent(work.repo)}/materials/libraries/${encodeURIComponent(name)}/import`, { body: { work: work.id, path: asset.path } });
      toast(`已存入素材库「${name}」`, "ok");
    });
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
      ...(asset.kind === "image" || asset.kind === "video"
        ? [{ label: "添加到画面（播放头处）", icon: <PlusSquare size={14} />, onClick: () => addLayer(asset) }]
        : []),
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
        <button className={tab === "resources" ? "active" : ""} onClick={() => setTab("resources")} title="素材库代码里声明的角色、场景、效果、音效等，可以预览和复用">
          资源
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
              title={`${asset.path}\n${formatBytes(asset.size)}${asset.width ? ` · ${asset.width}×${asset.height}` : ""}${asset.duration ? ` · ${formatTime(asset.duration, false)}` : ""}\n单击查看，拖到时间轴使用，右键更多操作`}
            >
              <div className="asset-thumb">
                {asset.kind === "image" ? (
                  <img src={fileUrl(asset)} alt="" loading="lazy" />
                ) : asset.kind === "video" ? (
                  <video src={fileUrl(asset) + "#t=0.5"} preload="metadata" muted />
                ) : asset.kind === "audio" ? (
                  <AudioLines size={26} />
                ) : (
                  <FileQuestion size={26} />
                )}
                {asset.duration ? <span className="asset-duration">{formatTime(asset.duration, false)}</span> : null}
                {asset.kind === "video" && <Film size={12} className="asset-kind" />}
              </div>
              <div className="asset-name ellipsis">{asset.path.replace(/^public\//, "")}</div>
              <button className="icon-btn asset-more" onClick={(event) => (event.stopPropagation(), assetMenu(event, asset))} aria-label="更多">
                ⋯
              </button>
            </div>
          ))}
          {!assets.length && <div className="empty">把图片、视频、音频拖到这里，或点上方按钮上传。</div>}
        </div>
      ) : tab === "library" ? (
        <MaterialsPanel onPlace={(asset, how) => (how === "layer" ? addLayer(asset) : placeAudio(asset))} />
      ) : (
        <ResourcesPanel onPlaceSound={placeSound} />
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

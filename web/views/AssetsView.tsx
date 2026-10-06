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
  ArrowDownToLine,
  FileQuestion,
  Eye,
} from "lucide-react";
import { api, del, formatBytes, formatTime, workPath, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, useToast, Dialog } from "../lib/ui";
import type { Asset } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { assetDrag } from "../workbench/assetDrag";
import { ViewHeader } from "./ViewHeader";
import { uploadBlobs, uploadFiles } from "./upload";

interface LibraryItem {
  id: string;
  name: string;
  mime: string;
  size: number;
  license: string;
  tags: string;
}

export function AssetsView() {
  const { work, stage, addToChat, reload, openFile, readOnly } = useWorkbench();
  const toast = useToast();
  const [tab, setTab] = useState<"work" | "library">("work");
  // A published work's own files are view-only; the shared materials library is not part of it.
  const locked = readOnly && tab === "work";
  const [assets, setAssets] = useState<Asset[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [urlDialog, setUrlDialog] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const [openMenu, menu] = useContextMenu();
  const base = workPath(work.repo, work.id);
  const load = () => api<Asset[]>(`${base}/assets`).then(setAssets, () => {});
  const loadLibrary = () => api<LibraryItem[]>(`/api/repos/${work.repo}/library`).then(setLibrary, () => {});
  useEffect(() => {
    void load();
    void loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useServerEvent((event) => {
    if ((event.type === "assets" || event.type === "work-files") && event.work === work.id) void load();
    if (event.type === "library" && event.repo === work.repo) void loadLibrary();
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
  const toLibrary = (asset: Asset) =>
    run(() => api(`/api/repos/${work.repo}/library/from-work`, { body: { work: work.id, path: asset.path } }), "已存入作品库的素材库");
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
    if (!files.length || locked) return;
    await run(async () => {
      if (tab === "library") for (const file of files) await api(`/api/repos/${work.repo}/library?name=${encodeURIComponent(file.name)}`, { raw: file });
      else await uploadBlobs(work, files, "public");
    }, `已上传 ${files.length} 个文件`);
  };

  return (
    <div
      className={`view ${dragging ? "drop-active" : ""}`}
      onDragOver={(event) => !locked && (event.preventDefault(), setDragging(true))}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <ViewHeader title="素材">
        {!locked && (
          <button
            className="icon-btn"
            title="上传文件"
            onClick={() => run(() => (tab === "work" ? uploadFiles(work, "public").then(load) : uploadToLibrary(work.repo).then(loadLibrary)))}
          >
            <Upload size={15} />
          </button>
        )}
        {tab === "work" && !readOnly && (
          <button className="icon-btn" title="从网址导入" onClick={() => setUrlDialog(true)}>
            <Link2 size={15} />
          </button>
        )}
        <button className="icon-btn" title="刷新" onClick={() => (tab === "work" ? load() : loadLibrary())}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      <div className="view-tabs">
        <button className={tab === "work" ? "active" : ""} onClick={() => setTab("work")}>
          本作品 <span className="faint">{assets.length}</span>
        </button>
        <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>
          素材库 <span className="faint">{library.length}</span>
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
      ) : (
        <div className="library-list">
          {library.map((item) => (
            <div key={item.id} className="library-row">
              <span className="ellipsis grow" title={`${item.name}\n${item.license || ""}`}>
                {item.name}
              </span>
              <span className="faint small-text">{formatBytes(item.size)}</span>
              <button
                className="icon-btn"
                disabled={readOnly}
                title={readOnly ? "作品已发布，不能再添加素材" : "复制到本作品"}
                onClick={() => run(() => api(`${base}/assets/import`, { body: { libraryId: item.id } }).then(load), "已复制到本作品 public/library/")}
              >
                <ArrowDownToLine size={14} />
              </button>
              <button
                className="icon-btn"
                title="从素材库移除"
                onClick={async () =>
                  (await confirm(`从素材库移除 ${item.name}？已复制到作品里的文件不受影响。`, { danger: true, confirm: "移除" })) &&
                  run(() => del(`/api/repos/${work.repo}/library/${item.id}`))
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!library.length && <div className="empty">素材库在同一作品库的所有作品间共享，并随 GitHub 同步。把文件拖到这里添加。</div>}
        </div>
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

function uploadToLibrary(repo: string) {
  return new Promise<void>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      try {
        for (const file of input.files ?? []) await api(`/api/repos/${repo}/library?name=${encodeURIComponent(file.name)}`, { raw: file });
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
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

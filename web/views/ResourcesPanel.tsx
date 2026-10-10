import { useEffect, useMemo, useState } from "react";
import { AudioLines, ChevronDown, ChevronRight, Copy, Eye, FileCode2, Music, Search, Shapes, Sparkles } from "lucide-react";
import { api, formatTime, workPath, useServerEvent } from "../lib/api";
import { useAction, useContextMenu, useToast } from "../lib/ui";
import type { Asset, ResourceItem } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { assetDrag } from "../workbench/assetDrag";

interface Listing {
  libraries: { id: string; title: string; linked: boolean }[];
  items: ResourceItem[];
  errors: { ref: string; errors: string[] }[];
}

const KINDS: [string, string][] = [
  ["", "全部"],
  ["character", "角色"],
  ["set", "场景"],
  ["prop", "物品"],
  ["ui", "界面"],
  ["effect", "效果"],
  ["transition", "转场"],
  ["text", "文字"],
  ["sound", "音效"],
];

/** Sound lengths: "0.4s" under a minute, else m:ss. */
export const seconds = (value: number) => (value < 60 ? `${+value.toFixed(2)}s` : formatTime(value, false));

/** A library sound as a draggable asset: dropped on an audio track it becomes a generated clip. */
export const soundAsset = (item: Pick<ResourceItem, "id" | "title" | "duration" | "module">): Asset => ({
  path: item.title,
  url: item.module ?? "",
  kind: "audio",
  mime: "",
  size: 0,
  duration: item.duration,
  sound: item.id,
});

/**
 * The reusable resources declared in the material libraries' code (characters, props, sets,
 * screens, effects, transitions, text, sounds): searched, previewed in a tab, and — sounds —
 * dragged onto an audio track.
 */
export function ResourcesPanel({ onPlaceSound }: { onPlaceSound: (item: ResourceItem) => void }) {
  const { work, readOnly, openResource, openMaterial, addToChat } = useWorkbench();
  const [listing, setListing] = useState<Listing>({ libraries: [], items: [], errors: [] });
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [run, busy] = useAction();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = workPath(work.repo, work.id);
  const enc = encodeURIComponent;

  const load = () =>
    run(async () => {
      setListing(await api<Listing>(`${base}/resources`));
      setLoaded(true);
    });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useServerEvent((event) => {
    if (event.type === "materials" && event.repo === work.repo) void load();
    if ((event.type === "work-materials" || event.type === "works") && (event.work === work.id || event.repo === work.repo)) void load();
  });

  const linked = new Set(listing.libraries.filter((item) => item.linked).map((item) => item.id));
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return listing.items.filter(
      (item) =>
        (!kind || item.kind === kind) &&
        words.every((word) => [item.title, item.key, item.kindLabel, item.description, ...(item.tags ?? [])].some((text) => text?.toLowerCase().includes(word))),
    );
  }, [listing.items, query, kind]);
  // Linked libraries first; each library by kind.
  const libraries = [...new Set(shown.map((item) => item.library))].sort((a, b) => Number(linked.has(b)) - Number(linked.has(a)) || a.localeCompare(b, "zh"));

  const menuOf = (event: React.MouseEvent, item: ResourceItem) =>
    openMenu(event, [
      { label: "打开预览", icon: <Eye size={14} />, onClick: () => openResource(item.id, { title: item.title }) },
      ...(item.type === "sound" && linked.has(item.library) && !readOnly ? [{ label: "放到音轨（播放头处）", icon: <Music size={14} />, onClick: () => onPlaceSound(item) }] : []),
      { label: "引用到 AI 聊天", icon: <Sparkles size={14} />, onClick: () => addToChat({ type: "resource", id: item.id, title: item.title }) },
      {
        label: item.type === "sound" ? "复制音效地址" : "复制导入语句",
        icon: <Copy size={14} />,
        onClick: () =>
          navigator.clipboard
            .writeText(item.type === "sound" ? item.id : `import {  } from "${item.import}"; // ${item.title}${item.usage ? "：" + item.usage : ""}`)
            .then(() => toast("已复制")),
      },
      { label: "查看源码", icon: <FileCode2 size={14} />, onClick: () => openMaterial(item.ref) },
    ]);

  return (
    <div className="resources">
      {busy && <div className="view-progress" />}
      <div className="resources-search">
        <Search size={13} />
        <input className="input" placeholder="搜索：角色、下雨、手机、甩镜…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="resource-kinds">
        {KINDS.map(([id, label]) => (
          <button key={id} className={kind === id ? "active" : ""} onClick={() => setKind(id)}>
            {label}
          </button>
        ))}
      </div>
      {libraries.map((library) => {
        const items = shown.filter((item) => item.library === library);
        // Characters first, sounds last (the order of KINDS).
        const order = KINDS.map(([, label]) => label);
        const kinds = [...new Set(items.map((item) => item.kindLabel))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const open = !closed.has(library);
        return (
          <section key={library} className="materials-library">
            <div
              className="tree-row"
              onClick={() =>
                setClosed((current) => {
                  const next = new Set(current);
                  if (next.has(library)) next.delete(library);
                  else next.add(library);
                  return next;
                })
              }
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <strong className="ellipsis grow">{listing.libraries.find((item) => item.id === library)?.title ?? library}</strong>
              {linked.has(library) ? <span className="badge accent">本作品</span> : <span className="faint small-text">未引用</span>}
              <span className="faint small-text">{items.length}</span>
            </div>
            {open &&
              kinds.map((label) => {
                const group = items.filter((item) => item.kindLabel === label);
                return (
                  <div key={label} className="resource-group">
                    <div className="resource-group-title">
                      {label} <span className="faint">{group.length}</span>
                    </div>
                    {group[0].type === "sound" ? (
                      <div className="sound-list">
                        {group.map((item) => (
                          <div
                            key={item.id}
                            className="sound-row"
                            draggable={linked.has(item.library) && !readOnly}
                            onDragStart={(event) => assetDrag.start(event, soundAsset(item))}
                            onDragEnd={() => assetDrag.end()}
                            onClick={() => openResource(item.id, { preview: true, title: item.title })}
                            onDoubleClick={() => openResource(item.id, { title: item.title })}
                            onContextMenu={(event) => menuOf(event, item)}
                            title={`${item.id}${item.description ? "\n" + item.description : ""}\n${linked.has(item.library) ? "单击试听和看波形，拖到音轨使用" : "单击试听；引用这个素材库后才能拖到音轨"}`}
                          >
                            <AudioLines size={13} />
                            <span className="ellipsis grow">{item.title}</span>
                            <span className="faint mono small-text">{item.key}</span>
                            {item.duration ? <span className="faint small-text">{seconds(item.duration)}</span> : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="asset-grid resource-grid">
                        {group.map((item) => (
                          <div
                            key={item.id}
                            className="asset-card"
                            onClick={() => openResource(item.id, { preview: true, title: item.title })}
                            onDoubleClick={() => openResource(item.id, { title: item.title })}
                            onContextMenu={(event) => menuOf(event, item)}
                            title={`${item.title}\n${item.id}${item.description ? "\n" + item.description : ""}\n单击预览（可调参数），右键更多操作`}
                          >
                            <div className="asset-thumb">
                              <ResourceThumb src={`${base}/resources/thumb?id=${enc(item.id)}&v=${item.version}`} />
                              {item.preview?.duration ? <span className="asset-duration">{formatTime(item.preview.duration, false)}</span> : null}
                            </div>
                            <div className="asset-name ellipsis">{item.title}</div>
                            <button className="icon-btn asset-more" onClick={(event) => (event.stopPropagation(), menuOf(event, item))} aria-label="更多">
                              ⋯
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </section>
        );
      })}
      {listing.errors.map((item) => (
        <p key={item.ref} className="view-hint danger-text">
          materials/{item.ref} 解析出错：{item.errors.join("；")}
        </p>
      ))}
      {loaded && !listing.items.length && (
        <p className="view-hint">
          素材库里还没有声明资源。在素材库的代码里用 defineResources / defineSounds 声明角色、场景、效果和音效后，它们会出现在这里，可以预览、调参数、拖到时间轴（音效）。AI 用 resources_search 找到它们。
        </p>
      )}
      {loaded && listing.items.length > 0 && !shown.length && <p className="view-hint">没有符合的资源。</p>}
      {menu}
    </div>
  );
}

/** A thumbnail rendered by the studio on first request (it may take a moment). */
function ResourceThumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <Shapes size={24} /> : <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

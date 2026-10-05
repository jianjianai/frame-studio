import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize,
  Plus,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  Scissors,
  Trash2,
  Sparkles,
  Captions,
  Flag,
  Layers,
  AudioLines,
  Type,
} from "lucide-react";
import { api, formatTime, workPath } from "../lib/api";
import { useAction, useContextMenu, usePrompt, Dialog, type MenuItem } from "../lib/ui";
import type { AudioDocument, Subtitle, Beat, VisualClip } from "../lib/types";
import { useObservable, useWorkbench } from "./store";
import { loadPeaks, drawPeaks } from "./waveform";

const WIDE_LABEL = 168;
const NARROW_LABEL = 92;
type Kind = "layer" | "audio" | "subtitle" | "beat";
interface Item {
  id: string;
  kind: Kind;
  start: number;
  duration: number;
  label: string;
  muted?: boolean;
  hidden?: boolean;
  src?: string;
  offset?: number;
  rate?: number;
  index?: number;
  editable: boolean;
}
interface Row {
  id: string;
  label: string;
  kind: Kind;
  icon: React.ReactNode;
  items: Item[];
  muted?: boolean;
  trackId?: string;
}

const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Light manual editing: move/trim/split/hide/delete layers, audio clips,
 * subtitles and shot markers. Everything else is the AI's job.
 */
export function Timeline() {
  const { work, stage, select, selection, addToChat, reload } = useWorkbench();
  const [run] = useAction();
  const [openMenu, menu] = useContextMenu();
  const prompt = usePrompt();
  const scroller = useRef<HTMLDivElement>(null);
  const [pps, setPps] = useState(0);
  const [drag, setDrag] = useState<{ item: Item; start: number; duration: number } | null>(null);
  const [editing, setEditing] = useState<{ index: number; subtitle: Subtitle } | null>(null);
  const [LABEL_WIDTH, setLabelWidth] = useState(WIDE_LABEL);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setLabelWidth(element.clientWidth < 560 ? NARROW_LABEL : WIDE_LABEL));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const meta = work.meta;
  const duration = meta?.duration ?? 10;
  const base = workPath(work.repo, work.id);
  const assetUrl = (src: string) => `${work.preview.assetBase}${src}`;

  // Fit the whole film into view the first time.
  useLayoutEffect(() => {
    if (pps || !scroller.current) return;
    setPps(Math.max(4, (scroller.current.clientWidth - LABEL_WIDTH - 24) / duration));
  }, [pps, duration]);
  const fit = () => scroller.current && setPps(Math.max(4, (scroller.current.clientWidth - LABEL_WIDTH - 24) / duration));

  const rows = useMemo<Row[]>(() => {
    if (!meta) return [];
    const result: Row[] = [];
    result.push({
      id: "beats",
      label: "镜头标记",
      kind: "beat",
      icon: <Flag size={13} />,
      items: meta.beats.map((beat: Beat, index) => ({
        id: "beat:" + index,
        kind: "beat",
        start: beat.at,
        duration: 0,
        label: beat.title,
        index,
        editable: true,
      })),
    });
    for (const clip of [...(meta.visual?.clips ?? [])].reverse() as VisualClip[])
      result.push({
        id: "layer:" + clip.id,
        label: clip.name || clip.id,
        kind: "layer",
        icon: <Layers size={13} />,
        items: [
          {
            id: clip.id,
            kind: "layer",
            start: clip.start,
            duration: clip.duration,
            hidden: clip.hidden,
            label: clip.name || clip.id,
            src: clip.source.kind === "scene" ? `scene:${clip.source.module}` : clip.source.kind === "color" ? clip.source.color : clip.source.src,
            editable: true,
          },
        ],
      });
    const doc = meta.audioDocument as AudioDocument | undefined;
    if (doc) {
      const sources = new Map(doc.sources.map((source) => [source.id, source]));
      for (const track of doc.tracks)
        result.push({
          id: "track:" + track.id,
          trackId: track.id,
          label: track.name,
          kind: "audio",
          muted: track.muted,
          icon: <AudioLines size={13} />,
          items: doc.clips
            .filter((clip) => clip.track === track.id)
            .map((clip) => {
              const source = sources.get(clip.source);
              return {
                id: clip.id,
                kind: "audio" as const,
                start: clip.start,
                duration: clip.duration,
                muted: clip.muted,
                label: clip.name || source?.src?.split("/").pop() || source?.module || clip.id,
                src: source?.kind === "file" ? source.src : undefined,
                offset: clip.offset ?? 0,
                rate: (clip as { rate?: number }).rate ?? 1,
                editable: true,
              };
            }),
        });
    }
    result.push({
      id: "subtitles",
      label: "字幕",
      kind: "subtitle",
      icon: <Captions size={13} />,
      items: meta.subtitles.map((subtitle, index) => ({
        id: "sub:" + index,
        kind: "subtitle",
        start: subtitle.start,
        duration: subtitle.end - subtitle.start,
        label: subtitle.text,
        index,
        editable: true,
      })),
    });
    return result;
  }, [meta, duration]);

  // ---- persistence of edits -------------------------------------------------
  const commitItem = async (item: Item, start: number, length: number) => {
    start = Math.max(0, Math.round(start * 1000) / 1000);
    length = Math.max(0.05, Math.round(length * 1000) / 1000);
    if (start + length > duration) length = Math.max(0.05, duration - start);
    if (item.kind === "layer") await api(`${base}/layers`, { body: { operations: [{ op: "update", id: item.id, patch: { start, duration: length } }] } });
    else if (item.kind === "audio") {
      const doc = meta!.audioDocument!;
      const clip = doc.clips.find((entry) => entry.id === item.id)!;
      const offset = Math.max(0, (clip.offset ?? 0) + (start - clip.start) * ((clip as { rate?: number }).rate ?? 1));
      await api(`${base}/audio`, {
        body: {
          operations: [
            {
              op: "put",
              collection: "clips",
              value: { ...clip, start, duration: length, offset: start !== clip.start && length !== clip.duration ? offset : clip.offset },
            },
          ],
        },
      });
    } else if (item.kind === "subtitle") {
      const subtitles = meta!.subtitles
        .map((subtitle, index) => (index === item.index ? { ...subtitle, start, end: start + length } : subtitle))
        .sort((a, b) => a.start - b.start);
      await api(base, { method: "PATCH", body: { subtitles } });
    } else if (item.kind === "beat") {
      const beats = meta!.beats.map((beat, index) => (index === item.index ? { ...beat, at: start } : beat)).sort((a, b) => a.at - b.at);
      await api(base, { method: "PATCH", body: { beats } });
    }
    await reload();
  };
  const removeItem = (item: Item) =>
    run(async () => {
      if (item.kind === "layer") await api(`${base}/layers`, { body: { operations: [{ op: "remove", id: item.id }] } });
      else if (item.kind === "audio") await api(`${base}/audio`, { body: { operations: [{ op: "remove", collection: "clips", id: item.id }] } });
      else if (item.kind === "subtitle") await api(base, { method: "PATCH", body: { subtitles: meta!.subtitles.filter((_, index) => index !== item.index) } });
      else if (item.kind === "beat") await api(base, { method: "PATCH", body: { beats: meta!.beats.filter((_, index) => index !== item.index) } });
      select(null);
      await reload();
    });
  const splitItem = (item: Item) =>
    run(async () => {
      const at = stage.playback.get().time;
      if (at <= item.start || at >= item.start + item.duration) throw new Error("播放头不在这个片段内");
      const operations = [{ op: "split", id: item.id, at, newId: newId(item.id.replace(/_[a-z0-9]{6}$/, "")) }];
      if (item.kind === "layer") await api(`${base}/layers`, { body: { operations } });
      else await api(`${base}/audio`, { body: { operations } });
      await reload();
    });
  const toggleHidden = (item: Item) =>
    run(async () => {
      await api(`${base}/layers`, {
        body: {
          operations: [item.hidden ? { op: "update", id: item.id, patch: {}, unset: ["hidden"] } : { op: "update", id: item.id, patch: { hidden: true } }],
        },
      });
      await reload();
    });
  const toggleClipMute = (item: Item) =>
    run(async () => {
      const clip = meta!.audioDocument!.clips.find((entry) => entry.id === item.id)!;
      await api(`${base}/audio`, { body: { operations: [{ op: "put", collection: "clips", value: { ...clip, muted: !clip.muted } }] } });
      await reload();
    });
  const toggleTrackMute = (row: Row) =>
    run(async () => {
      const track = meta!.audioDocument!.tracks.find((entry) => entry.id === row.trackId)!;
      await api(`${base}/audio`, { body: { operations: [{ op: "put", collection: "tracks", value: { ...track, muted: !track.muted } }] } });
      await reload();
    });
  const addSubtitle = () => {
    const at = stage.playback.get().time;
    setEditing({ index: -1, subtitle: { start: at, end: Math.min(duration, at + 2.5), text: "" } });
  };
  const saveSubtitle = (index: number, subtitle: Subtitle) =>
    run(async () => {
      const list = [...meta!.subtitles];
      if (index < 0) list.push(subtitle);
      else list[index] = subtitle;
      await api(base, { method: "PATCH", body: { subtitles: list.filter((item) => item.text.trim()).sort((a, b) => a.start - b.start) } });
      setEditing(null);
      await reload();
    });
  const addBeat = () =>
    run(async () => {
      const at = Math.round(stage.playback.get().time * 100) / 100;
      const title = await prompt("镜头标记名称", "镜头");
      if (!title) return;
      await api(base, { method: "PATCH", body: { beats: [...meta!.beats, { at, title, detail: "" }].sort((a, b) => a.at - b.at) } });
      await reload();
    });

  // ---- pointer interactions ------------------------------------------------------
  const timeAt = (clientX: number) => {
    const rect = scroller.current!.getBoundingClientRect();
    return (clientX - rect.left - LABEL_WIDTH + scroller.current!.scrollLeft) / pps;
  };
  const seekAt = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest(".tl-item")) return;
    const seek = (clientX: number) => void stage.seek(Math.max(0, Math.min(duration, timeAt(clientX))));
    seek(event.clientX);
    const move = (moveEvent: PointerEvent) => seek(moveEvent.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const startDrag = (event: React.PointerEvent, item: Item, mode: "move" | "left" | "right") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    select({ kind: item.kind, id: item.id, index: item.index });
    if (!item.editable) return;
    const origin = event.clientX;
    let moved = false;
    let state = { item, start: item.start, duration: item.duration };
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - origin) / pps;
      if (Math.abs(moveEvent.clientX - origin) > 2) moved = true;
      if (!moved) return;
      if (mode === "move") state = { item, start: Math.max(0, Math.min(duration - item.duration, item.start + delta)), duration: item.duration };
      else if (mode === "left") {
        const start = Math.max(0, Math.min(item.start + item.duration - 0.05, item.start + delta));
        state = { item, start, duration: item.duration + item.start - start };
      } else state = { item, start: item.start, duration: Math.max(0.05, Math.min(duration - item.start, item.duration + delta)) };
      setDrag(state);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) void run(() => commitItem(item, state.start, state.duration)).finally(() => setDrag(null));
      else {
        setDrag(null);
        void stage.seek(Math.max(item.start, Math.min(item.start + item.duration, timeAt(origin))));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const itemMenu = (event: React.MouseEvent, item: Item, row: Row) => {
    select({ kind: item.kind, id: item.id, index: item.index });
    const items: MenuItem[] = [];
    if (item.kind === "layer" || item.kind === "audio")
      items.push({ label: "在播放头处切开", icon: <Scissors size={14} />, onClick: () => splitItem(item), disabled: !item.editable });
    if (item.kind === "layer")
      items.push({
        label: item.hidden ? "显示图层" : "隐藏图层",
        icon: item.hidden ? <Eye size={14} /> : <EyeOff size={14} />,
        onClick: () => toggleHidden(item),
      });
    if (item.kind === "audio" && item.editable)
      items.push({
        label: item.muted ? "取消静音" : "静音片段",
        icon: item.muted ? <Volume2 size={14} /> : <VolumeX size={14} />,
        onClick: () => toggleClipMute(item),
      });
    if (item.kind === "subtitle")
      items.push({ label: "编辑字幕", icon: <Type size={14} />, onClick: () => setEditing({ index: item.index!, subtitle: meta!.subtitles[item.index!] }) });
    items.push({
      label: "让 AI 修改这里…",
      icon: <Sparkles size={14} />,
      onClick: () =>
        item.kind === "layer"
          ? addToChat({ type: "layer", id: item.id, name: item.label })
          : addToChat(
              { type: "range", start: item.start, end: item.start + item.duration },
              item.kind === "audio" ? `音轨「${row.label}」的片段「${item.label}」：` : `${item.label}：`,
            ),
    });
    if (item.editable) items.push("separator", { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => removeItem(item) });
    openMenu(event, items);
  };

  const zoom = (factor: number) => setPps((value) => Math.max(2, Math.min(800, value * factor)));
  const width = Math.max(1, duration * pps);
  const ticks = useMemo(() => {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((value) => value * pps >= 70) ?? 600;
    return Array.from({ length: Math.floor(duration / step) + 1 }, (_, index) => index * step);
  }, [pps, duration]);
  const selected = selection && rows.flatMap((row) => row.items).find((item) => item.id === selection.id && item.kind === selection.kind);

  if (!meta) return <div className="empty">project.ts 无法读取：{work.metaError}</div>;
  return (
    <div className="timeline">
      <div className="panel-toolbar">
        <button className="btn small" onClick={addSubtitle}>
          <Plus size={13} /> 字幕
        </button>
        <button className="btn small" onClick={addBeat}>
          <Flag size={13} /> 标记
        </button>
        {selected && (
          <span className="tl-inspector">
            <strong className="ellipsis">{selected.label}</strong>
            <span className="faint mono">
              {formatTime(selected.start)} – {formatTime(selected.start + selected.duration)}
            </span>
          </span>
        )}
        <span className="grow" />
        <button className="icon-btn" title="缩小" onClick={() => zoom(1 / 1.4)}>
          <ZoomOut size={15} />
        </button>
        <button className="icon-btn" title="放大" onClick={() => zoom(1.4)}>
          <ZoomIn size={15} />
        </button>
        <button className="icon-btn" title="适应宽度" onClick={fit}>
          <Maximize size={15} />
        </button>
      </div>
      <div
        className="tl-scroller"
        ref={scroller}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15);
        }}
      >
        <div className="tl-content" style={{ width: width + LABEL_WIDTH + 24, "--tl-label": LABEL_WIDTH + "px" } as React.CSSProperties}>
          <div className="tl-ruler" onPointerDown={seekAt}>
            <div className="tl-label" />
            <div className="tl-lane" style={{ width }}>
              {ticks.map((tick) => (
                <span key={tick} className="tl-tick" style={{ left: tick * pps }}>
                  {formatTime(tick, pps * (ticks[1] ?? 1) < 140 ? false : true)}
                </span>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <div key={row.id} className={`tl-row kind-${row.kind}`}>
              <div className="tl-label" title={row.label}>
                {row.icon}
                <span className="ellipsis grow">{row.label}</span>
                {row.kind === "audio" && (
                  <button
                    className={`icon-btn tiny ${row.muted ? "active" : ""}`}
                    title={row.muted ? "取消静音" : "静音音轨"}
                    onClick={() => toggleTrackMute(row)}
                  >
                    {row.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  </button>
                )}
              </div>
              <div className="tl-lane" style={{ width }} onPointerDown={seekAt}>
                {row.items.map((item) => {
                  const shown = drag?.item.id === item.id && drag.item.kind === item.kind ? drag : item;
                  const isSelected = selection?.id === item.id && selection.kind === item.kind;
                  if (item.kind === "beat")
                    return (
                      <div
                        key={item.id}
                        className={`tl-item tl-beat ${isSelected ? "selected" : ""}`}
                        style={{ left: shown.start * pps }}
                        title={`${item.label} · ${formatTime(item.start)}`}
                        onPointerDown={(event) => startDrag(event, item, "move")}
                        onContextMenu={(event) => itemMenu(event, item, row)}
                      >
                        <span>{item.label}</span>
                      </div>
                    );
                  return (
                    <div
                      key={item.id}
                      className={`tl-item tl-${item.kind} ${isSelected ? "selected" : ""} ${item.hidden || item.muted || row.muted ? "dim" : ""} ${item.editable ? "" : "locked"}`}
                      style={{ left: shown.start * pps, width: Math.max(2, shown.duration * pps) }}
                      title={`${item.label}\n${formatTime(shown.start)} – ${formatTime(shown.start + shown.duration)}${item.editable ? "" : "\n（旧格式音轨，让 AI 迁移到 audio.json 后可编辑）"}`}
                      onPointerDown={(event) => startDrag(event, item, "move")}
                      onDoubleClick={() => item.kind === "subtitle" && setEditing({ index: item.index!, subtitle: meta.subtitles[item.index!] })}
                      onContextMenu={(event) => itemMenu(event, item, row)}
                    >
                      {item.kind === "audio" && item.src && (
                        <Waveform url={assetUrl(item.src)} offset={item.offset ?? 0} duration={shown.duration} rate={item.rate ?? 1} />
                      )}
                      <span className="tl-item-label">{item.label}</span>
                      {item.editable && (
                        <>
                          <span className="tl-handle left" onPointerDown={(event) => startDrag(event, item, "left")} />
                          <span className="tl-handle right" onPointerDown={(event) => startDrag(event, item, "right")} />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <Playhead pps={pps} offset={LABEL_WIDTH} />
        </div>
      </div>
      {editing && (
        <SubtitleDialog
          value={editing.subtitle}
          duration={duration}
          onClose={() => setEditing(null)}
          onSave={(subtitle) => saveSubtitle(editing.index, subtitle)}
        />
      )}
      {menu}
    </div>
  );
}

function Playhead({ pps, offset }: { pps: number; offset: number }) {
  const { stage } = useWorkbench();
  const playback = useObservable(stage.playback);
  return <div className="tl-playhead" style={{ left: offset + playback.time * pps }} />;
}

function Waveform({ url, offset, duration, rate }: { url: string; offset: number; duration: number; rate: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<{ peaks: Float32Array; duration: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPeaks(url).then((result) => alive && setData(result));
    return () => {
      alive = false;
    };
  }, [url]);
  useEffect(() => {
    if (data && canvas.current) drawPeaks(canvas.current, data, offset, duration, rate);
  });
  return <canvas ref={canvas} className="tl-wave" />;
}

function SubtitleDialog({
  value,
  duration,
  onClose,
  onSave,
}: {
  value: Subtitle;
  duration: number;
  onClose: () => void;
  onSave: (subtitle: Subtitle) => void;
}) {
  const [text, setText] = useState(value.text);
  const [start, setStart] = useState(value.start);
  const [end, setEnd] = useState(value.end);
  return (
    <Dialog
      title="字幕"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!text.trim() || end <= start} onClick={() => onSave({ text: text.trim(), start, end })}>
            保存
          </button>
        </>
      }
    >
      <label className="field">
        <span>文字</span>
        <textarea className="textarea" rows={3} autoFocus value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="field-grid">
        <label className="field">
          <span>开始（秒）</span>
          <input className="input" type="number" step={0.1} min={0} max={duration} value={start} onChange={(event) => setStart(Number(event.target.value))} />
        </label>
        <label className="field">
          <span>结束（秒）</span>
          <input className="input" type="number" step={0.1} min={0} max={duration} value={end} onChange={(event) => setEnd(Number(event.target.value))} />
        </label>
      </div>
    </Dialog>
  );
}

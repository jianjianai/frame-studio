import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Undo2,
  Redo2,
  Pencil,
  SlidersHorizontal,
} from "lucide-react";
import { api, formatTime, workPath } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePrompt, useToast, Dialog, type MenuItem } from "../lib/ui";
import type { Asset, AudioDocument, Subtitle, Beat, VisualClip } from "../lib/types";
import { useObservable, useWorkbench } from "./store";
import { loadPeaks, drawPeaks } from "./waveform";
import { useTimelineHistory } from "./timelineHistory";
import { assetDrag } from "./assetDrag";

const WIDE_LABEL = 168;
const NARROW_LABEL = 92;
const SNAP_PX = 8;
type Kind = "layer" | "audio" | "subtitle" | "beat";
type AudioClip = AudioDocument["clips"][number];
type AudioTrack = AudioDocument["tracks"][number];
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
  layer?: VisualClip;
  clip?: AudioClip;
}
interface Row {
  id: string;
  label: string;
  kind: Kind;
  icon: React.ReactNode;
  items: Item[];
  track?: AudioTrack;
  layer?: VisualClip;
}
/** Where a dragged asset would land. */
interface DropTarget {
  row: string;
  start: number;
  duration: number;
  label: string;
}
type VolumeTarget = { kind: "track"; track: AudioTrack } | { kind: "clip"; clip: AudioClip } | { kind: "layer"; layer: VisualClip };

const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

// Volume is shown in dB like a mixer; the bottom of the slider is silence.
const MIN_DB = -60;
const MAX_DB = 12;
export const gainToDb = (gain: number) => (gain <= 0 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(gain))));
export const dbToGain = (db: number) => (db <= MIN_DB ? 0 : Math.min(4, 10 ** (db / 20)));
export const formatDb = (gain: number) => (gain <= 0 ? "-∞ dB" : `${gainToDb(gain) > 0 ? "+" : ""}${gainToDb(gain).toFixed(1)} dB`);

/**
 * Manual editing of the work's timeline: layers, audio tracks and clips, subtitles and
 * shot markers. Every edit can be undone. Zoom and scroll follow editing software:
 * Ctrl/Alt + wheel zooms around the pointer, wheel scrolls, the view follows playback.
 */
export function Timeline() {
  const { work, stage, select, selection, addToChat, reload } = useWorkbench();
  const [run] = useAction();
  const toast = useToast();
  const confirm = useConfirm();
  const [openMenu, menu] = useContextMenu();
  const prompt = usePrompt();
  const scroller = useRef<HTMLDivElement>(null);
  const [pps, setPps] = useState(0);
  const [drag, setDrag] = useState<{ item: Item; start: number; duration: number } | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [assetOver, setAssetOver] = useState(false);
  const [editing, setEditing] = useState<{ index: number; subtitle: Subtitle } | null>(null);
  const [volume, setVolume] = useState<{ target: VolumeTarget; x: number; y: number } | null>(null);
  const [LABEL_WIDTH, setLabelWidth] = useState(WIDE_LABEL);
  const [viewWidth, setViewWidth] = useState(0);
  const meta = work.meta;
  const duration = meta?.duration ?? 10;
  const fps = meta?.fps ?? 30;
  const base = workPath(work.repo, work.id);
  const assetUrl = (src: string) => `${work.preview.assetBase}${src}`;
  const history = useTimelineHistory(base, reload);
  const audioDoc = meta?.audioDocument as AudioDocument | undefined;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewWidth(element.clientWidth);
      setLabelWidth(element.clientWidth < 560 ? NARROW_LABEL : WIDE_LABEL);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // ---- zoom ---------------------------------------------------------------------
  const fitPps = useCallback(
    () => Math.max(0.5, ((viewWidth || scroller.current?.clientWidth || 800) - LABEL_WIDTH - 24) / duration),
    [viewWidth, LABEL_WIDTH, duration],
  );
  const limits = useCallback(() => ({ min: fitPps() / 2, max: fps * 80 }), [fitPps, fps]);
  // The whole film stays fitted to the panel (through resizes) until the user zooms.
  const fitted = useRef(true);
  useLayoutEffect(() => {
    if (fitted.current) setPps(fitPps());
  }, [fitPps]);
  /** Time under the anchor stays under it; the anchor defaults to the playhead (or the view's centre). */
  const anchor = useRef<{ time: number; x: number } | null>(null);
  const zoom = useCallback(
    (factor: number, clientX?: number) => {
      const element = scroller.current;
      if (!element || !pps) return;
      const rect = element.getBoundingClientRect();
      const view = element.clientWidth - LABEL_WIDTH;
      let x = clientX !== undefined ? clientX - rect.left - LABEL_WIDTH : stage.playback.get().time * pps - element.scrollLeft;
      if (clientX === undefined && (x < 0 || x > view)) x = view / 2;
      x = Math.max(0, Math.min(view, x));
      anchor.current = { time: (x + element.scrollLeft) / pps, x };
      fitted.current = false;
      const { min, max } = limits();
      setPps(Math.max(min, Math.min(max, pps * factor)));
    },
    [pps, LABEL_WIDTH, stage, limits],
  );
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !anchor.current) return;
    element.scrollLeft = anchor.current.time * pps - anchor.current.x;
    anchor.current = null;
  }, [pps]);
  const fit = () => {
    fitted.current = true;
    setPps(fitPps());
    if (scroller.current) scroller.current.scrollLeft = 0;
  };

  // Wheel: Ctrl/⌘/Alt + wheel (and trackpad pinch) zooms at the pointer; Shift + wheel scrolls
  // sideways; a plain wheel scrolls the tracks, or sideways when they all fit vertically.
  // Native listener: React's wheel listener is passive and cannot stop the browser's page zoom.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault();
        zoomRef.current(Math.exp(-delta * 0.0025), event.clientX);
      } else if (!event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY) && element.scrollHeight <= element.clientHeight + 1) {
        event.preventDefault();
        element.scrollLeft += delta;
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  // Middle button drag pans the view (hand tool).
  const pan = (event: React.PointerEvent) => {
    if (event.button !== 1) return false;
    event.preventDefault();
    const element = scroller.current!;
    const origin = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    const move = (moveEvent: PointerEvent) => {
      element.scrollLeft = origin.left - (moveEvent.clientX - origin.x);
      element.scrollTop = origin.top - (moveEvent.clientY - origin.y);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return true;
  };

  // During playback the view pages along when the playhead leaves it.
  useEffect(() => {
    const unsubscribe = stage.playback.subscribe(() => {
      const element = scroller.current;
      const snapshot = stage.playback.get();
      if (!element || !snapshot.playing || !pps) return;
      const x = snapshot.time * pps - element.scrollLeft;
      const view = element.clientWidth - LABEL_WIDTH;
      if (x > view - 16 || x < 0) element.scrollLeft = snapshot.time * pps - 24;
    });
    return () => void unsubscribe();
  }, [stage, pps, LABEL_WIDTH]);

  // ---- rows -----------------------------------------------------------------------
  const rows = useMemo<Row[]>(() => {
    if (!meta) return [];
    const result: Row[] = [];
    result.push({
      id: "beats",
      label: "镜头标记",
      kind: "beat",
      icon: <Flag size={13} />,
      items: meta.beats.map((beat: Beat, index) => ({ id: "beat:" + index, kind: "beat", start: beat.at, duration: 0, label: beat.title, index })),
    });
    for (const clip of [...(meta.visual?.clips ?? [])].reverse() as VisualClip[])
      result.push({
        id: "layer:" + clip.id,
        label: clip.name || clip.id,
        kind: "layer",
        icon: <Layers size={13} />,
        layer: clip,
        items: [
          {
            id: clip.id,
            kind: "layer",
            start: clip.start,
            duration: clip.duration,
            hidden: clip.hidden,
            label: clip.name || clip.id,
            src: clip.source.kind === "scene" ? `scene:${clip.source.module}` : clip.source.kind === "color" ? clip.source.color : clip.source.src,
            layer: clip,
          },
        ],
      });
    if (audioDoc) {
      const sources = new Map(audioDoc.sources.map((source) => [source.id, source]));
      for (const track of audioDoc.tracks)
        result.push({
          id: "track:" + track.id,
          label: track.name,
          kind: "audio",
          icon: <AudioLines size={13} />,
          track,
          items: audioDoc.clips
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
                rate: clip.rate ?? 1,
                clip,
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
      })),
    });
    return result;
  }, [meta, audioDoc]);

  // ---- edits (all recorded for undo) --------------------------------------------------
  const editLayers = (label: string, operations: unknown[]) => history.run("layers", label, () => api(`${base}/layers`, { body: { operations } }));
  const editAudio = (label: string, operations: unknown[]) => history.run("audio", label, () => api(`${base}/audio`, { body: { operations } }));
  const editProject = (label: string, change: { subtitles?: Subtitle[]; beats?: Beat[] }) =>
    history.run("project", label, () => api(base, { method: "PATCH", body: change }));

  const commitItem = async (item: Item, start: number, length: number) => {
    start = Math.max(0, round3(start));
    length = Math.max(0.05, round3(length));
    if (start + length > duration) length = Math.max(0.05, duration - start);
    if (item.kind === "layer") await editLayers("移动图层", [{ op: "update", id: item.id, patch: { start, duration: length } }]);
    else if (item.kind === "audio") {
      const clip = item.clip!;
      // Trimming the left edge moves the media offset with it; moving keeps it.
      const offset = Math.max(0, (clip.offset ?? 0) + (start - clip.start) * (clip.rate ?? 1));
      await editAudio("移动片段", [
        {
          op: "put",
          collection: "clips",
          value: { ...clip, start, duration: length, offset: start !== clip.start && length !== clip.duration ? offset : clip.offset },
        },
      ]);
    } else if (item.kind === "subtitle") {
      const subtitles = meta!.subtitles
        .map((subtitle, index) => (index === item.index ? { ...subtitle, start, end: start + length } : subtitle))
        .sort((a, b) => a.start - b.start);
      await editProject("移动字幕", { subtitles });
    } else if (item.kind === "beat") {
      const beats = meta!.beats.map((beat, index) => (index === item.index ? { ...beat, at: start } : beat)).sort((a, b) => a.at - b.at);
      await editProject("移动标记", { beats });
    }
  };
  const removeItem = (item: Item) =>
    run(async () => {
      if (item.kind === "layer") await editLayers("删除图层", [{ op: "remove", id: item.id }]);
      else if (item.kind === "audio") await editAudio("删除片段", [{ op: "remove", collection: "clips", id: item.id }]);
      else if (item.kind === "subtitle") await editProject("删除字幕", { subtitles: meta!.subtitles.filter((_, index) => index !== item.index) });
      else if (item.kind === "beat") await editProject("删除标记", { beats: meta!.beats.filter((_, index) => index !== item.index) });
      select(null);
    });
  const splitItem = (item: Item) =>
    run(async () => {
      const at = stage.playback.get().time;
      if (at <= item.start || at >= item.start + item.duration) throw new Error("播放头不在这个片段内");
      const operations = [{ op: "split", id: item.id, at, newId: newId(item.id.replace(/_[a-z0-9]{6}$/, "")) }];
      if (item.kind === "layer") await editLayers("切开图层", operations);
      else await editAudio("切开片段", operations);
    });
  const toggleHidden = (item: Item) =>
    run(() =>
      editLayers(item.hidden ? "显示图层" : "隐藏图层", [
        item.hidden ? { op: "update", id: item.id, patch: {}, unset: ["hidden"] } : { op: "update", id: item.id, patch: { hidden: true } },
      ]),
    );
  const toggleClipMute = (item: Item) =>
    run(() => editAudio(item.muted ? "取消静音" : "静音片段", [{ op: "put", collection: "clips", value: { ...item.clip!, muted: !item.clip!.muted } }]));
  const toggleTrackMute = (track: AudioTrack) =>
    run(() => editAudio(track.muted ? "取消静音" : "静音音轨", [{ op: "put", collection: "tracks", value: { ...track, muted: !track.muted } }]));

  // ---- tracks ---------------------------------------------------------------------
  const nextTrackName = () => {
    const names = new Set(audioDoc?.tracks.map((track) => track.name));
    let index = (audioDoc?.tracks.length ?? 0) + 1;
    while (names.has(`音轨 ${index}`)) index++;
    return `音轨 ${index}`;
  };
  const trackValue = (name: string) => ({ id: newId("track"), name, gain: 1, pan: 0, muted: false, processors: [], output: "master", sends: [] });
  const addTrack = () => run(() => editAudio("新建音轨", [{ op: "put", collection: "tracks", value: trackValue(nextTrackName()) }]));
  const renameTrack = (track: AudioTrack) =>
    run(async () => {
      const name = (await prompt("音轨名称", track.name))?.trim();
      if (name && name !== track.name) await editAudio("重命名音轨", [{ op: "put", collection: "tracks", value: { ...track, name } }]);
    });
  const removeTrack = (track: AudioTrack) =>
    run(async () => {
      const clips = audioDoc!.clips.filter((clip) => clip.track === track.id);
      if (clips.length && !(await confirm(`删除音轨「${track.name}」和其中的 ${clips.length} 个片段？可以用 Ctrl+Z 撤销。`, { confirm: "删除", danger: true })))
        return;
      await editAudio("删除音轨", [
        ...clips.map((clip) => ({ op: "remove", collection: "clips", id: clip.id })),
        // Other tracks' ducking can no longer listen to the removed track.
        ...audioDoc!.tracks
          .filter((other) => other.id !== track.id && other.processors?.some((processor) => processor.track === track.id))
          .map((other) => ({
            op: "put",
            collection: "tracks",
            value: { ...other, processors: other.processors!.filter((processor) => processor.track !== track.id) },
          })),
        { op: "remove", collection: "tracks", id: track.id },
      ]);
    });

  // ---- volume ------------------------------------------------------------------------
  const commitVolume = (target: VolumeTarget, gain: number) =>
    run(() => {
      if (target.kind === "track") return editAudio("调整音量", [{ op: "put", collection: "tracks", value: { ...target.track, gain } }]);
      if (target.kind === "clip") return editAudio("调整音量", [{ op: "put", collection: "clips", value: { ...target.clip, gain } }]);
      const audio = (target.layer.audio as { enabled: boolean; gain?: number } | undefined) ?? { enabled: true };
      return editLayers("调整音量", [{ op: "update", id: target.layer.id, patch: { audio: { ...audio, gain } } }]);
    });
  /** Hear the change while dragging; the mix is rebuilt when the edit is saved. */
  const previewVolume = (target: VolumeTarget, gain: number) => {
    const player = stage.api;
    try {
      if (target.kind === "clip") player?.setTrack?.(`audio:${target.clip.id}`, { gain: Math.min(4, gain) });
      else if (target.kind === "track" && target.track.gain > 0)
        for (const clip of audioDoc?.clips.filter((item) => item.track === target.track.id) ?? [])
          player?.setTrack?.(`audio:${clip.id}`, { gain: Math.min(4, (clip.gain * gain) / target.track.gain) });
    } catch {
      // Preview only; the saved value is what counts.
    }
  };
  const gainOf = (target: VolumeTarget) =>
    target.kind === "track"
      ? target.track.gain
      : target.kind === "clip"
        ? target.clip.gain
        : ((target.layer.audio as { gain?: number } | undefined)?.gain ?? 1);
  const openVolume = (event: React.MouseEvent, target: VolumeTarget) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setVolume({ target, x: rect.left, y: rect.bottom + 4 });
  };

  // ---- subtitles and markers -----------------------------------------------------------
  const addSubtitle = () => {
    const at = stage.playback.get().time;
    setEditing({ index: -1, subtitle: { start: at, end: Math.min(duration, at + 2.5), text: "" } });
  };
  const saveSubtitle = (index: number, subtitle: Subtitle) =>
    run(async () => {
      const list = [...meta!.subtitles];
      if (index < 0) list.push(subtitle);
      else list[index] = subtitle;
      await editProject(index < 0 ? "添加字幕" : "编辑字幕", { subtitles: list.filter((item) => item.text.trim()).sort((a, b) => a.start - b.start) });
      setEditing(null);
    });
  const addBeat = () =>
    run(async () => {
      const at = Math.round(stage.playback.get().time * 100) / 100;
      const title = await prompt("镜头标记名称", "镜头");
      if (!title) return;
      await editProject("添加标记", { beats: [...meta!.beats, { at, title, detail: "" }].sort((a, b) => a.at - b.at) });
    });

  // ---- pointer -------------------------------------------------------------------------
  const timeAt = (clientX: number) => {
    const rect = scroller.current!.getBoundingClientRect();
    return (clientX - rect.left - LABEL_WIDTH + scroller.current!.scrollLeft) / pps;
  };
  /** Snap to the playhead, the ends of the film and the edges of other items (Alt disables it). */
  const snap = (time: number, ignore: string | null, alt: boolean) => {
    if (alt) return { time, line: null };
    const candidates = [0, duration, stage.playback.get().time];
    for (const row of rows) for (const item of row.items) if (item.id !== ignore) candidates.push(item.start, item.start + item.duration);
    let best: number | null = null;
    for (const candidate of candidates)
      if (Math.abs(candidate - time) * pps <= SNAP_PX && (best === null || Math.abs(candidate - time) < Math.abs(best - time))) best = candidate;
    return best === null ? { time, line: null } : { time: best, line: best };
  };
  const seekAt = (event: React.PointerEvent) => {
    if (pan(event) || event.button !== 0 || (event.target as HTMLElement).closest(".tl-item")) return;
    event.preventDefault(); // dragging across the ruler must not select text
    select(null);
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
    if (pan(event) || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    select({ kind: item.kind, id: item.id, index: item.index });
    const origin = event.clientX;
    let moved = false;
    let state = { item, start: item.start, duration: item.duration };
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - origin) / pps;
      if (Math.abs(moveEvent.clientX - origin) > 2) moved = true;
      if (!moved) return;
      let line: number | null = null;
      if (mode === "move") {
        let start = Math.max(0, Math.min(duration - item.duration, item.start + delta));
        // Either edge may snap.
        const head = snap(start, item.id, moveEvent.altKey);
        const tail = snap(start + item.duration, item.id, moveEvent.altKey);
        if (head.line !== null) ((start = head.time), (line = head.line));
        else if (tail.line !== null) ((start = tail.time - item.duration), (line = tail.line));
        state = { item, start: Math.max(0, Math.min(duration - item.duration, start)), duration: item.duration };
      } else if (mode === "left") {
        const snapped = snap(item.start + delta, item.id, moveEvent.altKey);
        line = snapped.line;
        const start = Math.max(0, Math.min(item.start + item.duration - 0.05, snapped.time));
        state = { item, start, duration: item.duration + item.start - start };
      } else {
        const snapped = snap(item.start + item.duration + delta, item.id, moveEvent.altKey);
        line = snapped.line;
        state = { item, start: item.start, duration: Math.max(0.05, Math.min(duration - item.start, snapped.time - item.start)) };
      }
      setSnapAt(line);
      setDrag(state);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSnapAt(null);
      if (moved) void run(() => commitItem(item, state.start, state.duration)).finally(() => setDrag(null));
      else {
        setDrag(null);
        void stage.seek(Math.max(item.start, Math.min(item.start + item.duration, timeAt(origin))));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const dragPlayhead = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const move = (moveEvent: PointerEvent) => void stage.seek(Math.max(0, Math.min(duration, timeAt(moveEvent.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- dropping assets ------------------------------------------------------------------
  const usesLayers = Boolean(meta?.visual);
  const visualAsset = (asset: Asset) => asset.kind === "image" || asset.kind === "video";
  /** The row an asset lands in: audio goes to audio tracks (or a new one), pictures to layers. */
  const targetRow = (asset: Asset, rowId: string | null) => {
    const row = rows.find((item) => item.id === rowId);
    if (asset.kind === "audio") return row?.kind === "audio" ? row.id : "new-track";
    if (asset.kind === "video" && row?.kind === "audio") return row.id;
    return row?.kind === "layer" ? row.id : "new-layer";
  };
  const dragOver = (event: React.DragEvent) => {
    const asset = assetDrag.of(event);
    if (!asset || (!visualAsset(asset) && asset.kind !== "audio")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setAssetOver(true);
    const rowId = (event.target as HTMLElement).closest<HTMLElement>("[data-row]")?.dataset.row ?? null;
    const length = asset.duration ?? 5;
    const { time } = snap(Math.max(0, timeAt(event.clientX)), null, event.altKey);
    const start = Math.max(0, Math.min(duration - 0.05, time));
    setDropTarget({ row: targetRow(asset, rowId), start, duration: Math.min(length, duration - start), label: asset.path.split("/").pop()! });
  };
  const dragLeave = (event: React.DragEvent) => {
    if (scroller.current?.contains(event.relatedTarget as Node)) return;
    setDropTarget(null);
    setAssetOver(false);
  };
  const drop = (event: React.DragEvent) => {
    const asset = assetDrag.of(event);
    const target = dropTarget;
    setDropTarget(null);
    setAssetOver(false);
    if (!asset || !target) return;
    event.preventDefault();
    const name = asset.path.split("/").pop()!;
    void run(async () => {
      if (target.row.startsWith("track:") || target.row === "new-track") {
        // A new track is created by the same audio edit as the clip, so one undo removes both.
        const track = (target.row !== "new-track" && rows.find((row) => row.id === target.row)?.track?.name) || nextTrackName();
        await history.run("audio", "放入音频", () =>
          api(`${base}/audio/place`, { body: { src: asset.url, start: target.start, duration: asset.duration, track, name } }),
        );
        return;
      }
      if (!usesLayers) throw new Error("这个作品的画面完全由代码绘制，没有图层。可以把素材引用给 AI，让它接入。");
      const clips = meta!.visual!.clips;
      const below = target.row.startsWith("layer:") ? clips.findIndex((clip) => clip.id === target.row.slice(6)) : -1;
      const id =
        name
          .replace(/\.[^.]+$/, "")
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .replace(/^[^a-zA-Z]/, "m") +
        "_" +
        Math.random().toString(36).slice(2, 6);
      await editLayers("放入素材", [
        {
          op: "add",
          ...(below >= 0 ? { index: below + 1 } : {}),
          clip: {
            id,
            name,
            source: { kind: asset.kind === "video" ? "video" : "image", src: asset.url },
            start: round3(target.start),
            duration: Math.max(0.1, round3(target.duration)),
            fit: "contain",
            ...(asset.kind === "video" ? { audio: { enabled: true } } : {}),
          },
        },
      ]);
    });
  };

  // ---- keyboard --------------------------------------------------------------------------
  const selected = selection && rows.flatMap((row) => row.items).find((item) => item.id === selection.id && item.kind === selection.kind);
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    const target = event.target as HTMLElement;
    if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable || target.closest(".cm-editor, .dialog")) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z" && !event.shiftKey) {
      event.preventDefault();
      void run(async () => {
        const label = await history.undo();
        if (label) toast(`已撤销：${label}`);
      });
    } else if (mod && ((key === "z" && event.shiftKey) || key === "y")) {
      event.preventDefault();
      void run(async () => {
        const label = await history.redo();
        if (label) toast(`已重做：${label}`);
      });
    } else if (!mod && (event.key === "Delete" || event.key === "Backspace") && selected) {
      event.preventDefault();
      void removeItem(selected);
    } else if (!mod && (event.key === "=" || event.key === "+")) zoom(1.5);
    else if (!mod && event.key === "-") zoom(1 / 1.5);
    else if (!mod && event.key === "\\") fit();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // ---- menus --------------------------------------------------------------------------
  const itemMenu = (event: React.MouseEvent, item: Item, row: Row) => {
    select({ kind: item.kind, id: item.id, index: item.index });
    const items: MenuItem[] = [];
    if (item.kind === "layer" || item.kind === "audio") items.push({ label: "在播放头处切开", icon: <Scissors size={14} />, onClick: () => splitItem(item) });
    if (item.kind === "layer")
      items.push({
        label: item.hidden ? "显示图层" : "隐藏图层",
        icon: item.hidden ? <Eye size={14} /> : <EyeOff size={14} />,
        onClick: () => toggleHidden(item),
      });
    if (item.kind === "layer" && (item.layer?.audio as { enabled?: boolean } | undefined)?.enabled)
      items.push({
        label: "原声音量…",
        icon: <SlidersHorizontal size={14} />,
        onClick: () => setVolume({ target: { kind: "layer", layer: item.layer! }, x: event.clientX, y: event.clientY }),
      });
    if (item.kind === "audio") {
      items.push({
        label: item.muted ? "取消静音" : "静音片段",
        icon: item.muted ? <Volume2 size={14} /> : <VolumeX size={14} />,
        onClick: () => toggleClipMute(item),
      });
      items.push({
        label: "片段音量…",
        icon: <SlidersHorizontal size={14} />,
        onClick: () => setVolume({ target: { kind: "clip", clip: item.clip! }, x: event.clientX, y: event.clientY }),
      });
    }
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
    items.push("separator", { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => removeItem(item) });
    openMenu(event, items);
  };
  const trackMenu = (event: React.MouseEvent, track: AudioTrack) =>
    openMenu(event, [
      { label: "重命名", icon: <Pencil size={14} />, onClick: () => renameTrack(track) },
      {
        label: "音量…",
        icon: <SlidersHorizontal size={14} />,
        onClick: () => setVolume({ target: { kind: "track", track }, x: event.clientX, y: event.clientY }),
      },
      {
        label: track.muted ? "取消静音" : "静音音轨",
        icon: track.muted ? <Volume2 size={14} /> : <VolumeX size={14} />,
        onClick: () => toggleTrackMute(track),
      },
      { label: "新建音轨", icon: <Plus size={14} />, onClick: addTrack },
      "separator",
      { label: "删除音轨", icon: <Trash2 size={14} />, danger: true, onClick: () => removeTrack(track) },
    ]);

  // ---- ruler -------------------------------------------------------------------------
  const width = Math.max(1, duration * pps);
  const { ticks, minor } = useMemo(() => {
    const frame = 1 / fps;
    const steps = [frame, 2 * frame, 5 * frame, 10 * frame, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((value) => value * pps >= 80) ?? 1200;
    const minorStep = [frame, 0.1, 0.25, 0.5, 1, 5, 10, 30, 60].find((value) => value * pps >= 8 && value < step) ?? step;
    return { ticks: Array.from({ length: Math.floor(duration / step) + 1 }, (_, index) => index * step), minor: minorStep };
  }, [pps, duration, fps]);
  const tickLabel = (time: number) => {
    if (ticks[1] - ticks[0] < 0.5) {
      // Frame-level zoom: seconds + frame number, like editing software.
      const whole = Math.floor(time + 1e-6);
      return `${formatTime(whole, false)}:${String(Math.round((time - whole) * fps)).padStart(2, "0")}`;
    }
    return formatTime(time, false);
  };

  if (!meta) return <div className="empty">project.ts 无法读取：{work.metaError}</div>;
  const inspectorVolume: VolumeTarget | null =
    selected?.kind === "audio" && selected.clip
      ? { kind: "clip", clip: selected.clip }
      : selected?.kind === "layer" && (selected.layer?.audio as { enabled?: boolean } | undefined)?.enabled
        ? { kind: "layer", layer: selected.layer! }
        : null;
  const ghost = (rowId: string) =>
    dropTarget?.row === rowId && (
      <div className="tl-ghost" style={{ left: dropTarget.start * pps, width: Math.max(4, dropTarget.duration * pps) }}>
        <span className="tl-item-label">{dropTarget.label}</span>
      </div>
    );

  return (
    <div className="timeline">
      <div className="panel-toolbar">
        <button
          className="icon-btn"
          title={history.undoLabel ? `撤销：${history.undoLabel} (Ctrl+Z)` : "撤销 (Ctrl+Z)"}
          disabled={!history.undoLabel}
          onClick={() => run(history.undo)}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="icon-btn"
          title={history.redoLabel ? `重做：${history.redoLabel} (Ctrl+Shift+Z)` : "重做 (Ctrl+Shift+Z)"}
          disabled={!history.redoLabel}
          onClick={() => run(history.redo)}
        >
          <Redo2 size={15} />
        </button>
        <span className="toolbar-sep" />
        <button className="btn small" onClick={addTrack} title="新建一条空音轨">
          <Plus size={13} /> 音轨
        </button>
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
            {inspectorVolume && (
              <InlineVolume
                gain={gainOf(inspectorVolume)}
                onPreview={(gain) => previewVolume(inspectorVolume, gain)}
                onCommit={(gain) => commitVolume(inspectorVolume, gain)}
              />
            )}
          </span>
        )}
        <span className="grow" />
        <button className="icon-btn" title="缩小 (-)" onClick={() => zoom(1 / 1.5)}>
          <ZoomOut size={15} />
        </button>
        <input
          className="tl-zoom"
          type="range"
          min={0}
          max={1000}
          title="缩放（Ctrl + 滚轮在指针处缩放）"
          value={pps ? Math.round((Math.log(pps / limits().min) / Math.log(limits().max / limits().min)) * 1000) : 0}
          onChange={(event) => {
            const { min, max } = limits();
            zoom((min * (max / min) ** (Number(event.target.value) / 1000)) / pps);
          }}
        />
        <button className="icon-btn" title="放大 (=)" onClick={() => zoom(1.5)}>
          <ZoomIn size={15} />
        </button>
        <button className="icon-btn" title="适应宽度 (\)" onClick={fit}>
          <Maximize size={15} />
        </button>
      </div>
      <div className="tl-scroller" ref={scroller} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
        <div className="tl-content" style={{ width: width + LABEL_WIDTH + 24, "--tl-label": LABEL_WIDTH + "px" } as React.CSSProperties}>
          <div className="tl-ruler" onPointerDown={seekAt}>
            <div className="tl-label" />
            <div className="tl-lane" style={{ width, backgroundSize: `${minor * pps}px 100%` }}>
              {ticks.map((tick) => (
                <span key={tick} className="tl-tick" style={{ left: tick * pps }}>
                  {tickLabel(tick)}
                </span>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <div key={row.id} className={`tl-row kind-${row.kind}`} data-row={row.id}>
              <div className="tl-label" title={row.label} onContextMenu={row.track ? (event) => trackMenu(event, row.track!) : undefined}>
                {row.icon}
                <span className="ellipsis grow">{row.label}</span>
                {row.track && (
                  <>
                    <button
                      className="tl-gain"
                      title={`音量 ${formatDb(row.track.gain)}（点击调整）`}
                      onClick={(event) => openVolume(event, { kind: "track", track: row.track! })}
                    >
                      {formatDb(row.track.gain).replace(" dB", "")}
                    </button>
                    <button
                      className={`icon-btn tiny ${row.track.muted ? "active" : ""}`}
                      title={row.track.muted ? "取消静音" : "静音音轨"}
                      onClick={() => toggleTrackMute(row.track!)}
                    >
                      {row.track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                    </button>
                  </>
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
                      className={`tl-item tl-${item.kind} ${isSelected ? "selected" : ""} ${item.hidden || item.muted || row.track?.muted ? "dim" : ""}`}
                      style={{ left: shown.start * pps, width: Math.max(2, shown.duration * pps) }}
                      title={`${item.label}\n${formatTime(shown.start)} – ${formatTime(shown.start + shown.duration)}`}
                      onPointerDown={(event) => startDrag(event, item, "move")}
                      onDoubleClick={() => item.kind === "subtitle" && setEditing({ index: item.index!, subtitle: meta.subtitles[item.index!] })}
                      onContextMenu={(event) => itemMenu(event, item, row)}
                    >
                      {item.kind === "audio" && item.src && (
                        <Waveform url={assetUrl(item.src)} offset={item.offset ?? 0} duration={shown.duration} rate={item.rate ?? 1} />
                      )}
                      <span className="tl-item-label">{item.label}</span>
                      {item.kind === "audio" && item.clip && item.clip.gain !== 1 && <span className="tl-item-gain">{formatDb(item.clip.gain)}</span>}
                      <span className="tl-handle left" onPointerDown={(event) => startDrag(event, item, "left")} />
                      <span className="tl-handle right" onPointerDown={(event) => startDrag(event, item, "right")} />
                    </div>
                  );
                })}
                {ghost(row.id)}
              </div>
            </div>
          ))}
          {assetOver && (
            <>
              <div className="tl-row tl-new-row" data-row="new-layer">
                <div className="tl-label">
                  <Layers size={13} /> 新图层（最上层）
                </div>
                <div className="tl-lane" style={{ width }}>
                  {ghost("new-layer")}
                </div>
              </div>
              <div className="tl-row tl-new-row kind-audio" data-row="new-track">
                <div className="tl-label">
                  <AudioLines size={13} /> 新音轨
                </div>
                <div className="tl-lane" style={{ width }}>
                  {ghost("new-track")}
                </div>
              </div>
            </>
          )}
          {!assetOver && (
            <div className="tl-hint" style={{ left: LABEL_WIDTH + 8 }}>
              把素材从左侧「素材」拖到这里 · Ctrl + 滚轮缩放 · 中键拖动平移 · Alt 关闭吸附
            </div>
          )}
          {snapAt !== null && <div className="tl-snap" style={{ left: LABEL_WIDTH + snapAt * pps }} />}
          <Playhead pps={pps} offset={LABEL_WIDTH} onPointerDown={dragPlayhead} />
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
      {volume && (
        <VolumePopover
          x={volume.x}
          y={volume.y}
          title={volume.target.kind === "track" ? `音轨「${volume.target.track.name}」` : volume.target.kind === "clip" ? "片段音量" : "图层原声"}
          gain={gainOf(volume.target)}
          onPreview={(gain) => previewVolume(volume.target, gain)}
          onCommit={(gain) => commitVolume(volume.target, gain)}
          onClose={() => setVolume(null)}
        />
      )}
      {menu}
    </div>
  );
}

function Playhead({ pps, offset, onPointerDown }: { pps: number; offset: number; onPointerDown: (event: React.PointerEvent) => void }) {
  const { stage } = useWorkbench();
  const playback = useObservable(stage.playback);
  return (
    <div className="tl-playhead" style={{ left: offset + playback.time * pps }}>
      <span className="tl-playhead-grip" onPointerDown={onPointerDown} title="拖动播放头" />
    </div>
  );
}

/** dB slider: previews while dragging, saves (one undo step) on release. */
function VolumeSlider({ gain, onPreview, onCommit }: { gain: number; onPreview: (gain: number) => void; onCommit: (gain: number) => void }) {
  const [db, setDb] = useState(gainToDb(gain));
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setDb(gainToDb(gain));
  }, [gain]);
  const commit = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (Math.abs(dbToGain(db) - gain) > 1e-4) onCommit(Math.round(dbToGain(db) * 10000) / 10000);
  };
  return (
    <input
      className="tl-volume"
      type="range"
      min={MIN_DB}
      max={MAX_DB}
      step={0.5}
      value={db}
      onPointerDown={() => (dragging.current = true)}
      onKeyDown={() => (dragging.current = true)}
      onChange={(event) => {
        const next = Number(event.target.value);
        setDb(next);
        onPreview(dbToGain(next));
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onDoubleClick={() => {
        // Double-click resets to 0 dB, like a mixer fader.
        setDb(0);
        if (Math.abs(gain - 1) > 1e-4) onCommit(1);
      }}
      title="拖动调整，双击恢复 0 dB"
    />
  );
}

function InlineVolume(props: { gain: number; onPreview: (gain: number) => void; onCommit: (gain: number) => void }) {
  return (
    <span className="tl-inline-volume">
      <Volume2 size={13} className="faint" />
      <VolumeSlider {...props} />
      <span className="mono faint">{formatDb(props.gain)}</span>
    </span>
  );
}

function VolumePopover({
  x,
  y,
  title,
  gain,
  onPreview,
  onCommit,
  onClose,
}: {
  x: number;
  y: number;
  title: string;
  gain: number;
  onPreview: (gain: number) => void;
  onCommit: (gain: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(gain);
  useEffect(() => setShown(gain), [gain]);
  useEffect(() => {
    const away = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && onClose();
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return (
    <div className="tl-volume-popover" ref={ref} style={{ left: Math.min(x, innerWidth - 260), top: Math.min(y, innerHeight - 90) }}>
      <div className="row">
        <strong className="ellipsis grow">{title}</strong>
        <span className="mono">{formatDb(shown)}</span>
      </div>
      <VolumeSlider
        gain={gain}
        onPreview={(next) => {
          setShown(next);
          onPreview(next);
        }}
        onCommit={onCommit}
      />
      <div className="faint small-text">拖动调整，双击恢复 0 dB；松开后保存，可用 Ctrl+Z 撤销</div>
    </div>
  );
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

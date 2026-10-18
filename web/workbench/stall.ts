import { useEffect, useState } from "react";
import type { StageController } from "./store";
import { aiBusyBetween } from "../lib/gpu-render";

/**
 * Why the preview stopped (缓冲中): told while it waits, and for a moment after, since a
 * computation that holds the page's thread also freezes this very text until it is over.
 */
export interface Stall {
  /** What it waits (waited) for, e.g. 创建图层「hook」. */
  reason: string;
  /** How long it waited (ms), once it is over. */
  ms?: number;
}

/** Shorter stops are not worth telling. */
const SHOWN_MS = 300;
/** How long the cause of a stop that ended stays shown. */
const KEEP_MS = 6000;
/** A gap this long between two animation frames: the page's thread was held (the stage's and ours are one). */
const FROZEN_MS = 250;

interface Load {
  name?: string;
  id: string;
  start: number;
  end?: number;
}
interface Diagnostics {
  waiting?: boolean;
  scene?: { layerLoads?: Load[]; loading?: Load[] } | null;
  audio?: { buffering?: boolean };
}
interface Episode {
  start: number;
  /** The picture held playback (a layer loading, a slow frame), or the sound did. */
  visual: boolean;
  audio: boolean;
  /** The page's thread was held (no animation frame for a while). */
  frozen: boolean;
  layers: Set<string>;
  ai: boolean;
  update: boolean;
}

export function useStall(stage: StageController): Stall | null {
  const [stall, setStall] = useState<Stall | null>(null);
  useEffect(() => {
    let episode: Episode | null = null;
    let frame = 0;
    let lastFrame = 0;
    let polled = 0;
    let keep = 0;
    let shown = "";
    // When the stage was taking an edit (the AI saved a file): a layer of it is created again.
    const updates: { start: number; end: number }[] = [];
    let updatingFrom = 0;
    const offStatus = stage.status.subscribe(() => {
      const updating = Boolean(stage.status.get().updating);
      if (updating && !updatingFrom) updatingFrom = Date.now();
      else if (!updating && updatingFrom) {
        updates.push({ start: updatingFrom, end: Date.now() });
        if (updates.length > 10) updates.shift();
        updatingFrom = 0;
      }
    });

    const begin = (start: number) => {
      if (episode) episode.start = Math.min(episode.start, start);
      else episode = { start, visual: false, audio: false, frozen: false, layers: new Set(), ai: false, update: false };
    };
    /** What the stage says now, and what happened since the stop began. */
    const observe = (now: number) => {
      if (!episode) return;
      let diagnostics: Diagnostics | undefined;
      try {
        diagnostics = (stage.api as { getDiagnostics?: () => Diagnostics } | undefined)?.getDiagnostics?.();
      } catch {}
      if (diagnostics?.waiting) episode.visual = true;
      else if (diagnostics?.audio?.buffering) episode.audio = true;
      const scene = diagnostics?.scene;
      for (const load of scene?.loading ?? []) episode.layers.add(load.name || load.id);
      for (const load of scene?.layerLoads ?? []) if ((load.end ?? now) > episode.start && load.start < now) episode.layers.add(load.name || load.id);
      if (aiBusyBetween(episode.start, now)) episode.ai = true;
      if ((updatingFrom && updatingFrom < now) || updates.some((span) => span.start < now && span.end > episode!.start)) episode.update = true;
    };
    const show = (next: Stall | null) => {
      const key = next ? `${next.reason}|${next.ms ?? ""}` : "";
      if (key === shown) return;
      shown = key;
      setStall(next);
    };
    const finish = (now: number) => {
      if (!episode) return;
      const ms = now - episode.start;
      const reason = describe(episode);
      episode = null;
      window.clearTimeout(keep);
      if (ms < SHOWN_MS) return show(null);
      show({ reason, ms });
      keep = window.setTimeout(() => show(null), KEEP_MS);
    };

    const tick = () => {
      frame = 0;
      const now = Date.now();
      const { playing, buffering } = stage.playback.get();
      const gap = lastFrame && !document.hidden ? now - lastFrame : 0;
      lastFrame = now;
      if (gap > FROZEN_MS) {
        begin(now - gap);
        episode!.frozen = true;
      }
      if (buffering) begin(now);
      if (episode) {
        if (!buffering || now - polled > 300) {
          observe(now);
          polled = now;
        }
        if (buffering) {
          window.clearTimeout(keep);
          show({ reason: describe(episode) });
        } else finish(now);
      }
      if (playing || buffering) frame = requestAnimationFrame(tick);
      else lastFrame = 0;
    };
    const offPlayback = stage.playback.subscribe(() => {
      const { playing, buffering } = stage.playback.get();
      if ((playing || buffering) && !frame) frame = requestAnimationFrame(tick);
    });
    const hidden = () => (lastFrame = 0);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      offStatus();
      offPlayback();
      document.removeEventListener("visibilitychange", hidden);
      cancelAnimationFrame(frame);
      window.clearTimeout(keep);
    };
  }, [stage]);
  return stall;
}

/** The likely causes, most telling first: at most two. */
function describe(episode: Episode) {
  const reasons: string[] = [];
  if (episode.update) reasons.push("换上刚改的版本");
  if (episode.ai) reasons.push("AI 在后台画画面");
  if (episode.layers.size) {
    const names = [...episode.layers];
    reasons.push(`创建图层${names.slice(0, 2).map((name) => `「${name}」`).join("")}${names.length > 2 ? ` 等 ${names.length} 个` : ""}`);
  }
  if (!reasons.length && episode.audio && !episode.visual) reasons.push("准备声音");
  if (!reasons.length && episode.visual) reasons.push("这一帧画得慢");
  if (!reasons.length && episode.frozen) reasons.push("页面在忙别的计算");
  return reasons.slice(0, 2).join("、") || "加载中";
}

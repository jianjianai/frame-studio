import { createPlayerSession, type PlaybackSnapshot } from "../engine/player-session";
import { projectAudioTracks, type AnimationProject, type Quality } from "../engine/types";
import type { StudioApi } from "../engine/debug";
import { importWork, workSourceFromQuery, changeKinds } from "./load-work";
import { attachZoom, type Zoom } from "./zoom";
import { serverEvents } from "./server-events";
import "./stage.css";

/**
 * The stage only draws the work. The studio (same origin) drives playback through
 * `window.__FRAME_STAGE__` and receives state via postMessage. Saved edits are
 * hot-swapped into the running session, keeping the playhead.
 */
export interface StageStatus {
  status: "loading" | "ready" | "error";
  error?: string;
  updating?: boolean;
  revision: number;
  project?: {
    id: string;
    title: string;
    duration: number;
    fps: number;
    width: number;
    height: number;
    tracks: { id: string; name: string; kind: string }[];
    beats: AnimationProject["beats"];
    subtitles: AnimationProject["subtitles"];
    sample?: AnimationProject["sample"] | null;
  };
}
export interface StageApi {
  player(): StudioApi | undefined;
  project(): AnimationProject | undefined;
  status(): StageStatus;
  setQuality(quality: Quality): void;
  setSubtitles(enabled: boolean): void;
  reload(): Promise<void>;
  /** Looking closer at the frame; the studio hears of changes as `zoom` messages. */
  zoom: Pick<Zoom, "toggle" | "reset">;
}
declare global {
  interface Window {
    __FRAME_STAGE__?: StageApi;
  }
}

const params = new URLSearchParams(location.search);
const source = workSourceFromQuery(params);
const root = document.getElementById("stage")!;
const canvas = document.createElement("canvas");
canvas.className = "stage-canvas";
root.append(canvas);
const banner = document.createElement("div");
banner.className = "stage-banner";
banner.hidden = true;
root.append(banner);
/** Letterbox the frame inside the iframe at any size, keeping the work's aspect ratio. */
const fit = () => {
  const ratio = canvas.width && canvas.height ? canvas.width / canvas.height : 16 / 9;
  const width = Math.min(root.clientWidth, root.clientHeight * ratio);
  canvas.style.width = Math.floor(width) + "px";
  canvas.style.height = Math.floor(width / ratio) + "px";
};
new ResizeObserver(fit).observe(root);
new MutationObserver(fit).observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });

let quality = (params.get("quality") as Quality) || "standard";
let subtitles = params.get("subtitles") !== "0";
let project: AnimationProject | undefined;
let session: ReturnType<typeof createPlayerSession> | undefined;
let state: StageStatus = { status: "loading", revision: 0 };
let lastSnapshot: PlaybackSnapshot = { time: Number(params.get("t") || 0), playing: false, buffering: false, rate: 1, loop: false, volume: 1, muted: false };
const trackControls: Record<string, { gain: number; muted: boolean }> = {};

const post = (message: Record<string, unknown>) => {
  if (parent !== window) parent.postMessage({ source: "frame-stage", ...message }, location.origin);
};
// Zoomed in, the frame shows at the work's own size as "100%" (the canvas may draw fewer pixels).
const zoom = attachZoom(root, canvas, {
  natural: () => state.project,
  keys: document,
  onChange: (value) => post({ type: "zoom", ...value }),
});
// A click on the preview gives this frame the keyboard; the studio's shortcuts (space,
// arrows, undo) still belong to the studio, so key presses are handed up (but not the zoom's).
addEventListener("keydown", (event) => {
  if (parent === window || event.defaultPrevented || (event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
  if ([" ", "ArrowLeft", "ArrowRight", "Home"].includes(event.key)) event.preventDefault();
  const { key, code, ctrlKey, metaKey, shiftKey, altKey } = event;
  post({ type: "key", key, code, ctrlKey, metaKey, shiftKey, altKey });
});
function summary(p: AnimationProject): StageStatus["project"] {
  const size = p.composition ?? { width: 1920, height: 1080 };
  return {
    id: p.id,
    title: p.title,
    duration: p.duration,
    fps: p.fps,
    width: size.width,
    height: size.height,
    tracks: projectAudioTracks(p).map((track) => ({ id: track.id, name: track.name, kind: track.kind })),
    beats: p.beats,
    subtitles: p.subtitles,
    sample: p.sample ?? null,
  };
}
function setStatus(next: Partial<StageStatus>) {
  state = { ...state, ...next };
  // Inside the studio a load failure is shown by the studio itself; update warnings stay on the stage.
  banner.hidden = !state.error || (parent !== window && state.status === "error");
  banner.textContent = state.error ?? "";
  banner.dataset.kind = state.status === "error" ? "error" : "warning";
  post({ type: "status", ...state });
}

function start(next: AnimationProject, initial: PlaybackSnapshot) {
  session?.dispose();
  project = next;
  session = createPlayerSession({
    canvas,
    project: next,
    quality,
    embedded: true,
    initial: { ...initial, playing: false },
    controls: trackControls,
    subtitles: () => subtitles,
    segmentEnd: () => null,
    onSegmentEnd() {},
    onSnapshot(snapshot) {
      lastSnapshot = snapshot;
      post({ type: "playback", snapshot });
    },
    onLoading(loading) {
      if (!loading && state.status === "loading") setStatus({ status: "ready", project: summary(next) });
    },
    onError(error) {
      if (error) setStatus({ status: state.status === "loading" ? "error" : state.status, error });
      else if (state.error) setStatus({ error: undefined });
    },
    onFps(fps) {
      post({ type: "fps", fps });
    },
    onTrackControl(id, control) {
      trackControls[id] = control;
    },
  });
  setStatus({ status: "loading", project: summary(next), error: undefined });
}

async function load(timestamp?: number) {
  try {
    const next = await importWork(source, timestamp);
    start(next, lastSnapshot);
  } catch (error) {
    setStatus({ status: "error", error: "作品无法加载：" + messageOf(error) });
  }
}

/** When the library code copies (.materials/) last changed: modules named by documents are imported anew. */
let materialStamp: number | undefined;
/**
 * Changed public files must not be played from the asset precache: drop them
 * from it before the work reloads them (the workbench caches the new versions).
 */
async function dropCachedAssets(files: string[]) {
  const worker = navigator.serviceWorker?.controller;
  const urls = files.flatMap((file) => {
    const match = /(?:^|\/)projects\/([^/]+)\/public\/(.+)$/.exec(file);
    return match ? [new URL(`${source.assetBase}films/${match[1]}/${match[2]}`, location.origin).href] : [];
  });
  if (!worker || !urls.length) return;
  const channel = new MessageChannel();
  const done = new Promise((resolve) => {
    channel.port1.onmessage = resolve;
    setTimeout(resolve, 1000);
  });
  worker.postMessage({ type: "invalidate", urls }, [channel.port2]);
  await done;
}

/**
 * Edits that come while one is being swapped in are taken together (all their files, the newest
 * timestamp), as the server merges edits close together: only the newest version is built.
 * `files` null: which files changed is not known (edits made while the connection was down).
 */
let queued: { timestamp: number; files: Set<string> | null } | null = null;
let draining = false;
function hotUpdate(timestamp: number, files: string[] | null) {
  if (queued) {
    queued.timestamp = Math.max(queued.timestamp, timestamp);
    if (!files) queued.files = null;
    else for (const file of files) queued.files?.add(file);
  } else queued = { timestamp, files: files && new Set(files) };
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        await applyUpdate(next.timestamp, next.files && [...next.files]);
      }
    } finally {
      draining = false;
    }
  })();
}

async function applyUpdate(timestamp: number, files: string[] | null) {
  setStatus({ updating: true });
  try {
    if (files) await dropCachedAssets(files);
    if (!files || files.some((file) => file.includes("/.materials/"))) materialStamp = timestamp;
    const next = await importWork(source, timestamp, materialStamp);
    // Scene code may compute beat times when it is imported: a new grid needs fresh modules.
    if (JSON.stringify(next.tempo) !== JSON.stringify(project?.tempo) && project) return location.reload();
    const kinds = files ? changeKinds(files) : { visual: true, audio: true };
    if (!session || state.status === "error" || next.renderer !== project?.renderer) start(next, lastSnapshot);
    else {
      // A sample that plays the work's sound from elsewhere hears another part of it.
      const audioChanged = kinds.audio || JSON.stringify(next.sample) !== JSON.stringify(project?.sample);
      await session.updateProject(next, { visualChanged: kinds.visual, audioChanged, quality });
      project = next;
    }
    setStatus({
      updating: false,
      error: undefined,
      status: state.status === "error" ? "loading" : state.status,
      revision: state.revision + 1,
      project: summary(next),
    });
    post({ type: "updated", files: files ?? [], revision: state.revision });
  } catch (error) {
    setStatus({ updating: false, error: "修改未能生效，仍显示上一个可用版本：" + messageOf(error) });
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

window.__FRAME_STAGE__ = {
  player: () => session?.api,
  project: () => project,
  status: () => state,
  setQuality(next) {
    if (next === quality) return;
    quality = next;
    if (project && session) void session.updateProject(project, { quality, visualChanged: true, audioChanged: false });
  },
  setSubtitles(enabled) {
    subtitles = enabled;
    if (session) void session.api.seek(lastSnapshot.time);
  },
  reload: () => load(Date.now()),
  zoom: { toggle: zoom.toggle, reset: zoom.reset },
};

window.addEventListener("error", (event) => setStatus({ error: "运行错误：" + event.message }));
window.addEventListener("unhandledrejection", (event) => setStatus({ error: "运行错误：" + messageOf(event.reason) }));

if (params.get("live") !== "0") {
  const work = params.get("work");
  serverEvents().subscribe((message) => {
    // Edits saved while the connection was down never arrived: take whatever changed since.
    if (message.type === "reconnected") return hotUpdate(Date.now(), null);
    if (message.type !== "preview-update" || message.work !== work) return;
    const files = message.files as string[];
    // Material library files keep their address when the work's lock moves to another
    // version, but decoded media are cached by address: start over.
    if (files.some((file) => file.endsWith("materials.lock.json"))) location.reload();
    else hotUpdate(message.timestamp as number, files);
  });
}
void load();

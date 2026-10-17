import { createContext, useContext, useSyncExternalStore } from "react";
import type { CheckResult, PlaybackSnapshot, StageStatus, WorkInfo } from "../lib/types";
import type { TimelineHistory } from "./timelineHistory";
import type { ZoomState } from "../../src/preview/zoom";

/** Tiny observable value for high-frequency state (playhead) outside React's tree. */
export class Observable<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  set(value: T) {
    if (Object.is(value, this.value)) return;
    this.value = value;
    this.listeners.forEach((listener) => listener());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
export function useObservable<T>(observable: Observable<T>) {
  return useSyncExternalStore(observable.subscribe, observable.get, observable.get);
}

interface StudioApi {
  ready: boolean;
  duration: number;
  frame(time: number, subtitles?: boolean): Promise<void>;
  seek(time: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  capture?(): Promise<string>;
  setRate?(rate: number): void;
  setLoop?(loop: boolean): void;
  setVolume?(volume: number): void;
  setTrack?(id: string, control: Partial<{ gain: number; muted: boolean }>): void;
}
export interface StageApi {
  player(): StudioApi | undefined;
  status(): StageStatus;
  setQuality(quality: "draft" | "standard" | "high"): void;
  setSubtitles(enabled: boolean): void;
  reload(): Promise<void>;
  zoom: { toggle(): void; reset(): void };
}

/**
 * Controls a stage iframe: the film's preview, which every part of the workbench uses to
 * seek/play/capture, or a sample's tab. Stages side by side (split editors) can play together;
 * starting one stops the ones out of sight, which would otherwise be heard and not seen.
 */
export class StageController {
  private static all = new Set<StageController>();
  frame: HTMLIFrameElement | null = null;
  /** Shown in an editor group now (the editor area keeps it up to date). */
  visible = true;
  constructor() {
    StageController.all.add(this);
  }
  playback = new Observable<PlaybackSnapshot>({ time: 0, playing: false, buffering: false, rate: 1, loop: false, volume: 1, muted: false });
  status = new Observable<StageStatus>({ status: "loading", revision: 0 });
  fps = new Observable<number>(0);
  /** How far the frame is zoomed in (1: fitted), as the stage reports it. */
  zoom = new Observable<ZoomState>({ scale: 1, percent: null });
  private stage(): StageApi | undefined {
    return (this.frame?.contentWindow as unknown as { __FRAME_STAGE__?: StageApi } | null)?.__FRAME_STAGE__;
  }
  get api() {
    return this.stage()?.player();
  }
  get duration() {
    return this.status.get().project?.duration ?? 0;
  }
  seek(time: number) {
    const clamped = Math.max(0, Math.min(this.duration || time, time));
    this.playback.set({ ...this.playback.get(), time: clamped });
    return this.api?.seek(clamped);
  }
  async play() {
    for (const other of StageController.all) if (other !== this && !other.visible) other.pause();
    await this.api?.play();
  }
  /** The stage goes away (a closed tab). */
  dispose() {
    this.pause();
    StageController.all.delete(this);
    this.frame = null;
  }
  pause() {
    this.api?.pause();
  }
  toggle() {
    if (this.playback.get().playing) this.pause();
    else void this.play();
  }
  step(frames: number) {
    const fps = this.status.get().project?.fps || 30;
    this.pause();
    return this.seek(Math.round(this.playback.get().time * fps + frames) / fps);
  }
  /** PNG data URL of the current frame. */
  async capture() {
    const api = this.api;
    if (!api?.capture) throw new Error("预览尚未就绪");
    return api.capture();
  }
  setQuality(quality: "draft" | "standard" | "high") {
    this.stage()?.setQuality(quality);
  }
  setSubtitles(enabled: boolean) {
    this.stage()?.setSubtitles(enabled);
  }
  reload() {
    return this.stage()?.reload();
  }
  /** Fitted ↔ zoomed in to the frame's actual size. */
  toggleZoom() {
    this.stage()?.zoom.toggle();
  }
  handleMessage(data: Record<string, unknown>) {
    if (data.type === "playback") this.playback.set(data.snapshot as PlaybackSnapshot);
    else if (data.type === "status") {
      const { source, type, ...status } = data;
      void source;
      void type;
      this.status.set(status as unknown as StageStatus);
    } else if (data.type === "fps") this.fps.set(data.fps as number);
    else if (data.type === "zoom") this.zoom.set({ scale: data.scale as number, percent: data.percent as number | null });
  }
}

export type ChatAttachment =
  | { type: "frame"; time: number; data: string; mimeType: string; scene?: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "range"; start: number; end: number }
  | { type: "layer"; id: string; name?: string }
  | { type: "asset"; url: string; path?: string }
  | { type: "file"; path: string }
  | { type: "experience"; library: string; path: string }
  /** A file or folder of the repository's skills (`<skill>/<path>`). */
  | { type: "skill"; path: string }
  | { type: "resource"; id: string; title?: string }
  | { type: "problem"; message: string };

export interface Selection {
  kind: "layer" | "audio" | "subtitle" | "beat" | "track";
  id: string;
  index?: number;
}

/** What has versions: the work, each experience and material library (a branch each), and the repository's reviews and skills. */
export type VersionSource = "work" | "experience" | "materials" | "reviews" | "skills";
/**
 * Tools that open as editor tabs (wide, many options or much data) instead of side bar views:
 * export, reviews, the libraries' resources, and the management of the material or
 * experience libraries.
 */
export type Tool = "export" | "reviews" | "resources" | "libraries:materials" | "libraries:experiences";

export interface WorkbenchContextValue {
  work: WorkInfo;
  reload: () => Promise<void>;
  stage: StageController;
  /** A sample's tab is in front (`null`: it is not any more): the shortcuts and the AI follow its stage. */
  focusStage: (focus: { stage: StageController; path: string } | null) => void;
  /** The stage the user looks at: a sample's (`scene` is its file) when its tab is in front, else the film's. */
  currentStage: () => { stage: StageController; scene?: string };
  check: CheckResult | null;
  runCheck: () => Promise<void>;
  /** `preview`: a VS Code preview tab, replaced by the next preview until it is kept (double-click or edit). */
  openFile: (path: string, options?: { line?: number; preview?: boolean; split?: "left" | "right" | "up" | "down" }) => void;
  /** Play a module of the work on its own (a sample, a sheet) in its tab. */
  openSample: (path: string, options?: { preview?: boolean; split?: "left" | "right" | "up" | "down" }) => void;
  /** Open a document of the repository's experience libraries (path relative to the experience branch). */
  openExperience: (path: string, options?: { preview?: boolean }) => void;
  /** Open a file of the material libraries (`<library>/<path>`) in a viewer tab. */
  openMaterial: (ref: string, options?: { preview?: boolean }) => void;
  /** Preview a resource or sound of the material libraries (`<library>/<file>#<name>`) in a tab. */
  openResource: (id: string, options?: { preview?: boolean; title?: string }) => void;
  /** Open a file of a work's review (`<work id>/<path>`): documents to edit, original files to view. */
  openReview: (path: string, options?: { preview?: boolean }) => void;
  /** Open a file of the repository's skills (`<skill>/<path>`); `edit`: a document in the editor, not rendered. */
  openSkill: (path: string, options?: { preview?: boolean; edit?: boolean }) => void;
  /** Open changes as a diff tab (like VS Code); `query` is the /diff query: file=…, commit=… or empty. `library`: whose (experience, materials). */
  openDiff: (title: string, query: string, options?: { preview?: boolean; source?: VersionSource; library?: string }) => void;
  /** Open (or show) a tool's tab: export, reviews, resources, library management. */
  openTool: (tool: Tool) => void;
  /** The branch the 版本与同步 view shows (for libraries, which one of each kind); `showVersions` opens that view on a branch. */
  versionSource: VersionSource;
  versionLibrary: Partial<Record<VersionSource, string>>;
  showVersions: (source?: VersionSource, library?: string) => void;
  addToChat: (attachment: ChatAttachment, prompt?: string) => void;
  askAi: (prompt: string, attachments?: ChatAttachment[]) => void;
  /** Put a prompt into the chat's input box (opening the chat). */
  insertPrompt: (text: string) => void;
  /** The work is published: view-only (exports and the experience library still work). */
  readOnly: boolean;
  selection: Selection | null;
  select: (selection: Selection | null) => void;
  /** Exactly what the user is looking at now; sent with each chat message for the AI. */
  viewNow: () => {
    time: number;
    playing: boolean;
    selection: Selection | null;
    editing: string | null;
    sample?: { path: string; time: number; playing: boolean };
  };
  showPanel: (tab: string) => void;
  showView: (view: string) => void;
  openSettings: (section?: string) => void;
  /** Undo history of manual timeline edits, shared by the timeline and the properties view. */
  history: TimelineHistory;
}
export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);
export function useWorkbench() {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("WorkbenchContext missing");
  return value;
}

/**
 * Whether the editor tab a component is in is shown: tabs stay mounted while another tab of
 * their group is shown (until they are closed), so what plays pauses out of sight.
 */
export const TabVisible = createContext(true);
export const useTabVisible = () => useContext(TabVisible);

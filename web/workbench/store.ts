import { createContext, useContext, useSyncExternalStore } from "react";
import type { CheckResult, PlaybackSnapshot, StageStatus, WorkInfo } from "../lib/types";
import type { TimelineHistory } from "./timelineHistory";

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
  exportWebm(options: {
    width: number;
    fps: number;
    start?: number;
    end?: number;
    subtitles: boolean;
    signal: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  }): Promise<Blob | null>;
  player(): StudioApi | undefined;
  status(): StageStatus;
  setQuality(quality: "draft" | "standard" | "high"): void;
  setSubtitles(enabled: boolean): void;
  reload(): Promise<void>;
}

/** Controls the preview iframe; every part of the workbench uses this to seek/play/capture. */
export class StageController {
  frame: HTMLIFrameElement | null = null;
  playback = new Observable<PlaybackSnapshot>({ time: 0, playing: false, buffering: false, rate: 1, loop: false, volume: 1, muted: false });
  status = new Observable<StageStatus>({ status: "loading", revision: 0 });
  fps = new Observable<number>(0);
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
    await this.api?.play();
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
  exportWebm(options: Parameters<StageApi["exportWebm"]>[0]) {
    const stage = this.stage();
    if (!stage) throw new Error("预览尚未就绪");
    return stage.exportWebm(options);
  }
  handleMessage(data: Record<string, unknown>) {
    if (data.type === "playback") this.playback.set(data.snapshot as PlaybackSnapshot);
    else if (data.type === "status") {
      const { source, type, ...status } = data;
      void source;
      void type;
      this.status.set(status as unknown as StageStatus);
    } else if (data.type === "fps") this.fps.set(data.fps as number);
  }
}

export type ChatAttachment =
  | { type: "frame"; time: number; data: string; mimeType: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "range"; start: number; end: number }
  | { type: "layer"; id: string; name?: string }
  | { type: "asset"; url: string; path?: string }
  | { type: "file"; path: string }
  | { type: "experience"; library: string; path: string }
  | { type: "problem"; message: string };

export interface Selection {
  kind: "layer" | "audio" | "subtitle" | "beat" | "track";
  id: string;
  index?: number;
}

export interface WorkbenchContextValue {
  work: WorkInfo;
  reload: () => Promise<void>;
  stage: StageController;
  check: CheckResult | null;
  runCheck: () => Promise<void>;
  /** `preview`: a VS Code preview tab, replaced by the next preview until it is kept (double-click or edit). */
  openFile: (path: string, options?: { line?: number; preview?: boolean }) => void;
  /** Open a document of the repository's experience libraries (path relative to the experience branch). */
  openExperience: (path: string, options?: { preview?: boolean }) => void;
  /** Open changes as a diff tab (like VS Code); `query` is the /diff query: file=…, commit=… or empty. */
  openDiff: (title: string, query: string, options?: { preview?: boolean; source?: "work" | "experience" | "materials" }) => void;
  addToChat: (attachment: ChatAttachment, prompt?: string) => void;
  askAi: (prompt: string, attachments?: ChatAttachment[]) => void;
  /** Put a prompt into the chat's input box (opening the chat). */
  insertPrompt: (text: string) => void;
  /** The work is published: view-only (exports and the experience library still work). */
  readOnly: boolean;
  selection: Selection | null;
  select: (selection: Selection | null) => void;
  /** Exactly what the user is looking at now; sent with each chat message for the AI. */
  viewNow: () => { time: number; playing: boolean; selection: Selection | null; editing: string | null };
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

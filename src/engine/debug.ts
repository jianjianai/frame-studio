import type { AnimationProject, Sample } from "./types";
export interface StudioApi {
  ready: boolean;
  projectId: string;
  duration: number;
  /** A module playing on its own: what it declared as a sample (render page). */
  sample?: Sample | null;
  frame(time: number, subtitles?: boolean): Promise<void>;
  seek(time: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  getState(): {
    time: number;
    playing: boolean;
    rate: number;
    loop: boolean;
    audioState: string;
    width: number;
    height: number;
  };
  dataURL(): string;
  /** The frame as a PNG data URL (or `encoding`, e.g. JPEG); `region` (output pixels) cuts a part of it out. */
  capture?(region?: CaptureRegion, encoding?: { type: string; quality?: number }): Promise<string>;
  /** The frame as 8-bit luma, row by row, base64 (motion analysis). */
  luma?(): Promise<string>;
  /** Render at another width (and quality) from now on, without reloading the work. */
  resize?(width: number, quality?: "draft" | "standard" | "high"): Promise<{ width: number; height: number }>;
  /** Render page: draw this project (the work imported again after an edit) from now on, without reloading the page. */
  replace?(project: AnimationProject): Promise<{ width: number; height: number }>;
  /** Render page: import the work again (`timestamp` busts the module cache; `materials`, library code changed too) and draw it. */
  update?(timestamp: number, materials?: number): Promise<{ width: number; height: number }>;
  audioChunk?(
    start: number,
    duration: number,
    trackId?: string,
    format?: "pcm16" | "float32",
  ): Promise<string>;
  waitUntilReady?(options?: {
    audio?: boolean;
    timeoutMs?: number;
  }): Promise<void>;
  captureAt?(
    time: number,
    options?: { subtitles?: boolean; audio?: boolean; timeoutMs?: number },
  ): Promise<{
    time: number;
    dataURL: string;
    diagnostics: Record<string, unknown>;
  }>;
  setRate?(rate: number): void;
  setLoop?(loop: boolean): void;
  setVolume?(volume: number): void;
  setTrack?(
    id: string,
    control: Partial<{ gain: number; muted: boolean }>,
  ): void;
  getDiagnostics?(): Record<string, unknown>;
  getParameters?(): Record<
    string,
    { value: number; min: number; max: number; step?: number; label?: string }
  >;
  setParameters?(values: Record<string, number>): void | Promise<void>;
  setOverlay?(enabled: boolean): void | Promise<void>;
}
export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export async function waitForStudio(
  api: StudioApi,
  options: { timeoutMs?: number } = {},
) {
  const deadline = performance.now() + (options.timeoutMs ?? 60000);
  while (!api.ready) {
    if (performance.now() >= deadline)
      throw new Error("Timed out waiting for scene readiness");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
declare global {
  interface Window {
    __FRAME_STUDIO__?: StudioApi;
  }
}

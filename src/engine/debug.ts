export interface StudioApi {
  ready: boolean;
  projectId: string;
  duration: number;
  frame(time: number, subtitles?: boolean): void;
  seek(time: number): void;
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
  audioChunk?(
    start: number,
    duration: number,
    trackId?: string,
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
  setTrack?(
    id: string,
    control: Partial<{ gain: number; muted: boolean }>,
  ): void;
  getDiagnostics?(): Record<string, unknown>;
  getParameters?(): Record<
    string,
    { value: number; min: number; max: number; step?: number; label?: string }
  >;
  setParameters?(values: Record<string, number>): void;
  setOverlay?(enabled: boolean): void;
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

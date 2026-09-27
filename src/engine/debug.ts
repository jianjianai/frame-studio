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
  audioChunk?(start: number, duration: number): Promise<string>;
}
declare global {
  interface Window {
    __FRAME_STUDIO__?: StudioApi;
  }
}

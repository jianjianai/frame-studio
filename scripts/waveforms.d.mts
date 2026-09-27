import type { Buffer } from "node:buffer";
export function waveformFromWav(buffer: Buffer, bins?: number): number[];
export function updateWaveforms(): Promise<Record<string, number[]>>;

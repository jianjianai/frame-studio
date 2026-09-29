import {
  assetUrl,
  projectAudioTracks,
  type AnimationProject,
  type GeneratedAudioModule,
} from "./types";
import type { PreparedAudio } from "./audio-graph";

type Chunk = {
  start: number;
  duration: number;
  file: string;
  sha256: string;
  bytes: number;
};
type Manifest = {
  version: number;
  duration: number;
  tracks: { id: string; chunks: Chunk[] }[];
};
export class PreviewBuffering extends Error {}

async function bytes(chunk: Chunk, signal: AbortSignal): Promise<ArrayBuffer> {
  // The workbench owns persistent storage; the untrusted opaque frame never gets
  // cookies, same-origin privileges, or a general-purpose network proxy.
  if (parent !== window) {
    const cached = await new Promise<ArrayBuffer | undefined>(
      (resolve, reject) => {
        const channel = new MessageChannel();
        let timer: ReturnType<typeof setTimeout>;
        const close = () => {
          clearTimeout(timer);
          channel.port1.close();
          signal.removeEventListener("abort", abort);
        };
        const done = (value?: ArrayBuffer) => {
          close();
          resolve(value);
        };
        const abort = () => {
          channel.port1.postMessage({ cancel: true });
          close();
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        channel.port1.onmessage = ({ data }) => {
          if (data?.ack) {
            clearTimeout(timer);
            timer = setTimeout(() => done(), 45000);
          } else
            done(data?.bytes instanceof ArrayBuffer ? data.bytes : undefined);
        };
        timer = setTimeout(() => done(), 150);
        parent.postMessage(
          {
            type: "frame-preview-audio",
            file: chunk.file,
            sha256: chunk.sha256,
            bytes: chunk.bytes,
          },
          "*",
          [channel.port2],
        );
      },
    );
    signal.throwIfAborted();
    if (cached) return cached;
  }
  const response = await fetch(assetUrl(chunk.file), { signal });
  if (!response.ok)
    throw new Error(`预览音频加载失败 (${response.status})，请重试`);
  return response.arrayBuffer();
}

export async function preparePreviewAudio(
  project: AnimationProject,
  context: BaseAudioContext,
  signal?: AbortSignal,
): Promise<PreparedAudio | undefined> {
  if (document.documentElement.dataset.previewAudio !== "1") return;
  const response = await fetch(assetUrl("preview-audio.json"), { signal });
  if (response.status === 404) return; // Older/local builds still use original audio.
  if (!response.ok) throw new Error("预览音频索引加载失败，请重试");
  const manifest: Manifest = await response.json();
  const tracks = projectAudioTracks(project);
  if (
    manifest.version !== 1 ||
    Math.abs(manifest.duration - project.duration) > 0.001 ||
    manifest.tracks.length !== tracks.length
  )
    throw new Error("预览音频已过期，请刷新预览");
  const byId = new Map(manifest.tracks.map((t) => [t.id, t.chunks]));
  for (const track of tracks) {
    let end = 0;
    const chunks = byId.get(track.id);
    if (!chunks?.length) throw new Error("预览音轨缺失");
    for (const c of chunks) {
      if (
        Math.abs(c.start - end) > 0.001 ||
        !(c.duration > 0 && c.duration <= 2.001) ||
        !/^[a-f0-9]{64}$/.test(c.sha256) ||
        c.file !== `preview-audio/${c.sha256}.mp3` ||
        !(c.bytes > 0 && c.bytes < 262144)
      )
        throw new Error("无效预览音频索引");
      end += c.duration;
    }
    if (Math.abs(end - project.duration) > 0.001)
      throw new Error("预览音频长度不一致");
  }
  const lifetime = new AbortController();
  signal?.addEventListener("abort", () => lifetime.abort(), { once: true });
  const buffers = new Map<string, AudioBuffer>();
  const pending = new Map<string, Promise<AudioBuffer>>();
  const requests = new Map<string, AbortController>();
  const load = (c: Chunk, trackId: string) => {
    if (buffers.has(c.sha256)) {
      const buffer = buffers.get(c.sha256)!;
      buffers.delete(c.sha256);
      buffers.set(c.sha256, buffer);
      return Promise.resolve(buffer);
    }
    const key = trackId + ":" + c.sha256;
    if (!pending.has(key)) {
      const controller = requests.get(trackId)!;
      const combined = AbortSignal.any([lifetime.signal, controller.signal]);
      const promise = (async () => {
        const data = await bytes(c, combined);
        if (data.byteLength !== c.bytes)
          throw new Error("预览音频不完整，请重试");
        const digest = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
        ]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== c.sha256)
          throw new Error("预览音频校验失败，请刷新预览");
        const buffer = await context.decodeAudioData(data);
        combined.throwIfAborted();
        if (Math.abs(buffer.duration - c.duration) > 0.06)
          throw new Error("预览音频解码长度不符");
        buffers.set(c.sha256, buffer);
        // Bounded by active track count, never film duration (up to ~123 MB for 32 tracks).
        while (buffers.size > Math.max(40, tracks.length * 5))
          buffers.delete(buffers.keys().next().value!);
        return buffer;
      })().finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
      pending.set(key, promise);
    }
    return pending.get(key)!;
  };
  const cancellable = async (
    promise: Promise<unknown>,
    abort?: AbortSignal,
  ) => {
    abort?.throwIfAborted();
    if (!abort) return promise;
    await new Promise((resolve, reject) => {
      const cancel = () => reject(abort.reason);
      abort.addEventListener("abort", cancel, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => abort.removeEventListener("abort", cancel));
    });
  };
  const generated: GeneratedAudioModule = {
    async prepareSegment({ trackId, offset, signal: requestSignal }) {
      requests.get(trackId)?.abort();
      for (const key of pending.keys())
        if (key.startsWith(trackId + ":")) pending.delete(key);
      const controller = new AbortController();
      requests.set(trackId, controller);
      requestSignal?.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
      const chunks = byId.get(trackId)!;
      const initial = chunks.filter(
        (c) =>
          c.start + c.duration > offset + 0.00001 && c.start < offset + 0.25,
      );
      await cancellable(
        Promise.all(initial.map((c) => load(c, trackId))),
        requestSignal,
      );
    },
    createAudio({
      trackId,
      context,
      destination,
      when,
      offset,
      duration,
      rate,
      onError,
    }) {
      const chunks = byId
        .get(trackId)!
        .filter(
          (c) =>
            c.start < offset + duration &&
            c.start + c.duration > offset + 0.00001,
        );
      const sources = new Set<AudioBufferSourceNode>();
      const requested = new Set<string>();
      let cursor = 0,
        disposed = false;
      const fail = (error: unknown) => {
        if (!disposed) {
          disposed = true;
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const tick = () => {
        if (disposed) return;
        const now = context.currentTime;
        // Limit requests to the next six seconds; seeking does not synthesize the prefix.
        for (const c of chunks.slice(cursor)) {
          const at = when + (Math.max(c.start, offset) - offset) / rate;
          if (at > now + Math.min(6, 6 / rate)) break;
          if (!requested.has(c.sha256)) {
            requested.add(c.sha256);
            void load(c, trackId).then(() => tick(), fail);
          }
        }
        while (cursor < chunks.length) {
          const c = chunks[cursor],
            start = Math.max(c.start, offset);
          const at = when + (start - offset) / rate;
          if (at > now + Math.min(3, 3 / rate)) break;
          const buffer = buffers.get(c.sha256);
          if (!buffer) {
            if (at < now + 0.08) fail(new PreviewBuffering());
            break;
          }
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = rate;
          source.connect(destination);
          sources.add(source);
          source.onended = () => {
            source.disconnect();
            sources.delete(source);
          };
          source.start(
            at,
            start - c.start,
            Math.min(c.start + c.duration, offset + duration) - start,
          );
          cursor++;
        }
      };
      const timer = setInterval(tick, 40);
      tick();
      return {
        dispose() {
          disposed = true;
          clearInterval(timer);
          requests.get(trackId)?.abort();
          for (const source of sources) {
            source.onended = null;
            source.stop();
            source.disconnect();
          }
          sources.clear();
        },
      };
    },
    disposeAudio() {
      lifetime.abort();
      buffers.clear();
    },
  };
  return {
    preview: true,
    buffers: new Map(),
    generated,
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: "generated",
      gain: t.gain,
      muted: t.muted,
      start: 0,
      offset: 0,
      duration: project.duration,
    })),
  };
}

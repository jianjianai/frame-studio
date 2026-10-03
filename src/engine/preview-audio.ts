import {
  assetUrl,
  projectAudioTracks,
  type AnimationProject,
  type GeneratedAudioModule,
} from "./types";
import type { PreparedAudio } from "./audio-graph";
import { browserSha256 } from "../browser/hash.mjs";
import {
  PreviewBuffering,
  MediaRequestQueue,
  LIVE_BUFFER_SECONDS,
  LIVE_LOOKAHEAD_SECONDS,
} from "./media-buffering";

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
export { PreviewBuffering } from "./media-buffering";

async function bytes(chunk: Chunk, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
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
          if (!value) channel.port1.postMessage({ cancel: true });
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
        // This is a local message handshake, but startup/hydration can keep the
        // host main thread busy. A 150 ms fallback races its acknowledged fetch.
        timer = setTimeout(() => done(), 2000);
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
  const pending = new Map<
    string,
    { promise: Promise<AudioBuffer>; controller: AbortController }
  >();
  const windows = new Map<string, Set<string>>();
  const queue = new MediaRequestQueue();
  const budget = 128 * 1024 * 1024;
  let cacheBytes = 0,
    downloadMs = 0;
  // Reserve one extra boundary chunk per track within the same PCM budget.
  const horizon = (seconds: number, rate: number) =>
    Math.min(
      seconds * rate,
      Math.max(2, budget / Math.max(1, tracks.length) / (48000 * 8) - 4),
    );
  const startupSeconds = () =>
    Math.min(8, Math.max(6, LIVE_BUFFER_SECONDS, downloadMs / 1000 + 2));
  const selectWindow = (trackId: string, offset: number, rate: number) => {
    const chunks = byId
      .get(trackId)!
      .filter(
        (c) =>
          c.start + c.duration > offset + 0.00001 &&
          c.start <
            offset +
              horizon(
                Math.max(LIVE_LOOKAHEAD_SECONDS, startupSeconds() + 4),
                rate,
              ),
      );
    windows.set(trackId, new Set(chunks.map((c) => c.sha256)));
    const wanted = new Set([...windows.values()].flatMap((v) => [...v]));
    for (const [key, entry] of pending)
      if (!wanted.has(key)) {
        entry.controller.abort();
        pending.delete(key);
      }
    return chunks;
  };
  const load = (c: Chunk) => {
    if (buffers.has(c.sha256)) {
      const buffer = buffers.get(c.sha256)!;
      buffers.delete(c.sha256);
      buffers.set(c.sha256, buffer);
      return Promise.resolve(buffer);
    }
    const key = c.sha256;
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const combined = AbortSignal.any([lifetime.signal, controller.signal]);
      const promise = queue
        .run(
          combined,
          async () => {
            const began = performance.now();
            const data = await bytes(
              c,
              AbortSignal.any([combined, AbortSignal.timeout(45000)]),
            );
            if (data.byteLength !== c.bytes)
              throw new Error("预览音频不完整，请重试");
            const digest = await browserSha256(data, combined);
            if (digest !== c.sha256)
              throw new Error("预览音频校验失败，请刷新预览");
            const buffer = await context.decodeAudioData(data);
            combined.throwIfAborted();
            if (Math.abs(buffer.duration - c.duration) > 0.06)
              throw new Error("预览音频解码长度不符");
            downloadMs = Math.max(downloadMs * 0.85, performance.now() - began);
            buffers.set(key, buffer);
            cacheBytes += buffer.length * buffer.numberOfChannels * 4;
            while (cacheBytes > budget && buffers.size) {
              const [old, value] = buffers.entries().next().value!;
              buffers.delete(old);
              cacheBytes -= value.length * value.numberOfChannels * 4;
            }
            return buffer;
          },
          c.start,
        )
        .finally(() => {
          if (pending.get(key)?.promise === promise) pending.delete(key);
        });
      entry = { controller, promise };
      pending.set(key, entry);
    }
    return entry.promise;
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
    async prepareSegment({ trackId, offset, rate, signal: requestSignal }) {
      requestSignal?.throwIfAborted();
      const chunks = selectWindow(trackId, offset, rate);
      const initial = chunks.filter(
        (c) => c.start < offset + horizon(startupSeconds(), rate),
      );
      // Pause/preload/play share content-addressed work. Only a different seek window
      // cancels obsolete transfers; cancelling a waiter cannot discard useful bytes.
      await cancellable(
        Promise.all(initial.map((c) => load(c))),
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
        const position = offset + Math.max(0, now - when) * rate;
        for (const c of selectWindow(trackId, position, rate)) {
          if (!buffers.has(c.sha256) && !pending.has(c.sha256))
            void load(c).then(
              () => tick(),
              (error) => {
                if (error?.name !== "AbortError") fail(error);
              },
            );
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
      windows.clear();
      buffers.clear();
      cacheBytes = 0;
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

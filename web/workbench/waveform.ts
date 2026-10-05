/** Peak envelopes of audio files, decoded once per URL in the browser. */
const cache = new Map<string, Promise<{ peaks: Float32Array; duration: number } | null>>();
const PEAKS_PER_SECOND = 100;

export function loadPeaks(url: string) {
  if (!cache.has(url))
    cache.set(
      url,
      (async () => {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          const bytes = await response.arrayBuffer();
          const context = new OfflineAudioContext(1, 1, 44100);
          const buffer = await context.decodeAudioData(bytes);
          const count = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SECOND));
          const peaks = new Float32Array(count);
          const size = buffer.length / count;
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const data = buffer.getChannelData(channel);
            for (let index = 0; index < count; index++) {
              const from = Math.floor(index * size),
                to = Math.min(data.length, Math.floor((index + 1) * size));
              let peak = 0;
              for (let sample = from; sample < to; sample += 4) peak = Math.max(peak, Math.abs(data[sample]));
              peaks[index] = Math.max(peaks[index], peak);
            }
          }
          return { peaks, duration: buffer.duration };
        } catch {
          return null;
        }
      })(),
    );
  return cache.get(url)!;
}

/** Draw the part [offset, offset + duration * rate] of a file into a canvas. */
export function drawPeaks(
  canvas: HTMLCanvasElement,
  data: { peaks: Float32Array; duration: number },
  offset: number,
  duration: number,
  rate = 1,
  color = "rgba(255,255,255,0.55)",
) {
  const ratio = devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  const mid = height / 2;
  for (let x = 0; x < width; x++) {
    const time = offset + (x / width) * duration * rate;
    const index = Math.floor(time * PEAKS_PER_SECOND);
    if (index < 0 || index >= data.peaks.length) continue;
    const value = data.peaks[index] * mid * 0.95;
    ctx.fillRect(x, mid - value, 1, Math.max(1, value * 2));
  }
}

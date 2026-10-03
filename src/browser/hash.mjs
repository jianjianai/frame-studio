import { PreviewSha256 } from "../engine/preview-cache-storage.mjs";

/**
 * SHA-256 in secure previews and ordinary HTTP pages. The fallback reads views of
 * the original buffer and yields between bounded batches while checking abort.
 * @param {BufferSource} data
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function browserSha256(data, signal) {
  signal?.throwIfAborted();
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const result = await subtle.digest("SHA-256", data);
    signal?.throwIfAborted();
    return [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const hash = new PreviewSha256(),
    step = 64 * 1024;
  let began = performance.now();
  for (let at = 0; at < bytes.length; at += step) {
    signal?.throwIfAborted();
    hash.update(bytes.subarray(at, at + step));
    if (at + step < bytes.length && performance.now() - began >= 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      began = performance.now();
    }
  }
  signal?.throwIfAborted();
  return hash.digest();
}

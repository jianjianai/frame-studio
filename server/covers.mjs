import fs from "node:fs";
import sharp from "sharp";
import { hash, problem } from "./security.mjs";

const cache = new Map();
const waiting = [];
let active = 0, cachedBytes = 0;
const maximumCacheBytes = 8 * 1024 * 1024;

async function slot(fn) {
  if (active >= 2) {
    if (waiting.length >= 128) throw problem(503, "封面生成繁忙，请稍后刷新");
    await new Promise((resolve) => waiting.push(resolve));
  } else active++;
  try { return await fn(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// Never serve work-controlled SVG markup on the authenticated workbench origin.
// Decode every format from bytes; a misleading extension cannot bypass this boundary.
export function rasterCover(file) {
  return slot(async () => {
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw problem(413, "封面原图超过 8 MiB，请重新生成较小封面");
    const input = fs.readFileSync(file), key = hash(input);
    if (cache.has(key)) {
      const found = cache.get(key);
      cache.delete(key); cache.set(key, found);
      return found;
    }
    let buffer;
    try {
      buffer = await sharp(input, { limitInputPixels: 16777216, animated: false })
        .resize({ width: 960, height: 540, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 }).toBuffer();
    } catch { throw problem(422, "封面图像无法解码，请重新生成封面"); }
    // Another queued decode of the same bytes may have populated this key.
    if (cache.has(key)) return cache.get(key);
    const output = { buffer, etag: '"' + hash(buffer) + '"' };
    if (buffer.length <= maximumCacheBytes) {
      while (cache.size && (cache.size >= 128 || cachedBytes + buffer.length > maximumCacheBytes)) {
        const oldest = cache.keys().next().value;
        cachedBytes -= cache.get(oldest).buffer.length;
        cache.delete(oldest);
      }
      cache.set(key, output); cachedBytes += buffer.length;
    }
    return output;
  });
}

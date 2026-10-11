import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Input, FilePathSource, ALL_FORMATS } from "mediabunny";
import { mediaKind, mimeType } from "./util.mjs";
import { validateLottie } from "../src/engine/lottie-document.mjs";

const cache = new Map();

/** Duration, dimensions and codecs of a media file; cached by size+mtime. */
export async function probe(file) {
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const kind = mediaKind(file);
  const info = { kind, mime: mimeType(file), size: stat.size };
  try {
    if (kind === "image" && path.extname(file).toLowerCase() === ".svg") Object.assign(info, svgSize(file));
    else if (kind === "image") {
      const meta = await sharp(file, { animated: true }).metadata();
      Object.assign(info, { width: meta.width, height: meta.pageHeight || meta.height, frames: meta.pages || 1 });
    } else if (kind === "model" && /\.(glb|gltf)$/i.test(file)) Object.assign(info, gltfInfo(file));
    else if (kind === "environment") Object.assign(info, panoramaSize(file));
    else if (/\.json$/i.test(file)) Object.assign(info, lottieInfo(file, stat.size) ?? {});
    else if (kind === "audio" || kind === "video") {
      const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
      try {
        info.duration = Math.round((await input.computeDuration()) * 1000) / 1000;
        const video = await input.getPrimaryVideoTrack();
        const audio = await input.getPrimaryAudioTrack();
        if (video) Object.assign(info, { width: video.displayWidth, height: video.displayHeight, videoCodec: video.codec });
        if (audio) Object.assign(info, { audioCodec: audio.codec, sampleRate: audio.sampleRate, channels: audio.numberOfChannels });
      } finally {
        input.dispose?.();
      }
    }
    // .webm/.mp4 may hold only sound (microphone recordings).
    if (info.kind === "video" && !info.width && info.audioCodec) info.kind = "audio";
  } catch (error) {
    info.probeError = error.message;
  }
  cache.set(key, info);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return info;
}

/**
 * An SVG's own size from its root element (width/height, else the viewBox), read as text:
 * not rendered, so a hostile file costs nothing. Empty when it does not say.
 */
export function svgSize(file) {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(8192);
    head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    fs.closeSync(fd);
  } catch {
    return {};
  }
  const root = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!root) return {};
  const attribute = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(root)?.[1];
  const length = (value) => (value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? parseFloat(value) : null);
  let width = length(attribute("width"));
  let height = length(attribute("height"));
  const box = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if ((!width || !height) && box?.length === 4 && box[2] > 0 && box[3] > 0) {
    if (width) height = (width * box[3]) / box[2];
    else if (height) width = (height * box[2]) / box[3];
    else [width, height] = [box[2], box[3]];
  }
  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : {};
}

/** Reads at most `length` bytes from `position`. */
function readBytes(file, position, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What a glTF/GLB holds, from its JSON alone (geometry is not decoded): meshes, triangles,
 * animation clips and their lengths, skins, materials, textures and compression.
 */
export function gltfInfo(file) {
  let json;
  if (/\.glb$/i.test(file)) {
    const head = readBytes(file, 0, 20);
    if (head.length < 20 || head.readUInt32LE(0) !== 0x46546c67 || head.readUInt32LE(16) !== 0x4e4f534a) return { probeError: "不是有效的 GLB 文件" };
    json = JSON.parse(readBytes(file, 20, head.readUInt32LE(12)).toString("utf8"));
  } else {
    if (fs.statSync(file).size > 64 * 1024 * 1024) return {};
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const accessors = json.accessors ?? [];
  const trianglesOf = (mesh) =>
    (mesh?.primitives ?? []).reduce((sum, primitive) => {
      const count = accessors[primitive.indices ?? primitive.attributes?.POSITION]?.count ?? 0;
      const mode = primitive.mode ?? 4;
      return sum + (mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0);
    }, 0);
  const meshes = json.meshes ?? [];
  const placed = (json.nodes ?? []).filter((node) => Number.isInteger(node.mesh));
  const triangles = placed.length ? placed.reduce((sum, node) => sum + trianglesOf(meshes[node.mesh]), 0) : meshes.reduce((sum, mesh) => sum + trianglesOf(mesh), 0);
  const animations = (json.animations ?? []).map((animation, index) => ({
    name: animation.name || `动画 ${index + 1}`,
    // Animation inputs must carry their range (glTF 2.0): the clip ends at the latest key.
    duration: +Math.max(0, ...(animation.samplers ?? []).map((sampler) => accessors[sampler.input]?.max?.[0] ?? 0)).toFixed(3),
  }));
  const compression = { KHR_draco_mesh_compression: "Draco", EXT_meshopt_compression: "Meshopt", KHR_texture_basisu: "KTX2" };
  return {
    meshes: placed.length || meshes.length,
    triangles,
    animations,
    skinned: Boolean(json.skins?.length),
    materials: json.materials?.length ?? 0,
    textures: json.images?.length ?? 0,
    ...((json.extensionsUsed ?? []).some((name) => compression[name]) ? { compression: json.extensionsUsed.filter((name) => compression[name]).map((name) => compression[name]) } : {}),
  };
}

/** Width and height of an HDR (Radiance) or EXR panorama, from its header. */
export function panoramaSize(file) {
  const head = readBytes(file, 0, 65536);
  if (/\.hdr$/i.test(file)) {
    const match = /\n\s*[-+]Y\s+(\d+)\s+[-+]X\s+(\d+)\s*\n/.exec(head.toString("latin1"));
    return match ? { width: Number(match[2]), height: Number(match[1]) } : {};
  }
  if (head.readUInt32LE(0) !== 0x01312f76) return {};
  // Attributes: name\0 type\0 size value… until an empty name.
  for (let at = 8; at < head.length; ) {
    const nameEnd = head.indexOf(0, at);
    if (nameEnd <= at) break;
    const name = head.toString("latin1", at, nameEnd);
    const typeEnd = head.indexOf(0, nameEnd + 1);
    const size = head.readInt32LE(typeEnd + 1);
    const value = typeEnd + 5;
    if (name === "dataWindow" && value + 16 <= head.length)
      return { width: head.readInt32LE(value + 8) - head.readInt32LE(value) + 1, height: head.readInt32LE(value + 12) - head.readInt32LE(value + 4) + 1 };
    at = value + size;
  }
  return {};
}

/**
 * A JSON file that is a Lottie animation: its size, frame rate and length, and what the
 * engine's Canvas renderer cannot draw (external images, expressions). Null for other JSON.
 */
export function lottieInfo(file, size) {
  if (size > 64 * 1024 * 1024) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.layers) || !["fr", "ip", "op", "w", "h"].every((key) => typeof data[key] === "number")) return null;
  const info = { kind: "lottie", width: data.w, height: data.h, fps: data.fr, frames: Math.round(data.op - data.ip), duration: +((data.op - data.ip) / data.fr).toFixed(3) };
  try {
    validateLottie(data);
  } catch (error) {
    info.problem = /embedded/.test(error.message) ? "图片没有内嵌（导出 Lottie 时把图片内嵌为 PNG/JPEG/WebP）" : `无法播放：${error.message}`;
    return info;
  }
  // Expressions: a property with a script in "x" (the Canvas player in FRAME runs none).
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 60) return false;
    if (typeof node.x === "string" && "k" in node) return true;
    return Object.values(node).some((child) => visit(child, depth + 1));
  };
  if (visit(data, 0)) info.problem = "含有表达式，FRAME 的 Lottie 播放器不执行表达式，相关动画可能不动或画错";
  return info;
}

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { validateLottie } from "../src/engine/lottie-document.mjs";
import { fail } from "./mcp/workspace.mjs";

const groups = [
  [
    "image",
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      avif: "image/avif",
      gif: "image/gif",
    },
  ],
  [
    "audio",
    {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
      flac: "audio/flac",
      opus:"audio/ogg",aac:"audio/aac",aiff:"audio/aiff",aif:"audio/aiff",caf:"audio/x-caf",wma:"audio/x-ms-wma",
    },
  ],
  ["video", { mp4: "video/mp4", webm: "video/webm" }],
  ["animation", { json: "application/json" }],
  ["model", { glb: "model/gltf-binary", gltf: "model/gltf+json" }],
  [
    "font",
    {
      ttf: "font/ttf",
      otf: "font/otf",
      woff: "font/woff",
      woff2: "font/woff2",
    },
  ],
  ["soundfont", { sf2: "application/octet-stream" }],
  ["midi", { mid: "audio/midi", midi: "audio/midi" }],
];
export const assetTypes = Object.fromEntries(
  groups.flatMap(([type, entries]) =>
    Object.entries(entries).map(([ext, mimeType]) => [ext, { type, mimeType }]),
  ),
);
export function assetType(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!assetTypes[ext])
    fail("UNSUPPORTED_ASSET", "Unsupported material format.", {
      extensions: Object.keys(assetTypes),
    });
  return { ext, ...assetTypes[ext] };
}
export async function validateAsset(file, filename, bytes) {
  const info = assetType(filename);
  const header = Buffer.alloc(16),
    fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const at = (text, offset = 0) =>
    header.toString("ascii", offset, offset + text.length) === text;
  let valid = false;
  if (info.type === "image") {
    const meta = await sharp(file, {
      limitInputPixels: 100_000_000,
    }).metadata();
    valid =
      meta.format === ({ jpg: "jpeg", avif: "heif" }[info.ext] ?? info.ext) &&
      !!meta.width &&
      !!meta.height;
  } else if (info.type === "animation") {
    if(bytes > 16*1024*1024) fail("TOO_LARGE","Lottie limit is 16 MiB");
    validateLottie(JSON.parse(fs.readFileSync(file,"utf8")));
    valid = true;
  } else if (["gltf", "glb"].includes(info.ext)) {
    let json;
    if (info.ext === "gltf") {
      if (bytes > 16 * 1024 * 1024)
        fail("TOO_LARGE", "Use a self-contained GLB for large models.");
      json = fs.readFileSync(file, "utf8");
    } else {
      if (
        !at("glTF") ||
        header.readUInt32LE(4) !== 2 ||
        header.readUInt32LE(8) !== bytes
      )
        fail("INVALID_ASSET", "Invalid GLB header or declared length.");
      const fd = fs.openSync(file, "r"),
        chunk = Buffer.alloc(8);
      try {
        fs.readSync(fd, chunk, 0, 8, 12);
        const size = chunk.readUInt32LE(0);
        if (
          chunk.toString("ascii", 4) !== "JSON" ||
          size > 16 * 1024 * 1024 ||
          size + 20 > bytes ||
          size % 4
        )
          fail("INVALID_ASSET", "GLB must contain a bounded JSON chunk.");
        const data = Buffer.alloc(size);
        fs.readSync(fd, data, 0, size, 20);
        json = data.toString("utf8");
        let position = 20 + size;
        while (position < bytes) {
          if (position + 8 > bytes)
            fail("INVALID_ASSET", "Truncated GLB chunk.");
          fs.readSync(fd, chunk, 0, 8, position);
          const length = chunk.readUInt32LE(0);
          if (length % 4 || position + 8 + length > bytes)
            fail("INVALID_ASSET", "Invalid GLB chunk length.");
          position += 8 + length;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    const value = JSON.parse(json);
    const inspect = (node, depth = 0) => {
      if (depth > 100) fail("INVALID_ASSET", "Model nesting is too deep.");
      if (!node || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node)) {
        if (
          key === "uri" &&
          (typeof child !== "string" || !child.startsWith("data:"))
        )
          fail(
            "EXTERNAL_RESOURCE",
            "Upload a self-contained GLB or glTF with embedded data URIs.",
          );
        inspect(child, depth + 1);
      }
    };
    inspect(value);
    valid = value.asset?.version === "2.0";
  } else
    valid = {
      wav: at("RIFF") && at("WAVE", 8),
      sf2: at("RIFF") && at("sfbk", 8),
      mp3: at("ID3") || (header[0] === 255 && (header[1] & 0xe0) === 0xe0),
      ogg: at("OggS"),
      opus:at("OggS"),aac:header[0]===255&&(header[1]&0xf6)===0xf0,
      aiff:at("FORM")&&(at("AIFF",8)||at("AIFC",8)),aif:at("FORM")&&(at("AIFF",8)||at("AIFC",8)),
      caf:at("caff"),wma:header.toString("hex")==="3026b2758e66cf11a6d900aa0062ce6c",
      flac: at("fLaC"),
      m4a: at("ftyp", 4),
      mp4: at("ftyp", 4),
      webm: header.readUInt32BE(0) === 0x1a45dfa3,
      glb:
        at("glTF") &&
        header.readUInt32LE(4) === 2 &&
        header.readUInt32LE(8) === bytes,
      mid: at("MThd"),
      midi: at("MThd"),
      ttf: header.readUInt32BE(0) === 0x00010000,
      otf: at("OTTO"),
      woff: at("wOFF"),
      woff2: at("wOF2"),
    }[info.ext];
  if (!valid || bytes < 12)
    fail(
      "INVALID_ASSET",
      "File signature does not match its material extension.",
    );
  return info;
}

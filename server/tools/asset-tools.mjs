import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { workArg, asJson } from "./registry.mjs";
import { listAssets } from "./work-tools.mjs";
import { writeStream, uniquePath } from "../files.mjs";
import { problem } from "../util.mjs";
import { probe } from "../media.mjs";
import { placeAudio } from "../documents.mjs";

const extensionFor = (type) =>
  ({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "model/gltf-binary": ".glb",
    "application/json": ".json",
  })[String(type).split(";")[0].trim()] || "";

/** Download a URL into the work; refuses non-http(s) and oversized files. */
export async function importFromUrl(work, url, { name, folder = "public/imports", limit = 1024 * 1024 * 1024 } = {}) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw problem(400, "只能从 http/https 地址导入");
  const response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw problem(502, `下载失败：HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > limit) throw problem(413, "文件过大");
  let base = name || decodeURIComponent(path.basename(parsed.pathname)) || "download";
  if (!path.extname(base)) base += extensionFor(response.headers.get("content-type"));
  base = base.replace(/[\\/\x00-\x1f?#%*:|"<>]/g, "_");
  const relative = uniquePath(work.dir, `${folder.replace(/\/$/, "")}/${base}`);
  await writeStream(work.dir, relative, Readable.fromWeb(response.body), { limit });
  return relative;
}

export function registerAssetTools(registry) {
  const { services } = registry;

  registry.add({
    name: "assets_list",
    title: "素材列表",
    description: '列出作品 public/ 中的素材：引用地址 films/<名称>/...、类型、大小、时长和尺寸。代码中用 assetUrl("films/...") 引用。',
    readOnly: true,
    input: { work: workArg },
    async run(_, ctx) {
      const assets = await listAssets(await ctx.work());
      return asJson(
        assets.map(({ url, path: file, kind, size, duration, width, height, mime }) => ({ url, path: file, kind, mime, size, duration, width, height })),
      );
    },
  });

  registry.add({
    name: "asset_import",
    title: "导入素材",
    description:
      "把素材放进作品自己的 public/：从网址下载（url）或从服务器本地文件复制（file，仅本机模式）。返回代码中使用的 films/... 地址。注意素材版权，在 license 中记录来源。多个作品都要用的素材放进素材库（material_write），作品引用素材库后直接使用。",
    input: {
      work: workArg,
      url: z.string().url().optional(),
      file: z.string().optional().describe("服务器上的绝对路径（仅本机模式）"),
      name: z.string().max(120).optional().describe("保存的文件名"),
      folder: z
        .string()
        .regex(/^public(\/[\w.-]+)*$/)
        .default("public/imports"),
      license: z.string().max(500).optional().describe("来源与许可"),
    },
    async run({ url, file, name, folder, license }, ctx) {
      const work = await ctx.work();
      if ([url, file].filter(Boolean).length !== 1) throw problem(400, "url、file 必须且只能提供一个");
      let relative;
      if (url) relative = await importFromUrl(work, url, { name, folder });
      else if (file) {
        if (services.auth.required) throw problem(403, "服务器模式不能直接读取本地文件，请上传或使用 url");
        if (!path.isAbsolute(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw problem(400, "file 必须是存在的绝对路径");
        relative = uniquePath(work.dir, `${folder}/${name || path.basename(file)}`);
        fs.mkdirSync(path.dirname(path.join(work.dir, relative)), { recursive: true });
        fs.copyFileSync(file, path.join(work.dir, relative));
      }
      if (license) {
        const credits = path.join(work.dir, "production", "licenses.md");
        fs.mkdirSync(path.dirname(credits), { recursive: true });
        fs.appendFileSync(credits, `- ${relative}: ${license}\n`);
      }
      const info = await probe(path.join(work.dir, relative));
      const urlRef = `films/${work.slug}/${relative.replace(/^public\//, "")}`;
      services.events.emit({ type: "assets", work: work.id, repo: work.repo });
      return asJson({ path: relative, url: urlRef, ...info }, `已导入 ${relative}，引用地址 ${urlRef}`);
    },
  });

  registry.add({
    name: "audio_place",
    title: "放置音频",
    description: "把作品中的音频文件放到音轨上（不存在的音轨会自动创建）。用于配乐、音效、配音和录音。",
    input: {
      work: workArg,
      src: z.string().describe("films/<名称>/... 或 materials/<素材库>/... 地址"),
      start: z.number().nonnegative().default(0),
      duration: z.number().positive().optional().describe("默认放到文件结束或作品结束"),
      track: z.string().max(60).default("音效").describe("音轨名称"),
      name: z.string().max(100).optional(),
      gain: z.number().min(0).max(4).default(1),
    },
    async run({ src, start, duration, track, name, gain }, ctx) {
      const work = await ctx.work();
      const material = /^materials\/(.+)$/.exec(src);
      const file = material
        ? await services.materials.file(work.repo, services.materials.readLocks(work.dir), material[1])
        : path.join(work.dir, "public", src.replace(/^films\/[^/]+\//, ""));
      if (!fs.existsSync(file)) throw problem(404, "音频文件不存在：" + src);
      const info = await probe(file);
      const result = placeAudio(work, { src, start, duration: duration ?? info.duration, trackName: track, name, gain });
      await services.materials?.lockReferenced(work);
      return asJson(
        { clip: result.clip, track: result.track.name, sha256: result.sha256 },
        `已放到音轨「${result.track.name}」，${start}s 开始，时长 ${result.clip.duration.toFixed(2)}s`,
      );
    },
  });
}

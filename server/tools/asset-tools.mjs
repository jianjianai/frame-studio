import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { z } from "zod";
import { workArg, asJson } from "./registry.mjs";
import { eachSettled, summarize, errorOf } from "./batch.mjs";
import { listAssets } from "./work-tools.mjs";
import { writeStream, uniquePath } from "../files.mjs";
import { problem, confined } from "../util.mjs";
import { probe } from "../media.mjs";
import { placeAudio } from "../documents.mjs";
import { contactSheet, ffmpegExecutable, formatTime } from "../render.mjs";

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

/** Loopback, private, link-local, shared (CGNAT), benchmarking, multicast and reserved addresses. */
export function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return privateAddress(mapped[1]);
  return /^(f[cd]|fe[89ab]|ff)/.test(lower);
}

/** A studio on the network must not fetch its own network for whoever asks (SSRF). */
async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((item) => item.address);
  if (!addresses.length) throw problem(400, `找不到这个网址的服务器：${url.host}`);
  if (addresses.some(privateAddress)) throw problem(400, `不能从内网地址导入：${url.host}`, "PRIVATE_ADDRESS");
}

/**
 * Download a URL into a folder of `work.dir`; refuses non-http(s) and oversized files. With
 * `publicOnly` (a studio reachable from the network), every address on the way, redirects
 * included, must be a public one.
 */
export async function importFromUrl(work, url, { name, folder = "public/imports", limit = 1024 * 1024 * 1024, publicOnly = false } = {}) {
  let current = new URL(url);
  let response;
  for (let hops = 0; ; hops++) {
    if (!["http:", "https:"].includes(current.protocol)) throw problem(400, "只能从 http/https 地址导入");
    if (publicOnly) await assertPublicHost(current);
    response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(10 * 60 * 1000) });
    const location = response.status >= 300 && response.status < 400 && response.headers.get("location");
    if (!location) break;
    if (hops >= 5) throw problem(502, "下载失败：重定向次数过多");
    current = new URL(location, current);
  }
  if (!response.ok || !response.body) throw problem(502, `下载失败：HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > limit) throw problem(413, "文件过大");
  let base = name || decodeURIComponent(path.basename(current.pathname)) || "download";
  if (!path.extname(base)) base += extensionFor(response.headers.get("content-type"));
  base = base.replace(/[\\/\x00-\x1f?#%*:|"<>]/g, "_");
  const relative = uniquePath(work.dir, `${folder.replace(/\/$/, "")}/${base}`);
  await writeStream(work.dir, relative, Readable.fromWeb(response.body), { limit });
  return relative;
}

/** base64 file content sent with a tool call (clients without a shell); small files only. */
export const DATA_LIMIT = 8 * 1024 * 1024;
export function decodeData(data, name) {
  if (!name || !path.extname(name)) throw problem(400, "用 data 传文件时，name 要写带扩展名的文件名");
  const buffer = Buffer.from(String(data).replace(/^data:[^,]*,/, ""), "base64");
  if (!buffer.length) throw problem(400, "data 不是有效的 base64 内容");
  if (buffer.length > DATA_LIMIT) throw problem(413, `data 最多 ${DATA_LIMIT / 1048576} MB；更大的文件用 upload_link 上传`);
  return buffer;
}

/**
 * The file behind an asset address: films/<名称>/… or public/… in the work, or a library
 * file materials/<库>/… (the version the work locked, else the current one).
 */
export async function resolveAsset(services, work, src) {
  const material = /^materials\/(.+)$/.exec(src);
  if (material) {
    const file = await services.materials.file(work.repo, services.materials.readLocks(work.dir), material[1]).catch(() => null);
    if (!file || !fs.existsSync(file)) throw problem(404, `素材库里没有这个文件：${src}`, "NOT_FOUND");
    return file;
  }
  const films = /^films\/([^/]+)\/(.+)$/.exec(src);
  if (films && films[1] !== work.slug) throw problem(400, `${src} 不是这个作品的素材（应为 films/${work.slug}/…）`);
  const file = confined(work.dir, films ? `public/${films[2]}` : src);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw problem(404, `文件不存在：${src}`, "NOT_FOUND");
  return file;
}

/** One video frame as PNG (ffmpeg seeks to `time` seconds). */
async function videoFrame(file, time) {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw problem(500, "查看视频画面需要 FFmpeg", "NO_FFMPEG");
  const chunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { windowsHide: true });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && chunks.length ? resolve() : reject(new Error(`无法读取 ${formatTime(time)} 的画面`))));
  });
  return Buffer.concat(chunks);
}

const SHEET_CELLS = 36;
const BACKGROUND = "#16191d";
const sizeText = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const shortName = (src) => {
  const name = src.split("/").pop();
  return name.length > 22 ? name.slice(0, 10) + "…" + name.slice(-10) : name;
};

export function registerAssetTools(registry) {
  const { services } = registry;

  registry.add({
    name: "asset_view",
    title: "查看素材",
    description:
      "看素材本身的样子（不是作品画面）：图片（含 SVG、GIF 首帧）缩略图，视频按时间点抽帧（默认开头、中间、结尾附近 3 帧）。多个文件拼成一张带编号的总览图，只有一张图片时返回大图。用户上传或导入了图片、视频后，挑选和安排之前先看一眼。files 不给时看作品 public/ 里全部图片和视频；地址可以是 films/…、public/… 或素材库 materials/<库>/…。音频只列出信息（用 preview_audio 的 src 分析）。",
    readOnly: true,
    input: {
      work: workArg,
      files: z.array(z.string().min(1).max(512)).min(1).max(SHEET_CELLS).optional(),
      times: z.array(z.number().nonnegative()).min(1).max(8).optional().describe("视频抽帧的时间点（文件内秒数）"),
    },
    async run({ files, times }, ctx) {
      const work = await ctx.work();
      const all = !files;
      if (all) files = (await listAssets(work)).filter((item) => item.kind === "image" || item.kind === "video").map((item) => item.url);
      if (!files.length) return { data: { items: [] }, text: "作品 public/ 里还没有图片或视频。" };
      const items = [];
      for (const src of files) {
        const file = await resolveAsset(services, work, src);
        items.push({ src, file, info: await probe(file) });
      }
      // Cells: one per image, a few per video, at most SHEET_CELLS in all.
      const visual = items.filter((item) => item.info.kind === "image" || item.info.kind === "video");
      const videos = visual.filter((item) => item.info.kind === "video").length;
      const perVideo = times?.length ?? Math.max(1, Math.min(3, Math.floor((SHEET_CELLS - (visual.length - videos)) / Math.max(1, videos))));
      const cells = [];
      const skipped = [];
      for (const item of visual) {
        const wanted = item.info.kind === "video" ? (times ?? [0.1, 0.5, 0.9].slice(0, perVideo).map((share) => share * (item.info.duration ?? 1))).slice(0, perVideo) : [null];
        for (const time of wanted) {
          if (cells.length >= SHEET_CELLS) {
            if (!skipped.includes(item.src)) skipped.push(item.src);
            continue;
          }
          cells.push({ item, time: time === null ? null : Math.max(0, Math.min(time, (item.info.duration ?? time) - 0.05)) });
        }
      }
      const single = cells.length === 1 && cells[0].time === null;
      const w = single ? 1024 : cells.length <= 4 ? 480 : 320;
      // Cells take the typical shape of what is shown (landscape video, portrait photos…).
      const shapes = visual.filter((item) => item.info.width && item.info.height).map((item) => item.info.width / item.info.height).sort((a, b) => a - b);
      const shape = Math.min(2, Math.max(0.5, shapes[Math.floor(shapes.length / 2)] ?? 4 / 3));
      const h = single ? 1024 : Math.round(w / shape);
      const rendered = [];
      const problems = [];
      for (const [index, cell] of cells.entries()) {
        try {
          const input = cell.time === null ? cell.item.file : await videoFrame(cell.item.file, cell.time);
          const png = await sharp(input, { animated: false })
            .resize(w, h, { fit: single ? "inside" : "contain", withoutEnlargement: single, background: BACKGROUND })
            .flatten({ background: BACKGROUND })
            .png()
            .toBuffer();
          rendered.push({ png, label: `#${index + 1} ${shortName(cell.item.src)}${cell.time === null ? "" : " " + formatTime(cell.time)}` });
        } catch (error) {
          problems.push(`#${index + 1} ${cell.item.src}：${error.message}`);
          rendered.push({ png: await sharp({ create: { width: w, height: h, channels: 3, background: BACKGROUND } }).png().toBuffer(), label: `#${index + 1} 无法显示` });
        }
      }
      const image = single
        ? await sharp(rendered[0].png).jpeg({ quality: 85 }).toBuffer()
        : await contactSheet(rendered, w, h, Math.min(cells.length <= 4 ? 2 : 6, Math.ceil(Math.sqrt(cells.length))));
      const describe = (item) =>
        `${item.src}：${{ image: "图片", video: "视频", audio: "音频" }[item.info.kind] ?? item.info.kind}${item.info.width ? ` ${item.info.width}×${item.info.height}` : ""}${item.info.duration ? ` ${item.info.duration} 秒` : ""}，${sizeText(item.info.size)}`;
      const numbered = cells.map((cell, index) => `#${index + 1} ${cell.item.src}${cell.time === null ? "" : ` @${formatTime(cell.time)}`}`);
      const others = items.filter((item) => !visual.includes(item));
      const text = [
        single ? describe(items[0]) : `${numbered.join("\n")}\n\n${visual.map(describe).join("\n")}`,
        others.length ? `没有画面的文件：\n${others.map(describe).join("\n")}` : "",
        skipped.length ? `超过 ${SHEET_CELLS} 格，没有显示：${skipped.join("、")}（用 files 分批查看）` : "",
        problems.length ? `出错：\n${problems.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        data: { items: items.map(({ src, info }) => ({ src, ...info })), cells: numbered },
        text,
        images: [{ data: image, mimeType: "image/jpeg" }],
      };
    },
  });

  const plainSource = {
    url: z.string().url().optional(),
    data: z.string().max(12 * 1024 * 1024).optional(),
    file: z.string().optional(),
    name: z.string().max(120).optional(),
    folder: z
      .string()
      .regex(/^public(\/[\w.-]+)*$/)
      .optional(),
    license: z.string().max(500).optional(),
  };
  const source = {
    url: z.string().url().optional(),
    data: z.string().max(12 * 1024 * 1024).optional().describe("文件内容的 base64（≤8 MB，要同时给 name）；没有终端时用，否则用 upload_link"),
    file: z.string().optional().describe("服务器上的绝对路径（仅本机模式）"),
    name: z.string().max(120).optional().describe("保存的文件名"),
    folder: z
      .string()
      .regex(/^public(\/[\w.-]+)*$/)
      .optional()
      .describe("保存到哪个文件夹，默认 public/imports"),
    license: z.string().max(500).optional().describe("来源与许可"),
  };
  /** One import into the work's public/: from a URL, base64 data or (local studio) a file of this machine. */
  const importOne = async (work, { url, data, file, name, folder = "public/imports", license }) => {
    if ([url, data, file].filter(Boolean).length !== 1) throw problem(400, "url、data、file 必须且只能提供一个");
    let relative;
    if (url) relative = await importFromUrl(work, url, { name, folder, publicOnly: services.auth.required });
    else if (data) {
      const buffer = decodeData(data, name);
      relative = uniquePath(work.dir, `${folder}/${name.replace(/[\\/\x00-\x1f?#%*:|"<>]/g, "_")}`);
      await writeStream(work.dir, relative, Readable.from([buffer]));
    } else {
      if (services.auth.required) throw problem(403, "服务器模式不能直接读取服务器上的文件：你所在电脑上的文件用 upload_link 上传，网上的用 url");
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
    return { path: relative, url: `films/${work.slug}/${relative.replace(/^public\//, "")}`, ...info };
  };

  registry.add({
    name: "asset_import",
    title: "导入素材",
    description:
      "把素材放进作品自己的 public/：从网址下载（url）、base64 内容（data，小文件）或服务器本地文件（file，仅本机模式）。一次导入多个用 items（同时下载，某项失败不影响其他项，结果逐项列出，只需重试失败的）。你所在电脑上的文件用 upload_link 上传。返回代码中使用的 films/... 地址。注意素材版权，在 license 中记录来源。多个作品都要用的素材放进素材库（material_write）。",
    input: {
      work: workArg,
      ...source,
      items: z.array(z.strictObject(plainSource)).max(20).optional().describe("一次导入多个；每项和单个导入的参数相同"),
    },
    async run({ work: _ignored, items, ...single }, ctx) {
      const work = await ctx.work();
      const list = items?.length ? items.map((item) => ({ folder: single.folder, license: single.license, ...item })) : [single];
      const results = await eachSettled(list, (item) => importOne(work, item));
      services.events.emit({ type: "assets", work: work.id, repo: work.repo });
      if (!items?.length) {
        if (!results[0].ok) throw results[0].error;
        const one = results[0].value;
        return asJson(one, `已导入 ${one.path}，引用地址 ${one.url}`);
      }
      return {
        data: results.map((result, index) => (result.ok ? { ok: true, ...result.value } : { ok: false, item: index, error: errorOf(result.error) })),
        text: summarize(results, (result, index) =>
          result.ok ? `✓ ${index + 1}. ${result.value.path} → ${result.value.url}` : `✗ ${index + 1}. ${list[index].url || list[index].name || list[index].file}：${result.error.message}`,
        ),
      };
    },
  });

  registry.add({
    name: "audio_place",
    title: "放置音频",
    description: "把作品中的音频文件放到音轨上（不存在的音轨会自动创建）。用于配乐、音效、配音和录音。",
    input: {
      work: workArg,
      src: z.string().describe("films/<名称>/…、public/… 或 materials/<素材库>/… 地址"),
      start: z.number().nonnegative().default(0),
      duration: z.number().positive().optional().describe("默认放到文件结束或作品结束"),
      track: z.string().max(60).default("音效").describe("音轨名称"),
      name: z.string().max(100).optional(),
      gain: z.number().min(0).max(4).default(1),
    },
    async run({ src, start, duration, track, name, gain }, ctx) {
      const work = await ctx.work();
      const info = await probe(await resolveAsset(services, work, src));
      if (src.startsWith("public/")) src = `films/${work.slug}/${src.slice(7)}`;
      const result = placeAudio(work, { src, start, duration: duration ?? info.duration, trackName: track, name, gain });
      await services.materials?.lockReferenced(work);
      return asJson(
        { clip: result.clip, track: result.track.name, sha256: result.sha256 },
        `已放到音轨「${result.track.name}」（${result.track.id}）：片段 ${result.clip.id}，${start}s 开始，时长 ${result.clip.duration.toFixed(2)}s。调整用 audio_edit 的 update（collection clips，id ${result.clip.id}）`,
      );
    },
  });
}

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Thumbnails } from "./thumbnails.mjs";
import { problem, notFound, sha256, writeFileAtomic, confined } from "./util.mjs";
import { sendFile, sendJson } from "./http.mjs";
import { probe } from "./media.mjs";

/** Media the asset page draws (src/preview/asset.ts); the browser shows images, video and sound itself. */
export const DRAWN = new Set(["model", "lottie", "environment", "font"]);
const FORMAT = "1"; // part of every thumbnail name: bump to redo them after changing how they are drawn

/**
 * Thumbnails of models, Lottie animations, HDR/EXR panoramas and fonts — of a work's own
 * files and of the material libraries — drawn by the headless browser in the background
 * (one at a time, the latest request first) and cached by the file's version.
 */
export class AssetPreviews {
  constructor(services) {
    this.services = services;
    this.dir = path.join(services.config.dirs.cache, "assets");
    this.thumbs = new Thumbnails(this.dir);
  }

  /** `{ file }`, `{ error }` or `{ pending }`; the `asset-thumb` event (with `event`'s fields) says when it is drawn. */
  thumbnail({ assetBase, src, kind, version, event }) {
    const name = `${sha256(`${FORMAT}|${assetBase}|${src}|${version}`).slice(0, 32)}.webp`;
    return this.thumbs.request(name, {
      render: (file) => this.renderThumbnail({ assetBase, src, kind }, file),
      done: (error) => this.services.events.emit({ type: "asset-thumb", ...event, version, ...(error ? { error: error.message } : {}) }),
    });
  }
  async renderThumbnail({ assetBase, src, kind }, file) {
    const { frames } = await this.services.renderer.assetFrames({ assetBase, src, kind, width: 360 });
    const image = await sharp(frames[0].png).resize({ width: 240, height: 240, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    writeFileAtomic(file, image);
  }
}

/** The kind a file is drawn as, or a 400 for files the browser shows itself. */
async function drawnKind(file) {
  const info = await probe(file);
  if (!DRAWN.has(info.kind)) throw problem(400, "这种文件不需要缩略图（浏览器直接显示）");
  return info.kind;
}

export function assetPreviewsPlugin(services) {
  const { router } = services;
  const previews = (services.assetPreviews = new AssetPreviews(services));
  const reply = (req, res, result, version, wanted) => {
    if (result.error) throw problem(422, result.error, "RENDER_FAILED");
    // Never held open while drawing: 202 means "wait for asset-thumb".
    if (result.pending) return sendJson(res, 202, { pending: true, version });
    sendFile(req, res, result.file, { cache: wanted === version ? "private, max-age=31536000, immutable" : "no-cache" });
  };

  // A library file as the library has it now.
  router.get("/api/repos/:repo/materials/thumb", async ({ params, query, req, res }) => {
    const ref = String(query.path || "");
    const file = await services.materials.file(params.repo, {}, ref);
    const version = (await services.materials.headOf(params.repo)).get(ref) ?? "";
    if (!version) throw notFound(`素材不存在：materials/${ref}`);
    const result = previews.thumbnail({ assetBase: `/files/${params.repo}/-/`, src: `materials/${ref}`, kind: await drawnKind(file), version, event: { repo: params.repo, ref } });
    reply(req, res, result, version, query.v);
  });

  // A work's own file (public/…).
  router.get("/api/works/:repo/:id/assets/thumb", async ({ params, query, req, res }) => {
    const work = await services.openWork(params.id, params.repo);
    const relative = String(query.path || "");
    if (!relative.startsWith("public/")) throw problem(400, "只有 public/ 里的素材有缩略图");
    const file = confined(work.dir, relative);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw notFound(`文件不存在：${relative}`);
    const stat = fs.statSync(file);
    const version = `${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}`;
    const result = previews.thumbnail({
      assetBase: `/files/${work.repo}/${work.id}/`,
      src: `films/${work.slug}/${relative.slice("public/".length)}`,
      kind: await drawnKind(file),
      version,
      event: { repo: work.repo, work: work.id, path: relative },
    });
    reply(req, res, result, version, query.v);
  });
}

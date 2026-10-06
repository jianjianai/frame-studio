import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { tree } from "./files.mjs";
import { readBody, readJson, sendFile } from "./http.mjs";
import { problem, writeFileAtomic } from "./util.mjs";
import { removeProjectProperty, setProjectFields } from "./project-meta.mjs";

const WIDTH = 640; // home page cards on high-density screens
const FORMAT = "1"; // part of every key: bump to redo the cached covers after changing how they are made
const UPLOAD = "poster.webp"; // in the work's public/

const digest = (...parts) => createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
const thumbnail = (image) => image.rotate().resize({ width: WIDTH, height: WIDTH, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();

/**
 * Work covers for the home page. A work shows the image project.ts names in `poster`, or else
 * a frame of the work itself: at `posterTime`, or the fullest of a few moments. Covers are
 * cached per work outside it, so they stay when the local copy is freed. Listing works redoes
 * stale covers in the background, one at a time, and announces each with a `work-cover` event.
 */
export class Covers {
  constructor(services) {
    this.services = services;
    this.dir = path.join(services.config.dirs.cache, "covers");
    this.pending = new Map(); // waiting to be made, by "repo/id"
    this.making = null;
    this.queue = Promise.resolve();
  }

  /** Cache files of a work, without extension; ids come from addresses, so only real repositories and work ids. */
  base(repo, id) {
    this.services.repos.get(repo);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw problem(400, `无效的作品 id：${id}`);
    return path.join(this.dir, repo, id);
  }

  file(repo, id) {
    return this.base(repo, id) + ".webp";
  }

  /** `{ key, attempted, kind, time, error }`: `key` names the cached image, `attempted` the last source tried. */
  info(repo, id) {
    try {
      return JSON.parse(fs.readFileSync(this.base(repo, id) + ".json", "utf8"));
    } catch {
      return null;
    }
  }

  /** What the cover is made from now, with a key that changes whenever the result could. */
  source(work) {
    const meta = this.services.works.meta(work);
    const poster = meta.ok ? String(meta.meta.poster || "") : "";
    const prefix = `films/${work.slug}/`;
    if (poster.startsWith(prefix)) {
      const file = path.join(work.dir, "public", poster.slice(prefix.length));
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile()) return { kind: "image", file, key: digest(FORMAT, "image", poster, stat.size, stat.mtimeMs) };
    }
    const time = meta.ok && typeof meta.meta.posterTime === "number" ? meta.meta.posterTime : null;
    // Any file may change the picture (code, layers, media, the material lock).
    const files = tree(work.dir)
      .filter((entry) => entry.type === "file")
      .map((entry) => `${entry.path}:${entry.size}:${Math.round(entry.mtime)}`);
    return { kind: time === null ? "auto" : "time", time, key: digest(FORMAT, "frame", time, ...files) };
  }

  stale(work) {
    return this.info(work.repo, work.id)?.attempted !== this.source(work).key;
  }

  /** Make the cover again unless its source is unchanged since the last attempt. */
  refresh(work) {
    const id = `${work.repo}/${work.id}`;
    if (!this.pending.has(id)) {
      // Requests while one is waiting share it; one that is running already looked at the files.
      const run = this.queue.then(async () => {
        this.pending.delete(id);
        this.making = id;
        try {
          return await this.make(work);
        } finally {
          this.making = null;
        }
      });
      this.queue = run.catch(() => {});
      this.pending.set(id, run);
    }
    return this.pending.get(id);
  }

  async make(work) {
    if (!fs.existsSync(path.join(work.dir, "project.ts"))) return null;
    const source = this.source(work);
    const info = this.info(work.repo, work.id);
    if (info?.attempted === source.key) return info;
    let next;
    try {
      let image, time;
      if (source.kind === "image") image = await thumbnail(sharp(source.file));
      else {
        const frame = await this.services.renderer.cover(work, { time: source.time ?? undefined, width: WIDTH });
        image = await thumbnail(sharp(frame.png));
        time = Math.round(frame.time * 1000) / 1000;
      }
      writeFileAtomic(this.file(work.repo, work.id), image);
      next = { key: source.key, attempted: source.key, kind: source.kind, time, madeAt: new Date().toISOString() };
    } catch (error) {
      // Keep showing the last cover that worked.
      next = { ...info, attempted: source.key, error: String(error.message).slice(0, 2000) };
    }
    writeFileAtomic(this.base(work.repo, work.id) + ".json", JSON.stringify(next));
    this.services.events.emit({ type: "work-cover", repo: work.repo, work: work.id, cover: next.key || "" });
    return next;
  }

  /** The cached cover's version for each listed work (`cover`, "" for none); stale covers of local works are redone. */
  annotate(list) {
    return list.map((item) => {
      if (item.checkedOut)
        try {
          const work = this.services.works.describe(item.repo, item.id);
          if (this.stale(work)) this.refresh(work).catch(() => {});
        } catch {}
      return { ...item, cover: this.current(item.repo, item.id) };
    });
  }

  current(repo, id) {
    const info = this.info(repo, id);
    return info?.key && fs.existsSync(this.file(repo, id)) ? info.key : "";
  }

  /** For the work's properties: what the cover is, and whether a newer one is (or with `refresh`, will be) made. */
  state(work, { refresh = true } = {}) {
    const meta = this.services.works.meta(work).meta || {};
    const info = this.info(work.repo, work.id) || {};
    const stale = this.stale(work);
    if (stale && refresh) this.refresh(work).catch(() => {});
    return {
      cover: this.current(work.repo, work.id),
      mode: meta.poster ? "image" : typeof meta.posterTime === "number" ? "time" : "auto",
      poster: meta.poster || "",
      time: info.kind === "image" ? null : (info.time ?? null),
      updating: stale && (refresh || this.pending.has(`${work.repo}/${work.id}`) || this.making === `${work.repo}/${work.id}`),
      error: info.attempted === info.key ? "" : info.error || "",
    };
  }

  /** Set (or with nothing, clear) the cover fields of project.ts. */
  setFields(work, { poster, posterTime }) {
    this.services.works.assertEditable(work);
    const file = path.join(work.dir, "project.ts");
    let code = fs.readFileSync(file, "utf8");
    code = poster ? setProjectFields(code, { poster }) : removeProjectProperty(code, "poster");
    code = posterTime === undefined ? removeProjectProperty(code, "posterTime") : setProjectFields(code, { posterTime });
    writeFileAtomic(file, code);
    this.services.events.emit({ type: "works", repo: work.repo });
    this.refresh(work).catch(() => {});
    return this.state(work);
  }

  /** The frame at `time` (seconds) is the cover, made from the work as it is at any moment. */
  useFrame(work, time) {
    const meta = this.services.works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error, "WORK_INVALID");
    if (!Number.isFinite(time) || time < 0) throw problem(400, "封面时间应为不小于 0 的秒数");
    const last = Math.max(0, meta.meta.duration - 1 / (meta.meta.fps || 30));
    return this.setFields(work, { posterTime: Math.round(Math.min(time, last) * 1000) / 1000 });
  }

  /** An uploaded image is the cover: saved as public/poster.webp (at most 1920 px). */
  async useImage(work, data) {
    this.services.works.assertEditable(work);
    let image;
    try {
      image = await sharp(data, { failOn: "error" })
        .rotate()
        .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer();
    } catch {
      throw problem(400, "不是可以读取的图片（支持 PNG、JPEG、WebP、GIF、AVIF、SVG）");
    }
    writeFileAtomic(path.join(work.dir, "public", UPLOAD), image);
    this.services.events.emit({ type: "assets", work: work.id, repo: work.repo });
    return this.setFields(work, { poster: `films/${work.slug}/${UPLOAD}` });
  }

  forget(repo, id) {
    for (const extension of [".webp", ".json"]) fs.rmSync(this.base(repo, id) + extension, { force: true });
  }
}

export function coversPlugin(services) {
  const { router } = services;
  const covers = (services.covers = new Covers(services));
  const base = "/api/works/:repo/:id/cover";

  /** The cached image; `?v=` is the version from the work list, so a matching one never changes. */
  router.get(base, ({ params, query, req, res }) => {
    const current = covers.current(params.repo, params.id);
    if (!current) throw problem(404, "还没有封面", "NOT_FOUND");
    sendFile(req, res, covers.file(params.repo, params.id), { cache: query.v === current ? "private, max-age=31536000, immutable" : "no-cache" });
  });
  router.get(`${base}/state`, async ({ params, query }) => covers.state(await services.openWork(params.id, params.repo), { refresh: query.refresh !== "0" }));
  router.post(`${base}/frame`, async ({ params, req }) => covers.useFrame(await services.openEditable(params.id, params.repo), Number((await readJson(req)).time)));
  router.post(`${base}/image`, async ({ params, req }) => covers.useImage(await services.openEditable(params.id, params.repo), await readBody(req, 40 * 1024 * 1024)), {
    raw: true,
  });
  router.delete(base, async ({ params }) => covers.setFields(await services.openEditable(params.id, params.repo), {}));
}

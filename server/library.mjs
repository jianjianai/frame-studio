import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { git, gitOk } from "./git.mjs";
import { problem, notFound, mimeType, Locks, writeFileAtomic } from "./util.mjs";
import { uniquePath } from "./files.mjs";

const safeName = (name) => {
  const clean = String(name || "")
    .replace(/[\\/\x00-\x1f]/g, "_")
    .trim()
    .slice(0, 200);
  if (!clean || clean === "." || clean === "..") throw problem(400, "无效的文件名");
  return clean;
};

export async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Each repository has a shared materials library on branch frame/materials:
 * materials/index.json + materials/<sha256>/<name>. Using a material copies it
 * into the work's public/ folder, so every work stays self-contained.
 */
export class Library {
  constructor({ repos, events }) {
    this.repos = repos;
    this.events = events;
    this.locks = new Locks();
  }
  async dir(repo) {
    return this.repos.library(repo);
  }
  async list(repo, { includeDeleted = false } = {}) {
    const dir = await this.dir(repo);
    const file = path.join(dir, "materials", "index.json");
    const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    return items
      .filter((item) => includeDeleted || !item.deleted)
      .map((item) => {
        const full = path.join(dir, "materials", item.sha, item.name);
        return { ...item, size: fs.existsSync(full) ? fs.statSync(full).size : null, path: `materials/${item.sha}/${item.name}` };
      });
  }
  async file(repo, id) {
    const item = (await this.list(repo, { includeDeleted: true })).find((entry) => entry.id === id);
    if (!item) throw notFound("素材不存在");
    return { item, file: path.join(await this.dir(repo), item.path) };
  }
  /** Add a file to the library and save it as a commit on frame/materials. */
  async add(repo, source, { name, license = "", tags = "" }) {
    return this.locks.run(repo, async () => {
      const dir = await this.dir(repo);
      const sha = await fileSha256(source);
      name = safeName(name || path.basename(source));
      const target = path.join(dir, "materials", sha, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      const indexFile = path.join(dir, "materials", "index.json");
      const items = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [];
      let item = items.find((entry) => entry.sha === sha && entry.name === name);
      if (item) item.deleted = false;
      else {
        item = { id: randomUUID(), name, sha, mime: mimeType(name), license, tags, deleted: false, addedAt: new Date().toISOString() };
        items.push(item);
      }
      writeFileAtomic(indexFile, JSON.stringify(items, null, 2) + "\n");
      await git(dir, ["add", "--", "materials"]);
      await git(dir, ["commit", "-q", "-m", `添加素材：${name}`]).catch(() => {});
      this.events.emit({ type: "library", repo });
      return item;
    });
  }
  async remove(repo, id) {
    return this.locks.run(repo, async () => {
      const dir = await this.dir(repo);
      const indexFile = path.join(dir, "materials", "index.json");
      const items = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      const item = items.find((entry) => entry.id === id);
      if (!item) throw notFound("素材不存在");
      item.deleted = true;
      writeFileAtomic(indexFile, JSON.stringify(items, null, 2) + "\n");
      await git(dir, ["add", "--", "materials/index.json"]);
      await git(dir, ["commit", "-q", "-m", `移除素材：${item.name}`]);
      this.events.emit({ type: "library", repo });
    });
  }
  /** Copy a library material into a work's public/ folder; returns the work-relative path and URL. */
  async use(work, id, { folder = "public/library" } = {}) {
    const { item, file } = await this.file(work.repo, id);
    const relative = uniquePath(work.dir, `${folder.replace(/\/$/, "")}/${item.name}`);
    const target = path.join(work.dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    return { path: relative, url: `films/${work.slug}/${relative.replace(/^public\//, "")}`, license: item.license };
  }
  async push(repo) {
    const info = this.repos.get(repo);
    if (!info.remote) throw problem(400, "作品库没有连接 GitHub");
    const dir = await this.dir(repo);
    await git(dir, ["push", "-u", "origin", "frame/materials"], { env: this.repos.env(info) });
  }
  /**
   * Bring in the remote library. Materials are content-addressed, so even
   * diverged libraries merge cleanly: files are unioned and so is the catalog.
   */
  async pull(repo) {
    const info = this.repos.get(repo);
    if (!info.remote) return;
    await this.repos.fetch(repo);
    const dir = await this.dir(repo);
    if (!(await gitOk(dir, ["rev-parse", "--verify", "--quiet", "origin/frame/materials"]))) return;
    await this.locks.run(repo, async () => {
      if (await gitOk(dir, ["merge", "--ff-only", "origin/frame/materials"])) return;
      const indexFile = path.join(dir, "materials", "index.json");
      const ours = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [];
      const theirs = JSON.parse((await git(dir, ["show", "origin/frame/materials:materials/index.json"]).catch(() => "[]")) || "[]");
      await git(dir, ["merge", "--no-commit", "--allow-unrelated-histories", "-X", "ours", "origin/frame/materials"]).catch(() => {});
      const merged = new Map(theirs.map((item) => [item.id, item]));
      for (const item of ours) merged.set(item.id, item);
      writeFileAtomic(indexFile, JSON.stringify([...merged.values()], null, 2) + "\n");
      await git(dir, ["add", "--", "materials"]);
      await git(dir, ["commit", "-q", "--no-edit", "-m", "合并素材库"]);
    });
    this.events.emit({ type: "library", repo });
  }
}

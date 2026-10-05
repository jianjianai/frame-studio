import fs from "node:fs";
import path from "node:path";
import { problem, notFound } from "./util.mjs";

const slugify = (text) =>
  String(text || "video")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
    .trim()
    .slice(0, 60) || "video";

/** Exported videos live outside the work branch: <home>/exports/<repo>/<work>/. */
export class Exports {
  constructor(services) {
    this.services = services;
  }
  dir(work) {
    return path.join(this.services.config.dirs.exports, work.repo, work.id);
  }
  list(work) {
    const dir = this.dir(work);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => /\.(mp4|webm|png|srt)$/i.test(name) && !name.includes(".partial."))
      .map((name) => {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        let info = {};
        try {
          info = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
        } catch {}
        return { name, size: stat.size, createdAt: stat.mtime.toISOString(), ...info };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  file(work, name) {
    if (!/^[^/\\]+$/.test(name)) throw problem(400, "无效的文件名");
    const file = path.join(this.dir(work), name);
    if (!fs.existsSync(file)) throw notFound("导出文件不存在");
    return file;
  }
  remove(work, name) {
    const file = this.file(work, name);
    fs.rmSync(file);
    fs.rmSync(file + ".json", { force: true });
  }
  /** Start an MP4 export task from a frozen copy of the work. */
  start(work, options = {}) {
    const { renderer, tasks, works } = this.services;
    const meta = works.meta(work);
    if (!meta.ok) throw problem(422, "project.ts 无法读取：" + meta.error);
    const dir = this.dir(work);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const name = `${slugify(meta.meta.title)}-${stamp}.mp4`;
    const output = path.join(dir, name);
    return tasks.start({ kind: "export", title: `导出 ${meta.meta.title}`, work: work.id, repo: work.repo }, async ({ signal, progress }) => {
      const status = await works.status(work);
      const result = await renderer.exportVideo(work, { ...options, output, signal, progress });
      const info = { ...result, file: undefined, name, title: meta.meta.title, version: status.head?.commit, unsavedChanges: status.files.length };
      fs.writeFileSync(output + ".json", JSON.stringify(info, null, 2));
      this.services.events.emit({ type: "exports", work: work.id, repo: work.repo });
      return info;
    });
  }
}

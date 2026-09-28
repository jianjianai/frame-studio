import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { command } from "./process.mjs";
import { confined, copyTree, treeHash, problem } from "./security.mjs";
import {
  readProject,
  sourceFile,
  visitNodes,
} from "../scripts/project-metadata.mjs";
import { applyProject } from "./apply-project.mjs";

export class Works {
  constructor(db, data, repos, assets, tasks) {
    Object.assign(this, { db, data, repos, assets, tasks });
  }
  async discover() {
    for (const repo of await this.repos.list()) {
      for (const project of repo.projects) {
        const { dir } = await this.repos.project(repo.id, project.id);
        const file = confined(dir, "production/work.json");
        let info = {};
        try {
          info = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        const title =
          typeof info.title === "string"
            ? info.title.slice(0, 150)
            : project.title;
        const inserted = await this.db.pool.query(
          `INSERT INTO works(id,repo,project,title,category,status,description,deleted)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(repo,project) DO UPDATE
          SET title=EXCLUDED.title,category=EXCLUDED.category,status=EXCLUDED.status,description=EXCLUDED.description,deleted=EXCLUDED.deleted,updated=now()
          WHERE (works.title,works.category,works.status,works.description,works.deleted)
          IS DISTINCT FROM (EXCLUDED.title,EXCLUDED.category,EXCLUDED.status,EXCLUDED.description,EXCLUDED.deleted)`,
          [
            randomUUID(),
            repo.id,
            project.id,
            title,
            String(info.category || "").slice(0, 80),
            ["draft", "review", "finished"].includes(info.status)
              ? info.status
              : "draft",
            String(info.description || "").slice(0, 4000),
            info.deleted === true,
          ],
        );
        if (inserted.rowCount)
          await this.assets.importProject(repo.id, project.id);
      }
    }
  }
  async list({
    deleted = false,
    search = "",
    category = "",
    status = "",
  } = {}) {
    await this.discover();
    const rows = await this.db.all(
      `SELECT w.*, r.name AS storage_name, r.url AS remote,
      (SELECT jsonb_build_object('id',t.id,'kind',t.kind,'state',t.state,'finished',t.finished) FROM tasks t WHERE t.repo=w.repo AND t.project=w.project ORDER BY t.created DESC LIMIT 1) AS activity,
      greatest(w.updated,COALESCE((SELECT max(t.finished) FROM tasks t WHERE t.repo=w.repo AND t.project=w.project AND t.kind IN ('agent','new') AND t.state='succeeded'),w.updated)) AS modified
      FROM works w JOIN repos r ON r.id=w.repo WHERE w.deleted=$1 AND (w.title ILIKE $2 OR w.description ILIKE $2) AND ($3='' OR w.category=$3) AND ($4='' OR w.status=$4) ORDER BY modified DESC`,
      [deleted, "%" + search + "%", category, status],
    );
    for (const row of rows) {
      try {
        const { dir } = await this.repos.project(row.repo, row.project);
        const { meta } = readProject(confined(dir, "project.ts"));
        Object.assign(row, {
          duration: meta.duration,
          fps: meta.fps,
          renderer: meta.renderer,
        });
        row.cover = this.coverPath(dir)
          ? `/api/works/${row.id}/cover?v=${new Date(row.modified).getTime()}`
          : null;
      } catch {
        row.unavailable = true;
      }
    }
    return rows;
  }
  coverPath(dir) {
    for (const name of [
      "poster.webp",
      "poster.png",
      "poster.jpg",
      "cover.webp",
      "cover.png",
      "poster.svg",
    ]) {
      const file = confined(dir, "public/" + name);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }
  async get(id, { active = false } = {}) {
    const row = await this.db.one("SELECT * FROM works WHERE id=$1", [id]);
    if (!row) throw problem(404, "Work not found");
    if (active && row.deleted) throw problem(409, "Restore this work first");
    return row;
  }
  async defaultRepo() {
    return this.db.lock("default-content-repo", async () => {
      const preferred = await this.db.setting("default-repository");
      if (
        preferred?.id &&
        (await this.db.one("SELECT id FROM repos WHERE id=$1", [preferred.id]))
      )
        return preferred.id;
      const repo = await this.repos.add({ name: "我的作品" });
      await this.db.setting("default-repository", { id: repo.id });
      return repo.id;
    });
  }
  async create({
    title,
    repo,
    renderer = "canvas",
    duration = 12,
    category = "",
  }) {
    repo ||= await this.defaultRepo();
    return this.db.lock(repo, async () => {
      await this.repos.writable(repo);
      const r = await this.repos.get(repo);
      const id = randomUUID(),
        project = "work-" + id.slice(0, 8);
      await command(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/new-animation.mjs", import.meta.url),
          ),
          project,
          title,
          "--renderer",
          renderer,
          "--duration",
          String(duration),
        ],
        { cwd: r.root },
      );
      await this.db.pool.query(
        "INSERT INTO works(id,repo,project,title,category) VALUES($1,$2,$3,$4,$5)",
        [id, repo, project, title, category],
      );
      const work = await this.get(id);
      await this.saveInfo(work);
      return work;
    });
  }
  async saveInfo(work) {
    const { dir } = await this.repos.project(work.repo, work.project);
    const file = confined(dir, "production/work.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const info = Object.fromEntries(
      ["title", "category", "status", "description", "deleted"].map((k) => [
        k,
        work[k],
      ]),
    );
    fs.writeFileSync(file + ".tmp", JSON.stringify(info, null, 2) + "\n");
    fs.renameSync(file + ".tmp", file);
  }
  async update(id, fields) {
    const w = await this.get(id);
    return this.db.lock(w.repo, async () => {
      await this.repos.writable(w.repo);
      const next = { ...w, ...fields };
      await this.saveInfo(next);
      await this.db.pool.query(
        "UPDATE works SET title=$2,category=$3,status=$4,description=$5,deleted=$6,updated=now() WHERE id=$1",
        [
          id,
          next.title,
          next.category,
          next.status,
          next.description,
          next.deleted,
        ],
      );
      return this.get(id);
    });
  }
  async duplicate(id, title) {
    const w = await this.get(id, { active: true });
    return this.db.lock(w.repo, async () => {
      await this.repos.writable(w.repo);
      const { dir, repo } = await this.repos.project(w.repo, w.project);
      const newId = randomUUID(),
        project = "work-" + newId.slice(0, 8),
        dest = confined(repo.root, "projects/" + project);
      copyTree(dir, dest);
      // Only rewrite this work's identity and its own URL/path prefixes; binary material bytes remain identical.
      const walk = (folder) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          const file = confined(
            dest,
            path
              .relative(dest, path.join(folder, entry.name))
              .replaceAll("\\", "/"),
          );
          if (entry.isDirectory()) walk(file);
          else if (/\.(ts|tsx|js|mjs|json|md|txt|svg|css)$/.test(file)) {
            const content = fs
              .readFileSync(file, "utf8")
              .replaceAll(`films/${w.project}/`, `films/${project}/`)
              .replaceAll(`projects/${w.project}/`, `projects/${project}/`);
            fs.writeFileSync(file, content);
          }
        }
      };
      try {
        walk(dest);
        const file = path.join(dest, "project.ts"),
          replacements = [];
        visitNodes(sourceFile(file), (node) => {
          if (
            node.type === "ObjectProperty" &&
            ["id", "title"].includes(node.key.name || node.key.value) &&
            node.value.type === "StringLiteral"
          ) {
            if (
              (node.key.name || node.key.value) === "id" &&
              node.value.value === w.project
            )
              replacements.push([
                node.value.start,
                node.value.end,
                JSON.stringify(project),
              ]);
            if (
              (node.key.name || node.key.value) === "title" &&
              node.value.value ===
                readProject(path.join(dir, "project.ts")).meta.title
            )
              replacements.push([
                node.value.start,
                node.value.end,
                JSON.stringify(title),
              ]);
          }
        });
        let source = fs.readFileSync(file, "utf8");
        for (const [start, end, value] of replacements.sort(
          (a, b) => b[0] - a[0],
        ))
          source = source.slice(0, start) + value + source.slice(end);
        fs.writeFileSync(file, source);
        if (readProject(file).meta.id !== project)
          throw problem(
            409,
            "This work uses a computed id; duplicate requires a literal id",
          );
        await this.db.pool.query(
          "INSERT INTO works(id,repo,project,title,category,description) VALUES($1,$2,$3,$4,$5,$6)",
          [newId, w.repo, project, title, w.category, w.description],
        );
        const next = await this.get(newId);
        await this.saveInfo(next);
        await this.db.pool.query(
          "INSERT INTO asset_refs(asset,repo,project,path) SELECT asset,repo,$3,path FROM asset_refs WHERE repo=$1 AND project=$2 ON CONFLICT DO NOTHING",
          [w.repo, w.project, project],
        );
        return next;
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true });
        await this.db.pool.query("DELETE FROM works WHERE id=$1", [newId]);
        throw e;
      }
    });
  }
  async version(id, name) {
    const w = await this.get(id, { active: true });
    return this.db.lock(w.repo, async () => {
      await this.repos.writable(w.repo);
      const { dir } = await this.repos.project(w.repo, w.project),
        version = randomUUID();
      copyTree(dir, path.join(this.data, "versions", version));
      return this.db.one(
        "INSERT INTO work_versions(id,work,name) VALUES($1,$2,$3) RETURNING *",
        [version, id, name],
      );
    });
  }
  async restore(id, version) {
    const w = await this.get(id, { active: true });
    if (
      !(await this.db.one(
        "SELECT id FROM work_versions WHERE id=$1 AND work=$2",
        [version, id],
      ))
    )
      throw problem(404, "Version not found");
    return this.db.lock(w.repo, async () => {
      await this.repos.writable(w.repo);
      const { dir } = await this.repos.project(w.repo, w.project),
        backup = randomUUID();
      copyTree(dir, path.join(this.data, "versions", backup));
      await this.db.pool.query(
        "INSERT INTO work_versions(id,work,name) VALUES($1,$2,$3)",
        [backup, id, "恢复前自动备份"],
      );
      const run = path.join(this.data, "restores", randomUUID());
      fs.mkdirSync(run, { recursive: true });
      applyProject({
        source: path.join(this.data, "versions", version),
        destination: dir,
        run,
        id: randomUUID(),
        fingerprint: treeHash(dir),
      });
      await this.saveInfo(w);
      await this.db.pool.query("UPDATE works SET updated=now() WHERE id=$1", [
        id,
      ]);
      return this.get(id);
    });
  }
}

import { versionTree } from "./version-review.mjs";
import { assertSourceRevision } from "./source-control.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { command } from "./process.mjs";
import { confined, problem, hash } from "./security.mjs";
import { copyTree, treeHash } from "./project-files.mjs";
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
  async discover(repository = null, projectId = null) {
    await this.recoverInfo();
    for (const repo of await this.repos.list(repository, projectId)) {
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
        const work = await this.db.one(
          "SELECT * FROM works WHERE repo=$1 AND project=$2",
          [repo.id, project.id],
        );
        const migrated = !work.branch;
        await this.repos.isolate(work);
        if (migrated)
          await this.repos.checkpoint(
            repo.id,
            project.id,
            "导入作品 · " + title,
          );
        if (inserted.rowCount || migrated || repository)
          await this.assets.importProject(repo.id, project.id);
        await this.repos.revisions?.refreshIfIdle(repo.id, project.id);
      }
    }
    if (!repository) this.discovered = true;
  }
  async list({
    deleted = false,
    search = "",
    category = "",
    status = "",
    repo = null,
    recent = false,
    limit = 60,
    offset = 0,
  } = {}) {
    if (!this.discovered) await this.discover();
    const rows = await this.db.all(
      `SELECT w.*, r.name AS storage_name, r.url AS remote,
      (SELECT jsonb_build_object('id',t.id,'kind',t.kind,'state',t.state,'finished',t.finished) FROM tasks t WHERE t.repo=w.repo AND t.project=w.project AND t.input->>'version' IS NULL ORDER BY (t.state IN ('queued','running','cancelling','publishing','publish_failed')) DESC,t.created DESC LIMIT 1) AS activity,
      greatest(w.updated,COALESCE((SELECT max(t.finished) FROM tasks t WHERE t.repo=w.repo AND t.project=w.project AND t.kind IN ('agent','new') AND t.state='succeeded'),w.updated)) AS modified
      FROM works w JOIN repos r ON r.id=w.repo WHERE w.deleted=$1 AND (w.title ILIKE $2 OR w.description ILIKE $2) AND ($3='' OR w.category=$3) AND ($4='' OR w.status=$4) AND ($5::uuid IS NULL OR w.repo=$5) AND (NOT $6 OR w.opened IS NOT NULL)
      ORDER BY CASE WHEN $6 THEN w.opened ELSE w.updated END DESC,w.id LIMIT $7 OFFSET $8`,
      [
        deleted,
        "%" + search + "%",
        category,
        status,
        repo,
        recent,
        Math.min(100, limit),
        offset,
      ],
    );
    for (const row of rows) {
      try {
        const { dir } = await this.repos.project(row.repo, row.project);
        const { meta } = readProject(confined(dir, "project.ts"));
        Object.assign(row, {
          duration: meta.duration,
          fps: meta.fps,
          renderer: meta.renderer,
          composition: meta.composition || { width: 1920, height: 1080 },
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
    return {
      ...row,
      metadataRevision: hash(JSON.stringify(this.info(row))),
    };
  }
  async create({
    title,
    repo,
    renderer = "canvas",
    duration = 12,
    composition,
    category = "",
  }) {
    if (!repo) throw problem(400, "请选择作品所属仓库");
    return this.db.lock("create-work:" + repo, async () => {
      const id = randomUUID(),
        project = "work-" + id.slice(0, 8);
      await this.db.pool.query(
        "INSERT INTO works(id,repo,project,title,category) VALUES($1,$2,$3,$4,$5)",
        [id, repo, project, title, category],
      );
      try {
        const r = await this.repos.isolate(await this.get(id));
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
            ...(composition
              ? [
                  "--width",
                  String(composition.width),
                  "--height",
                  String(composition.height),
                ]
              : []),
          ],
          { cwd: r.root },
        );
        const work = await this.get(id);
        await this.saveInfo(work);
        await this.repos.checkpoint(repo, project, "创建作品 · " + title);
        await this.repos.revisions?.refresh(repo, project);
        return work;
      } catch (error) {
        await this.removeFailedCreation(id, repo);
        await this.db.pool.query("DELETE FROM works WHERE id=$1", [id]);
        throw error;
      }
    });
  }
  async removeFailedCreation(id, repo) {
    const root = path.resolve(this.data, "works"),
      target = path.resolve(root, id);
    if (path.dirname(target) !== root || !/^[0-9a-f-]{36}$/.test(id))
      throw new Error("Invalid work path");
    const r = await this.repos.get(repo);
    if (fs.existsSync(path.join(target, ".git")))
      await this.repos.git(r.root, [
        "worktree",
        "remove",
        "--force",
        "--",
        target,
      ]);
    else if (fs.existsSync(target))
      fs.rmSync(target, { recursive: true, force: true });
  }
  info(work) {
    return Object.fromEntries(
      ["title", "category", "status", "description", "deleted"].map((key) => [
        key,
        work[key],
      ]),
    );
  }
  async recoverInfo(id = null) {
    const root = path.join(this.data, "metadata-recovery");
    if (!fs.existsSync(root)) return;
    const ids = id
      ? [id]
      : fs.readdirSync(root).map((name) => name.replace(/\.json$/, ""));
    for (const key of ids) {
      if (!/^[0-9a-f-]{36}$/.test(key)) continue;
      const file = path.join(root, key + ".json");
      if (!fs.existsSync(file)) continue;
      const recover = async () => {
        if (!fs.existsSync(file)) return;
        // The atomic SQL row is authoritative after an interrupted/ambiguous save.
        await this.saveInfo(await this.get(key));
        fs.rmSync(file);
      };
      if (id) await recover();
      else {
        const work = await this.get(key);
        await this.db.lock(`${work.repo}:${work.project}`, recover);
      }
    }
  }
  async saveInfo(work) {
    const { dir } = await this.repos.project(work.repo, work.project);
    const file = confined(dir, "production/work.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + ".tmp-" + randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify(this.info(work), null, 2) + "\n", {
        flag: "wx",
      });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  async update(id, fields, { expectedRevision } = {}) {
    const w = await this.get(id);
    return this.db.lock(`${w.repo}:${w.project}`, async () => {
      await this.repos.writable(w.repo, w.project);
      await this.recoverInfo(id);
      const current = await this.get(id);
      if (expectedRevision && expectedRevision !== current.metadataRevision)
        throw problem(409, "作品资料已更新，请重新打开资料后再保存");
      const next = { ...current, ...fields };
      const journal = path.join(this.data, "metadata-recovery", id + ".json");
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.writeFileSync(journal, JSON.stringify({ id }), { flag: "wx" });
      try {
        await this.repos.revisions?.invalidate(w.repo, w.project);
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
      } catch (error) {
        // Re-read SQL rather than blindly restoring an old snapshot: COMMIT may
        // have succeeded even when its response was lost. Keep the journal if offline.
        await this.recoverInfo(id).catch(() => {});
        throw error;
      }
      fs.rmSync(journal, { force: true });
      return this.get(id);
    });
  }
  async duplicate(id, title) {
    const w = await this.get(id, { active: true });
    return this.db.lock(`${w.repo}:${w.project}`, async () => {
      await this.repos.writable(w.repo, w.project);
      const { dir } = await this.repos.project(w.repo, w.project);
      const newId = randomUUID(),
        project = "work-" + newId.slice(0, 8);
      await this.db.pool.query(
        "INSERT INTO works(id,repo,project,title,category,description) VALUES($1,$2,$3,$4,$5,$6)",
        [newId, w.repo, project, title, w.category, w.description],
      );
      let dest;
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
        const repo = await this.repos.isolate(await this.get(newId));
        dest = confined(repo.root, "projects/" + project);
        await copyTree(dir, dest);
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
        const next = await this.get(newId);
        await this.saveInfo(next);
        await this.db.pool.query(
          "INSERT INTO asset_refs(asset,repo,project,path) SELECT asset,repo,$3,path FROM asset_refs WHERE repo=$1 AND project=$2 ON CONFLICT DO NOTHING",
          [w.repo, w.project, project],
        );
        await this.repos.checkpoint(w.repo, project, "复制作品 · " + title);
        return next;
      } catch (e) {
        await this.removeFailedCreation(newId, w.repo);
        await this.db.pool.query("DELETE FROM works WHERE id=$1", [newId]);
        throw e;
      }
    });
  }
  async version(id, name) {
    const w = await this.get(id, { active: true });
    return this.db.lock(`${w.repo}:${w.project}`, async () => {
      await this.repos.writable(w.repo, w.project);
      const commit = await this.repos.checkpoint(w.repo, w.project, name, {
        named: true,
      });
      return {
        id: commit,
        work: id,
        name,
        created: new Date().toISOString(),
        kind: "git",
      };
    });
  }
  async history(id, limit = 50, offset = 0) {
    const w = await this.get(id),
      { repo } = await this.repos.project(w.repo, w.project, { exists: false });
    const log = await this.repos.git(repo.root, [
      "log",
      `--max-count=${limit}`,
      `--skip=${offset}`,
      "--format=%H%x00%cI%x00%s%x00",
      "HEAD",
    ]);
    const fields = log.split("\0"),
      rows = [];
    for (let i = 0; i + 2 < fields.length; i += 3)
      rows.push({
        id: fields[i].trim(),
        created: fields[i + 1],
        name: fields[i + 2],
        kind: "git",
      });
    // Local snapshots from earlier installations remain recoverable during migration.
    if (offset === 0)
      rows.push(
        ...(await this.db.all(
          "SELECT *, 'snapshot' AS kind FROM work_versions WHERE work=$1 ORDER BY created DESC LIMIT 50",
          [id],
        )),
      );
    return rows;
  }
  async restore(id, version, expectedRevision) {
    const w = await this.get(id, { active: true });
    if (/^[a-f0-9]{40}$/.test(version))
      return this.restoreCommit(w, version, expectedRevision);
    if (
      !(await this.db.one(
        "SELECT id FROM work_versions WHERE id=$1 AND work=$2",
        [version, id],
      ))
    )
      throw problem(404, "Version not found");
    return this.db.lock(`${w.repo}:${w.project}`, async () => {
      await this.repos.writable(w.repo, w.project);
      if (expectedRevision) {
        const source = await assertSourceRevision(
          this.repos,
          w,
          expectedRevision,
        );
        if (
          source.outside ||
          source.branch !== w.branch ||
          source.merging ||
          source.files.some((file) => !file.untracked && file.index !== ".") ||
          source.files.some((file) => file.unsafe || file.conflict)
        )
          throw problem(
            409,
            "存在已暂存更改、作品范围外文件、冲突或不安全文件，请先处理后再恢复",
          );
      }
      const { dir } = await this.repos.project(w.repo, w.project, {
          exists: false,
        }),
        backup = randomUUID();
      await copyTree(dir, path.join(this.data, "versions", backup));
      await this.db.pool.query(
        "INSERT INTO work_versions(id,work,name) VALUES($1,$2,$3)",
        [backup, id, "恢复前自动备份"],
      );
      const run = path.join(this.data, "restores", randomUUID());
      fs.mkdirSync(run, { recursive: true });
      await this.repos.revisions?.invalidate(w.repo, w.project);
      await applyProject({
        source: path.join(this.data, "versions", version),
        destination: dir,
        run,
        id: randomUUID(),
        fingerprint: await treeHash(dir),
      });
      await this.saveInfo(w);
      await this.db.pool.query("UPDATE works SET updated=now() WHERE id=$1", [
        id,
      ]);
      await this.repos.checkpoint(w.repo, w.project, "恢复本地快照");
      fs.rmSync(run, { recursive: true, force: true });
      return this.get(id);
    });
  }
  async restoreCommit(w, version, expectedRevision) {
    await this.db.lock(`${w.repo}:${w.project}`, async () => {
      await this.repos.writable(w.repo, w.project);
      if (expectedRevision) {
        const source = await assertSourceRevision(
          this.repos,
          w,
          expectedRevision,
        );
        if (
          source.outside ||
          source.branch !== w.branch ||
          source.merging ||
          source.files.some((file) => !file.untracked && file.index !== ".") ||
          source.files.some((file) => file.unsafe || file.conflict)
        )
          throw problem(
            409,
            "存在已暂存更改、作品范围外文件、冲突或不安全文件，请先处理后再恢复",
          );
      }
      const { repo } = await this.repos.project(w.repo, w.project, {
        exists: false,
      });
      const valid = await this.repos
        .git(repo.root, ["merge-base", "--is-ancestor", version, "HEAD"])
        .then(
          () => true,
          () => false,
        );
      if (!valid) throw problem(400, "只能恢复当前作品分支的历史版本");
      await this.repos.git(repo.root, [
        "cat-file",
        "-e",
        `${version}:projects/${w.project}/project.ts`,
      ]);
      await versionTree(this.repos, w, version);
      const backup = await this.repos.checkpoint(
        w.repo,
        w.project,
        "恢复前自动保存",
      );
      await this.repos.revisions?.invalidate(w.repo, w.project);
      try {
        await this.repos.git(
          repo.root,
          [
            "restore",
            "--source=" + version,
            "--staged",
            "--worktree",
            "--",
            `projects/${w.project}`,
          ],
          true,
        );
        await this.repos.checkpoint(
          w.repo,
          w.project,
          "恢复版本 " + version.slice(0, 8),
          { named: true },
        );
      } catch (error) {
        await this.repos.git(
          repo.root,
          [
            "restore",
            "--source=" + backup,
            "--staged",
            "--worktree",
            "--",
            `projects/${w.project}`,
          ],
          true,
        );
        throw error;
      }
    });
    await this.db.pool.query("UPDATE works SET updated=now() WHERE id=$1", [
      w.id,
    ]);
    await this.discover(w.repo, w.project);
    return this.get(w.id);
  }
}

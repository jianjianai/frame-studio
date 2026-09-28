import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash, problem, confined } from "./security.mjs";
export class Assets {
  constructor(db, data, repos) {
    this.db = db;
    this.data = data;
    this.repos = repos;
    fs.mkdirSync(path.join(data, "blobs"), { recursive: true });
  }
  async register(
    file,
    { name, mime = "application/octet-stream", license = "", tags = "" },
  ) {
    if (!name || name.length > 200 || /[\\/\x00-\x1f]/.test(name))
      throw problem(400, "Invalid filename");
    if (!license.trim()) throw problem(400, "Source/license is required");
    const bytes = fs.statSync(file).size;
    const { fileSha256 } = await import("../scripts/production-input.mjs");
    const sha = fileSha256(file),
      dest = path.join(this.data, "blobs", sha);
    return this.db.lock("blob:" + sha, async () => {
      if (!fs.existsSync(dest))
        fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      const id = randomUUID();
      return this.db.one(
        "INSERT INTO assets(id,name,sha,bytes,mime,license,tags) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id, name, sha, bytes, mime, license, tags],
      );
    });
  }
  async list({ unused = false, deleted = false, search = "" } = {}) {
    return this.db.all(
      `SELECT a.*, COALESCE(jsonb_agg(jsonb_build_object('repo',r.repo,'project',r.project,'path',r.path)) FILTER(WHERE r.asset IS NOT NULL),'[]') AS refs FROM assets a LEFT JOIN asset_refs r ON r.asset=a.id WHERE a.deleted=$1 AND (a.name ILIKE $2 OR a.tags ILIKE $2) GROUP BY a.id ${unused ? "HAVING count(r.asset)=0" : ""} ORDER BY a.created DESC`,
      [deleted, "%" + search + "%"],
    );
  }
  async get(id) {
    const a = await this.db.one("SELECT * FROM assets WHERE id=$1", [id]);
    if (!a) throw problem(404, "Asset not found");
    return a;
  }
  async attach(id, repo, project) {
    return this.db.lock(repo, async () => {
      await this.repos.writable(repo);
      const a = await this.get(id);
      if (a.deleted) throw problem(409, "Restore asset first");
      const { dir } = await this.repos.project(repo, project);
      const ext = path
          .extname(a.name)
          .replace(/[^.a-zA-Z0-9]/g, "")
          .slice(0, 12),
        relative = `public/imports/${a.sha.slice(0, 20)}${ext}`,
        dest = confined(dir, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest) && hash(fs.readFileSync(dest)) !== a.sha)
        throw problem(409, "Project asset path has different contents");
      fs.copyFileSync(path.join(this.data, "blobs", a.sha), dest);
      const manifest = confined(dir, "production/materials.json");
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      const refs = fs.existsSync(manifest)
        ? JSON.parse(fs.readFileSync(manifest, "utf8"))
        : [];
      if (!Array.isArray(refs))
        throw problem(409, "Invalid materials manifest");
      fs.writeFileSync(
        manifest,
        JSON.stringify(
          [
            ...refs.filter((r) => r.asset !== id),
            {
              asset: id,
              path: relative,
              sha256: a.sha,
              source: a.license,
              name: a.name,
            },
          ],
          null,
          2,
        ),
      );
      await this.db.pool.query(
        "INSERT INTO asset_refs VALUES($1,$2,$3,$4) ON CONFLICT(asset,repo,project) DO UPDATE SET path=$4",
        [id, repo, project, relative],
      );
      return { path: relative, url: `films/${project}/${relative.slice(7)}` };
    });
  }
  async trash(id, deleted) {
    if (
      deleted &&
      (await this.db.one(
        "SELECT asset FROM asset_refs WHERE asset=$1 LIMIT 1",
        [id],
      ))
    )
      throw problem(
        409,
        "Asset is attached to a project; detach the association first",
      );
    await this.db.pool.query("UPDATE assets SET deleted=$2 WHERE id=$1", [
      id,
      deleted,
    ]);
    return { ok: true };
  }
  async detach(id, repo, project) {
    return this.db.lock(repo, async () => {
      await this.repos.writable(repo);
      const { dir } = await this.repos.project(repo, project);
      const manifest = confined(dir, "production/materials.json");
      if (fs.existsSync(manifest)) {
        const refs = JSON.parse(fs.readFileSync(manifest, "utf8"));
        fs.writeFileSync(
          manifest,
          JSON.stringify(
            refs.filter((r) => r.asset !== id),
            null,
            2,
          ),
        );
      }
      await this.db.pool.query(
        "DELETE FROM asset_refs WHERE asset=$1 AND repo=$2 AND project=$3",
        [id, repo, project],
      );
      return {
        ok: true,
        note: "Project file retained to preserve possible dynamic code references",
      };
    });
  }
  async purge(id) {
    const asset = await this.get(id);
    return this.db.lock("blob:" + asset.sha, async () => {
      const deleted = await this.db.one(
        "DELETE FROM assets WHERE id=$1 AND deleted=true AND NOT EXISTS(SELECT 1 FROM asset_refs WHERE asset=$1) RETURNING sha",
        [id],
      );
      if (!deleted)
        throw problem(
          409,
          "Only unassigned recycled assets can be permanently deleted",
        );
      if (
        !(await this.db.one("SELECT id FROM assets WHERE sha=$1 LIMIT 1", [
          deleted.sha,
        ]))
      )
        fs.rmSync(path.join(this.data, "blobs", deleted.sha), { force: true });
      return { ok: true };
    });
  }
}

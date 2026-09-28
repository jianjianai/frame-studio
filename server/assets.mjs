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
    this.digests = new Map();
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
    await this.reconcile();
    return this.db.all(
      `SELECT a.*, COALESCE(jsonb_agg(jsonb_build_object('repo',r.repo,'project',r.project,'path',r.path,'work',w.id,'title',COALESCE(w.title,r.project),'deleted',COALESCE(w.deleted,false))) FILTER(WHERE r.asset IS NOT NULL),'[]') AS refs FROM assets a LEFT JOIN asset_refs r ON r.asset=a.id LEFT JOIN works w ON w.repo=r.repo AND w.project=r.project WHERE a.deleted=$1 AND (a.name ILIKE $2 OR a.tags ILIKE $2) GROUP BY a.id ${unused ? "HAVING count(r.asset)=0" : ""} ORDER BY a.created DESC`,
      [deleted, "%" + search + "%"],
    );
  }
  async reconcile() {
    // File presence is authoritative, including dynamically referenced materials and recycled works.
    // Cache only unchanged files. Reopening, Git pulls, AI edits and snapshot restores are reflected.
    if (this.scanning) return this.scanning;
    this.scanning = this.scanReferences();
    try {
      await this.scanning;
    } finally {
      this.scanning = null;
    }
  }
  async scanReferences() {
    const rows = await this.db.all("SELECT id,sha,bytes FROM assets");
    const sizes = new Set(rows.map((a) => Number(a.bytes))),
      byHash = new Map();
    for (const a of rows)
      byHash.set(a.sha, [...(byHash.get(a.sha) || []), a.id]);
    const seen = new Map();
    const { fileSha256 } = await import("../scripts/production-input.mjs");
    for (const r of await this.repos.list())
      for (const p of r.projects) {
        const { dir } = await this.repos.project(r.id, p.id);
        const walk = (folder) => {
          if (!fs.existsSync(folder)) return;
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const relative = path
              .relative(dir, path.join(folder, entry.name))
              .replaceAll("\\", "/");
            const file = confined(dir, relative),
              st = fs.statSync(file);
            if (st.isDirectory()) walk(file);
            else if (sizes.has(st.size)) {
              const signature = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
              let cache = this.digests.get(file);
              if (cache?.signature !== signature) {
                cache = { signature, sha: fileSha256(file) };
                this.digests.set(file, cache);
              }
              for (const asset of byHash.get(cache.sha) || [])
                seen.set(`${asset}:${r.id}:${p.id}`, {
                  asset,
                  repo: r.id,
                  project: p.id,
                  path: relative,
                });
            }
          }
        };
        walk(confined(dir, "public"));
      }
    for (const ref of await this.db.all("SELECT * FROM asset_refs")) {
      if (!seen.has(`${ref.asset}:${ref.repo}:${ref.project}`))
        await this.db.pool.query(
          "DELETE FROM asset_refs WHERE asset=$1 AND repo=$2 AND project=$3",
          [ref.asset, ref.repo, ref.project],
        );
    }
    for (const ref of seen.values())
      await this.db.pool.query(
        "INSERT INTO asset_refs VALUES($1,$2,$3,$4) ON CONFLICT(asset,repo,project) DO UPDATE SET path=$4",
        [ref.asset, ref.repo, ref.project, ref.path],
      );
  }
  async get(id) {
    const a = await this.db.one("SELECT * FROM assets WHERE id=$1", [id]);
    if (!a) throw problem(404, "Asset not found");
    return a;
  }
  async importProject(repo, project) {
    const { dir } = await this.repos.project(repo, project);
    let catalog = [];
    try {
      catalog = JSON.parse(
        fs.readFileSync(confined(dir, "public/assets.json"), "utf8"),
      );
    } catch {}
    if (!Array.isArray(catalog)) catalog = [];
    const known = new Set(
      (await this.db.all("SELECT sha FROM assets")).map((a) => a.sha),
    );
    const { fileSha256 } = await import("../scripts/production-input.mjs");
    const types = {
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".glb": "model/gltf-binary",
      ".sf2": "application/octet-stream",
      ".bin": "application/octet-stream",
    };
    const walk = async (folder) => {
      if (!fs.existsSync(folder)) return;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = confined(
          dir,
          path
            .relative(dir, path.join(folder, entry.name))
            .replaceAll("\\", "/"),
        );
        if (entry.isDirectory()) await walk(file);
        else if (types[path.extname(entry.name).toLowerCase()]) {
          const st = fs.statSync(file),
            signature = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
          let cache = this.digests.get(file);
          if (cache?.signature !== signature) {
            cache = { signature, sha: fileSha256(file) };
            this.digests.set(file, cache);
          }
          if (known.has(cache.sha)) continue;
          const url = `films/${project}/${path.relative(path.join(dir, "public"), file).replaceAll("\\", "/")}`;
          const meta = catalog.find((a) => a.url === url);
          await this.register(file, {
            name: entry.name,
            mime: types[path.extname(entry.name).toLowerCase()],
            license:
              meta?.license || `来自作品 ${project}；来源与许可见作品制作资料`,
            tags: "作品导入",
          });
          known.add(cache.sha);
        }
      }
    };
    await walk(confined(dir, "public"));
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
    await this.reconcile();
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
    await this.reconcile();
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

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
  async migrate() {
    if (await this.db.setting("asset-repositories-v4")) return;
    const repositories = await this.db.all(
        "SELECT id FROM repos ORDER BY created",
      ),
      preferred = await this.db.setting("default-repository");
    const target =
      repositories.find((r) => r.id === preferred?.id)?.id ||
      (repositories.length === 1 ? repositories[0].id : null);
    const unassigned = await this.db.all(
      "SELECT id FROM assets WHERE NOT EXISTS(SELECT 1 FROM asset_repos ar WHERE ar.asset=assets.id)",
    );
    if (unassigned.length && !target)
      throw new Error(
        "Legacy materials need a default content repository before migration",
      );
    if (target)
      for (const asset of unassigned)
        await this.linkRepository(asset.id, target);
    await this.db.setting("asset-repositories-v4", {
      completed: new Date().toISOString(),
      repository: target,
      imported: unassigned.length,
    });
  }
  async register(
    file,
    {
      name,
      mime = "application/octet-stream",
      license = "",
      tags = "",
      repo = null,
    },
  ) {
    if (!name || name.length > 200 || /[\\/\x00-\x1f]/.test(name))
      throw problem(400, "Invalid filename");
    if (!license.trim()) throw problem(400, "Source/license is required");
    if (repo) await this.repos.get(repo);
    const bytes = fs.statSync(file).size;
    const { fileSha256 } = await import("../scripts/production-input.mjs");
    const sha = fileSha256(file),
      dest = path.join(this.data, "blobs", sha);
    const registered = await this.db.lock("blob:" + sha, async () => {
      if (!fs.existsSync(dest))
        fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      const id = randomUUID();
      return this.db.one(
        "INSERT INTO assets(id,name,sha,bytes,mime,license,tags) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id, name, sha, bytes, mime, license, tags],
      );
    });
    if (repo) await this.linkRepository(registered.id, repo);
    return registered;
  }
  async list({
    unused = false,
    deleted = false,
    search = "",
    repo = null,
    project = null,
    limit = 60,
    offset = 0,
  } = {}) {
    await this.reconcile(repo, false);
    return this.db.all(
      `SELECT a.*, COALESCE(jsonb_agg(jsonb_build_object('repo',r.repo,'project',r.project,'path',r.path,'work',w.id,'title',COALESCE(w.title,r.project),'deleted',COALESCE(w.deleted,false))) FILTER(WHERE r.asset IS NOT NULL),'[]') AS refs FROM assets a LEFT JOIN asset_refs r ON r.asset=a.id LEFT JOIN works w ON w.repo=r.repo AND w.project=r.project WHERE a.deleted=$1 AND (a.name ILIKE $2 OR a.tags ILIKE $2) AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM asset_repos ar WHERE ar.asset=a.id AND ar.repo=$3)) AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM asset_refs ar WHERE ar.asset=a.id AND ar.repo=$3 AND ar.project=$6)) GROUP BY a.id ${unused ? "HAVING count(r.asset)=0" : ""} ORDER BY a.created DESC,a.id LIMIT $4 OFFSET $5`,
      [
        deleted,
        "%" + search + "%",
        repo,
        Math.min(200, limit),
        offset,
        project,
      ],
    );
  }
  async reconcile(repo = null, force = true) {
    // File presence is authoritative, including dynamically referenced materials and recycled works.
    // Cache only unchanged files. Reopening, Git pulls, AI edits and snapshot restores are reflected.
    this.scans ||= new Map();
    const key = repo || "all",
      previous = this.scans.get(key);
    if (previous?.promise) return previous.promise;
    if (!force && previous?.at > Date.now() - 30000) return;
    const promise = this.scanReferences(repo);
    this.scans.set(key, { promise });
    try {
      await promise;
      this.scans.set(key, { at: Date.now() });
    } finally {
      if (this.scans.get(key)?.promise) this.scans.delete(key);
    }
  }
  async scanReferences(repository = null) {
    const rows = await this.db.all(
      "SELECT a.id,a.sha,a.bytes,ar.repo FROM assets a JOIN asset_repos ar ON ar.asset=a.id WHERE ($1::uuid IS NULL OR ar.repo=$1)",
      [repository],
    );
    const sizes = new Set(rows.map((a) => Number(a.bytes))),
      byHash = new Map();
    for (const a of rows)
      byHash.set(a.repo + ":" + a.sha, [
        ...(byHash.get(a.repo + ":" + a.sha) || []),
        a.id,
      ]);
    const seen = new Map();
    const { fileSha256 } = await import("../scripts/production-input.mjs");
    for (const r of await this.repos.list(repository))
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
              for (const asset of byHash.get(r.id + ":" + cache.sha) || [])
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
    for (const ref of await this.db.all(
      "SELECT * FROM asset_refs WHERE ($1::uuid IS NULL OR repo=$1)",
      [repository],
    )) {
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
  async update(id, name, tags, license) {
    return this.db.lock("asset:" + id, async () => {
      if (!name.trim() || /[\\/\x00-\x1f]/.test(name))
        throw problem(400, "Invalid filename");
      const previous = await this.get(id);
      await this.db.pool.query(
        "UPDATE assets SET name=$2,tags=$3,license=$4 WHERE id=$1",
        [id, name, tags, license || previous.license],
      );
      for (const { repo } of await this.db.all(
        "SELECT repo FROM asset_repos WHERE asset=$1",
        [id],
      )) {
        await this.db.lock(repo + ":materials", async () => {
          await this.linkRepository(id, repo, true);
          if (name !== previous.name) {
            const shared = await this.db.one(
              "SELECT a.id FROM assets a JOIN asset_repos ar ON ar.asset=a.id WHERE ar.repo=$1 AND a.sha=$2 AND a.name=$3",
              [repo, previous.sha, previous.name],
            );
            if (!shared)
              fs.rmSync(
                confined(
                  (await this.repos.library(repo)).root,
                  `materials/${previous.sha}/${previous.name}`,
                ),
                { force: true },
              );
          }
        });
      }
      return this.get(id);
    });
  }
  async linkRepository(id, repo, locked = false) {
    const write = async () => {
      const a = await this.get(id),
        r = await this.repos.library(repo);
      const relative = `materials/${a.sha}/${a.name}`;
      const dest = confined(r.root, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest))
        fs.copyFileSync(path.join(this.data, "blobs", a.sha), dest);
      await this.db.pool.query(
        "INSERT INTO asset_repos(asset,repo,catalog_id) VALUES($1,$2,$1) ON CONFLICT DO NOTHING",
        [id, repo],
      );
      await this.saveCatalog(repo);
    };
    return locked ? write() : this.db.lock(repo + ":materials", write);
  }
  async saveCatalog(repo) {
    const r = await this.repos.library(repo);
    const rows = await this.db.all(
      "SELECT COALESCE(ar.catalog_id,a.id) AS id,a.name,a.sha,a.mime,a.license,a.tags,a.deleted FROM assets a JOIN asset_repos ar ON ar.asset=a.id WHERE ar.repo=$1 ORDER BY a.sha,a.id",
      [repo],
    );
    const file = confined(r.root, "materials/index.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(rows, null, 2) + "\n");
    fs.renameSync(file + ".tmp", file);
  }
  async indexRepository(repo) {
    return this.db.lock(repo + ":materials", async () => {
      const r = await this.repos.library(repo),
        file = confined(r.root, "materials/index.json");
      if (!fs.existsSync(file)) return;
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(rows)) throw problem(409, "Invalid material catalog");
      const present = new Set();
      for (const row of rows) {
        if (
          !/^[a-f0-9]{64}$/.test(row.sha) ||
          typeof row.name !== "string" ||
          !row.name ||
          row.name.length > 200 ||
          /[\\/\x00-\x1f]/.test(row.name) ||
          !/^[0-9a-f-]{36}$/.test(row.id)
        )
          throw problem(409, "Invalid material catalog entry");
        const existing = await this.db.one(
          "SELECT a.id,a.sha FROM assets a JOIN asset_repos ar ON ar.asset=a.id WHERE ar.repo=$1 AND ar.catalog_id=$2",
          [repo, row.id],
        );
        const source = confined(r.root, `materials/${row.sha}/${row.name}`);
        if (!fs.existsSync(source))
          throw problem(409, "Material catalog file missing");
        const { fileSha256 } = await import("../scripts/production-input.mjs");
        if (fileSha256(source) !== row.sha)
          throw problem(409, "Material checksum mismatch");
        if (existing && existing.sha !== row.sha)
          throw problem(
            409,
            "Material identity changed; import it with a new identifier",
          );
        if (existing) {
          await this.db.pool.query(
            "UPDATE assets SET name=$2,tags=$3,license=$4,deleted=$5 WHERE id=$1",
            [
              existing.id,
              row.name,
              String(row.tags || "").slice(0, 1000),
              String(row.license || "Imported from repository").slice(0, 4000),
              row.deleted === true,
            ],
          );
          present.add(existing.id);
          continue;
        }
        const a = await this.register(source, {
          ...row,
          license: row.license || "Imported from repository",
        });
        await this.db.pool.query(
          "INSERT INTO asset_repos(asset,repo,catalog_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [a.id, repo, row.id],
        );
        present.add(a.id);
        if (row.deleted)
          await this.db.pool.query(
            "UPDATE assets SET deleted=true WHERE id=$1",
            [a.id],
          );
      }
      await this.db.pool.query(
        "DELETE FROM asset_repos WHERE repo=$1 AND NOT (asset=ANY($2::uuid[]))",
        [repo, [...present]],
      );
      this.scans?.delete(repo);
    });
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
      (
        await this.db.all(
          "SELECT a.sha FROM assets a JOIN asset_repos ar ON ar.asset=a.id WHERE ar.repo=$1",
          [repo],
        )
      ).map((a) => a.sha),
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
            repo,
          });
          known.add(cache.sha);
        }
      }
    };
    await walk(confined(dir, "public"));
  }
  async attach(id, repo, project) {
    return this.db.lock("asset:" + id, () =>
      this.db.lock(`${repo}:${project}`, async () => {
        await this.repos.writable(repo, project);
        const a = await this.get(id);
        if (a.deleted) throw problem(409, "Restore asset first");
        await this.linkRepository(id, repo);
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
      }),
    );
  }
  async reconcileAsset(id) {
    for (const { repo } of await this.db.all(
      "SELECT repo FROM asset_repos WHERE asset=$1",
      [id],
    ))
      await this.reconcile(repo);
  }
  async trash(id, deleted) {
    return this.db.lock("asset:" + id, async () => {
      await this.reconcileAsset(id);
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
      for (const { repo } of await this.db.all(
        "SELECT repo FROM asset_repos WHERE asset=$1",
        [id],
      ))
        await this.db.lock(repo + ":materials", () => this.saveCatalog(repo));
      return { ok: true };
    });
  }
  async detach(id, repo, project) {
    return this.db.lock(`${repo}:${project}`, async () => {
      await this.repos.writable(repo, project);
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
      this.scans?.delete(repo);
      this.scans?.delete("all");
      return {
        ok: true,
        note: "Project file retained to preserve possible dynamic code references",
      };
    });
  }
  async purge(id) {
    return this.db.lock("asset:" + id, async () => {
      await this.reconcileAsset(id);
      const asset = await this.get(id);
      const memberships = await this.db.all(
        "SELECT repo FROM asset_repos WHERE asset=$1",
        [id],
      );
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
        for (const { repo } of memberships)
          await this.db.lock(repo + ":materials", async () => {
            const shared = await this.db.one(
              "SELECT a.id FROM assets a JOIN asset_repos ar ON ar.asset=a.id WHERE ar.repo=$1 AND a.sha=$2 AND a.name=$3",
              [repo, asset.sha, asset.name],
            );
            if (!shared)
              fs.rmSync(
                confined(
                  (await this.repos.library(repo)).root,
                  `materials/${asset.sha}/${asset.name}`,
                ),
                { force: true },
              );
            await this.saveCatalog(repo);
          });
        if (
          !(await this.db.one("SELECT id FROM assets WHERE sha=$1 LIMIT 1", [
            deleted.sha,
          ]))
        )
          fs.rmSync(path.join(this.data, "blobs", deleted.sha), {
            force: true,
          });
        return { ok: true };
      });
    });
  }
}

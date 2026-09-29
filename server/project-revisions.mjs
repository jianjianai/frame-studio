import { treeHash } from "./project-files.mjs";

/** SQL is the shared cache; only controlled changes or explicit refresh scan files. */
export class ProjectRevisions {
  constructor(db, repos) { this.db = db; this.repos = repos; this.pending = new Map(); }
  invalidate(repo, project = null) {
    return this.db.pool.query(
      "UPDATE works SET source_generation=source_generation+1,source_revision=NULL,source_indexed_at=NULL WHERE repo=$1 AND ($2::text IS NULL OR project=$2)",
      [repo, project],
    );
  }
  read(repo, project) {
    return this.db.one("SELECT source_generation,source_revision,source_indexed_at FROM works WHERE repo=$1 AND project=$2", [repo, project]);
  }
  async refreshIfIdle(repo, project) {
    try { return await this.refresh(repo, project); }
    catch (error) {
      if (error.statusCode !== 409) throw error;
      // A busy or concurrently changing work stays unindexed/stale, never falsely current.
      return this.read(repo, project);
    }
  }
  async refresh(repo, project, { locked = false } = {}) {
    const key = repo + ":" + project;
    if (this.pending.has(key)) return this.pending.get(key);
    const scan = async () => {
      await this.invalidate(repo, project);
      const before = await this.read(repo, project);
      if (!before) return null;
      const { dir } = await this.repos.project(repo, project);
      const revision = await treeHash(dir);
      const saved = await this.db.one(
        "UPDATE works SET source_revision=$4,source_indexed_at=now() WHERE repo=$1 AND project=$2 AND source_generation=$3 RETURNING source_revision,source_generation,source_indexed_at",
        [repo, project, before.source_generation, revision],
      );
      // A concurrent invalidation wins; never label a mixed or older scan current.
      return saved || this.read(repo, project);
    };
    const pending = (locked ? scan() : this.db.lock(key, scan)).finally(() => {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    });
    this.pending.set(key, pending);
    return pending;
  }
}

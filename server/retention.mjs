import fs from "node:fs";
import path from "node:path";

export class Retention {
  constructor(db, data) {
    Object.assign(this, { db, data });
    this.downloads = new Map();
  }
  lease(id) {
    this.downloads.set(id, (this.downloads.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = this.downloads.get(id) - 1;
      n ? this.downloads.set(id, n) : this.downloads.delete(id);
    };
  }
  async cleanTask(id, { manual = false } = {}) {
    return this.db.lock(`artifact:${id}`, async () => {
      if (this.downloads.has(id)) return false;
      const task = await this.db.one(
        "SELECT * FROM tasks WHERE id=$1 AND state NOT IN ('queued','running','cancelling') AND cleaned IS NULL",
        [id],
      );
      if (!task) return false;
      if (
        !manual &&
        (!task.expires || new Date(task.expires).getTime() > Date.now())
      )
        return false;
      if (
        task.kind === "build" &&
        !task.input?.version &&
        (await this.db
          .one(
            "SELECT id FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND input->>'version' IS NULL AND state='succeeded' AND cleaned IS NULL ORDER BY created DESC LIMIT 1",
            [task.repo, task.project],
          )
          .then((row) => row?.id === id))
      )
        return false;
      if (
        await this.db.one(
          "SELECT key FROM settings WHERE key LIKE 'preview:%' AND value->>'task'=$1 AND (value->>'expires')::bigint>$2 LIMIT 1",
          [id, Date.now()],
        )
      )
        return false;
      const root = path.resolve(this.data, "runs"),
        target = path.resolve(root, id);
      if (!/^[0-9a-f-]{36}$/.test(id) || path.dirname(target) !== root)
        throw new Error("Invalid run directory");
      fs.rmSync(target, { recursive: true, force: true });
      await this.db.pool.query("UPDATE tasks SET cleaned=now() WHERE id=$1", [
        id,
      ]);
      return true;
    });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.db.pool.query("DELETE FROM sessions WHERE expires<now()");
      await this.db.pool.query(
        "DELETE FROM agent_tokens WHERE task IN (SELECT id FROM tasks WHERE state NOT IN ('queued','running','cancelling'))",
      );
      await this.db.pool.query(
        "DELETE FROM settings WHERE key LIKE 'preview:%' AND (value->>'expires')::bigint<$1",
        [Date.now()],
      );
      await this.db.pool.query(
        "DELETE FROM settings WHERE key LIKE 'preview-link:%' AND (value->>'until')::bigint<$1",
        [Date.now()],
      );
      for (const task of await this.db.all(
        `SELECT t.id FROM tasks t WHERE t.expires<now() AND t.cleaned IS NULL AND t.state IN ('succeeded','failed','cancelled')
        AND NOT (t.kind='build' AND t.input->>'version' IS NULL AND t.state='succeeded' AND NOT EXISTS(SELECT 1 FROM tasks newer WHERE newer.repo=t.repo AND newer.project=t.project AND newer.kind='build' AND newer.input->>'version' IS NULL AND newer.state='succeeded' AND newer.cleaned IS NULL AND newer.created>t.created))
        AND NOT EXISTS(SELECT 1 FROM settings s WHERE s.key LIKE 'preview:%' AND s.value->>'task'=t.id::text AND (s.value->>'expires')::bigint>$1)
        ORDER BY t.expires LIMIT 30`,
        [Date.now()],
      )) {
        await this.cleanTask(task.id).catch(() => {});
      }
      const uploads = path.join(this.data, "uploads");
      if (fs.existsSync(uploads))
        for (const entry of fs.readdirSync(uploads, { withFileTypes: true })) {
          if (!/^[0-9a-f-]{36}$/.test(entry.name) || entry.isSymbolicLink())
            continue;
          const file = path.join(uploads, entry.name);
          if (Date.now() - fs.statSync(file).mtimeMs > 86400000)
            await this.db
              .lock("upload:" + entry.name, async () =>
                fs.rmSync(file, { recursive: true, force: true }),
              )
              .catch(() => {});
        }
    } finally {
      this.running = false;
    }
  }
  start() {
    this.timer = setInterval(
      () => void this.tick().catch(console.error),
      60000,
    );
    this.timer.unref();
    void this.tick().catch(console.error);
  }
  close() {
    clearInterval(this.timer);
  }
}

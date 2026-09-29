import { randomUUID } from "node:crypto";
import { problem } from "./security.mjs";

/** Persistent, renewable read leases work across API and cleanup processes. */
export class ArtifactLeases {
  constructor(db) { this.db = db; this.active = new Map(); }
  async acquire(task, { onLost = () => {} } = {}) {
    const id = randomUUID();
    await this.db.lock("artifact:" + task, async () => {
      const current = await this.db.one("SELECT id FROM tasks WHERE id=$1 AND cleaned IS NULL AND state IN ('succeeded','failed','cancelled')", [task]);
      if (!current) throw problem(410, "Artifact is unavailable or being cleaned");
      await this.db.pool.query("INSERT INTO artifact_leases(id,task,expires) VALUES($1,$2,now()+interval '120 seconds')", [id, task]);
    });
    let released = false, renewing = false, watchdog;
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      clearTimeout(watchdog);
      this.active.delete(id);
      await this.db.pool.query("DELETE FROM artifact_leases WHERE id=$1", [id]);
    };
    const lost = () => {
      if (released) return;
      try { onLost(new Error("Artifact read lease lost; transfer stopped to protect cleanup consistency")); }
      catch { /* A consumer callback cannot prevent lease cleanup. */ }
      return release().catch(() => {});
    };
    const guard = () => { clearTimeout(watchdog); watchdog = setTimeout(lost, 60000); watchdog.unref(); };
    const timer = setInterval(async () => {
      if (released || renewing) return;
      renewing = true;
      try {
        const row = await this.db.one("UPDATE artifact_leases SET expires=now()+interval '120 seconds' WHERE id=$1 AND expires>now() RETURNING id", [id]);
        if (released) return;
        if (row) guard(); else lost();
      } catch { lost(); }
      finally { renewing = false; }
    }, 20000);
    timer.unref();
    guard();
    this.active.set(id, { release, lost });
    return release;
  }
  async close() {
    await Promise.allSettled([...this.active.values()].map(({ lost }) => lost()));
  }
}

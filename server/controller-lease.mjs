import { randomUUID } from "node:crypto";

const key = "frame-task-controller";
/** A dedicated PostgreSQL session owns leadership; losing it fences all new side effects. */
export class ControllerLease {
  constructor(pool) { this.pool = pool; this.id = randomUUID(); this.client = null; this.closed = false; }
  get held() { return !!this.client && !this.closed; }
  lost(client) {
    if (this.client !== client) return;
    this.client = null;
    client.release(true);
  }
  async acquire() {
    if (this.closed) return false;
    if (this.client) { await this.assert(); return true; }
    const client = await this.pool.connect();
    let retained = false;
    const broken = () => this.lost(client);
    client.on("error", broken);
    client.on("end", broken);
    try {
      const row = await client.query({ text: "SELECT pg_try_advisory_lock(hashtext($1)) AS ok", values: [key], query_timeout: 5000 });
      if (!row.rows[0].ok || this.closed) return false;
      this.client = client;
      retained = true;
      return true;
    } finally {
      if (!retained) { client.removeListener("error", broken); client.removeListener("end", broken); client.release(true); }
    }
  }
  async assert() {
    const client = this.client;
    if (!client || this.closed) throw Object.assign(new Error("Controller leadership is unavailable"), { leadershipLost: true });
    try {
      await client.query({ text: "SELECT 1", query_timeout: 5000 });
      if (client !== this.client || this.closed) throw Error("Controller leadership changed");
    } catch (error) {
      this.lost(client);
      throw Object.assign(new Error("Controller leadership lost; execution copies remain recoverable"), { leadershipLost: true, cause: error });
    }
  }
  close() {
    this.closed = true;
    const client = this.client;
    this.client = null;
    if (client) client.release(true); // Destroy the session; never return a held lock to the pool.
  }
}

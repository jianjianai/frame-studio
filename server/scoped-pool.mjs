import { AsyncLocalStorage } from "node:async_hooks";

/**
 * An advisory lock owns a connection until its callback settles. Queries made
 * by that callback use the same connection, including nested locks, so lock
 * holders never wait for a second slot in their own saturated pool.
 */
export function scopedPool(rawPool, lockPool = rawPool) {
  const context = new AsyncLocalStorage();
  const current = () => {
    const scope = context.getStore();
    return scope?.active && scope.resource.active ? scope.resource : undefined;
  };
  const query = (...args) => (current()?.client || rawPool).query(...args);
  const pool = new Proxy(rawPool, {
    get(target, key) {
      if (key === "query") return query;
      if (key === "end") return async () => {
        const results = await Promise.allSettled(
          [rawPool, ...(lockPool === rawPool ? [] : [lockPool])].map(pool => pool.end()),
        );
        const failed = results.filter(result => result.status === "rejected");
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Database pools failed to close");
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  async function acquireClient() {
    const resource = current();
    if (!resource) return rawPool.connect();
    // Two manual BEGIN/COMMIT sequences on one connection must never overlap.
    // A caller needing an independent long-lived connection uses pool.connect.
    if (resource.borrowed)
      throw new Error(
        "A transaction already owns the advisory-lock connection",
      );
    resource.borrowed = true;
    let released = false;
    return {
      query(...args) {
        if (released || !resource.active)
          throw new Error("Database client has been released");
        return resource.client.query(...args);
      },
      release(error) {
        if (released) return;
        released = true;
        resource.borrowed = false;
        if (error) resource.broken = true;
      },
    };
  }

  async function lock(id, fn) {
    const parent = current();
    const resource = parent || {
      client: await lockPool.connect(),
      active: true,
      borrowed: false,
      broken: false,
    };
    const scope = { resource, active: true };
    let locked = false;
    const onError = () => {
      resource.broken = true;
    };
    if (!parent) resource.client.on("error", onError);
    try {
      const row = await resource.client.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
        [id],
      );
      if (!row.rows[0].ok) {
        const error = new Error("Repository is busy");
        error.statusCode = 409;
        throw error;
      }
      locked = true;
      return await context.run(scope, fn);
    } finally {
      // Detached continuations can outlive fn; they must not use a returned
      // client merely because AsyncLocalStorage propagated the old scope.
      scope.active = false;
      if (locked) {
        try {
          const result = await resource.client.query(
            "SELECT pg_advisory_unlock(hashtext($1)) AS ok",
            [id],
          );
          if (!result.rows[0].ok) resource.broken = true;
        } catch {
          resource.broken = true;
        }
      }
      if (!parent) {
        resource.active = false;
        resource.client.off("error", onError);
        resource.client.release(resource.broken || resource.borrowed);
      }
    }
  }

  return { pool, lock, acquireClient };
}

/** Explicit transaction clients borrow a surrounding lock without releasing it. */
export function acquireDatabaseClient(db) {
  return db.acquireClient ? db.acquireClient() : db.pool.connect();
}

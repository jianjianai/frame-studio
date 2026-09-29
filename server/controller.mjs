import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServices } from "./services.mjs";
import { command } from "./process.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";

/** No HTTP routes: only this private process has access to Docker's control socket. */
export async function startController(options = {}) {
  if (process.env.FRAME_ROLE === "api") throw Error("Cannot start a controller in the public API role");
  const services = await createServices({ ...options, initialize: false });
  const { db, tasks, retention } = services;
  const runtime = await runtimeIdentity();
  let closed = false, reporting = false;
  const healthFile = "/tmp/frame-controller-health.json";
  const report = async () => {
    if (closed || reporting) return;
    reporting = true;
    try {
      let leader = false, docker = { ok: false };
      if (tasks.lease?.held) {
        await tasks.assertLeadership();
        leader = true;
        try { docker = { ok: true, version: (await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 3000, max: 65536 })).trim() }; }
        catch (error) { docker.error = error.message.slice(0, 300); }
      } else await db.one("SELECT 1");
      const value = { checked: Date.now(), controllerId: tasks.controllerId, leader, docker,
        limits: tasks.limits, queueBlocked: tasks.queueBlocked, runtimeFingerprint: runtime.fingerprint };
      if (leader) {
        await tasks.assertLeadership();
        await db.setting("controller-runtime", value);
      }
      await fs.writeFile(healthFile + ".tmp", JSON.stringify({ checked: Date.now(), connected: true, leader, ready: !leader || docker.ok }), { mode: 0o600 });
      await fs.rename(healthFile + ".tmp", healthFile);
    } catch (error) { console.error("Controller heartbeat:", error.message); }
    finally { reporting = false; }
  };
  tasks.startLoop({ onLeadership: leader => leader ? retention.start() : retention.stop() });
  const timer = setInterval(() => void report(), 10000);
  void report();
  return { ...services, async close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    retention.stop();
    await services.close();
    await fs.rm(healthFile, { force: true });
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.FRAME_ROLE ||= "controller";
  const controller = await startController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => { void controller.close().catch(error => { console.error(error.message); process.exitCode = 1; }); });
}

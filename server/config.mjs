import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const appRoot = fileURLToPath(new URL("..", import.meta.url));
export const appVersion = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;

/**
 * Everything FRAME writes lives under one data directory:
 *   settings.json / secrets.json   configuration (secrets are 0600)
 *   repos/<repo>/                  main clone of each content repository
 *   works/<repo>/<work>/           git worktree of branch works/<work>
 *   libraries/<repo>/              worktree of the frame/materials branch
 *   exports/<work>/                rendered videos
 *   models/                        installed speech models
 *   ai/                            chat transcripts
 *   tmp/                           render snapshots and uploads in progress
 */
export function loadConfig(env = process.env) {
  const home = path.resolve(env.FRAME_HOME || path.join(os.homedir(), ".frame-studio"));
  const host = env.FRAME_HOST || "127.0.0.1";
  const port = Number(env.FRAME_PORT || 4310);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("FRAME_PORT must be a TCP port");
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  const password = env.FRAME_PASSWORD || "";
  if ((!local || env.FRAME_PUBLIC_URL) && !password)
    throw new Error("The studio is reachable from the network (FRAME_HOST / FRAME_PUBLIC_URL): set FRAME_PASSWORD");
  return {
    home,
    host,
    port,
    password,
    dev: env.FRAME_DEV === "1",
    publicUrl: env.FRAME_PUBLIC_URL || "",
    dirs: {
      repos: path.join(home, "repos"),
      works: path.join(home, "works"),
      libraries: path.join(home, "libraries"),
      exports: path.join(home, "exports"),
      models: path.join(home, "models"),
      ai: path.join(home, "ai"),
      tmp: path.join(home, "tmp"),
    },
  };
}

export function ensureDirs(config) {
  for (const dir of [config.home, ...Object.values(config.dirs)]) fs.mkdirSync(dir, { recursive: true });
}

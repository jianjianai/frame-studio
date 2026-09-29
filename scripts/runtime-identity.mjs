import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ENGINE_PROTOCOL_VERSION } from "../src/engine/protocol.mjs";

const rootDirectory = fileURLToPath(new URL("../", import.meta.url));
const pending = new Map();
const sourceNames = ["src", "public", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", ".npmrc", "vite.config.ts", "index.html", "server/executor.mjs", "server/agent-events.mjs", "server/preview-version.mjs"];
async function identity(root) {
  const files = [];
  const walk = async relative => {
    const file = path.join(root, relative);
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error("Runtime identity cannot follow links: " + relative);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort())
        if (![".cache", "exports", "node_modules", ".git"].includes(name)) await walk(relative + "/" + name);
    } else if (stat.isFile()) {
      const content = await fs.readFile(file);
      const bytes = /\.(?:[cm]?js|jsx|tsx?|json|css|html|ya?ml)$/.test(relative) ? content.toString("utf8").replaceAll("\r\n", "\n") : content;
      files.push([relative, createHash("sha256").update(bytes).digest("hex")]);
    }
  };
  for (const name of sourceNames) await walk(name);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const fingerprint = createHash("sha256").update(JSON.stringify(files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex");
  return Object.freeze({ schemaVersion: 1, engineProtocol: ENGINE_PROTOCOL_VERSION, fingerprint,
    platformVersion: pkg.version, platformRevision: process.env.FRAME_REVISION || null,
    dependencyLock: files.find(([file]) => file === "pnpm-lock.yaml")?.[1] || null,
    node: process.versions.node, platform: process.platform, arch: process.arch });
}
/** Runtime files are immutable for a server process; explicit refresh supports development tools. */
export function runtimeIdentity(root = rootDirectory, { refresh = false } = {}) {
  root = path.resolve(root);
  if (refresh) pending.delete(root);
  if (!pending.has(root)) pending.set(root, identity(root).catch(error => { pending.delete(root); throw error; }));
  return pending.get(root);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await runtimeIdentity(process.argv[2] || rootDirectory)));

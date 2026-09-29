import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Installed versions are immutable; publishing a new selection never rewrites a running CLI. */
export async function installToolVersion({ provider, version, run, root = "/tools" }) {
  if (!["codex", "claude"].includes(provider) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw Error("Choose a supported provider and explicit tool version");
  const pkg = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const parent = path.join(root, provider), target = path.join(parent, version);
  const exists = async file => { try { await fs.lstat(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
  const validate = async dir => {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Invalid tool installation directory");
    const metadata = JSON.parse(await fs.readFile(path.join(dir, "node_modules", pkg, "package.json"), "utf8"));
    if (metadata.version !== version) throw Error("Installed tool version does not match its immutable directory");
    return (await run(path.join(dir, "node_modules/.bin", provider), ["--version"])).trim();
  };
  await fs.mkdir(parent, { recursive: true });
  const stage = path.join(parent, ".install-" + randomUUID());
  try {
    if (!(await exists(target))) {
      await fs.mkdir(stage);
      await run("npm", ["install", "--prefix", stage, "--save-exact", pkg + "@" + version]);
      await validate(stage);
      try { await fs.rename(stage, target); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    }
    const actualVersion = await validate(target);
    const pointer = path.join(parent, "current.tmp-" + randomUUID());
    try { await fs.writeFile(pointer, version, { flag: "wx" }); await fs.rename(pointer, path.join(parent, "current")); }
    finally { await fs.rm(pointer, { force: true }); }
    return { status: "passed", provider, version, actualVersion };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

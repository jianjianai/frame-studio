import fs from "node:fs";
import path from "node:path";

/** Resolve PATH in its actual order, including the npm shims used on Windows. */
export function localToolBinary(tool, { env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") return tool;
  for (const directory of (env.PATH || env.Path || "").split(";")) {
    if (!directory) continue;
    const base = path.join(directory.replace(/^"|"$/g, ""), tool);
    for (const extension of [".exe", ".cmd"]) if (fs.existsSync(base + extension)) return base + extension;
  }
  return tool;
}

/** Execute known npm CLIs through Node, preserving arguments without a command shell. */
export function processLaunch(bin, args) {
  if (process.platform !== "win32") return { bin, args };
  if (["codex", "claude"].includes(bin)) bin = localToolBinary(bin);
  if (!/\.cmd$/i.test(bin)) return { bin, args };
  const tool = path.basename(bin, ".cmd").toLowerCase();
  const packageName = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" }[tool];
  if (!packageName) throw Error("Unsupported CLI launcher");
  const packageRoot = path.join(path.dirname(bin), "node_modules", packageName);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[tool];
  const file = path.resolve(packageRoot, entry || "");
  if (!entry || !file.startsWith(packageRoot + path.sep) || !fs.statSync(file).isFile()) throw Error("CLI installation is incomplete");
  return { bin: process.execPath, args: [file, ...args] };
}

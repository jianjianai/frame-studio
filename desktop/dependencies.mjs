import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const read = (file) => fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
const metadata = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"];
const canonical = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export function fingerprint(root) {
  const pkg = JSON.parse(read(path.join(root, "package.json")));
  const versions = JSON.parse(read(path.join(root, "desktop", "runtime-versions.json")));
  const configuration = {};
  for (const name of metadata.slice(1)) configuration[name] = read(path.join(root, name));
  const lifecycle = Object.fromEntries(["preinstall", "install", "postinstall", "prepare"].filter((key) => pkg.scripts?.[key]).map((key) => [key, pkg.scripts[key]]));
  const input = canonical({ node: versions.node, pnpm: versions.pnpm, platform: "win32-x64",
    dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, optionalDependencies: pkg.optionalDependencies,
    peerDependencies: pkg.peerDependencies, peerDependenciesMeta: pkg.peerDependenciesMeta, packageConfiguration: pkg.pnpm,
    lifecycle: Object.keys(lifecycle).length ? lifecycle : undefined,
    packageManager: pkg.packageManager, engines: pkg.engines, configuration });
  const sha256 = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return { manager: "pnpm", id: `pnpm-dependencies-win-x64-${sha256.slice(0, 20)}`, sha256, pnpm: versions.pnpm };
}

export async function installDependencies(app, cache, tools, { checkOnly = false } = {}) {
  const manifest = JSON.parse(read(path.join(app, "desktop", "runtime-manifest.json")));
  const entry = fingerprint(app);
  if (JSON.stringify(canonical(manifest.dependencies)) !== JSON.stringify(canonical(entry)))
    throw Error("程序依赖清单与锁文件不一致，请重新下载完整程序包");
  const destination = path.join(cache, entry.id);
  const marker = path.join(destination, "FRAME-RUNTIME.json");
  if (fs.existsSync(marker)) {
    const installed = JSON.parse(read(marker));
    if (installed.sha256 !== entry.sha256 || installed.manager !== "pnpm") throw Error("Dependency cache identity mismatch");
    if (fs.existsSync(path.join(destination, "node_modules", ".modules.yaml"))) {
      console.log("复用 pnpm 已安装依赖");
      return destination;
    }
  }
  if (checkOnly) throw Error("工作台依赖缺失，请修复安装后重试");
  fs.mkdirSync(destination, { recursive: true });
  for (const name of metadata) fs.copyFileSync(path.join(app, name), path.join(destination, name));
  const pnpm = path.join(tools, "tools", "pnpm", "pnpm.exe");
  const versions = JSON.parse(read(path.join(app, "desktop", "runtime-versions.json")));
  if (process.versions.node !== versions.node || execFileSync(pnpm, ["--version"], { encoding: "utf8", windowsHide: true }).trim() !== entry.pnpm)
    throw Error("Node/pnpm 版本与程序清单不一致，请重新安装匹配的工具组件");
  const data = path.dirname(cache);
  console.log("正在通过 pnpm 安装锁定依赖，复用本地包缓存");
  // Install at its permanent path: pnpm's generated metadata can contain absolute paths.
  // An interrupted install has no completion marker and is repaired by pnpm on retry.
  await new Promise((resolve, reject) => {
    const child = spawn(pnpm, ["--dir", destination, "install", "--frozen-lockfile", "--prefer-offline", "--prod=false",
      "--node-linker=hoisted", "--store-dir", path.join(data, "pnpm-store"), "--state-dir", path.join(data, "pnpm-state"),
      "--reporter", "append-only"], {
      windowsHide: true, stdio: "inherit",
      env: { ...process.env, CI: "true", NODE_ENV: "development", PATH: [tools, path.dirname(pnpm), process.env.PATH].join(path.delimiter) },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(Error(`pnpm 安装失败（${code}），重新启动可继续安装并复用已下载的包`)));
  });
  fs.writeFileSync(marker + ".tmp", JSON.stringify(entry));
  fs.renameSync(marker + ".tmp", marker);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "fingerprint") console.log(JSON.stringify(fingerprint(path.resolve(process.argv[3]))));
  else if (["install", "check"].includes(process.argv[2])) await installDependencies(...process.argv.slice(3, 6).map((p) => path.resolve(p)), { checkOnly: process.argv[2] === "check" });
  else throw Error("Expected fingerprint <app> or install <app> <cache> <tools>");
}

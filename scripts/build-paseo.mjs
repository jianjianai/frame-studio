import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { processLaunch, localToolBinary } from "../server/local-tools.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const integration = path.join(root, "integrations/paseo");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const present = file => fs.access(file).then(() => true, () => false);
function buildLaunch(bin, args) {
  if (process.platform === "win32" && bin === "npm") {
    const shim = localToolBinary(bin);
    const cli = path.join(path.dirname(shim), "node_modules/npm/bin/npm-cli.js");
    return { bin: process.execPath, args: [cli, ...args] };
  }
  return processLaunch(bin, args);
}
async function run(bin, args, cwd, env = {}) {
  const launch = buildLaunch(bin, args);
  await new Promise((resolve, reject) => {
    const child = spawn(launch.bin, launch.args, { cwd, windowsHide: true, stdio: "inherit",
      env: { ...process.env, ...env } });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(Error(bin + " exited " + code)));
  });
}
async function output(bin, args, cwd, env = {}) {
  const launch = buildLaunch(bin, args);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.bin, launch.args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
    child.stdout.setEncoding("utf8");
    let value = ""; child.stdout.on("data", bytes => { value += bytes; });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve(value.trim()) : reject(Error(bin + " exited " + code)));
  });
}
/** Exact file content is checked before installing a platform-independent prepared bundle. */
async function sourceFilesIdentity(directory) {
  const rows = [];
  const walk = async (relative = "") => {
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      const entry = relative ? relative + "/" + name : name;
      const stat = await fs.lstat(path.join(directory, entry));
      if (stat.isSymbolicLink()) throw Error("Paseo source cannot contain links");
      if (stat.isDirectory()) await walk(entry);
      else if (stat.isFile()) rows.push([entry, sha(await fs.readFile(path.join(directory, entry)))]);
    }
  };
  await walk();
  return sha(JSON.stringify(rows));
}
async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}
export async function paseoBundleIdentity(directory, {
  serverDirectory = path.join(directory, "server"), webDirectory = path.join(directory, "web"),
} = {}) {
  const rows = [];
  const walk = async (file, name) => {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw Error("Invalid Paseo bundle entry " + name);
    if (stat.isDirectory()) for (const entry of (await fs.readdir(file)).sort()) await walk(path.join(file, entry), name + "/" + entry);
    else rows.push([name, stat.size, await fileHash(file)]);
  };
  await walk(serverDirectory, "server"); await walk(webDirectory, "web");
  return { fingerprint: sha(JSON.stringify(rows)), files: rows.length,
    bytes: rows.reduce((sum, [, bytes]) => sum + bytes, 0) };
}
/** Compare the build tree to HEAD plus the declared patches without touching its Git index. */
export async function validatePatchedPaseoSource({ sourceDirectory, commit, patches,
  pluginDirectory = path.join(integration, "frame-plugin") }) {
  if (await output("git", ["rev-parse", "HEAD"], sourceDirectory) !== commit) throw Error("Paseo source commit differs");
  const checkRoot = path.join(root, ".cache/paseo-source-checks");
  await fs.mkdir(checkRoot, { recursive: true });
  const index = path.join(checkRoot, randomUUID() + ".index");
  const env = { GIT_INDEX_FILE: index };
  try {
    await run("git", ["read-tree", commit], sourceDirectory, env);
    for (const patch of patches) await run("git", ["apply", "--cached", patch], sourceDirectory, env);
    // A fresh index forces content comparisons, including new tracked files supplied by a patch.
    try { await run("git", ["diff", "--exit-code", "--no-ext-diff", "--quiet"], sourceDirectory, env); }
    catch { throw Error("Paseo build source differs from its pinned commit and declared patches"); }
    const extra = (await output("git", ["ls-files", "--others", "--exclude-standard", "-z"], sourceDirectory, env))
      .split("\u0000").filter(Boolean);
    for (const name of extra) {
      if (!name.startsWith("plugin-examples/frame/")) throw Error("Undeclared Paseo build source: " + name);
      const relative = name.slice("plugin-examples/frame/".length);
      const expected = path.join(pluginDirectory, relative);
      if (!await present(expected) || await fileHash(path.join(sourceDirectory, name)) !== await fileHash(expected))
        throw Error("Paseo Frame plugin copy differs: " + name);
    }
    if (await sourceFilesIdentity(path.join(sourceDirectory, "plugin-examples/frame")) !== await sourceFilesIdentity(pluginDirectory))
      throw Error("Paseo Frame plugin tree differs");
  } finally {
    await fs.rm(index, { force: true }); await fs.rm(index + ".lock", { force: true });
  }
}
export async function verifyPaseoBundle(bundle) {
  const proof = JSON.parse(await fs.readFile(path.join(bundle, "source-proof.json"), "utf8"));
  const source = JSON.parse(await fs.readFile(path.join(integration, "source.json"), "utf8"));
  if (proof.commit !== source.commit || proof.version !== source.version) throw Error("Prepared Paseo source identity differs");
  for (const name of source.patches)
    if (proof.patches[name] !== sha(await fs.readFile(path.join(integration, "patches", name)))) throw Error("Prepared Paseo patch differs: " + name);
  if (proof.bridge !== sha(await fs.readFile(path.join(integration, "frame-plugin/shared/bridge.ts"))))
    throw Error("Prepared Paseo bridge differs");
  if (proof.plugin !== await sourceFilesIdentity(path.join(integration, "frame-plugin")) ||
      proof.dependencies !== await sourceFilesIdentity(path.join(integration, "runtime")))
    throw Error("Prepared Paseo plugin or locked dependencies differ");
  const identity = await paseoBundleIdentity(bundle);
  if (identity.fingerprint !== proof.bundle.fingerprint) throw Error("Prepared Paseo bundle content differs");
  return { proof, source, identity, proofFingerprint: sha(JSON.stringify(proof)) };
}
export async function installPaseoBundle({ bundle, runtime, packageManager = "npm", pnpm = "pnpm", checkOnly = false }) {
  const { proof, source, identity, proofFingerprint } = await verifyPaseoBundle(bundle);
  const complete = path.join(runtime, "FRAME-PASEO.json");
  const old = await fs.readFile(complete, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error; return null;
  });
  if (old?.fingerprint === proofFingerprint) {
    const installed = await paseoBundleIdentity(runtime, {
      serverDirectory: path.join(runtime, "node_modules/@getpaseo/server/dist"), webDirectory: path.join(runtime, "web"),
    }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (installed?.fingerprint === proof.bundle.fingerprint) return { runtime, proof, reused: true };
  }
  if (checkOnly) throw Error("Paseo 环境缺失，请修复安装后重试");
  await fs.mkdir(runtime, { recursive: true });
  for (const name of ["package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"])
    if (await present(path.join(integration, "runtime", name))) await fs.copyFile(path.join(integration, "runtime", name), path.join(runtime, name));
  if (packageManager === "pnpm")
    await run(pnpm, ["--ignore-workspace", "install", "--frozen-lockfile", "--prefer-offline", "--node-linker=hoisted"], runtime);
  else if (packageManager === "npm") await run("npm", ["ci", "--no-audit", "--no-fund"], runtime);
  else throw Error("Unsupported Paseo dependency installer");
  const server = path.join(runtime, "node_modules/@getpaseo/server/dist");
  // Replace only this owned runtime's compiled package, never the upstream source or a work's native home.
  await fs.rm(server, { recursive: true, force: true });
  await fs.cp(path.join(bundle, "server"), server, { recursive: true });
  await fs.rm(path.join(runtime, "web"), { recursive: true, force: true });
  await fs.cp(path.join(bundle, "web"), path.join(runtime, "web"), { recursive: true });
  await fs.copyFile(path.join(bundle, "source-proof.json"), path.join(runtime, "source-proof.json"));
  await fs.copyFile(path.join(integration, "PASEO-LICENSE"), path.join(runtime, "PASEO-LICENSE"));
  const installed = await paseoBundleIdentity(runtime, {
    serverDirectory: server, webDirectory: path.join(runtime, "web"),
  });
  if (installed.fingerprint !== identity.fingerprint) throw Error("Installed Paseo bundle content differs");
  await fs.writeFile(complete + ".tmp", JSON.stringify({ fingerprint: proofFingerprint, commit: source.commit }));
  await fs.rename(complete + ".tmp", complete);
  return { runtime, proof, reused: false };
}
export async function buildPaseo({ sourceDirectory, outputDirectory = path.join(root, ".cache/paseo-generated") } = {}) {
  const source = JSON.parse(await fs.readFile(path.join(integration, "source.json"), "utf8"));
  const patches = Object.fromEntries(await Promise.all(source.patches.map(async name =>
    [name, sha(await fs.readFile(path.join(integration, "patches", name)))])));
  const owned = !sourceDirectory;
  sourceDirectory = path.resolve(sourceDirectory || path.join(root, ".cache/paseo-build", source.commit.slice(0, 12)));
  if (owned && !await present(path.join(sourceDirectory, ".git"))) {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await run("git", ["init"], sourceDirectory);
    await run("git", ["remote", "add", "origin", source.repository], sourceDirectory);
    await run("git", ["fetch", "--depth=1", "origin", source.commit], sourceDirectory);
    await run("git", ["checkout", "--detach", "FETCH_HEAD"], sourceDirectory);
  }
  if (await output("git", ["rev-parse", "HEAD"], sourceDirectory) !== source.commit) throw Error("Paseo source commit differs");
  if (owned) for (const name of source.patches) {
    const patch = path.join(integration, "patches", name);
    try { await run("git", ["apply", "--check", patch], sourceDirectory); await run("git", ["apply", patch], sourceDirectory); }
    catch { await run("git", ["apply", "--reverse", "--check", patch], sourceDirectory); }
  }
  // Upstream's own plugin loader and Metro receive the same public plugin source.
  const pluginTarget = path.join(sourceDirectory, "plugin-examples/frame");
  await fs.mkdir(pluginTarget, { recursive: true });
  await fs.cp(path.join(integration, "frame-plugin"), pluginTarget, { recursive: true });
  await validatePatchedPaseoSource({ sourceDirectory, commit: source.commit,
    patches: source.patches.map(name => path.join(integration, "patches", name)) });
  if (!await present(path.join(sourceDirectory, "node_modules/.package-lock.json")))
    await run("npm", ["ci", "--no-audit", "--no-fund"], sourceDirectory);
  await run("npm", ["run", "build:app-deps"], sourceDirectory);
  await run("npm", ["run", "build:server"], sourceDirectory);
  await run("npm", ["run", "build:daemon-web-ui"], sourceDirectory, { PASEO_FRAME_EMBED: "1", CI: "1" });
  await validatePatchedPaseoSource({ sourceDirectory, commit: source.commit,
    patches: source.patches.map(name => path.join(integration, "patches", name)) });
  const outputDirectoryAbsolute = path.resolve(outputDirectory);
  await fs.mkdir(outputDirectoryAbsolute, { recursive: true });
  for (const name of ["server", "web"]) await fs.rm(path.join(outputDirectoryAbsolute, name), { recursive: true, force: true });
  await fs.cp(path.join(sourceDirectory, "packages/server/dist"), path.join(outputDirectoryAbsolute, "server"), { recursive: true });
  await fs.cp(path.join(sourceDirectory, "packages/server/dist/server/web-ui"), path.join(outputDirectoryAbsolute, "web"), { recursive: true });
  await fs.copyFile(path.join(sourceDirectory, "LICENSE"), path.join(outputDirectoryAbsolute, "PASEO-LICENSE"));
  const proof = { schema: 1, repository: source.repository, version: source.version, commit: source.commit,
    patches, bridge: sha(await fs.readFile(path.join(integration, "frame-plugin/shared/bridge.ts"))),
    plugin: await sourceFilesIdentity(path.join(integration, "frame-plugin")),
    dependencies: await sourceFilesIdentity(path.join(integration, "runtime")),
    bundle: await paseoBundleIdentity(outputDirectoryAbsolute) };
  await fs.writeFile(path.join(outputDirectoryAbsolute, "source-proof.json"), JSON.stringify(proof, null, 2) + "\n");
  return { bundle: outputDirectoryAbsolute, proof };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const split = arg.indexOf("="); return split < 0 ? [arg, true] : [arg.slice(0, split), arg.slice(split + 1)];
  }));
  if (Object.keys(flags).some(flag => !["--source", "--output", "--runtime", "--prebuilt", "--package-manager", "--pnpm", "--check", "--bundle-only"].includes(flag)))
    throw Error("Unknown Paseo build option");
  const bundle = flags["--prebuilt"] ? path.resolve(flags["--prebuilt"]) :
    (await buildPaseo({ sourceDirectory: flags["--source"], outputDirectory: flags["--output"] })).bundle;
  if (flags["--prebuilt"] && flags["--bundle-only"]) await verifyPaseoBundle(bundle);
  if (!flags["--bundle-only"]) await installPaseoBundle({ bundle,
    runtime: path.resolve(flags["--runtime"] || path.join(root, ".cache/paseo-runtime")),
    packageManager: flags["--package-manager"] || "npm", pnpm: flags["--pnpm"] || "pnpm", checkOnly: !!flags["--check"] });
  console.log("Paseo pinned runtime ready");
}

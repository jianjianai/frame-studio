import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { processLaunch } from "../server/local-tools.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const integration = path.join(root, "integrations/t3-code");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const present = file => fs.access(file).then(() => true, () => false);
async function run(bin, args, cwd, env = {}, capture = false) {
  const launch = processLaunch(bin, args);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.bin, launch.args, { cwd, windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", env: { ...process.env, pnpm_config_verify_deps_before_run: "false", ...env } });
    let output = "";
    if (capture) { child.stdout.setEncoding("utf8"); child.stdout.on("data", bytes => { output += bytes; }); }
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output.trim()) : reject(Error(bin + " exited " + code)));
  });
}
async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}
async function filesIdentity(directory, { exclude = [] } = {}) {
  const rows = [];
  async function walk(relative = "") {
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      const entry = relative ? relative + "/" + name : name;
      if (exclude.includes(entry)) continue;
      const file = path.join(directory, entry); const stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(entry);
      else if (stat.isFile()) rows.push([entry, stat.size, await fileHash(file)]);
      else throw Error("Invalid T3 artifact entry " + entry);
    }
  }
  await walk();
  return { fingerprint: sha(JSON.stringify(rows)), files: rows.length, bytes: rows.reduce((sum, row) => sum + row[1], 0) };
}
const sourceConfig = async () => JSON.parse(await fs.readFile(path.join(integration, "source.json"), "utf8"));
const patchHashes = async source => Object.fromEntries(await Promise.all(source.patches.map(async name =>
  [name, await fileHash(path.join(integration, "patches", name))])));
const overlays = [{ from: "native/web", to: "apps/web/src/frame", exclude: ["shared"] }, { from: "native/server", to: "apps/server/src/frame" },
  { from: "shared", to: "apps/web/src/frame/shared" }];
export const t3BundleIdentity = directory => filesIdentity(path.join(directory, "dist"));

/** Compare the actual build files to the pinned commit, declared patch and copied adapter. */
export async function validatePatchedT3Source({ sourceDirectory, source = null }) {
  source ??= await sourceConfig();
  if (await run("git", ["rev-parse", "HEAD"], sourceDirectory, {}, true) !== source.commit) throw Error("T3 source commit differs");
  if (await fileHash(path.join(sourceDirectory, "pnpm-lock.yaml")) !== source.upstreamLockSha256) throw Error("T3 upstream lockfile differs");
  const index = path.join(root, ".cache", "t3-index-" + randomUUID());
  const env = { GIT_INDEX_FILE: index }; const allowed = new Set();
  try {
    await run("git", ["read-tree", source.commit], sourceDirectory, env);
    for (const name of source.patches) await run("git", ["apply", "--cached", path.join(integration, "patches", name)], sourceDirectory, env);
    try { await run("git", ["diff", "--exit-code", "--no-ext-diff", "--quiet"], sourceDirectory, env); }
    catch { throw Error("T3 source differs from its pinned commit and declared patch"); }
    for (const overlay of overlays) {
      const from = path.join(integration, overlay.from); const to = path.join(sourceDirectory, overlay.to);
      if ((await filesIdentity(from)).fingerprint !== (await filesIdentity(to, { exclude: overlay.exclude })).fingerprint) throw Error("T3 adapter copy differs: " + overlay.from);
      async function allow(relative = "") {
        for (const entry of await fs.readdir(path.join(from, relative), { withFileTypes: true })) {
          const name = relative ? relative + "/" + entry.name : entry.name;
          if (entry.isDirectory()) await allow(name); else allowed.add(overlay.to + "/" + name);
        }
      }
      await allow();
    }
    const extra = (await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], sourceDirectory, env, true)).split("\0").filter(Boolean);
    for (const name of extra) if (!allowed.has(name)) throw Error("Undeclared T3 source: " + name);
  } finally { await fs.rm(index, { force: true }); await fs.rm(index + ".lock", { force: true }); }
}
export async function verifyT3Bundle(bundle) {
  const source = await sourceConfig(); const proof = JSON.parse(await fs.readFile(path.join(bundle, "source-proof.json"), "utf8"));
  if (proof.schema !== 1 || proof.commit !== source.commit || proof.version !== source.version || proof.upstreamLockSha256 !== source.upstreamLockSha256) throw Error("Prepared T3 source identity differs");
  if (JSON.stringify(proof.patches) !== JSON.stringify(await patchHashes(source))) throw Error("Prepared T3 patches differ");
  for (const directory of ["shared", "native", "runtime"])
    if (proof[directory] !== (await filesIdentity(path.join(integration, directory))).fingerprint) throw Error("Prepared T3 " + directory + " differs");
  const identity = await t3BundleIdentity(bundle);
  if (identity.fingerprint !== proof.bundle.fingerprint) throw Error("Prepared T3 bundle content differs");
  return { proof, source, identity, proofFingerprint: sha(JSON.stringify(proof)) };
}
function assertNodeRuntime() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 13 || minor === 13 && patch < 1) throw Error("T3 needs Node.js 24.13.1 or newer within Node 24");
}
export async function installT3Bundle({ bundle, runtime, pnpm = "pnpm", packageManager = "pnpm", checkOnly = false }) {
  assertNodeRuntime();
  if (packageManager !== "pnpm") throw Error("T3's locked portable runtime requires pnpm 11 or newer");
  const { proof, identity, proofFingerprint } = await verifyT3Bundle(bundle);
  const marker = path.join(runtime, "FRAME-T3.json");
  const old = await fs.readFile(marker, "utf8").then(JSON.parse).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (old?.fingerprint === proofFingerprint && old.platform === process.platform && old.arch === process.arch && (await t3BundleIdentity(runtime).catch(error => { if (error.code !== "ENOENT") throw error; return null; }))?.fingerprint === identity.fingerprint && await present(path.join(runtime, "node_modules/node-pty/package.json"))) return { runtime, proof, reused: true };
  if (checkOnly) throw Error("T3 Code runtime is missing or differs; repair the installation");
  await fs.mkdir(runtime, { recursive: true });
  await fs.cp(path.join(integration, "runtime"), runtime, { recursive: true });
  await run(pnpm, ["install", "--prod", "--frozen-lockfile", "--prefer-offline"], runtime);
  await fs.rm(path.join(runtime, "dist"), { recursive: true, force: true });
  await fs.cp(path.join(bundle, "dist"), path.join(runtime, "dist"), { recursive: true });
  await fs.copyFile(path.join(bundle, "source-proof.json"), path.join(runtime, "source-proof.json"));
  await fs.copyFile(path.join(integration, "T3-LICENSE"), path.join(runtime, "T3-LICENSE"));
  if ((await t3BundleIdentity(runtime)).fingerprint !== identity.fingerprint) throw Error("Installed T3 content differs");
  const temporaryMarker = marker + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporaryMarker, JSON.stringify({ fingerprint: proofFingerprint, commit: proof.commit, version: proof.version, entry: "dist/bin.mjs", platform: process.platform, arch: process.arch }) + "\n", { flag: "wx" });
    await fs.rename(temporaryMarker, marker);
  } finally { await fs.rm(temporaryMarker, { force: true }); }
  return { runtime, proof, reused: false };
}
/** Publish an already compiled, source-verified upstream checkout without rebuilding it. */
export async function publishT3Bundle({ sourceDirectory, outputDirectory, source = null }) {
  source ??= await sourceConfig();
  await validatePatchedT3Source({ sourceDirectory, source });
  await fs.access(path.join(sourceDirectory, "apps/server/dist/bin.mjs"));
  outputDirectory = path.resolve(outputDirectory); await fs.mkdir(outputDirectory, { recursive: true });
  await fs.rm(path.join(outputDirectory, "dist"), { recursive: true, force: true });
  await fs.cp(path.join(sourceDirectory, "apps/server/dist"), path.join(outputDirectory, "dist"), { recursive: true });
  await fs.copyFile(path.join(integration, "T3-LICENSE"), path.join(outputDirectory, "T3-LICENSE"));
  const proof = { schema: 1, repository: source.repository, version: source.version, commit: source.commit,
    upstreamManifestVersion: source.upstreamManifestVersion, upstreamLockSha256: source.upstreamLockSha256,
    patches: await patchHashes(source), shared: (await filesIdentity(path.join(integration, "shared"))).fingerprint,
    native: (await filesIdentity(path.join(integration, "native"))).fingerprint,
    runtime: (await filesIdentity(path.join(integration, "runtime"))).fingerprint, bundle: await t3BundleIdentity(outputDirectory) };
  await fs.writeFile(path.join(outputDirectory, "source-proof.json"), JSON.stringify(proof, null, 2) + "\n");
  return { bundle: outputDirectory, proof };
}

export async function buildT3({ sourceDirectory, outputDirectory = path.join(root, ".cache/t3-generated"), pnpm = "pnpm" } = {}) {
  assertNodeRuntime();
  const source = await sourceConfig(); const owned = !sourceDirectory;
  sourceDirectory = path.resolve(sourceDirectory || path.join(root, ".cache", "t3-source-" + randomUUID()));
  try {
    if (owned) {
      await fs.mkdir(sourceDirectory, { recursive: true });
      await run("git", ["init"], sourceDirectory);
      await run("git", ["remote", "add", "origin", source.repository], sourceDirectory);
      await run("git", ["fetch", "--depth=1", "origin", source.commit], sourceDirectory);
      await run("git", ["checkout", "--detach", "FETCH_HEAD"], sourceDirectory);
      for (const name of source.patches) await run("git", ["apply", path.join(integration, "patches", name)], sourceDirectory);
    }
    for (const overlay of overlays) await fs.cp(path.join(integration, overlay.from), path.join(sourceDirectory, overlay.to), { recursive: true });
    await validatePatchedT3Source({ sourceDirectory, source });
    await run(pnpm, ["--filter", "t3...", "--filter", "@t3tools/web...", "install", "--frozen-lockfile"], sourceDirectory);
    await run(pnpm, ["exec", "vp", "run", "--filter", "t3", "build"], sourceDirectory, { FRAME_T3_BASE_PATH: "/ai/", T3CODE_WEB_SOURCEMAP: "0", CI: "1" });
    return await publishT3Bundle({ sourceDirectory, outputDirectory, source });
  } finally { if (owned) await fs.rm(sourceDirectory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => { const split = arg.indexOf("="); return split < 0 ? [arg, true] : [arg.slice(0, split), arg.slice(split + 1)]; }));
  if (Object.keys(flags).some(flag => !["--source", "--output", "--runtime", "--prebuilt", "--pnpm", "--package-manager", "--check", "--bundle-only"].includes(flag))) throw Error("Unknown T3 build option");
  const bundle = flags["--prebuilt"] ? path.resolve(flags["--prebuilt"]) : (await buildT3({ sourceDirectory: flags["--source"], outputDirectory: flags["--output"], pnpm: flags["--pnpm"] || "pnpm" })).bundle;
  if (flags["--bundle-only"]) await verifyT3Bundle(bundle);
  else await installT3Bundle({ bundle, runtime: path.resolve(flags["--runtime"] || path.join(root, ".cache/t3-runtime")), pnpm: flags["--pnpm"] || "pnpm", packageManager: flags["--package-manager"] || "pnpm", checkOnly: !!flags["--check"] });
  console.log("T3 Code pinned runtime ready");
}

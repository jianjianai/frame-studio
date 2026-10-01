import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { command } from "../../server/process.mjs";
import { validatePatchedPaseoSource, paseoBundleIdentity, installPaseoBundle } from "../../scripts/build-paseo.mjs";

const integration = fileURLToPath(new URL("../../integrations/paseo", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame paseo build 中文 "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function write(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
async function sourceIdentity(directory) {
  const rows = [];
  const walk = async (relative = "") => {
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      const entry = relative ? relative + "/" + name : name;
      const file = path.join(directory, entry), stat = await fs.lstat(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await walk(entry);
      else if (stat.isFile()) rows.push([entry, sha(await fs.readFile(file))]);
    }
  };
  await walk();
  return sha(JSON.stringify(rows));
}

test("Pinned Paseo build validation proves real Git patches and plugin bytes without changing the caller index", { timeout: 20000 }, async t => {
  const directory = await temporary(t), source = path.join(directory, "source"), plugin = path.join(directory, "plugin");
  const base = "export const state='base';\n", patched = "export const state='patched';\n";
  await write(path.join(source, "source.ts"), base);
  await write(path.join(source, ".gitignore"), "node_modules/\ndist/\n");
  await command("git", ["init", "-b", "main"], { cwd: source });
  await command("git", ["config", "user.name", "Owned test"], { cwd: source });
  await command("git", ["config", "user.email", "owned@invalid"], { cwd: source });
  await command("git", ["add", "--", ".gitignore", "source.ts"], { cwd: source });
  await command("git", ["commit", "-m", "Owned baseline"], { cwd: source });
  const commit = await command("git", ["rev-parse", "HEAD"], { cwd: source });
  await write(path.join(source, "source.ts"), patched);
  await write(path.join(source, "new-file.ts"), "export const added=true;\n");
  await command("git", ["add", "--intent-to-add", "--", "new-file.ts"], { cwd: source });
  const patch = path.join(directory, "owned.patch");
  await fs.writeFile(patch, (await command("git", ["diff", "--binary"], { cwd: source })) + "\n");
  await write(path.join(plugin, "index.ts"), "export const plugin=true;\n");
  await write(path.join(plugin, "嵌套/声音.ts"), "export const sound='音色🎹';\n");
  await fs.cp(plugin, path.join(source, "plugin-examples/frame"), { recursive: true });
  const index = await fs.readFile(path.join(source, ".git/index"));
  const options = { sourceDirectory: source, commit, patches: [patch], pluginDirectory: plugin };
  await validatePatchedPaseoSource(options);
  assert.deepEqual(await fs.readFile(path.join(source, ".git/index")), index);
  await write(path.join(source, "source.ts"), base);
  await assert.rejects(validatePatchedPaseoSource(options), /differs from its pinned commit and declared patches/);
  await write(path.join(source, "source.ts"), patched + "export const undeclared=true;\n");
  await assert.rejects(validatePatchedPaseoSource(options), /differs from its pinned commit and declared patches/);
  await write(path.join(source, "source.ts"), patched);
  await write(path.join(source, "unexpected.ts"), "extra build source");
  await assert.rejects(validatePatchedPaseoSource(options), /Undeclared Paseo build source/);
  await fs.rm(path.join(source, "unexpected.ts"));
  await write(path.join(source, "plugin-examples/frame/index.ts"), "export const plugin='changed';\n");
  await assert.rejects(validatePatchedPaseoSource(options), /plugin copy differs|plugin tree differs/);
  await fs.cp(plugin, path.join(source, "plugin-examples/frame"), { recursive: true });
  await validatePatchedPaseoSource(options);
  await assert.rejects(validatePatchedPaseoSource({ ...options, commit: "0".repeat(40) }), /source commit differs/);
  assert.deepEqual(await fs.readFile(path.join(source, ".git/index")), index);
});

test("Installed Paseo compiled bundle is checked by content even with a matching marker and never invokes npm in check mode", { timeout: 20000 }, async t => {
  const directory = await temporary(t), bundle = path.join(directory, "bundle"), runtime = path.join(directory, "runtime");
  await write(path.join(bundle, "server/scripts/supervisor-entrypoint.js"), "export const entry='owned';\n");
  await write(path.join(bundle, "server/providers/frame.js"), "export const state='good';\n");
  await write(path.join(bundle, "web/index.html"), "<main>Owned Paseo UI</main>\n");
  await write(path.join(bundle, "web/chunks/frame.js"), "export const title='音色🎹';\n");
  const source = JSON.parse(await fs.readFile(path.join(integration, "source.json"), "utf8"));
  const proof = { schema: 1, repository: source.repository, version: source.version, commit: source.commit,
    patches: Object.fromEntries(await Promise.all(source.patches.map(async name => [name, sha(await fs.readFile(path.join(integration, "patches", name)))]))),
    bridge: sha(await fs.readFile(path.join(integration, "frame-plugin/shared/bridge.ts"))),
    plugin: await sourceIdentity(path.join(integration, "frame-plugin")),
    dependencies: await sourceIdentity(path.join(integration, "runtime")), bundle: await paseoBundleIdentity(bundle) };
  await write(path.join(bundle, "source-proof.json"), JSON.stringify(proof));
  const installedServer = path.join(runtime, "node_modules/@getpaseo/server/dist");
  await fs.cp(path.join(bundle, "server"), installedServer, { recursive: true });
  await fs.cp(path.join(bundle, "web"), path.join(runtime, "web"), { recursive: true });
  const marker = JSON.stringify({ fingerprint: sha(JSON.stringify(proof)), commit: proof.commit });
  await write(path.join(runtime, "FRAME-PASEO.json"), marker);
  let installations = 0;
  const mock = t.mock.method(childProcess, "spawn", () => { installations++; throw Error("Check-only cannot install dependencies"); });
  syncBuiltinESMExports();
  try {
    assert.equal((await installPaseoBundle({ bundle, runtime, checkOnly: true })).reused, true);
    // Identical byte count proves that existence/size-only checks cannot catch this corruption.
    const compiled = path.join(installedServer, "providers/frame.js");
    const before = await fs.stat(compiled);
    await fs.writeFile(compiled, "export const state='evil';\n");
    assert.equal((await fs.stat(compiled)).size, before.size);
    await assert.rejects(installPaseoBundle({ bundle, runtime, checkOnly: true }), /环境缺失/);
    await fs.copyFile(path.join(bundle, "server/providers/frame.js"), compiled);
    await write(path.join(runtime, "web/undeclared.js"), "unexpected installed content");
    await assert.rejects(installPaseoBundle({ bundle, runtime, checkOnly: true }), /环境缺失/);
    await fs.rm(path.join(runtime, "web/undeclared.js"));
    await fs.rm(path.join(runtime, "web/index.html"));
    await assert.rejects(installPaseoBundle({ bundle, runtime, checkOnly: true }), /环境缺失/);
    await fs.copyFile(path.join(bundle, "web/index.html"), path.join(runtime, "web/index.html"));
    assert.equal((await installPaseoBundle({ bundle, runtime, checkOnly: true })).reused, true);
    await fs.writeFile(path.join(bundle, "server/providers/frame.js"), "export const state='evil';\n");
    await assert.rejects(installPaseoBundle({ bundle, runtime, checkOnly: true }), /Prepared Paseo bundle content differs/);
    assert.equal(await fs.readFile(path.join(runtime, "FRAME-PASEO.json"), "utf8"), marker);
    assert.equal(installations, 0);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

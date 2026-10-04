import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishRuntime } from "../../scripts/publish-runtime.mjs";

const names = ["src", "scripts", "node_modules", "package.json"];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-runtime-publication-"));
  const unseal = async directory => {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await unseal(path.join(directory, entry.name));
  };
  t.after(async () => { await unseal(root); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"), destination = path.join(root, "runtime");
  for (const name of ["src", "scripts", "node_modules/.store/example"])
    await fs.mkdir(path.join(source, name), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ version: "8.4.0" }));
  await fs.writeFile(path.join(source, "src", "engine.mjs"), "export const revision = 1;\n");
  await fs.writeFile(path.join(source, "scripts", "film.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await fs.writeFile(path.join(source, "node_modules/.store/example/index.js"), "module.exports = 1;\n");
  await fs.symlink(".store/example", path.join(source, "node_modules/example"));
  return { source, destination, names };
}

test("publishes immutable dependencies once and switches the shared core without changing old versions", async t => {
  const options = await fixture(t);
  const first = await publishRuntime(options);
  assert.equal(first.created, true);
  assert.equal(await fs.readlink(first.current), first.runtime.fingerprint);
  assert.equal((await fs.stat(path.join(first.root, "src/engine.mjs"))).mode & 0o222, 0);
  assert.equal((await fs.stat(path.join(first.root, "scripts/film.mjs"))).mode & 0o111, 0o111);
  assert.equal(await fs.readFile(path.join(first.root, "node_modules/example/index.js"), "utf8"), "module.exports = 1;\n");
  const reused = await publishRuntime(options);
  assert.equal(reused.created, false);
  assert.equal(reused.root, first.root);
  await fs.writeFile(path.join(options.source, "src/engine.mjs"), "export const revision = 2;\n");
  const second = await publishRuntime(options);
  assert.notEqual(second.root, first.root);
  assert.equal(await fs.readlink(first.current), second.runtime.fingerprint);
  assert.equal(await fs.readFile(path.join(first.root, "src/engine.mjs"), "utf8"), "export const revision = 1;\n");
});

test("failed publication retains the working pointer and removes its own staging files", async t => {
  const options = await fixture(t);
  const first = await publishRuntime(options);
  await fs.writeFile(path.join(options.source, "src/engine.mjs"), "export const revision = 2;\n");
  await assert.rejects(publishRuntime({ ...options, names: [...names, "missing"] }), { code: "ENOENT" });
  assert.equal(await fs.readlink(first.current), first.runtime.fingerprint);
  assert.deepEqual(await fs.readdir(options.destination), ["current", first.runtime.fingerprint].sort());
  await assert.rejects(publishRuntime({ ...options, destination: path.join(options.source, "runtime") }), /outside/);
  await assert.rejects(publishRuntime({ ...options, names: ["../source"] }), /Invalid public runtime entry/);
});

test("refuses modified published core and unmanaged current directories", async t => {
  const options = await fixture(t);
  const first = await publishRuntime(options);
  const file = path.join(first.root, "src/engine.mjs");
  await fs.chmod(file, 0o644);
  await fs.writeFile(file, "export const revision = 99;\n");
  await assert.rejects(publishRuntime(options), /source was changed/);
  await fs.unlink(first.current);
  await fs.mkdir(first.current);
  await fs.writeFile(path.join(options.source, "src/engine.mjs"), "export const revision = 2;\n");
  await assert.rejects(publishRuntime(options), /not a managed symlink/);
  assert.equal((await fs.lstat(first.current)).isDirectory(), true);
  assert.equal((await fs.readdir(options.destination)).some(name => name.startsWith(".")), false);
});

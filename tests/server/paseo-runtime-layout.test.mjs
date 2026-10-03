import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture } from "./paseo-test-fixture.mjs";
import { PaseoManager } from "../../server/paseo-manager.mjs";
import { command } from "../../server/process.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { validatePaseoWorkspace } from "../../server/paseo-validate.mjs";

const core = path.resolve(import.meta.dirname, "../..");

test("canonical runtime upgrades its own HTML link to a private entry and builds the actual player without a second checkout", { timeout: 90000 }, async t => {
  const f = await fixture(t), checkout = path.dirname(path.dirname(f.canonical));
  const manager = new PaseoManager({ ...f, localMode: true, tasks: {} });
  t.after(() => manager.close());
  // The fixture owns this complete project; scaffold a real composition for the public build pipeline.
  await fs.rm(f.canonical, { recursive: true, force: true });
  await command(process.execPath, [path.join(core, "scripts/new-animation.mjs"), "fixture", "Runtime build", "--renderer", "composition", "--duration", "1", "--fps", "12", "--audio", "silent"], { cwd: checkout });
  const source = await treeHash(f.canonical, { includeExecutableMode: true });
  const entry = path.join(checkout, "index.html"), original = await fs.readFile(path.join(core, "index.html"), "utf8");
  await fs.symlink(path.join(core, "index.html"), entry);
  const runtime = await runtimeIdentity();
  await manager.prepareRuntime(checkout, f.work, runtime);
  assert.equal((await fs.lstat(entry)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(entry, "utf8"), original);
  assert.equal(await treeHash(f.canonical, { includeExecutableMode: true }), source);
  for (const name of ["src", "scripts", "public", "node_modules"])
    assert.equal((await fs.lstat(path.join(checkout, name))).isSymbolicLink(), true);
  const previous = Object.fromEntries(["FRAME_SHARED_RUNTIME_ROOT", "FRAME_SHARED_RUNTIME_FINGERPRINT", "FRAME_WORK_PREVIEW", "FRAME_PREVIEW_AUDIO"].map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  Object.assign(process.env, { FRAME_SHARED_RUNTIME_ROOT: core, FRAME_SHARED_RUNTIME_FINGERPRINT: runtime.fingerprint, FRAME_WORK_PREVIEW: "1", FRAME_PREVIEW_AUDIO: "0" });
  const result = await executeProject(checkout, f.work.project, "build");
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal((await fs.stat(path.join(result.output, "index.html"))).isFile(), true);
  const validated = await validatePaseoWorkspace({ core, work: checkout, project: f.work.project,
    baselineCommit: await command("git", ["rev-parse", "HEAD"], { cwd: checkout }),
    modeFingerprint: source, runtimeFingerprint: runtime.fingerprint });
  assert.equal(validated.status, "passed", JSON.stringify(validated));
  assert.deepEqual(validated.validation.map(({ name, status }) => [name, status]),
    ["scope", "structure", "project-tests", "project-types", "runtime"].map(name => [name, "passed"]));
  assert.equal(validated.stale, false);
  assert.equal(await fs.readFile(path.join(core, "index.html"), "utf8"), original);
  assert.equal(await command("git", ["rev-parse", "--show-toplevel"], { cwd: checkout }), checkout);
  await fs.writeFile(entry, original.replace("FRAME · 动画工坊", "Private runtime entry"));
  await manager.prepareRuntime(checkout, f.work, runtime);
  assert.match(await fs.readFile(entry, "utf8"), /Private runtime entry/);
  const outside = path.join(f.directory, "foreign-entry.html");
  await fs.writeFile(outside, "Unrelated entry");
  await fs.unlink(entry); await fs.symlink(outside, entry);
  await assert.rejects(manager.prepareRuntime(checkout, f.work, runtime), /outside the pinned core/);
  assert.equal(await fs.readFile(outside, "utf8"), "Unrelated entry");
  t.diagnostic("canonical player build completed in " + result.buildMetrics.totalMs + " ms");
});

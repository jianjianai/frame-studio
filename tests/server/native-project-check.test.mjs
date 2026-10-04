import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../../server/process.mjs";
import { prepareAiRuntime } from "../../server/ai-work.mjs";
import { validateProject } from "../../server/project-validation.mjs";
import { fileSha256, treeHash } from "../../server/project-files.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";

test("Canonical project checks run real unit/type gates through shared dependencies and clean only their temporary configuration", { timeout: 120000 }, async t => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "frame-native-project-check-"));
  const core = fileURLToPath(new URL("../../", import.meta.url)), project = "test-film";
  const previous = [process.env.FRAME_SHARED_RUNTIME_ROOT, process.env.FRAME_SHARED_RUNTIME_FINGERPRINT];
  t.after(async () => {
    for (const [name, value] of [["FRAME_SHARED_RUNTIME_ROOT", previous[0]], ["FRAME_SHARED_RUNTIME_FINGERPRINT", previous[1]]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(work, { recursive: true, force: true });
  });
  await command(process.execPath, [path.join(core, "scripts/new-animation.mjs"), project, "Canonical checks", "--renderer", "canvas"], { cwd: work });
  const source = path.join(work, "projects", project), valueFile = path.join(source, "value.ts");
  await fs.mkdir(path.join(source, "tests/unit"), { recursive: true });
  await fs.writeFile(valueFile, "export const value = 41;\n");
  await fs.writeFile(path.join(source, "tests/unit/value.test.ts"),
    "import {expect,test} from 'vitest';import {value} from '../../value';test('canonical source unit gate',()=>expect(value).toBe(41));\n");
  const git = args => command("git", args, { cwd: work });
  await git(["init", "--initial-branch=main"]);
  await git(["add", "--", "projects/" + project]);
  await git(["-c", "user.name=FRAME test", "-c", "user.email=frame-test@localhost", "commit", "-m", "Canonical source baseline"]);
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const index = path.resolve(work, (await git(["rev-parse", "--git-path", "index"])).trim());
  const indexSha256 = await fileSha256(index), revision = await treeHash(source);
  await prepareAiRuntime({ db: { lock: (_key, callback) => callback() }, workspaceRoot: work, repo: "canonical-check-fixture", core });
  assert.equal(await fs.realpath(path.join(work, "node_modules")), await fs.realpath(path.join(core, "node_modules")));
  process.env.FRAME_SHARED_RUNTIME_ROOT = core;
  process.env.FRAME_SHARED_RUNTIME_FINGERPRINT = (await runtimeIdentity(core)).fingerprint;
  const checks = [], results = [];
  await validateProject({ core, work, project, baselineCommit: head,
    run: async (bin, args) => {
      const output = await command(bin, args, { cwd: work, timeout: 60000, max: 8 * 1024 * 1024 });
      if (args.includes("test")) results.push(JSON.parse(output));
      return output;
    },
    measured: async (name, callback) => { const value = await callback(); checks.push(name); return value; },
  });
  assert.deepEqual(checks, ["scope", "structure", "project-tests", "project-types"]);
  assert.equal(results[0].status, "passed");
  assert.match(results[0].output, /projects\/test-film\/tests\/unit\/value\.test\.ts/);
  assert.equal(await treeHash(source), revision);
  assert.deepEqual(await fs.readdir(path.join(source, ".cache/checks")), []);

  await fs.writeFile(valueFile, "export const value = 42;\n");
  const failed = await executeProject(work, project, "test");
  assert.equal(failed.status, "failed"); assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /expected 42 to be 41/);
  assert.doesNotMatch(failed.output, /EROFS|EACCES|vite-temp/);
  assert.deepEqual(await fs.readdir(path.join(source, ".cache/checks")), []);
  await fs.writeFile(valueFile, "export const value = 41;\n");
  assert.equal(await treeHash(source), revision);
  assert.equal((await git(["rev-parse", "HEAD"])).trim(), head);
  assert.equal(await fileSha256(index), indexSha256);
});

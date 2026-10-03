import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./paseo-test-fixture.mjs";
import { PaseoValidation } from "../../server/paseo-validation.mjs";

test("Docker checks execute in the existing work container and preserve revision/runtime identity", async t => {
  const f = await fixture(t), calls = [];
  await f.workService.prepare(f.work.id);
  const runtimeFingerprint = "a".repeat(64);
  await f.store.updateRuntime(f.work.id, { state: "ready", container: "owned-container", runtimeFingerprint });
  const binding = await f.store.getWork(f.work.id);
  const report = await f.store.createValidation({ workId: f.work.id, revision: binding.revision, generation: binding.generation, runtimeFingerprint });
  const validator = new PaseoValidation({ ...f, tasks: { assertLeadership: async () => {} }, manager: {}, localMode: false,
    runCommand: async (bin, args) => { calls.push({ bin, args });
      if (bin === "git") return "b".repeat(40);
      return JSON.stringify({ status: "passed", modeFingerprint: binding.revision }); },
  });
  assert.equal((await validator.validate(report)).status, "passed");
  const exec = calls.find(call => call.bin === "docker");
  assert.deepEqual(exec.args.slice(0, 4), ["exec", "--workdir", "/workspace", "owned-container"]);
  assert.equal(JSON.parse(exec.args.at(-1)).modeFingerprint, binding.revision);
  assert.equal(calls.some(call => call.args.includes("run") || call.args.includes("cp") || call.args.includes("init")), false);
  await f.store.updateRuntime(f.work.id, { runtimeFingerprint: "c".repeat(64) });
  await assert.rejects(validator.validate(report), /运行环境已更新/);
});

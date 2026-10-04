import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, until } from "./ai-test-fixture.mjs";
import { AiValidation } from "../../server/ai-validation.mjs";

test("Docker checks execute in the existing work container and preserve revision/runtime identity", async t => {
  const f = await fixture(t), calls = [];
  await f.workService.prepare(f.work.id);
  const runtimeFingerprint = "a".repeat(64);
  await f.store.updateRuntime(f.work.id, { state: "ready", runtimeFingerprint });
  const binding = await f.store.getWork(f.work.id);
  const report = await f.store.createValidation({ workId: f.work.id, revision: binding.revision, generation: binding.generation, runtimeFingerprint });
  const validator = new AiValidation({ ...f, tasks: { assertLeadership: async () => {} }, manager: { container: "frame-t3" }, localMode: false,
    runCommand: async (bin, args) => { calls.push({ bin, args });
      if (bin === "git") return "b".repeat(40);
      return JSON.stringify({ status: "passed", modeFingerprint: binding.revision }); },
  });
  assert.equal((await validator.validate(report)).status, "passed");
  const exec = calls.find(call => call.bin === "docker");
  assert.deepEqual(exec.args.slice(0, 4), ["exec", "--workdir", path.dirname(path.dirname(f.canonical)), "frame-t3"]);
  assert.equal(JSON.parse(exec.args.at(-1)).modeFingerprint, binding.revision);
  assert.equal(calls.some(call => call.args.includes("run") || call.args.includes("cp") || call.args.includes("init")), false);
  await f.store.updateRuntime(f.work.id, { runtimeFingerprint: "c".repeat(64) });
  await assert.rejects(validator.validate(report), /运行环境已更新/);
});

test("An aborted Docker validation awaits its single native cancellation before releasing report ownership", async t => {
  const f=await fixture(t); await f.workService.prepare(f.work.id);
  const runtimeFingerprint="a".repeat(64);
  await f.store.updateRuntime(f.work.id,{state:"ready",runtimeFingerprint});
  const binding=await f.store.getWork(f.work.id), report=await f.store.createValidation({workId:f.work.id,
    revision:binding.revision,generation:binding.generation,runtimeFingerprint});
  let started=false, cancellations=0, releaseCancellation, settled=false;
  const manager={container:"frame-t3",cancelValidation:async (workId,reportId) => {
    assert.equal(workId,report.workId); assert.equal(reportId,report.id); cancellations++;
    await new Promise(resolve => { releaseCancellation=resolve; });
  }};
  const validator=new AiValidation({...f,tasks:{assertLeadership:async()=>{}},manager,localMode:false,
    runCommand:async (bin,_args,{signal}={}) => {
      if (bin === "git") return "b".repeat(40);
      started=true;
      return new Promise((resolve,reject) => signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
    },
  });
  const controller=new AbortController(), operation=validator.validate(report,{signal:controller.signal});
  operation.then(()=>{settled=true;},()=>{settled=true;});
  const checked=assert.rejects(operation,/Abort native validation/);
  try {
    await until(()=>started); controller.abort(Error("Abort native validation")); await until(()=>cancellations === 1);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false); assert.equal(validator.workers.size,1);
    assert.equal(cancellations,1,"The abort listener and error cleanup share one native cancellation");
    releaseCancellation(); await checked;
    assert.equal(settled,true); assert.equal(validator.workers.size,0); assert.equal(cancellations,1);
  } finally { releaseCancellation?.(); await checked; }
});

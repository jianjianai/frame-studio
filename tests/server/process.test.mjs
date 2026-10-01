import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { command } from "../../server/process.mjs";

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame process 中文 "));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function until(callback, message, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await callback();
    if (value) return value;
    if (Date.now() > end) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
const running = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function jsonWhenReady(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}

const writer = `
const text = {out:'音色🎹𝄞 café', err:'变速🙂 écho'};
const writes = Object.entries(text).map(([key,value]) => ({stream:key==='out'?process.stdout:process.stderr,bytes:Buffer.from(value)}));
for (const {stream,bytes} of writes) stream.write(bytes.subarray(0,1));
setTimeout(() => {
  for (const {stream,bytes} of writes) stream.write(bytes.subarray(1,2));
  setTimeout(() => {
    for (const {stream,bytes} of writes) stream.write(bytes.subarray(2));
    process.exitCode=Number(process.argv[2]||0);
  },35);
},35);
`;

test("Real UTF-8 stdout/stderr split inside characters remains intact in normal, combined and error output", { timeout: 15000 }, async t => {
  const directory = await workspace(t);
  const file = path.join(directory, "writer.cjs");
  await fs.writeFile(file, writer);
  // Confirm that the real fixture crosses decoder boundaries instead of relying on one complete Buffer.
  const probe = childProcess.spawn(process.execPath, [file], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (probe.exitCode === null && probe.signalCode === null) probe.kill("SIGKILL"); });
  const chunks = [];
  probe.stdout.on("data", bytes => chunks.push(bytes));
  probe.stderr.resume();
  const code = await new Promise((resolve, reject) => { probe.once("close", resolve); probe.once("error", reject); });
  assert.equal(code, 0);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "音色🎹𝄞 café");
  assert.notEqual(chunks.map(bytes => bytes.toString("utf8")).join(""), "音色🎹𝄞 café", "Fixture did not split a multibyte character");
  assert.equal(await command(process.execPath, [file], { cwd: directory }), "音色🎹𝄞 café");
  const combined = await command(process.execPath, [file], { cwd: directory, combined: true });
  assert.ok(combined.includes("音色🎹𝄞 café"));
  assert.ok(combined.includes("变速🙂 écho"));
  assert.equal(combined.includes("\uFFFD"), false);
  await assert.rejects(command(process.execPath, [file, "7"], { cwd: directory }), error => error.message === "变速🙂 écho");
});

async function tree(t, { exitLeader = false } = {}) {
  const directory = await workspace(t);
  const controller = new AbortController();
  const file = path.join(directory, "tree.cjs");
  await fs.writeFile(file, `
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const directory=process.argv[2];
const code="const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.argv[1],'grandchild.json'),JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);";
const grandchild=spawn(process.execPath,['-e',code,directory],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true});
grandchild.once('spawn',()=>{fs.writeFileSync(path.join(directory,'leader.json'),JSON.stringify({pid:process.pid,grandchild:grandchild.pid}));${exitLeader ? "grandchild.unref();" : "setInterval(()=>{},1000);"}});
`);
  const reason = Error("Owned fixture cancelled");
  const result = command(process.execPath, [file, directory], { cwd: directory, signal: controller.signal, timeout: 15000 })
    .then(value => ({ value }), error => ({ error }));
  let leader;
  t.after(async () => {
    controller.abort(reason);
    if (leader && process.platform !== "win32") {
      try { process.kill(-leader.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (leader) {
      for (const pid of [leader.pid, leader.grandchild]) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    await result;
  });
  leader = await until(() => jsonWhenReady(path.join(directory, "leader.json")), "Owned leader never launched");
  const grandchild = await until(() => jsonWhenReady(path.join(directory, "grandchild.json")), "Owned grandchild never launched");
  assert.equal(grandchild.pid, leader.grandchild);
  assert.ok(running(leader.grandchild));
  return { controller, reason, result, leader };
}

test("AbortSignal stops its real child and grandchild without leaving either process", { timeout: 20000 }, async t => {
  const f = await tree(t);
  assert.ok(running(f.leader.pid));
  f.controller.abort(f.reason);
  const result = await f.result;
  assert.strictEqual(result.error, f.reason);
  await until(() => !running(f.leader.pid) && !running(f.leader.grandchild), "Cancelled owned process tree remains alive");
});

test("POSIX cancellation still kills descendants after their group leader already exited", { timeout: 20000, skip: process.platform === "win32" }, async t => {
  const f = await tree(t, { exitLeader: true });
  await until(() => !running(f.leader.pid), "Fixture group leader did not exit");
  assert.ok(running(f.leader.grandchild));
  f.controller.abort(f.reason);
  const result = await f.result;
  assert.strictEqual(result.error, f.reason);
  await until(() => !running(f.leader.grandchild), "Orphaned owned descendant remains alive after cancellation");
});

test("An already aborted signal rejects before spawning any process", async t => {
  const controller = new AbortController();
  const reason = Error("Already cancelled");
  controller.abort(reason);
  let attempted = 0;
  const mock = t.mock.method(childProcess, "spawn", () => { attempted++; throw Error("Unexpected spawn"); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(Promise.resolve().then(() => command(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal })), error => error === reason);
    assert.equal(attempted, 0);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

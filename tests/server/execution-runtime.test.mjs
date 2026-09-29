import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executionRuntime } from "../../server/execution-runtime.mjs";

test("execution pins an immutable image and selected tool before launch", async t => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-runtime-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  await fs.mkdir(path.join(data, "tools/codex"), { recursive: true });
  await fs.writeFile(path.join(data, "tools/codex/current"), "1.2.3");
  const runtime = await executionRuntime({ data, task: { kind: "agent", input: { provider: "codex" } },
    command: async () => JSON.stringify({ Id: "sha256:" + "a".repeat(64), Config: { Labels: {} } }) });
  await fs.writeFile(path.join(data, "tools/codex/current"), "1.2.4");
  assert.equal(runtime.image, "sha256:" + "a".repeat(64));
  assert.equal(runtime.tool.version, "1.2.3");
  assert.match(runtime.fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(executionRuntime({ data, task: { kind: "build" }, command: async () => '{"Id":"mutable-tag"}' }), /immutable/);
});

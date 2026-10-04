import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiControl } from "../../server/ai-control.mjs";
import { command } from "../../server/process.mjs";

test("Concurrent FRAME processes atomically share one private control secret and preserve it after restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame-ai-control-"));
  const module = fileURLToPath(new URL("../../server/ai-control.mjs", import.meta.url));
  const source = "const {aiControl}=await import(" + JSON.stringify(module) + ");process.stdout.write(JSON.stringify(await aiControl(process.argv[1])));";
  const env = { ...process.env }; delete env.FRAME_AI_CONTROL_FILE;
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => command(process.execPath, ["--input-type=module", "-e", source, directory], { env, timeout: 10000 })));
    const first = JSON.parse(results[0]);
    assert.deepEqual(Object.keys(first).sort(), ["secret", "version"]); assert.equal(first.version, 1);
    assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/); assert.ok(results.every(result => JSON.parse(result).secret === first.secret));
    const next = JSON.parse(await command(process.execPath, ["--input-type=module", "-e", source, directory], { env, timeout: 10000 }));
    assert.deepEqual(next, first);
    const control = path.join(directory, "ai/shared/control.json");
    assert.deepEqual(JSON.parse(await fs.readFile(control, "utf8")), first);
    if (process.platform !== "win32") assert.equal((await fs.stat(control)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(path.dirname(control)), ["control.json"], "Only the published private file remains after concurrent initialization");
    assert.deepEqual(await aiControl(directory), first);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { command } from "../../server/process.mjs";

const core = path.resolve(import.meta.dirname, "../.."), enabled = process.env.FRAME_TEST_EXECUTOR_RUNTIME === "1";

test("real executor new, frame, storyboard, build and MP4 reuse pinned public runtime with no public copy or Git index", {
  skip: !enabled, timeout: 240000,
}, async t => {
  const work = path.join(core, ".cache", "executor-shared-runtime-" + randomUUID());
  await fs.mkdir(work, { recursive: true });
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  for (const kind of ["new", "frame", "storyboard", "build", "render"]) {
    const task = { id: randomUUID(), project: "executor-film", kind,
      input: kind === "new" ? { title: "Shared runtime test", renderer: "composition", duration: 1 }
        : { width: 160, fps: 12, time: 0.1, start: 0, end: 0.25 } };
    await fs.writeFile(path.join(work, "task.json"), JSON.stringify(task));
    const output = await command(process.execPath, [path.join(core, "server", "executor.mjs")], {
      cwd: work, timeout: 120000, max: 12000,
      env: { FRAME_EXECUTOR_WORK: work, FRAME_EXECUTOR_CORE: core, FRAME_PREVIEW_AUDIO: "0" },
    });
    const result = JSON.parse(await fs.readFile(path.join(work, "result.json"), "utf8"));
    assert.equal(result.status, "passed", kind + ": " + output + "\n" + JSON.stringify(result));
    for (const name of ["src", "scripts", "public", "node_modules"])
      assert((await fs.lstat(path.join(work, name))).isSymbolicLink(), kind + " links " + name);
    await assert.rejects(fs.stat(path.join(work, ".git")), { code: "ENOENT" });
    if (kind === "new") assert((await fs.stat(path.join(work, "projects", task.project, "project.ts"))).isFile());
    if (kind === "build") {
      assert(result.output.includes("projects/executor-film/exports/build-"));
      assert((await fs.stat(path.join(result.output, "index.html"))).isFile());
      assert.equal(result.input.runtimeFingerprint, result.runtimeFingerprint);
    }
    if (kind === "render") {
      const files = await fs.readdir(path.join(work, "projects", task.project, "exports"));
      assert(files.some(name => name.endsWith(".mp4")));
      assert(!files.some(name => name.startsWith(".") && name.endsWith(".tmp.mp4")));
    }
    t.diagnostic(kind + " completed in " + result.executorMetrics.totalMs + " ms");
  }
});

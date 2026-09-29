#!/usr/bin/env node
/** Scripted agent fixture: exercises the real executor, not a live/paid model. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
if (process.argv.includes("--version")) {
  console.log("creator-executor-fixture 1.0.0");
} else {
  const prompt = fs.readFileSync(0, "utf8");
  assert(prompt.includes("work-tool.mjs context"));
  const project = process.env.FRAME_PROJECT;
  assert.match(project, /^[a-z][a-z0-9-]*$/);
  const records = path.join("projects", project, "records");
  fs.mkdirSync(records, { recursive: true });
  const results = [];
  const run = (script, args, env = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.notEqual(report.status, "failed");
    results.push({ script, args, status: report.status ?? "passed", report });
    return report;
  };
  console.log(
    JSON.stringify({
      type: "thread.started",
      thread_id: "scripted-creator-acceptance",
    }),
  );
  fs.appendFileSync(
    path.join("projects", project, "scene.ts"),
    "\n// Creator executor fixture completed a project-local edit.\n",
  );
  run("scripts/work-tool.mjs", ["context"]);
  // This used to leave a root progress.json which made the final scope gate fail.
  run("scripts/film.mjs", ["build", project, "--json"], {
    FRAME_WORK_PREVIEW: "1",
  });
  assert(fs.existsSync("progress.json"));
  const check = run("scripts/work-tool.mjs", [
    "check",
    '{"runtime":true,"start":3.5,"end":5.5}',
  ]);
  assert.equal(check.stages.scope, "passed");
  assert.equal(check.stages.playback, "passed");
  fs.writeFileSync(
    path.join(records, "executor-acceptance.json"),
    JSON.stringify({ fixture: "scripted, not a live model", results }, null, 2),
  );
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "done",
        type: "agent_message",
        text: "Scripted creator fixture completed context, project edit, real preview build and sampled preflight. Content listening not reviewed.",
      },
    }),
  );
}

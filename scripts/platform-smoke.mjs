// Explicitly targeted integration probe: creates an owned test repository.
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const base = process.env.FRAME_SMOKE_URL;
if (!base || !process.env.FRAME_SMOKE_PASSWORD)
  throw new Error("Explicit smoke URL and password required");
let cookie;
async function request(route, body) {
  const r = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await r.json();
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  assert.ok(r.ok, JSON.stringify(value));
  return value;
}
const action = (name, args = {}) => request("/api/action", { name, args });
await request("/api/login", { password: process.env.FRAME_SMOKE_PASSWORD });
const repo = await action("repositories_add", {
  name: "FRAME integration " + Date.now(),
});
const evidence = {
  repo: repo.id,
  tasks: {},
  started: new Date().toISOString(),
};
const project = "smoke-film";
async function task(kind, input = {}) {
  const t = await action("task_create", {
    repo: repo.id,
    project,
    kind,
    input,
  });
  console.log(JSON.stringify({ kind, id: t.id, state: t.state }));
  const deadline = Date.now() + 300000;
  for (;;) {
    const detail = await action("task_get", { id: t.id });
    if (!["queued", "running", "cancelling", "publishing"].includes(detail.task.state)) {
      assert.equal(detail.task.state, "succeeded", JSON.stringify(detail));
      evidence.tasks[kind] = detail.task;
      console.log(
        JSON.stringify({
          kind,
          state: detail.task.state,
          artifacts: detail.task.result.artifacts?.map((a) => a.name),
        }),
      );
      return detail.task;
    }
    assert.ok(Date.now() < deadline, "Task exceeded deadline");
    await sleep(1500);
  }
}
await task("new", { title: "服务器集成验证", renderer: "canvas", duration: 2 });
const read = await action("project_read", {
  repo: repo.id,
  project,
  path: "scene.ts",
});
await action("project_write", {
  repo: repo.id,
  project,
  path: "scene.ts",
  content: read.content + "\n// Platform integration probe\n",
  expectedSha256: read.sha256,
});
await task("validate");
const frame = await task("frame", { time: 0.5, width: 640 });
const png = frame.result.artifacts.find((a) => a.name.endsWith(".png"));
assert.ok(png);
const image = await action("artifact_read", { id: frame.id, path: png.path });
assert.equal(image.mimeType, "image/png");
await task("storyboard", { width: 640 });
const build = await task("build");
evidence.preview = await request("/api/tasks/" + build.id + "/preview", {});
await task("render", { start: 0, end: 1, width: 640 });
const engines = await action("engines_list");
evidence.speech = await action("speech_test", {
  engine: engines[0].id,
  text: "你好，欢迎使用动画工作台。",
  repo: repo.id,
  project,
});
assert.ok(Number(evidence.speech.asset.bytes) > 10000);
const unused = await action("assets_list", { unused: true });
assert.ok(!unused.some((a) => a.id === evidence.speech.asset.id));
await action("repositories_sync", {
  repo: repo.id,
  action: "commit",
  message: "Integration verification",
});
evidence.finished = new Date().toISOString();
fs.writeFileSync(
  process.env.FRAME_SMOKE_OUTPUT || "platform-smoke.json",
  JSON.stringify(evidence, null, 2),
);
console.log("Platform smoke passed");

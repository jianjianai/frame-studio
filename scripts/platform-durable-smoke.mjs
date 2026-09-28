import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
const base = process.env.FRAME_SMOKE_URL;
if (!base || !process.env.FRAME_SMOKE_PASSWORD)
  throw new Error("Explicit test URL and password required");
let cookie;
async function request(route, body) {
  const r = await fetch(base + route, {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const v = await r.json();
  assert.ok(r.ok, JSON.stringify(v));
  return v;
}
const call = (name, args = {}) => request("/api/action", { name, args });
await request("/api/login", { password: process.env.FRAME_SMOKE_PASSWORD });
const evidence = JSON.parse(
  fs.readFileSync(".cache/platform-smoke.json", "utf8"),
);
const token = await call("tokens_create", {
  name: "temporary integration probe",
});
const client = new Client({ name: "frame-integration", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: "Bearer " + token.token } },
  }),
);
const tools = await client.listTools();
assert.ok(tools.tools.some((t) => t.name === "frame_artifact_read"));
const png = evidence.tasks.frame.result.artifacts.find((a) =>
  a.name.endsWith(".png"),
);
const image = await client.callTool({
  name: "frame_artifact_read",
  arguments: { id: evidence.tasks.frame.id, path: png.path },
});
assert.equal(image.content[0].type, "image");
assert.equal(image.content[0].mimeType, "image/png");
await client.close();
await call("tokens_revoke", { id: token.id });
console.log("Authenticated MCP PNG image roundtrip passed");
async function wait(id) {
  const end = Date.now() + 300000;
  for (;;) {
    const { task, events } = await call("task_get", { id });
    if (!["running", "queued"].includes(task.state)) {
      assert.equal(task.state, "succeeded", JSON.stringify({ task, events }));
      return task;
    }
    assert.ok(Date.now() < end);
    await sleep(1000);
  }
}
if (process.env.FRAME_SMOKE_SSH) {
  assert.equal(
    process.env.FRAME_SMOKE_URL,
    "http://localhost:45840",
    "Restart probe is limited to staging",
  );
  const task = await call("task_create", {
    repo: evidence.repo,
    project: "smoke-film",
    kind: "render",
    input: { width: 1920, start: 0, end: 2 },
  });
  for (;;) {
    const d = await call("task_get", { id: task.id });
    if (d.task.state === "running") break;
    assert.equal(d.task.state, "queued");
    await sleep(200);
  }
  execFileSync(
    "ssh",
    [process.env.FRAME_SMOKE_SSH, "sudo -n docker restart frame-test-studio"],
    { stdio: "pipe" },
  );
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(base + "/healthz");
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }
  evidence.recoveredTask = await wait(task.id);
  console.log("Running render survived controller restart");
}
const update = await call("tools_update", {
  provider: "codex",
  version: "0.158.0",
});
evidence.toolUpdate = await wait(update.id);
console.log("Independent Codex installation and version check passed");
if (process.env.FRAME_SMOKE_GITHUB_TOKEN) {
  assert.equal(
    base,
    "http://localhost:45840",
    "Git credential probe is limited to staging",
  );
  await call("settings_save", {
    provider: "github",
    secret: process.env.FRAME_SMOKE_GITHUB_TOKEN,
  });
  const branch = "codex/frame-sync-smoke-" + Date.now();
  const repo = await call("repositories_add", {
    name: "Git sync fixture",
    branch,
  });
  await call("repositories_remote", {
    repo: repo.id,
    url: "https://github.com/jianjianai/frame-studio.git",
  });
  const t = await call("task_create", {
    repo: repo.id,
    project: "git-fixture",
    kind: "new",
    input: { renderer: "canvas", duration: 2, title: "Git sync fixture" },
  });
  await wait(t.id);
  await call("assets_attach", {
    id: evidence.speech.asset.id,
    repo: repo.id,
    project: "git-fixture",
  });
  await call("repositories_sync", {
    repo: repo.id,
    action: "commit",
    message: "Owned platform sync verification fixture",
  });
  await call("repositories_sync", { repo: repo.id, action: "push" });
  const second = await call("repositories_add", {
    name: "Git sync second clone",
    url: "https://github.com/jianjianai/frame-studio.git",
    branch,
  });
  const files = await call("project_files", {
    repo: second.id,
    project: "git-fixture",
  });
  assert.ok(
    files.some((f) => f.path.endsWith(".wav") && Number(f.bytes) > 10000),
  );
  await call("project_write", {
    repo: repo.id,
    project: "git-fixture",
    path: "sync.txt",
    expectedSha256: null,
    content: "pull verified",
  });
  await call("repositories_sync", {
    repo: repo.id,
    action: "commit",
    message: "Verify fast forward pull",
  });
  await call("repositories_sync", { repo: repo.id, action: "push" });
  await call("repositories_sync", { repo: second.id, action: "pull" });
  assert.equal(
    (
      await call("project_read", {
        repo: second.id,
        project: "git-fixture",
        path: "sync.txt",
      })
    ).content,
    "pull verified",
  );
  evidence.gitSync = { branch, repo: repo.id, clone: second.id };
  console.log(
    "Private GitHub push, second clone, associated WAV/LFS and pull passed",
  );
}
fs.writeFileSync(
  ".cache/platform-durable-smoke.json",
  JSON.stringify(evidence, null, 2),
);

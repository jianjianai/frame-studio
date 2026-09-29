import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createFrameServer } from "../../scripts/mcp/server.mjs";

export const repo = path.resolve(import.meta.dirname, "../..");
export function fixture({ browser = false, renderer = "canvas" } = {}) {
  const root = path.join(repo, ".cache", "mcp-tests", randomUUID());
  fs.mkdirSync(root, { recursive: true });
  if (browser) {
    for (const name of ["src", "public", "scripts", "templates", "docs"])
      fs.cpSync(path.join(repo, name), path.join(root, name), {
        recursive: true,
      });
    for (const name of [
      "vite.config.ts",
      "index.html",
      "package.json",
      "tsconfig.json",
      "AGENTS.md",
    ])
      fs.copyFileSync(path.join(repo, name), path.join(root, name));
    fs.symlinkSync(
      path.join(repo, "node_modules"),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } else {
    fs.mkdirSync(path.join(root, "src/engine"), { recursive: true });
    fs.copyFileSync(
      path.join(repo, "src/engine/types.ts"),
      path.join(root, "src/engine/types.ts"),
    );
  }
  for (const file of ["protocol.mjs", "dimensions.mjs"])
    fs.copyFileSync(path.join(repo, "src/engine", file), path.join(root, "src/engine", file));
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "scripts/new-animation.mjs"),
      "test-film",
      "MCP 测试",
      "--renderer",
      renderer,
      "--duration",
      "2",
      "--fps",
      "12",
      "--audio",
      "generated",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return {
    root,
    file: (relative) => path.join(root, "projects/test-film", relative),
    close() {
      // The UUID path belongs exclusively to this fixture. Never follow node_modules.
      if (browser) fs.unlinkSync(path.join(root, "node_modules"));
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    },
  };
}
export async function memoryClient(root, options = {}) {
  const app = createFrameServer({ root, ...options });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  const client = new Client({ name: "frame-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    app,
    client,
    async close() {
      await app.close();
      await client.close();
    },
  };
}
export async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}
export async function waitForJob(client, project, jobId, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const state = await call(client, "frame_job", { project, jobId });
    if (!["running", "cancelling"].includes(state.status)) return state;
    assert.ok(Date.now() < end, "Job exceeded test deadline");
    await sleep(200);
  }
}

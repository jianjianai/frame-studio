import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { repo, call } from "./helpers.mjs";

for (const entry of ["scripts/mcp.mjs", "scripts/film.mjs"]) {
  test(
    "real stdio SDK discovery and calls: " + entry,
    { timeout: 20000 },
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repo, entry),
          ...(entry.endsWith("film.mjs") ? ["mcp"] : []),
          "--read-only",
          "--project",
          "tiny-seed",
        ],
        cwd: path.dirname(repo),
        stderr: "pipe",
      });
      let diagnostics = "";
      transport.stderr.on("data", (chunk) => {
        diagnostics += chunk;
      });
      const client = new Client({
        name: "stdio-integration",
        version: "1.0.0",
      });
      try {
        await client.connect(transport);
        const result = await call(client, "frame_list_projects");
        assert.deepEqual(
          result.projects.map((item) => item.id),
          ["tiny-seed"],
        );
        const resources = await client.listResources();
        assert.ok(
          resources.resources.some(
            (item) => item.uri === "frame://reference/authoring",
          ),
        );
        assert.ok(
          (
            await client.readResource({ uri: "frame://reference/authoring" })
          ).contents[0].text.includes("createScene"),
        );
        assert.ok(
          (await client.listPrompts()).prompts.some(
            (item) => item.name === "frame_edit_animation",
          ),
        );
        const prompt = await client.getPrompt({
          name: "frame_edit_animation",
          arguments: { project: "tiny-seed", request: "调整镜头" },
        });
        assert.ok(prompt.messages[0].content.text.includes("调整镜头"));
        assert.ok(prompt.messages[0].content.text.includes("frame_edit_files"));
        assert.ok(
          (
            await call(client, "frame_read_reference", { name: "scene-types" })
          ).content.includes("Scene"),
        );
        const context = await call(client, "frame_project_context", {
          project: "tiny-seed",
        });
        assert.equal(context.metadata.renderer, "canvas");
        assert.equal(diagnostics, "");
      } finally {
        await client.close();
      }
    },
  );
}
test(
  "legacy initialize handshake and EOF exit keep stdout valid JSON-RPC",
  { timeout: 15000 },
  async () => {
    const child = spawn(
      process.execPath,
      [path.join(repo, "scripts/mcp.mjs"), "--read-only"],
      { cwd: repo, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const messages = [];
    let pending = "";
    const waiters = new Map();
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const at = pending.indexOf("\n");
        if (at < 0) break;
        const parsed = JSON.parse(pending.slice(0, at));
        pending = pending.slice(at + 1);
        messages.push(parsed);
        waiters.get(parsed.id)?.(parsed);
      }
    });
    const request = (id, method, params) =>
      new Promise((resolve) => {
        waiters.set(id, resolve);
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    try {
      const initialized = await request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1" },
      });
      assert.equal(initialized.result.protocolVersion, "2025-11-25");
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      const tools = await request(2, "tools/list", {});
      assert.ok(tools.result.tools.length >= 7);
      const exited = once(child, "exit");
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0);
      assert.equal(messages.length, 2);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { hash } from "../../server/security.mjs";
import { PlatformClient } from "../../scripts/platform/client.mjs";

const databaseUrl = process.env.FRAME_TEST_DATABASE_URL;
test(
  "real HTTP, MCP and CLI share discovery, safe authoring, uploads and durable task results",
  { skip: !databaseUrl },
  async (t) => {
    assert.match(new URL(databaseUrl).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-agentkit-api-"));
    const db = await database(databaseUrl, "toolkit-test-password-1234");
    await db.pool.query(
      "TRUNCATE events,tasks,asset_refs,assets,repos,tokens,sessions,engines RESTART IDENTITY CASCADE",
    );
    const { app, actions, tasks } = await createApp({
      db,
      data,
      masterKey: "34".repeat(32),
      origin: "http://frame.test",
      scheduler: false,
    });
    try {
      const repo = await actions.call("repositories_add", {
        name: "Agent toolkit fixture",
      });
      const work = await actions.call("works_create", {
        title: "工具闭环测试",
        renderer: "canvas",
        repo: repo.id,
        duration: 1.2,
      });
      const access = await actions.call("tokens_create", {
        name: "integration fixture only",
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const url = `http://127.0.0.1:${app.server.address().port}`,
        client = new PlatformClient({ url, token: access.token });
      const cli = async (args, input = "") => {
        const child = spawn(
          process.execPath,
          ["scripts/platform-cli.mjs", ...args],
          {
            env: { ...process.env, FRAME_URL: url, FRAME_TOKEN: access.token },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        child.stdin.end(input);
        const [code] = await once(child, "close");
        return { code, stdout, stderr };
      };
      const headers = {
        authorization: "Bearer " + access.token,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      let rpcId = 0;
      const rpc = async (method, params) => {
        const r = await app.inject({
          method: "POST",
          url: "/mcp",
          headers,
          payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
        });
        assert.equal(r.statusCode, 200, r.body);
        const value = r.headers["content-type"].includes("text/event-stream")
          ? r.body
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => JSON.parse(line.slice(5)))
              .find((v) => v.id === rpcId)
          : r.json();
        assert(!value.error, JSON.stringify(value));
        return value.result;
      };
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "agentkit-integration", version: "1" },
      });
      const mcp = (name, args = {}) =>
        rpc("tools/call", { name: "frame_" + name, arguments: args });
      await t.test(
        "discovery is usable without source knowledge and keeps private operations off MCP",
        async () => {
          const listed = await rpc("tools/list", {});
          assert(
            listed.tools.find(
              (tool) => tool.name === "frame_workspace_context",
            ),
          );
          assert(
            listed.tools.find((tool) => tool.name === "frame_works_patch")
              .annotations.destructiveHint,
          );
          assert(
            !listed.tools.some((tool) => tool.name === "frame_tokens_create"),
          );
          const overview = await mcp("workspace_context");
          assert(
            overview.structuredContent.capabilities.groups.visual.some(
              (item) => item.id === "remotion",
            ),
          );
          assert.equal(
            overview.structuredContent.schemaDiscovery.tool,
            "frame_tool_describe",
          );
          const capabilityTool = listed.tools.find(
            (tool) => tool.name === "frame_capabilities",
          );
          assert(capabilityTool?.annotations.readOnlyHint);
          const capabilityDescription = (
            await mcp("tool_describe", { name: "frame_capabilities" })
          ).structuredContent;
          assert.deepEqual(
            capabilityTool.inputSchema,
            capabilityDescription.inputSchema,
          );
          const audioCapabilities = (
            await mcp("capabilities", { category: "audio" })
          ).structuredContent;
          assert(audioCapabilities.items.some((item) => item.id === "tone"));
          const cliCapabilities = await cli(
            ["capabilities", "-"],
            JSON.stringify({ category: "audio" }),
          );
          assert.equal(cliCapabilities.code, 0, cliCapabilities.stderr);
          assert.deepEqual(
            JSON.parse(cliCapabilities.stdout),
            audioCapabilities,
          );
          const workContext = (
            await mcp("works_context", { id: work.id, taskLimit: 0 })
          ).structuredContent;
          assert.deepEqual(
            workContext.capabilities,
            overview.structuredContent.capabilities,
          );
          assert(
            workContext.nextActions.some(
              (action) => action.tool === "frame_capabilities",
            ),
          );
          assert(
            overview.structuredContent.works.some((w) => w.id === work.id),
          );
          const help = await cli(["describe", "works_patch"]);
          assert.equal(help.code, 0, help.stderr);
          const schema = JSON.parse(help.stdout).inputSchema;
          assert(schema.required.includes("expectedSha256"));
          assert(schema.properties.edits);
          const denied = await mcp("tool_describe", { name: "tokens_create" });
          assert.equal(denied.isError, true);
          assert.equal(denied.structuredContent.status, 404);
          assert.equal(
            (await app.inject({ url: "/api/actions/works_patch" })).statusCode,
            401,
          );
        },
      );
      await t.test(
        "MCP reads and patches the same source seen by CLI, with conflict and missing-file recovery",
        async () => {
          const read = (
            await mcp("works_read", { id: work.id, path: "scene.ts" })
          ).structuredContent;
          assert(read.complete);
          assert.equal(read.sha256, hash(read.content));
          const patch = {
            id: work.id,
            path: "scene.ts",
            expectedSha256: read.sha256,
            edits: [{ oldText: "height * .07", newText: "height * .09" }],
          };
          const dry = await mcp("works_patch", { ...patch, dryRun: true });
          assert(!dry.structuredContent.applied);
          const written = await cli(
            ["works_patch", "-"],
            JSON.stringify(patch),
          );
          assert.equal(written.code, 0, written.stderr);
          const after = await client.call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          assert.match(after.content, /height \* .09/);
          const conflict = await mcp("works_patch", patch);
          assert(conflict.isError);
          assert.equal(conflict.structuredContent.code, "FILE_CHANGED");
          const missing = await mcp("works_read", {
            id: work.id,
            path: "records/absent.md",
          });
          assert(missing.isError);
          assert.equal(missing.structuredContent.status, 404);
          assert(!JSON.stringify(missing).includes(data));
          const search = await client.call("works_search", {
            id: work.id,
            query: "height * .09",
          });
          assert.equal(search.matches[0].path, "scene.ts");
          const created = await client.call("works_write", {
            id: work.id,
            path: "records/disposable.md",
            expectedSha256: null,
            content: "fixture",
          });
          const deleted = await mcp("works_delete_file", {
            id: work.id,
            path: "records/disposable.md",
            expectedSha256: created.sha256,
          });
          assert(deleted.structuredContent.deleted);
        },
      );
      await t.test(
        "resumable uploads support idempotent begin, strict chunks, status and safe cleanup",
        async () => {
          const bytes = Buffer.from("original licensed fixture"),
            key = randomUUID();
          const args = {
            repo: repo.id,
            name: "fixture.txt",
            bytes: bytes.length,
            sha256: hash(bytes),
            license: "Original",
            requestKey: key,
          };
          const upload = await client.call("upload_begin", args);
          assert.equal(upload.id, key);
          assert.equal((await client.call("upload_begin", args)).id, key);
          await assert.rejects(
            client.call("upload_begin", { ...args, name: "different.txt" }),
            { status: 409 },
          );
          await assert.rejects(
            client.call("upload_chunk", { id: key, offset: 0, base64: "!!!!" }),
            { status: 400 },
          );
          await client.call("upload_chunk", {
            id: key,
            offset: 0,
            base64: bytes.subarray(0, 3).toString("base64"),
          });
          const overlap = Buffer.concat([
            bytes.subarray(2, 3),
            Buffer.from([0]),
          ]);
          await assert.rejects(
            client.call("upload_chunk", {
              id: key,
              offset: 2,
              base64: overlap.toString("base64"),
            }),
            { status: 409 },
          );
          assert.equal(
            (await client.call("upload_status", { id: key })).offset,
            3,
          );
          await client.call("upload_chunk", {
            id: key,
            offset: 3,
            base64: bytes.subarray(3).toString("base64"),
          });
          const asset = await client.call("upload_finish", { id: key });
          assert.equal(
            (await client.call("upload_status", { id: key })).result.id,
            asset.id,
          );
          assert.equal(
            (await client.call("upload_finish", { id: key })).id,
            asset.id,
          );
          await assert.rejects(client.call("upload_abort", { id: key }), {
            status: 409,
          });
          const attached = await client.call("works_use_asset", {
            id: work.id,
            asset: asset.id,
          });
          assert(attached.path);
          const pending = await client.call("upload_begin", {
            ...args,
            requestKey: randomUUID(),
          });
          assert(
            (await client.call("upload_abort", { id: pending.id })).aborted,
          );
          await assert.rejects(
            client.call("upload_status", { id: pending.id }),
            { code: "UPLOAD_NOT_FOUND" },
          );
          const file = path.join(data, "cli-asset.txt");
          fs.writeFileSync(file, "CLI original fixture");
          const uploaded = await cli([
            "upload",
            file,
            "--repo",
            repo.id,
            "--license",
            "Original",
          ]);
          assert.equal(uploaded.code, 0, uploaded.stderr);
          assert(JSON.parse(uploaded.stdout).id);
        },
      );
      await t.test(
        "queued tasks are idempotent, busy files remain protected, cancellation is observable",
        async () => {
          const requestKey = randomUUID(),
            args = { id: work.id, kind: "frame", requestKey };
          const task = await client.call("works_task", args);
          assert.equal((await client.call("works_task", args)).id, task.id);
          await assert.rejects(
            client.call("works_write", {
              id: work.id,
              path: "records/busy.md",
              expectedSha256: null,
              content: "must not write",
            }),
            { status: 409 },
          );
          const state = await mcp("task_status", { id: task.id });
          assert.equal(state.structuredContent.task.state, "queued");
          assert.equal(
            state.structuredContent.nextActions[0].arguments.after,
            state.structuredContent.nextAfter,
          );
          await client.call("task_cancel", { id: task.id });
          assert.equal((await client.wait(task.id)).task.state, "cancelled");
        },
      );
      await t.test(
        "compact context omits manifests; final events, PNG MCP output and CLI download stay usable",
        async () => {
          const task = await client.call("works_task", {
            id: work.id,
            kind: "frame",
          });
          const artifactPath = `projects/${work.project}/exports/fixture.png`;
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rL8AAAAASUVORK5CYII=",
            "base64",
          );
          const file = path.join(data, "runs", task.id, artifactPath);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, png);
          const result = {
            status: "passed",
            input: {
              files: Array.from({ length: 1500 }, (_, i) => ({
                path: `engine/${i}`,
                sha256: "a".repeat(64),
              })),
            },
            artifacts: [
              { name: "fixture.png", path: artifactPath, bytes: png.length },
            ],
          };
          // Controlled persisted result fixture; renderer execution is covered by executor tests and manual smoke.
          await db.pool.query(
            "UPDATE tasks SET state='succeeded',result=$2,finished=now() WHERE id=$1",
            [task.id, result],
          );
          for (let i = 0; i < 4; i++)
            await db.pool.query(
              "INSERT INTO events(task,kind,data) VALUES($1,'result',$2)",
              [task.id, result],
            );
          const context = (await mcp("works_context", { id: work.id }))
            .structuredContent;
          assert(!JSON.stringify(context).includes("engine/1499"));
          assert(JSON.stringify(context).length < 20000);
          assert(context.projectInstructions);
          assert(context.brief);
          assert.match(context.instructions, /frame_works_patch/);
          let after = "0",
            count = 0;
          do {
            const response = await client.call("task_status", {
              id: task.id,
              after,
              limit: 1,
            });
            count += response.events.length;
            after = response.nextAfter;
            assert(response.done);
            if (!response.hasMore) break;
          } while (count < 10);
          assert.equal(count, 4);
          const image = await mcp("artifact_read", {
            id: task.id,
            path: artifactPath,
          });
          assert.equal(image.content[0].type, "image");
          assert.equal(image.content[0].data, png.toString("base64"));
          assert.equal(image.structuredContent.path, artifactPath);
          assert(!image.structuredContent.dataBase64);
          const output = path.join(data, "downloaded.png"),
            downloaded = await cli([
              "download",
              task.id,
              "fixture.png",
              "--out",
              output,
            ]);
          assert.equal(downloaded.code, 0, downloaded.stderr);
          assert(fs.readFileSync(output).equals(png));
          const waited = await cli(["wait", task.id]);
          assert.equal(waited.code, 0, waited.stderr);
          assert.equal(JSON.parse(waited.stdout).task.state, "succeeded");
          const page = await client.call("works_tasks_page", {
            id: work.id,
            limit: 1,
          });
          assert.equal(page.tasks.length, 1);
          assert.equal(page.nextOffset, 1);
          await db.pool.query("UPDATE tasks SET cleaned=now() WHERE id=$1", [
            task.id,
          ]);
          const expired = await mcp("artifact_read", {
            id: task.id,
            path: artifactPath,
          });
          assert(expired.isError);
          assert.equal(expired.structuredContent.code, "ARTIFACT_EXPIRED");
        },
      );
      await t.test(
        "version checkpoint/restore and recoverable work trash close the authoring loop",
        async () => {
          const version = await client.call("works_checkpoint", {
            id: work.id,
            name: "CLI fixture baseline",
          });
          const source = await client.call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          await client.call("works_write", {
            id: work.id,
            path: "scene.ts",
            expectedSha256: source.sha256,
            content: source.content + "\n// temporary edit\n",
          });
          await client.call("works_restore", {
            id: work.id,
            version: version.id,
          });
          assert.equal(
            (await client.call("works_read", { id: work.id, path: "scene.ts" }))
              .sha256,
            source.sha256,
          );
          assert(
            (await client.call("works_versions", { id: work.id })).length > 0,
          );
          await client.call("works_trash", {
            id: work.id,
            deleted: true,
            confirm: work.title,
          });
          await assert.rejects(
            client.call("works_read", { id: work.id, path: "scene.ts" }),
            { status: 409 },
          );
          await client.call("works_trash", { id: work.id, deleted: false });
        },
      );
    } finally {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);

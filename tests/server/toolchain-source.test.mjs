import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { hash, treeHash } from "../../server/security.mjs";
import {
  operationDescription,
  toolAnnotations,
} from "../../server/tool-catalog.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";

const url = process.env.FRAME_TEST_DATABASE_URL;
const decodeRpc = (body) =>
  JSON.parse(
    body.startsWith("{")
      ? body
      : body
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6),
  );
test(
  "real platform MCP and CLI: discover, edit, rollback, conflicts, assets and task lifecycle",
  { skip: !url, timeout: 180000 },
  async (t) => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-toolchain-"));
    const db = await database(url, "toolchain-test-password-2026");
    await db.pool.query(
      "TRUNCATE repos,tokens,engines RESTART IDENTITY CASCADE",
    );
    const { app, actions, repos } = await createApp({
      db,
      data,
      masterKey: "57".repeat(32),
      scheduler: false,
    });
    const call = (name, args = {}) => actions.call(name, args);
    try {
      const repo = await call("repositories_add", {
        name: "Real toolchain fixture",
      });
      const work = await call("works_create", {
        repo: repo.id,
        title: "一束光的旅程 · 回归",
        duration: 24,
        fps: 24,
        audio: "generated",
      });
      const other = await call("works_create", {
        repo: repo.id,
        title: "Unrelated work",
      });
      const { dir } = await repos.project(repo.id, work.project);
      const { dir: otherDir } = await repos.project(repo.id, other.project);
      const otherHash = treeHash(otherDir);
      const tok = await call("tokens_create", { name: "toolchain-regression" });
      const headers = {
        authorization: "Bearer " + tok.token,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      let rpcId = 0;
      const rpc = async (method, params) => {
        const response = await app.inject({
          method: "POST",
          url: "/mcp",
          headers,
          payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
        });
        assert.equal(response.statusCode, 200, response.body);
        return decodeRpc(response.body).result;
      };
      await t.test(
        "MCP advertises help, exact schemas, structured results and conservative annotations",
        async () => {
          const list = await rpc("tools/list", {});
          for (const name of [
            "frame_help",
            "frame_works_files_page",
            "frame_works_read_lines",
            "frame_works_search",
            "frame_works_edit",
            "frame_works_patch_batch",
            "frame_upload_status",
            "frame_upload_abort",
          ])
            assert(
              list.tools.some((tool) => tool.name === name),
              name,
            );
          assert.equal(
            list.tools.find((tool) => tool.name === "frame_works_search")
              .annotations.readOnlyHint,
            true,
          );
          assert.equal(
            toolAnnotations("works_assets").readOnlyHint,
            false,
            "asset indexing is not a read-only operation",
          );
          assert.equal(
            toolAnnotations("works_patch_batch").destructiveHint,
            true,
          );
          const help = await rpc("tools/call", {
            name: "frame_help",
            arguments: { name: "frame_works_patch_batch" },
          });
          assert(!help.isError, JSON.stringify(help));
          assert.equal(
            help.structuredContent.tools[0].inputSchema.type,
            "object",
          );
          assert(
            help.structuredContent.tools[0].inputSchema.required.includes(
              "changes",
            ),
          );
          for (const [name, op] of Object.entries(actions.registry))
            assert(
              operationDescription(name, op, { schema: true }).inputSchema,
              name,
            );
          const missing = await call("help", { name: "nonexistent" });
          assert.equal(missing.total, 0);
          const page = await call("help", { limit: 2 });
          assert.equal(page.tools.length, 2);
          assert.equal(page.nextOffset, 2);
        },
      );
      await t.test(
        "creation options and compact context retain backwards compatibility",
        async () => {
          const full = await call("works_context", {
            id: work.id,
            detail: true,
          });
          const compact = await call("works_context", {
            id: work.id,
            taskLimit: 0,
          });
          assert.match(compact.metadata, /"fps": 24/);
          assert.match(compact.metadata, /audioTracks/);
          assert.match(compact.instructions, /frame_works_patch/);
          assert(full.authoring.length > 1000);
          assert(full.readme.length > 200);
          assert(compact.authoring.length < full.authoring.length);
          assert.deepEqual(compact.tasks, []);
          assert.equal(compact.project, work.project);
        },
      );
      await t.test(
        "bounded file pages, full-file hashes and literal searches",
        async () => {
          const first = await call("works_files_page", {
            id: work.id,
            limit: 3,
          });
          const second = await call("works_files_page", {
            id: work.id,
            limit: 3,
            offset: first.nextOffset,
          });
          assert.equal(first.files.length, 3);
          assert.notEqual(first.files[0].path, second.files[0].path);
          const original = await call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          const slice = await call("works_read_lines", {
            id: work.id,
            path: "scene.ts",
            lineCount: 1,
          });
          assert.equal(slice.sha256, original.sha256);
          assert(slice.nextLine > 1);
          const result = await call("works_search", {
            id: work.id,
            query: "createScene",
            limit: 1,
          });
          assert.equal(result.matches.length, 1);
          assert.equal(result.matches[0].path, "scene.ts");
          assert.equal(result.matches[0].sha256, original.sha256);
          await assert.rejects(
            call("works_read_lines", { id: work.id, path: "../scene.ts" }),
            { statusCode: 400 },
          );
          await assert.rejects(
            call("works_read_lines", { id: work.id, path: ".env" }),
            { statusCode: 400 },
          );
          await assert.rejects(
            call("works_read_lines", { id: work.id, path: "absent.ts" }),
            { statusCode: 404 },
          );
        },
      );
      await t.test(
        "dry-run writes no files or history, then multi-file edit succeeds in a sparse work branch",
        async () => {
          const original = await call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          const proposal = {
            id: work.id,
            changes: [
              {
                path: "scene.ts",
                expectedSha256: original.sha256,
                content: original.content + "\n// Atomic source edit\n",
              },
              {
                path: "production/note.md",
                expectedSha256: null,
                content: "Original test note\n",
              },
              {
                path: "public/captions.srt",
                expectedSha256: null,
                content: "1\n00:00:00,000 --> 00:00:01,000\n信号开始\n",
              },
            ],
          };
          const before = treeHash(dir);
          assert.equal(
            (await call("works_edit", { ...proposal, dryRun: true })).applied,
            false,
          );
          assert.equal(treeHash(dir), before);
          assert(!fs.existsSync(path.join(dir, ".history")));
          assert(!fs.existsSync(path.join(dir, ".cache")));
          const result = await call("works_edit", proposal);
          assert(result.applied, JSON.stringify(result));
          assert(result.validation.passed);
          assert.equal(result.changes.length, 3);
          assert(result.checkpoint);
          assert.equal(
            (
              await call("works_read_lines", {
                id: work.id,
                path: "public/captions.srt",
              })
            ).totalLines,
            4,
          );
          assert.equal(treeHash(otherDir), otherHash);
        },
      );
      await t.test(
        "patch requires exact matches and fresh hashes; failed cross-file checks roll back",
        async () => {
          const original = await call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          const patch = {
            id: work.id,
            changes: [
              {
                path: "scene.ts",
                expectedSha256: original.sha256,
                replacements: [
                  { find: "Atomic source edit", replace: "Exact source patch" },
                ],
              },
            ],
          };
          assert.equal((await call("works_patch_batch", patch)).applied, true);
          await assert.rejects(call("works_patch_batch", patch), {
            statusCode: 409,
            code: "VERSION_CONFLICT",
          });
          const current = await call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          await assert.rejects(
            call("works_patch_batch", {
              ...patch,
              changes: [
                {
                  ...patch.changes[0],
                  expectedSha256: current.sha256,
                  replacements: [{ find: "not-present", replace: "x" }],
                },
              ],
            }),
            { code: "PATCH_AMBIGUOUS" },
          );
          await assert.rejects(
            call("works_edit", {
              id: work.id,
              changes: [
                {
                  path: "scene.ts",
                  expectedSha256: current.sha256,
                  content: "export function createScene( { broken",
                },
                {
                  path: "production/rolled-back.md",
                  expectedSha256: null,
                  content: "Must disappear",
                },
              ],
            }),
            { code: "VALIDATION_FAILED" },
          );
          assert.equal(
            (await call("works_read", { id: work.id, path: "scene.ts" }))
              .sha256,
            current.sha256,
          );
          assert(!fs.existsSync(path.join(dir, "production/rolled-back.md")));
          await assert.rejects(
            call("works_edit", {
              id: work.id,
              changes: [
                {
                  path: "escape.ts",
                  expectedSha256: null,
                  content: "import '../../studio/main.jsx';",
                },
              ],
            }),
            { code: "VALIDATION_FAILED" },
          );
          assert(!fs.existsSync(path.join(dir, "escape.ts")));
          const note = await call("works_read", {
            id: work.id,
            path: "production/note.md",
          });
          assert.equal(
            (
              await call("works_edit", {
                id: work.id,
                changes: [
                  {
                    path: note.path,
                    expectedSha256: note.sha256,
                    content: null,
                  },
                ],
              })
            ).applied,
            true,
          );
          const failed = await rpc("tools/call", {
            name: "frame_works_patch_batch",
            arguments: patch,
          });
          assert.equal(failed.isError, true);
          assert.equal(failed.structuredContent.code, "VERSION_CONFLICT");
        },
      );
      await t.test(
        "UTF-8 byte limits, binary rejection and legacy writes remain safe",
        async () => {
          const read = (path) => call("works_read", { id: work.id, path });
          fs.writeFileSync(
            path.join(dir, "production/binary.txt"),
            Buffer.from([0xff, 0xfe, 0]),
          );
          await assert.rejects(read("production/binary.txt"), {
            statusCode: 400,
          });
          fs.unlinkSync(path.join(dir, "production/binary.txt"));
          await assert.rejects(
            call("works_write", {
              id: work.id,
              path: "production/large.md",
              expectedSha256: null,
              content: "汉".repeat(400000),
            }),
            { statusCode: 413 },
          );
          await assert.rejects(
            call("works_write", {
              id: work.id,
              path: "production/nul.txt",
              expectedSha256: null,
              content: "a\u0000b",
            }),
            { statusCode: 400 },
          );
          assert(!fs.existsSync(path.join(dir, "production/large.md")));
          assert(!fs.existsSync(path.join(dir, "production/nul.txt")));
        },
      );
      await t.test(
        "resumable uploads reject malformed/overlapping chunks and safely expose status/abort",
        async () => {
          const bytes = Buffer.from("original-toolchain-material");
          const input = {
            repo: repo.id,
            name: "marker.txt",
            bytes: bytes.length,
            sha256: hash(bytes),
            license: "Original test material",
          };
          const upload = await call("upload_begin", input);
          assert.equal(
            (await call("upload_status", { id: upload.id })).offset,
            0,
          );
          await assert.rejects(
            call("upload_chunk", { id: upload.id, offset: 0, base64: "%%%" }),
            { statusCode: 400 },
          );
          const chunk = {
            id: upload.id,
            offset: 0,
            base64: bytes.subarray(0, 4).toString("base64"),
          };
          assert.equal((await call("upload_chunk", chunk)).offset, 4);
          assert.equal((await call("upload_chunk", chunk)).offset, 4);
          await assert.rejects(
            call("upload_chunk", {
              id: upload.id,
              offset: 2,
              base64: bytes.subarray(2, 8).toString("base64"),
            }),
            { statusCode: 409 },
          );
          assert.equal(
            (await call("upload_status", { id: upload.id })).offset,
            4,
          );
          await call("upload_chunk", {
            id: upload.id,
            offset: 4,
            base64: bytes.subarray(4).toString("base64"),
          });
          const asset = await call("upload_finish", { id: upload.id });
          assert.equal(
            (await call("upload_status", { id: upload.id })).result.id,
            asset.id,
          );
          assert.equal(
            (await call("upload_finish", { id: upload.id })).id,
            asset.id,
          );
          await assert.rejects(call("upload_abort", { id: upload.id }), {
            statusCode: 409,
          });
          const unused = await call("upload_begin", input);
          assert.equal(
            (await call("upload_abort", { id: unused.id })).aborted,
            true,
          );
          assert.equal(
            (await call("upload_abort", { id: unused.id })).aborted,
            false,
          );
          await assert.rejects(call("upload_status", { id: unused.id }), {
            statusCode: 404,
          });
        },
      );
      await t.test(
        "HTTP CLI discovers exact schemas, allows edits during validation and obeys exclusive task locks",
        async () => {
          await app.listen({ host: "127.0.0.1", port: 0 });
          const env = {
            FRAME_URL: `http://127.0.0.1:${app.server.address().port}/`,
            FRAME_TOKEN: tok.token,
          };
          const cli = async (args) => {
            const child = spawn(
              process.execPath,
              ["scripts/platform-cli.mjs", ...args],
              {
                env: { ...process.env, ...env },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "",
              stderr = "";
            child.stdout.on("data", (chunk) => (stdout += chunk));
            child.stderr.on("data", (chunk) => (stderr += chunk));
            const [code] = await once(child, "close");
            return { code, stdout, stderr };
          };
          const described = await cli(["describe", "works_edit"]);
          assert.equal(described.code, 0, described.stderr);
          assert(JSON.parse(described.stdout).inputSchema.properties.changes);
          const line = await cli([
            "works_read_lines",
            JSON.stringify({ id: work.id, path: "scene.ts", lineCount: 1 }),
          ]);
          assert.equal(line.code, 0, line.stderr);
          assert(JSON.parse(line.stdout).nextLine > 1);
          assert.equal((await cli(["works_page", "[]"])).code, 1);
          assert.equal((await cli(["works_write", "{}"])).code, 1);
          const validation = await call("works_task", {
            id: work.id,
            kind: "validate",
          });
          let source = await call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          const edit = await call("works_edit", {
            id: work.id,
            changes: [{
              path: source.path,
              expectedSha256: source.sha256,
              content: source.content + "\n// editing while workspace validation is queued",
            }],
          });
          assert.equal(edit.applied, true);
          await call("task_cancel", { id: validation.id });
          const task = await call("works_task", {
            id: work.id,
            kind: "frame",
          });
          source = await call("works_read", { id: work.id, path: "scene.ts" });
          await assert.rejects(
            call("works_edit", {
              id: work.id,
              changes: [
                {
                  path: source.path,
                  expectedSha256: source.sha256,
                  content: source.content + "\n// busy",
                },
              ],
            }),
            { statusCode: 409 },
          );
          await call("task_cancel", { id: task.id });
          const cancelled = await cli([
            "wait",
            task.id,
            "--timeout-ms",
            "1000",
          ]);
          assert.equal(cancelled.code, 1);
          assert.equal(JSON.parse(cancelled.stdout).task.state, "cancelled");
          assert.equal(treeHash(otherDir), otherHash);
        },
      );
    } finally {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);

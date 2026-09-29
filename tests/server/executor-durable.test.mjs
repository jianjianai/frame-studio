import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { command } from "../../server/process.mjs";
const enabled = process.env.FRAME_TEST_EXECUTOR === "1",
  url = process.env.FRAME_TEST_DATABASE_URL;

for (const scenario of ["codex", "claude", "codex-invalid"])
  test(
    `real ${scenario} CLI: durable execution and validation before publishing`,
    { skip: !enabled, timeout: 180000 },
    async (t) => {
      const provider = scenario.split("-")[0],
        invalid = scenario.endsWith("-invalid");
      assert.match(new URL(url).pathname, /frame_test/);
      assert(process.env.FRAME_TEST_HOST_ROOT);
      const relative = ".cache/durable-" + randomUUID(),
        data = path.resolve(relative),
        modelPort = 55179,
        requests = [];
      fs.mkdirSync(data, { recursive: true });
      let platform, task, work;
      const api = http.createServer(async (req, res) => {
        if (
          req.method !== "POST" ||
          (!req.url.includes("/responses") && !req.url.includes("/messages"))
        ) {
          res.writeHead(404);
          res.end();
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        if (req.url.includes("/count_tokens")) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ input_tokens: 80 }));
          return;
        }
        requests.push(input);
        await delay(800);
        if (provider === "claude") {
          const call =
            requests.filter((r) => r.tools?.some((x) => x.name === "Bash"))
              .length === 1 && input.tools?.some((x) => x.name === "Bash");
          const message = {
            id: "msg_fixture_" + requests.length,
            type: "message",
            role: "assistant",
            model: input.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 80, output_tokens: 10 },
          };
          const block = call
            ? {
                type: "tool_use",
                id: "tool_fixture",
                name: "Bash",
                input: {
                  command: `printf '\\n// Durable fixture edit\\n' >> projects/${work.project}/scene.ts`,
                  description: "Update fixture scene",
                },
              }
            : { type: "text", text: "作品修改完成，已准备验证。" };
          if (!input.stream) {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ...message,
                content: [block],
                stop_reason: call ? "tool_use" : "end_turn",
              }),
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const send = (type, data) =>
            res.write(
              "event: " +
                type +
                "\ndata: " +
                JSON.stringify({ type, ...data }) +
                "\n\n",
            );
          send("message_start", { message });
          send("content_block_start", {
            index: 0,
            content_block: call
              ? { ...block, input: {} }
              : { type: "text", text: "" },
          });
          send("content_block_delta", {
            index: 0,
            delta: call
              ? {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input),
                }
              : { type: "text_delta", text: block.text },
          });
          send("content_block_stop", { index: 0 });
          send("message_delta", {
            delta: {
              stop_reason: call ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 10 },
          });
          send("message_stop", {});
          res.end();
          return;
        }
        const id = "resp_" + requests.length,
          message = {
            type: "message",
            id: "msg_" + requests.length,
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "作品修改完成，已准备验证。",
                annotations: [],
              },
            ],
          };
        let item = message;
        if (requests.length === 1) {
          const tools = input.tools.flatMap((x) => x.tools || [x]);
          const shell = tools.find((x) =>
            ["exec_command", "shell_command", "shell"].includes(x.name),
          );
          if (!shell) {
            res.writeHead(500);
            res.end("No shell tool: " + tools.map((x) => x.name).join(","));
            return;
          }
          const cmd = invalid
            ? "printf invalid > outside-work.txt"
            : `printf '\\n// Durable fixture edit\\n' >> projects/${work.project}/scene.ts`;
          const args =
            shell.name === "exec_command"
              ? { cmd }
              : shell.name === "shell_command"
                ? { command: cmd }
                : { command: ["bash", "-lc", cmd] };
          item = {
            type: "function_call",
            id: "fc_fixture",
            call_id: "call_fixture",
            name: shell.name,
            arguments: JSON.stringify(args),
            status: "completed",
          };
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        const send = (type, extra) =>
          res.write(
            "event: " +
              type +
              "\ndata: " +
              JSON.stringify({ type, ...extra }) +
              "\n\n",
          );
        send("response.created", {
          response: {
            id,
            status: "in_progress",
            model: input.model,
            output: [],
          },
        });
        send("response.output_item.added", { output_index: 0, item });
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", {
          response: {
            id,
            status: "completed",
            model: input.model,
            output: [item],
            usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
          },
        });
        res.end();
      });
      await new Promise((resolve) => api.listen(modelPort, "0.0.0.0", resolve));
      const oldHost = process.env.FRAME_HOST_DATA,
        oldAgent = process.env.FRAME_AGENT_URL;
      process.env.FRAME_HOST_DATA = path.posix.join(
        process.env.FRAME_TEST_HOST_ROOT,
        relative,
      );
      process.env.FRAME_AGENT_URL = "http://172.17.0.1:55178";
      try {
        let db = await database(url, "test-password-at-least-14");
        await db.pool.query(
          "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
        );
        platform = await createApp({
          db,
          data,
          masterKey: "44".repeat(32),
          scheduler: false,
        });
        const repo = await platform.actions.call("repositories_add", {
          name: "Durable test",
        });
        work = await platform.actions.call("works_create", {
          repo: repo.id,
          title: "Durable creation",
        });
        const connection = await platform.actions.call("connections_save", {
          name: "Model fixture",
          tool: provider,
          mode: "api",
          baseUrl: `http://172.17.0.1:${modelPort}${provider === "codex" ? "/v1" : ""}`,
          apiKey: "fixture-provider-key",
          model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
        });
        const chat = await platform.actions.call("works_chat_create", {
          id: work.id,
          connection: connection.id,
          title: "Durable turn",
        });
        const beforeRevision = await platform.repos.git((await platform.repos.project(work.repo, work.project)).repo.root, ["rev-parse", "HEAD"]);
        task = await platform.actions.call("works_chat_send", {
          id: work.id,
          chat: chat.id,
          prompt: "Append the fixture comment to the scene, then finish.",
          requestKey: randomUUID(),
          context: { sourceCommit: beforeRevision, time: 0.5 },
        });
        assert.equal(task.execution.model, provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6");
        assert.equal(task.review_reference.sourceCommit, beforeRevision);
        await platform.tasks.start(task);
        await platform.app.close();
        platform = null;
        db = await database(url, "test-password-at-least-14");
        platform = await createApp({
          db,
          data,
          masterKey: "44".repeat(32),
          scheduler: false,
        });
        const deadline = Date.now() + 150000;
        while (Date.now() < deadline) {
          await platform.tasks.tick();
          task = await platform.tasks.get(task.id);
          if (!["queued", "running", "cancelling", "publishing"].includes(task.state)) break;
          await delay(500);
        }
        if (invalid) {
          assert.equal(task.state, "failed");
          const scene = await platform.actions.call("works_read", {
            id: work.id,
            path: "scene.ts",
          });
          assert(!scene.content.includes("// Durable fixture edit"));
          assert(
            !(await db.one(
              "SELECT id FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND state='succeeded'",
              [work.repo, work.project],
            )),
          );
          assert(
            fs.existsSync(path.join(data, "runs", task.id, "outside-work.txt")),
            "failed isolated output retained",
          );
          t.diagnostic(
            "Out-of-scope edit rejected before applying or publishing",
          );
          return;
        }
        assert.equal(
          task.state,
          "succeeded",
          task.error || JSON.stringify(task),
        );
        const scene = await platform.actions.call("works_read", {
          id: work.id,
          path: "scene.ts",
        });
        assert(scene.content.includes("// Durable fixture edit"));
        assert.equal(task.base_commit, beforeRevision);
        assert.deepEqual(task.result.validation.map(check => [check.check, check.status]), [
          ["scope", "passed"], ["structure", "passed"], ["project-tests", "passed"], ["preview-build", "passed"],
        ]);
        assert(task.result.executorMetrics.agentMs >= 0);
        assert(task.result.buildMetrics.compileMs >= 0);
        const events = await db.all(
          "SELECT * FROM events WHERE task=$1 ORDER BY id",
          [task.id],
        );
        assert(events.some((e) => e.kind === "message"));
        assert(events.some((e) => e.kind === "activity"));
        assert(!JSON.stringify(events).includes("fixture-provider-key"));
        assert(
          await db.one(
            "SELECT id FROM tasks WHERE repo=$1 AND project=$2 AND kind='build' AND state='succeeded'",
            [work.repo, work.project],
          ),
        );
        t.diagnostic(
          JSON.stringify({
            providerRequests: requests.length,
            events: events.length,
            tool: `real ${provider} CLI, deterministic fixture provider`,
            previewPublished: true,
            recoveredAfterRestart: true,
          }),
        );
      } finally {
        if (task)
          await command("docker", ["rm", "-f", "frame-task-" + task.id]).catch(
            () => {},
          );
        await platform?.app.close();
        api.closeAllConnections();
        await new Promise((resolve) => api.close(resolve));
        if (oldHost === undefined) delete process.env.FRAME_HOST_DATA;
        else process.env.FRAME_HOST_DATA = oldHost;
        if (oldAgent === undefined) delete process.env.FRAME_AGENT_URL;
        else process.env.FRAME_AGENT_URL = oldAgent;
        fs.rmSync(data, { recursive: true, force: true });
      }
    },
  );

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runAgentTurn } from "../../server/agent-runtime.mjs";
import { agentModelServer } from "./fixtures/agent-model-server.mjs";

for (const provider of ["codex", "claude"])
  test(
    `native ${provider}: bidirectional questions pause, accept human answers, then execute a command in the SAME turn`,
    { timeout: 120000 },
    async (t) => {
      const version = spawnSync(provider, ["--version"], { encoding: "utf8" });
      if (version.status !== 0) {
        t.skip("Installed " + provider + " CLI is required");
        return;
      }
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "frame-native-agent-"),
      );
      const home = path.join(root, "home"),
        cwd = path.join(root, "work");
      fs.mkdirSync(home);
      fs.mkdirSync(cwd);
      fs.mkdirSync(path.join(home, "codex"));
      fs.mkdirSync(path.join(home, "claude"));
      fs.writeFileSync(
        path.join(cwd, "AGENTS.md"),
        "This is an isolated protocol test work directory.\n",
      );
      const identity = process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : {};
      if (identity.uid) {
        fs.chmodSync(root, 0o755);
        for (const file of [
          home,
          cwd,
          path.join(home, "codex"),
          path.join(home, "claude"),
          path.join(cwd, "AGENTS.md"),
        ])
          fs.chownSync(file, identity.uid, identity.gid);
      }
      const upstream = await agentModelServer({
        provider,
        command:
          "printf 'native completed\\n' > proof.txt; printf 'verified command output\\n'",
      });
      const events = [],
        stderr = [],
        questions = [];
      const controller = new AbortController();
      let answer, notifyQuestion;
      const asked = new Promise((resolve) => {
        notifyQuestion = resolve;
      });
      const waiting = new Promise((resolve) => {
        answer = resolve;
      });
      let run;
      try {
        const env = {
          ...process.env,
          HOME: home,
          CODEX_HOME: path.join(home, "codex"),
          CLAUDE_CONFIG_DIR: path.join(home, "claude"),
          CODEX_API_KEY: "fixture-native-model-api-key",
          OPENAI_API_KEY: "fixture-native-model-api-key",
          ANTHROPIC_API_KEY: "fixture-native-model-api-key",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_BASE_URL: upstream.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        };
        for (const name of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
        ])
          delete env[name];
        run = runAgentTurn({
          provider,
          bin: provider,
          task: {
            model: provider === "codex" ? "gpt-5.1-codex" : "claude-sonnet-4-6",
            authMode: "api",
            baseUrl: upstream.url + "/v1",
          },
          prompt:
            "Use the question tool to ask for creative direction, wait for a human, then run the returned command and report the result.",
          cwd,
          env,
          processIdentity: identity,
          signal: controller.signal,
          emit: (event) => events.push(event),
          onStderr: (value) => stderr.push(value),
          ask: async (request) => {
            questions.push(request);
            notifyQuestion();
            await waiting;
            return {
              state: "answered",
              payload: request,
              answers: Object.fromEntries(
                request.questions.map((q) => [
                  q.id,
                  {
                    selected: (q.multiSelect
                      ? q.options
                      : q.options.slice(0, 1)
                    ).map((o) => o.id),
                    text: "",
                  },
                ]),
              ),
            };
          },
        });
        run.catch(() => {});
        await Promise.race([
          asked,
          run.then(() => {
            throw Error("Agent completed without awaiting human input");
          }),
          delay(60000, undefined, { ref: false }).then(() => {
            throw Error(
              "Question not received: " + stderr.join("").slice(-3000),
            );
          }),
        ]);
        assert.equal(questions.length, 1);
        await delay(180);
        assert.equal(
          fs.existsSync(path.join(cwd, "proof.txt")),
          false,
          "Must not execute before the human answers",
        );
        assert.equal(
          upstream.calls.length,
          1,
          "Model must pause instead of guessing the answer",
        );
        answer();
        const result = await run;
        assert(result.upstream, "Real native session id is retained");
        assert.equal(
          fs.readFileSync(path.join(cwd, "proof.txt"), "utf8"),
          "native completed\n",
        );
        assert(
          upstream.calls
            .slice(1)
            .some((input) => JSON.stringify(input).includes("紧凑")),
          "The human answer must reach the upstream model",
        );
        assert(
          events.some(
            (event) =>
              event.kind === "command" &&
              event.phase === "completed" &&
              event.output?.includes("verified command output"),
          ),
          JSON.stringify(events),
        );
        assert(
          events.some(
            (event) =>
              event.kind === "message" && event.text?.includes("完成修改"),
          ),
        );
        assert(
          !JSON.stringify(events).includes("fixture-native-model-api-key"),
        );
        const resumed = await runAgentTurn({
          provider,
          bin: provider,
          task: {
            model: provider === "codex" ? "gpt-5.1-codex" : "claude-sonnet-4-6",
            authMode: "api",
            baseUrl: upstream.url + "/v1",
            upstream: result.upstream,
          },
          prompt:
            "Continue the same session and report the result without running another command.",
          cwd,
          env,
          processIdentity: identity,
          signal: controller.signal,
          emit: (event) => events.push(event),
          onStderr: (value) => stderr.push(value),
        });
        assert.equal(
          resumed.upstream,
          result.upstream,
          "A later turn resumes the native session rather than mixing accounts",
        );
        t.diagnostic(
          version.stdout.trim() +
            "; real protocol + local model fixture + real command; no production credentials",
        );
      } catch (error) {
        error.message +=
          "\nSTDERR: " +
          stderr.join("").slice(-3000) +
          "\nTOOLS: " +
          JSON.stringify(upstream.toolsSeen[0] || []);
        throw error;
      } finally {
        controller.abort();
        answer?.();
        await run?.catch(() => {});
        await upstream.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

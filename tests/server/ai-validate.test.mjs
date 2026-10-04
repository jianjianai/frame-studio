import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fixture } from "./ai-test-fixture.mjs";
import { fixture as browserFixture, repo } from "../mcp/helpers.mjs";
import {
  validateAiWorkspace,
  probeAiRuntime,
} from "../../server/ai-validate.mjs";
import { treeHash } from "../../server/project-files.mjs";
const commit = "a".repeat(40);

test("Workspace validation preserves scope/structure/test/type order before actual runtime and rejects changed revisions", async (t) => {
  const f = await fixture(t);
  const { workspace } = await f.workService.prepare(f.work.id);
  const calls = [];
  const result = await validateAiWorkspace({
    core: repo,
    work: workspace.workspaceRoot,
    project: f.work.project,
    baselineCommit: commit,
    fingerprint: await treeHash(workspace.projectRoot),
    modeFingerprint: await treeHash(workspace.projectRoot, {
      includeExecutableMode: true,
    }),
    run: async (bin, args) => {
      calls.push({ bin, args });
      return args.includes("typecheck") ? '{"status":"passed"}' : "";
    },
    runtimeProbe: async () => ({ status: "passed", width: 320, samples: [] }),
  });
  assert.deepEqual(
    result.validation.map((item) => item.name),
    ["scope", "structure", "project-tests", "project-types", "runtime"],
  );
  assert.deepEqual(calls[0].args.slice(-3), [f.work.project, "--base", commit]);
  assert.equal(calls[1].args.at(-1), "--strict");
  assert.deepEqual(calls[2].args.slice(-3), ["test", f.work.project, "--json"]);
  assert.deepEqual(calls[3].args.slice(-3), [
    "typecheck",
    f.work.project,
    "--json",
  ]);
  await assert.rejects(
    validateAiWorkspace({
      core: repo,
      work: workspace.workspaceRoot,
      project: f.work.project,
      baselineCommit: commit,
      fingerprint: "f".repeat(64),
    }),
    /changed before validation/,
  );
  let runtime = false;
  const failed = await validateAiWorkspace({ core: repo, work: workspace.workspaceRoot,
    project: f.work.project, baselineCommit: commit,
    run: async (_bin, args) => args.includes("typecheck") ? '{"status":"failed"}' : "",
    runtimeProbe: async () => { runtime = true; },
  });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /type validation failed/);
  assert.equal(runtime, false);
  await assert.rejects(
    validateAiWorkspace({
      core: repo,
      work: workspace.workspaceRoot,
      project: "../foreign",
      baselineCommit: commit,
    }),
    /Invalid Ai project/,
  );
});

test("Runtime probe rejects non-finite PCM and always releases its page and session", async (t) => {
  const f = await fixture(t);
  const { workspace } = await f.workService.prepare(f.work.id);
  const pcm = Buffer.alloc(8);
  pcm.writeFloatLE(NaN, 0);
  let pageClosed = 0,
    sessionClosed = 0;
  const sessionFactory = async () => ({
    page: async (_project, options) => {
      assert.equal(options.purpose, "media");
      return {
        evaluate: async (_fn, value) =>
          value.time !== undefined
            ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")
            : pcm.toString("base64"),
        close: async () => {
          pageClosed++;
        },
        frameDiagnostics: () => ({ errors: [] }),
      };
    },
    close: async () => {
      sessionClosed++;
    },
  });
  await assert.rejects(
    probeAiRuntime({
      work: workspace.workspaceRoot,
      project: f.work.project,
      sessionFactory,
    }),
    /non-finite/,
  );
  assert.equal(pageClosed, 1);
  assert.equal(sessionClosed, 1);
  pcm.writeFloatLE(0, 0);
  const brokenClose = async () => {
    const session = await sessionFactory();
    const page = await session.page(f.work.project, { purpose: "media" });
    page.close = async () => {
      throw Error("Page close failed");
    };
    return { page: async () => page, close: session.close };
  };
  await assert.rejects(
    probeAiRuntime({
      work: workspace.workspaceRoot,
      project: f.work.project,
      sessionFactory: brokenClose,
    }),
    /Page close failed/,
  );
  assert.equal(sessionClosed, 2);
});

test(
  "The workspace runtime gate renders real frames and finite short generated-audio chunks without a movie export",
  { timeout: 120000 },
  async () => {
    const f = browserFixture({ browser: true });
    try {
      const probe = await probeAiRuntime({
        work: f.root,
        project: "test-film",
      });
      assert.equal(probe.status, "passed");
      assert.equal(probe.samples.length, 2);
      assert.deepEqual(
        probe.samples.map((sample) => sample.time),
        [0, 1],
      );
      assert.ok(
        probe.samples.every(
          (sample) =>
            sample.duration <= 0.125 &&
            sample.audioFrames > 0 &&
            sample.pngBytes > 100,
        ),
      );
    } finally {
      f.close();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { launchBrowser } from "../../scripts/browser.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { nativeWorkflowFixture } from "./paseo-workflow-fixture.mjs";
import { until } from "./paseo-test-fixture.mjs";

test(
  "Full official Paseo WebUI sends through native Codex app-server, scopes FRAME tools and verifies/applies a reversible main draft",
  { skip: !process.env.FRAME_TEST_DATABASE_URL, timeout: 240000 },
  async (t) => {
    const f = await nativeWorkflowFixture(t);
    const browser = await launchBrowser();
    f.registerBrowser(browser);
    const page = await browser.newPage({
      viewport: { width: 1500, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      t.diagnostic("API authentication and parent player");
      await page.goto(f.origin);
      await page
        .getByLabel("登录密码", { exact: true })
        .fill("owned-native-workflow-password");
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page.goto(f.origin + "/#/work/" + f.work.id);
      const player = page.frameLocator('iframe[title="作品播放器"]');
      await player.getByTestId("play-toggle").waitFor({ timeout: 45000 });
      const openAI = page.getByRole("button", {
        name: "打开 AI 对话",
        exact: true,
      });
      if (await openAI.count()) await openAI.click();
      else
        await page
          .locator('[data-tool-key="ai"][aria-expanded="true"]')
          .waitFor();
      const frameElement = page.locator('iframe[title^="Paseo ·"]');
      await frameElement.waitFor({ timeout: 45000 });
      // Use the official v0.10.2 host-workspace open route; the work bootstrap and nonce remain authoritative.
      await frameElement.evaluate(
        (iframe, identity) => {
          const url = new URL(iframe.src);
          const workspace = /^[A-Za-z0-9._~-]+$/.test(identity.workspaceId)
            ? identity.workspaceId
            : "b64_" +
              btoa(unescape(encodeURIComponent(identity.workspaceId)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replace(/=+$/, "");
          url.pathname =
            identity.basePath.replace(/\/$/, "") +
            "/h/" +
            encodeURIComponent(identity.serverId) +
            "/workspace/" +
            encodeURIComponent(workspace);
          url.searchParams.set("open", "agent:" + identity.agentId);
          iframe.src = url.href;
        },
        {
          basePath: "/paseo/" + f.work.id + "/",
          serverId: f.ready.serverId,
          workspaceId: f.ready.workspaceId,
          agentId: f.agent.id,
        },
      );
      t.diagnostic("Official native agent route/composer");
      const native = page.frameLocator('iframe[title^="Paseo ·"]');
      const composer = native
        .getByRole("textbox", { name: "Message agent..." })
        .first();
      await composer.waitFor({ timeout: 45000 });
      await composer.fill(
        "FRAME WORKFLOW FIXTURE: modify only this project's scene and inspect the exact FRAME reference.",
      );
      t.diagnostic("Native UI submission/frozen reference");
      await native
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      const accepted = await until(
        async () => {
          const rows = await f.captured();
          const failure = rows.find(
            (row) =>
              row.kind === "owned-turn-error" || row.kind === "protocol-error",
          );
          if (failure) throw Error(JSON.stringify(failure));
          return rows.find((row) => row.kind === "accepted-turn");
        },
        "Native app-server did not receive/complete the real WebUI submission",
        60000,
      );
      await native
        .getByText("FRAME_NATIVE_WORKFLOW_COMPLETE", { exact: true })
        .first()
        .waitFor({ timeout: 15000 });
      assert.equal(accepted.cwd, f.ready.draftRoot);
      assert.equal(accepted.project, f.work.project);
      assert.ok(JSON.stringify(accepted.frameAssets).includes(f.ownAsset.id));
      assert.ok(
        !JSON.stringify(accepted.frameAssets).includes(f.foreignAsset.id),
        "FRAME HMAC tools must hide another repository's assets",
      );
      assert.equal(accepted.framePreview.paseoAgent, f.agent.id);
      assert.match(accepted.prompt, /FRAME work reference|FRAME work:/);
      const launches = (await f.captured()).filter(
        (row) => row.kind === "launch",
      );
      assert.ok(launches.length);
      assert.ok(
        launches.every(
          (row) =>
            row.frameCredentialInjected &&
            row.apiCredentialInjected &&
            !row.hasMasterKey &&
            !row.hasDatabaseUrl &&
            !row.hasTestDatabaseUrl,
        ),
      );
      const frozen = await f.db.all(
        "SELECT * FROM paseo_message_contexts WHERE work_id=$1",
        [f.work.id],
      );
      assert.equal(frozen.length, 1);
      assert.equal(frozen[0].agent_id, f.agent.id);
      assert.deepEqual(frozen[0].execution.nativeSelection, {
        provider: f.profileId,
        model: "owned-model",
      });
      t.diagnostic(
        "Native turn completed; real candidate validation/publication",
      );
      const candidate = await until(
        async () => {
          const row = (
            await f.services.paseoStore.listCandidates(f.work.id, { limit: 1 })
          )[0];
          if (
            row &&
            ["invalid", "publish_failed", "conflict"].includes(row.state)
          )
            throw Error(
              JSON.stringify({
                state: row.state,
                error: row.error,
                result: row.result,
              }),
            );
          return row?.state === "applied" && row;
        },
        "Real FRAME validation/publication did not apply the native main draft",
        120000,
      );
      assert.deepEqual(
        candidate.result.validation.map((check) => check.name),
        ["scope", "structure", "project-tests", "project-types", "runtime"],
      );
      assert.ok(
        candidate.result.validation.every((check) => check.status === "passed"),
      );
      assert.equal(await treeHash(f.canonical), candidate.snapshotFingerprint);
      assert.match(
        await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"),
        /FRAME_NATIVE_WORKFLOW_APPLIED/,
      );
      assert.equal(
        (await f.db.all("SELECT kind,state FROM tasks WHERE kind='paseo'"))
          .length,
        1,
      );
      const appliedStatus = page.locator(
        ".paseo-candidate.state-applied span[role=status]",
      );
      await appliedStatus.waitFor({ timeout: 15000 });
      assert.equal(
        await appliedStatus.innerText(),
        "已应用到作品 · " + candidate.revision.slice(0, 8),
      );
      t.diagnostic("Main candidate applied; native managed Git worktree scope");
      // Managed native Git worktrees retain isolation and use the same work-scoped tool credentials.
      const checkout = await f.client.createPaseoWorktree({
        cwd: f.ready.draftRoot,
        worktreeSlug: "owned-isolated-worktree",
        action: "branch-off",
        refName: "frame-draft",
      });
      assert.equal(checkout.error, null, JSON.stringify(checkout));
      const treeAgent = await f.client.createAgent({
        provider: f.profileId,
        model: "owned-model",
        cwd: checkout.workspace.workspaceDirectory,
        workspaceId: checkout.workspace.id,
        title: "Native isolated worktree",
        modeId: "auto",
      });
      await f.client.sendAgentMessage(
        treeAgent.id,
        "FRAME ISOLATED WORKTREE FIXTURE",
        {
          messageId: randomUUID(),
        },
      );
      const isolated = await until(
        async () =>
          (await f.captured()).find(
            (row) =>
              row.kind === "accepted-turn" &&
              row.cwd === checkout.workspace.workspaceDirectory,
          ),
        "Managed worktree did not use its own exact FRAME tool context",
        60000,
      );
      assert.equal(isolated.framePreview.paseoAgent, treeAgent.id);
      assert.ok(
        isolated.scenePath.startsWith(
          checkout.workspace.workspaceDirectory + path.sep,
        ),
      );
      assert.ok(
        !JSON.stringify(isolated.frameAssets).includes(f.foreignAsset.id),
      );
      await until(
        async () =>
          !(await f.services.paseoManager.observe(f.work.id, { refresh: true }))
            .activeAgents.length,
        "Native agents did not become idle",
        15000,
      );
      await f.services.paseoDrafts.reconcile(f.work.id, { force: true });
      assert.equal(
        (await f.services.paseoStore.listCandidates(f.work.id)).length,
        1,
        "An isolated worktree must not silently publish to the main work",
      );
      t.diagnostic("Native worktree stayed isolated; exact Git restore");
      // Restore the exact pre-send Git version after a successful real publication.
      const scm = await f.call("works_scm_status", { id: f.work.id });
      await f.call("works_restore", {
        id: f.work.id,
        version: f.baseline.id,
        expectedRevision: scm.revision,
      });
      assert.equal(
        await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"),
        f.sceneBefore,
      );
      const timeline = await f.client.fetchAgentTimeline(f.agent.id);
      assert.match(JSON.stringify(timeline), /FRAME_NATIVE_WORKFLOW_COMPLETE/);
      assert.deepEqual(errors, []);
    } catch (error) {
      const observed = [];
      for (const frame of page.frames()) {
        observed.push({
          url: frame.url(),
          text: await frame
            .locator("body")
            .innerText({ timeout: 3000 })
            .then((text) => text.slice(0, 12000))
            .catch(() => "unavailable"),
        });
      }
      const captured = await f.captured();
      const frozen = await f.db.all(
        "SELECT agent_id,message_id FROM paseo_message_contexts WHERE work_id=$1",
        [f.work.id],
      );
      const native = page
        .frames()
        .find((frame) => frame.url().startsWith(f.origin + "/paseo/"));
      const composerState = native
        ? await native
            .locator("body")
            .evaluate((element) => ({
              inputs: [...element.querySelectorAll("textarea,input")].map(
                (item) => ({
                  placeholder: item.getAttribute("placeholder"),
                  value: item.value,
                  disabled: item.disabled,
                }),
              ),
              buttons: [
                ...element.querySelectorAll("button,[role=button]"),
              ].map((item) => ({
                label: item.getAttribute("aria-label"),
                testId: item.getAttribute("data-testid"),
                title: item.getAttribute("title"),
                text: item.textContent?.slice(0, 100),
                disabled: item.disabled,
              })),
            }))
            .catch(() => null)
        : null;
      const nativeAgent = await f.services.paseoManager.agent(
        f.work.id,
        f.agent.id,
      );
      t.diagnostic(
        JSON.stringify({
          failure: error.message,
          pageErrors: errors,
          frames: observed,
          composerState,
          frozen,
          captured: captured.map((row) => ({
            kind: row.kind,
            name: row.name,
            message: row.message,
          })),
          nativeAgent: nativeAgent && {
            id: nativeAgent.id,
            provider: nativeAgent.provider,
            model: nativeAgent.model,
            status: nativeAgent.status,
          },
        }),
      );
      await page
        .screenshot({
          path: path.join(f.directory, "failed-workflow.png"),
          fullPage: true,
        })
        .catch(() => {});
      throw error;
    }
  },
);

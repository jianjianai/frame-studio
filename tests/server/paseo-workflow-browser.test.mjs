import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "../../scripts/browser.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { nativeWorkflowFixture } from "./paseo-workflow-fixture.mjs";
import { until } from "./paseo-test-fixture.mjs";

test(
  "Full official Paseo WebUI and standalone tab share the canonical workspace, scope FRAME tools and validate the current revision",
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
      const playerElement = await page
        .locator('iframe[title="作品播放器"]')
        .elementHandle();
      const playerFrame = await playerElement.contentFrame();
      await playerFrame.waitForFunction(
        () =>
          window.__FRAME_LIVE_STATUS__?.state === "ready" &&
          window.__FRAME_LIVE_STATUS__?.compiledRevision,
        undefined,
        { timeout: 45000 },
      );
      const shownReference = await playerFrame.evaluate(
        () => window.__FRAME_LIVE_STATUS__,
      );
      assert.equal(
        shownReference.sourceRevision,
        await treeHash(f.canonical, { includeExecutableMode: true }),
      );
      await player.locator(".timeline-options summary").click();
      const locate = player.getByLabel("定位帧", { exact: true });
      await locate.fill("6");
      await locate.press("Enter");
      await player.getByRole("button", { name: "设为入点" }).click();
      await locate.fill("18");
      await locate.press("Enter");
      await player.getByRole("button", { name: "设为出点" }).click();
      const positioned = await playerFrame.evaluate(() =>
        window.__FRAME_STUDIO__.getState(),
      );
      assert.equal(positioned.time, 1.5);
      await player.locator(".timeline-options summary").click();
      const playerUrl = playerFrame.url();
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
      const native = page.frameLocator('iframe[title^="Paseo ·"]');
      t.diagnostic("Default official native workspace route/composer");
      const composer = native
        .getByRole("textbox", { name: "Message agent..." })
        .first();
      await composer.waitFor({ timeout: 45000 });
      const nativeFrame = await (
        await frameElement.elementHandle()
      ).contentFrame();
      assert.ok(
        new URL(nativeFrame.url()).pathname.startsWith(
          `/paseo/${f.work.id}/h/${f.ready.serverId}/workspace/`,
        ),
        "The default FRAME entry must open its work instead of the project picker",
      );
      assert.equal(
        await native.getByText("Add a project", { exact: true }).count(),
        0,
      );
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
      assert.equal(accepted.cwd, f.ready.workspaceRoot);
      assert.equal(accepted.scenePath, path.join(f.canonical, "scene.ts"));
      assert.equal(accepted.project, f.work.project);
      assert.ok(JSON.stringify(accepted.frameAssets).includes(f.ownAsset.id));
      assert.ok(
        !JSON.stringify(accepted.frameAssets).includes(f.foreignAsset.id),
        "FRAME HMAC tools must hide another repository's assets",
      );
      assert.equal(accepted.framePreview.source, "work");
      assert.equal(accepted.framePreview.paseoAgent, undefined);
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
      assert.equal(
        frozen[0].envelope.context.time,
        undefined,
        "A selected range uses start/end rather than a separate point reference",
      );
      assert.equal(frozen[0].envelope.context.start, 0.5);
      assert.equal(frozen[0].envelope.context.end, 1.5);
      assert.equal(
        frozen[0].envelope.context.sourceRevision,
        shownReference.sourceRevision,
      );
      assert.equal(
        frozen[0].envelope.context.compiledRevision,
        shownReference.compiledRevision,
      );
      assert.equal(
        frozen[0].review_reference.sourceRevision,
        shownReference.sourceRevision,
      );
      assert.equal(
        frozen[0].review_reference.compiledRevision,
        shownReference.compiledRevision,
      );
      assert.deepEqual(frozen[0].execution.nativeSelection, {
        provider: f.profileId,
        model: "owned-model",
      });
      t.diagnostic("Native turn completed; same-workspace revision validation");
      const report = await until(
        async () => {
          await f.services.paseoWorkspace.reconcile(f.work.id);
          const row = (
            await f.services.paseoStore.listValidations(f.work.id, { limit: 1 })
          )[0];
          const revision = await treeHash(f.canonical, {
            includeExecutableMode: true,
          });
          if (row?.revision === revision && row.state === "failed")
            throw Error(
              JSON.stringify({
                state: row.state,
                error: row.error,
                result: row.result,
              }),
            );
          return row?.revision === revision && row.state === "passed" && row;
        },
        "Real FRAME validation did not pass for the current canonical revision",
        120000,
      );
      assert.deepEqual(
        report.result.validation.map((check) => check.name),
        ["scope", "structure", "project-tests", "project-types", "runtime"],
      );
      assert.ok(
        report.result.validation.every((check) => check.status === "passed"),
      );
      assert.equal(
        await treeHash(f.canonical, { includeExecutableMode: true }),
        report.revision,
      );
      assert.match(
        await fs.readFile(path.join(f.canonical, "scene.ts"), "utf8"),
        /FRAME_NATIVE_WORKFLOW_APPLIED/,
      );
      assert.equal(
        (await f.db.all("SELECT kind,state FROM tasks WHERE kind='paseo'"))
          .length,
        0,
      );
      const appliedStatus = page.locator(".paseo-validation span[role=status]");
      await appliedStatus.waitFor({ timeout: 15000 });
      await until(
        async () =>
          (await appliedStatus.innerText()) ===
          "作品检查通过 · " + report.revision.slice(0, 8),
        "The subscribed Paseo panel did not show validation for the current revision",
        15000,
      );
      await playerFrame.waitForFunction(
        (revision) =>
          window.__FRAME_LIVE_STATUS__?.state === "ready" &&
          window.__FRAME_LIVE_STATUS__?.sourceRevision === revision,
        report.revision,
        { timeout: 15000 },
      );
      assert.equal(
        playerFrame.url(),
        playerUrl,
        "Canonical edits update the existing player without starting another workspace",
      );
      const pixels = await playerElement.screenshot();
      assert.equal(
        pixels.subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
        "The source-scoped preview must render actual PNG pixels",
      );
      assert.ok(pixels.length > 300);
      t.diagnostic(
        "A sent native reference opens its recorded range and distinguishes the changed canonical version",
      );
      const [reviewPage] = await Promise.all([
        page.waitForEvent("popup"),
        native
          .getByRole("button", { name: "打开 作品 0.50–1.50 秒", exact: true })
          .click(),
      ]);
      reviewPage.on("pageerror", (error) => errors.push(error.message));
      assert.equal(await reviewPage.evaluate(() => window.opener), null);
      const reviewNote = reviewPage.locator(
        '[role="status"][aria-label="对话中的画面引用"]',
      );
      await reviewNote
        .getByText("引用记录的版本与当前预览不同，尚未定位。", { exact: true })
        .waitFor({ timeout: 45000 });
      await reviewNote.getByText("查看引用版本", { exact: true }).click();
      await reviewNote
        .getByText("记录源码：" + shownReference.sourceRevision, { exact: true })
        .waitFor();
      await reviewNote
        .getByText("记录画面：" + shownReference.compiledRevision, { exact: true })
        .waitFor();
      await reviewNote
        .getByText("当前源码：" + report.revision, { exact: true })
        .waitFor();
      const reviewPlayer = await (
        await reviewPage.locator('iframe[title="作品播放器"]').elementHandle()
      ).contentFrame();
      await reviewPlayer.waitForFunction(
        (revision) =>
          window.__FRAME_LIVE_STATUS__?.state === "ready" &&
          window.__FRAME_LIVE_STATUS__?.sourceRevision === revision,
        report.revision,
        { timeout: 15000 },
      );
      const untouchedReview = await reviewPlayer.evaluate(() =>
        window.__FRAME_STUDIO__.getState(),
      );
      assert.equal(
        untouchedReview.time,
        0,
        "An older reference must not silently seek a different current version",
      );
      await reviewPage.evaluate(() => {
        window.addEventListener("message", (event) => {
          if (
            event.source ===
              document.querySelector('iframe[title="作品播放器"]')
                ?.contentWindow &&
            event.data?.type === "frame-player-state"
          )
            window.__FRAME_TEST_REVIEW_STATE__ = event.data;
        });
      });
      await reviewNote
        .getByRole("button", { name: "在当前版本定位此时间", exact: true })
        .click();
      await reviewPage.waitForFunction(
        () => {
          const state = window.__FRAME_TEST_REVIEW_STATE__;
          return (
            state?.time === 0.5 &&
            state.selection?.start === 0.5 &&
            state.selection?.end === 1.5 &&
            state.playing === false
          );
        },
        undefined,
        { timeout: 10000 },
      );
      await reviewNote
        .getByText("已按你的选择定位当前版本；引用仍属于记录的较早版本。", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        (await f.services.paseoStore.getWork(f.work.id)).serverId,
        f.ready.serverId,
      );
      await reviewPage.close();
      t.diagnostic("Another native conversation shares the canonical work");
      const secondAgent = await f.client.createAgent({
        provider: f.profileId,
        model: "owned-model",
        cwd: f.ready.workspaceRoot,
        workspaceId: f.ready.workspaceId,
        title: "Second conversation in the same work",
        modeId: "auto",
      });
      const secondNative = await f.services.paseoManager.agent(
        f.work.id,
        secondAgent.id,
      );
      assert.notEqual(secondAgent.id, f.agent.id);
      assert.equal(secondNative.cwd, f.ready.workspaceRoot);
      assert.equal(secondNative.workspaceId, f.ready.workspaceId);
      t.diagnostic(
        "Standalone official WebUI retains the existing conversation and daemon",
      );
      const [standalone] = await Promise.all([
        page.waitForEvent("popup"),
        page
          .getByRole("link", { name: "在新标签页打开 Paseo", exact: true })
          .click(),
      ]);
      standalone.on("pageerror", (error) => errors.push(error.message));
      const standaloneComposer = standalone
        .getByRole("textbox", { name: "Message agent..." })
        .first();
      await standaloneComposer.waitFor({ timeout: 45000 });
      assert.equal(
        new URL(standalone.url()).searchParams.get("frameStandalone"),
        "1",
      );
      await standalone
        .getByText("Native Frame workflow", { exact: true })
        .first()
        .waitFor();
      assert.equal(await standalone.evaluate(() => window.opener), null);
      await standaloneComposer.fill(
        "FRAME STANDALONE WORKFLOW FIXTURE: continue editing this same project.",
      );
      await standalone
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      const continued = await until(
        async () => {
          const rows = await f.captured();
          const failure = rows.find(
            (row) =>
              row.kind === "owned-turn-error" || row.kind === "protocol-error",
          );
          if (failure) throw Error(JSON.stringify(failure));
          return rows.filter((row) => row.kind === "accepted-turn")[1];
        },
        "Standalone native message did not use the same FRAME work",
        60000,
      );
      assert.equal(continued.cwd, accepted.cwd);
      assert.equal(continued.scenePath, accepted.scenePath);
      const standaloneFrozen = await f.db.all(
        "SELECT * FROM paseo_message_contexts WHERE work_id=$1",
        [f.work.id],
      );
      assert.equal(standaloneFrozen.length, 2);
      assert.ok(standaloneFrozen.every((row) => row.agent_id === f.agent.id));
      const unpositioned = standaloneFrozen.find(
        (row) => row.message_id !== frozen[0].message_id,
      );
      assert.deepEqual(
        unpositioned.envelope.context || {},
        {},
        "A standalone tab must not invent a preview time or selection",
      );
      assert.equal(
        (await f.services.paseoStore.getWork(f.work.id)).serverId,
        f.ready.serverId,
      );
      t.diagnostic(
        "Standalone reload reconnects to the same native conversation without replaying its submission",
      );
      await standalone.reload();
      await standaloneComposer.waitFor({ timeout: 45000 });
      await standalone
        .getByText("FRAME_NATIVE_WORKFLOW_COMPLETE", { exact: true })
        .last()
        .waitFor({ timeout: 15000 });
      await standalone
        .getByText("Native Frame workflow", { exact: true })
        .first()
        .waitFor();
      assert.equal(
        (await f.services.paseoStore.getWork(f.work.id)).serverId,
        f.ready.serverId,
      );
      assert.equal(
        (await f.captured()).filter((row) => row.kind === "accepted-turn")
          .length,
        2,
      );
      assert.equal(
        (
          await f.db.all(
            "SELECT * FROM paseo_message_contexts WHERE work_id=$1",
            [f.work.id],
          )
        ).length,
        2,
      );
      await standalone.close();
      t.diagnostic("Native worktree creation is rejected");
      const checkout = await f.client
        .createPaseoWorktree({
          cwd: f.ready.workspaceRoot,
          worktreeSlug: "owned-isolated-worktree",
          action: "branch-off",
          refName: "main",
        })
        .catch((error) => ({ error: error.message }));
      assert.ok(checkout.error, "Native worktree creation must be blocked");
      assert.match(JSON.stringify(checkout.error), /共享工作区|workspace/i);
      await until(
        async () =>
          !(await f.services.paseoManager.observe(f.work.id, { refresh: true }))
            .activeAgents.length,
        "Native agents did not become idle",
        15000,
      );
      t.diagnostic(
        "Native conversations became idle; exact canonical Git restore",
      );
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
      for (const frame of page.context().pages().flatMap((tab) => tab.frames())) {
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
          ready: f.ready,
          binding: await f.services.paseoStore.getWork(f.work.id),
          validations: await f.services.paseoStore.listValidations(f.work.id, {
            limit: 2,
          }),
          nativeBootstrap: await native
            ?.evaluate(() => ({
              embed: window.__PASEO_FRAME_EMBED__,
              routeBase: window.__FRAME_PASEO_ROUTE_BASE__,
            }))
            .catch(() => null),
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

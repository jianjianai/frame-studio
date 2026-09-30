import { sourceControlFlow } from "../ui/source-control-flow.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { treeHash } from "../../server/security.mjs";
import { fixture, repo as platformRoot } from "../mcp/helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { PREVIEW_VERSION } from "../../server/preview-version.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "workbench browser: repository navigation, real sandboxed preview, resizing, dialogs and background continuity",
  { skip: !url, timeout: 180000 },
  async () => {
    const port = Number(process.env.FRAME_TEST_PORT || 55173),
      origin = `http://127.0.0.1:${port}`;
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-ui-")),
      f = fixture({ browser: true, renderer: "pixi" }),
      db = await database(url, "test-password-at-least-14");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const { app, actions } = await createApp({
      db,
      data,
      masterKey: "33".repeat(32),
      origin,
      scheduler: false,
    });
    let browser;
    const call = (name, args = {}) => actions.call(name, args);
    try {
      const repo = await call("repositories_add", { name: "作品浏览器测试" });
      fs.cpSync(
        f.file(""),
        path.join(data, "repos", repo.id, "projects/test-film"),
        { recursive: true },
      );
      await actions.works.discover(repo.id);
      const work = (await call("works_page", { repo: repo.id })).items[0];
      const oldPreview = process.env.FRAME_WORK_PREVIEW;
      process.env.FRAME_WORK_PREVIEW = "1";
      let built;
      try {
        built = await executeProject(f.root, "test-film", "build");
      } finally {
        if (oldPreview === undefined) delete process.env.FRAME_WORK_PREVIEW;
        else process.env.FRAME_WORK_PREVIEW = oldPreview;
      }
      assert.equal(built.status, "passed", JSON.stringify(built));
      const id = randomUUID(),
        relative = "projects/test-film/exports/preview";
      fs.cpSync(built.output, path.join(data, "runs", id, relative), {
        recursive: true,
      });
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint,finished) VALUES($1,$2,'test-film','build','succeeded','{}',$3,$4,now())",
        [
          id,
          repo.id,
          {
            runtimeFingerprint: (await runtimeIdentity()).fingerprint,
            previewVersion: PREVIEW_VERSION,
            artifacts: [{ name: "index.html", path: relative + "/index.html" }],
          },
          treeHash(path.join(data, "works", work.id, "projects/test-film")),
        ],
      );
      // A newer historical build must never replace the current work preview.
      const historicalId = randomUUID();
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,result,created) VALUES($1,$2,'test-film','build','succeeded',$3,$4,now()+interval '1 second')",
        [
          historicalId,
          repo.id,
          { version: "a".repeat(40) },
          {
            previewVersion: PREVIEW_VERSION,
            runtimeFingerprint: (await runtimeIdentity()).fingerprint,
          },
        ],
      );
      assert.equal(
        (await call("works_preview_status", { id: work.id })).latest.id,
        id,
      );
      await db.pool.query("DELETE FROM tasks WHERE id=$1", [historicalId]);
      await app.listen({ host: "127.0.0.1", port });
      browser = await launchBrowser();
      // The test may disconnect the actual socket to exercise client resubscription.
      const context = await browser.newContext({
          viewport: { width: 1500, height: 1000 },
        }),
        page = await context.newPage(),
        errors = [],
        actionRequests = [];
      page.on("request", (req) => {
        if (req.url().endsWith("/api/action")) actionRequests.push(req.url());
      });
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        const Native = WebSocket;
        window.fixtureSockets = [];
        window.WebSocket = class extends Native {
          constructor(...args) {
            super(...args);
            window.fixtureSockets.push(this);
          }
        };
      });
      await page.goto(origin);
      await page
        .getByLabel("登录密码", { exact: true })
        .fill("test-password-at-least-14");
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page.getByRole("link", { name: "作品仓库", exact: true }).click();
      await page.getByRole("button", { name: /作品浏览器测试/ }).click();
      const workLink = page.getByRole("link", { name: /MCP 测试/ }).first();
      assert.equal(await workLink.getAttribute("target"), "_blank");
      await page.goto(origin + "/" + (await workLink.getAttribute("href")));
      const player = page.frameLocator('iframe[title="作品播放器"]');
      await page.getByRole("button", { name: "导出", exact: true }).waitFor();
      await page.getByRole("button", { name: "后台任务", exact: true }).click();
      await page.getByRole("complementary", { name: "后台任务" }).waitFor();
      assert.equal(await page.locator(".creation-status").count(), 0);
      await page.getByRole("button", { name: "关闭后台任务" }).click();
      await page.getByRole("button", { name: "打开 AI 对话" }).click();
      await player.getByTestId("play-toggle").waitFor({ timeout: 30000 });
      await player.getByTestId("play-toggle").click();
      await page.waitForTimeout(350);
      await player.getByTestId("play-toggle").click();
      await player.locator(".timeline-options summary").click();
      await player.getByLabel("定位帧", { exact: true }).fill("6");
      await player.getByLabel("定位帧", { exact: true }).press("Enter");
      await player.getByRole("button", { name: "设为入点" }).click();
      await player.getByLabel("定位帧", { exact: true }).fill("12");
      await player.getByLabel("定位帧", { exact: true }).press("Enter");
      await player.getByRole("button", { name: "设为出点" }).click();
      await player.getByRole("button", { name: "播放选段" }).click();
      await page.waitForTimeout(650);
      const playerFrame = await page
        .locator('iframe[title="作品播放器"]')
        .elementHandle()
        .then((element) => element.contentFrame());
      assert(playerFrame, "the named sandboxed player must stay attached");
      const state = await playerFrame.evaluate(() =>
        window.__FRAME_STUDIO__.getState(),
      );
      assert.equal(state.playing, false);
      assert(Math.abs(state.time - 1) < 0.1, JSON.stringify(state));
      await player
        .getByRole("slider", { name: "时间轴可视终点", exact: true })
        .press("Home");
      assert(
        await player
          .locator(".timeline-scroll")
          .evaluate((element) => element.scrollWidth > element.clientWidth * 3),
      );
      await player
        .getByRole("slider", { name: "时间轴可视范围", exact: true })
        .press("0");
      await player.locator(".timeline-options summary").click();
      const separator = page.getByRole("separator"),
        before = await page.locator(".preview-pane").boundingBox(),
        box = await separator.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x - 120, box.y + 40, { steps: 8 });
      await page.mouse.up();
      assert(
        (await page.locator(".preview-pane").boundingBox()).width <
          before.width - 70,
      );
      assert.equal(await page.locator(".navigation").count(), 0);
      assert.equal(
        await page.getByRole("button", { name: "切换左右或上下布局" }).count(),
        0,
      );
      await page
        .locator(".creation-toolbar")
        .getByRole("button", { name: "关闭 AI 对话" })
        .click();
      await page.getByRole("button", { name: "打开 AI 对话" }).click();
      await sourceControlFlow({
        page,
        call,
        work,
        data,
        reportDir: path.join(platformRoot, ".cache/scm-validation"),
      });
      fs.mkdirSync(path.join(platformRoot, ".cache/validation"), {
        recursive: true,
      });
      await page.screenshot({
        path: path.join(
          platformRoot,
          ".cache/validation/workbench-desktop.png",
        ),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileStage = await player
        .getByTestId("stage-canvas")
        .boundingBox();
      const mobileTransport = await player.locator(".transport").boundingBox();
      const mobileTimeline = await player
        .locator(".timeline-panel")
        .boundingBox();
      assert(
        mobileStage.height >= 140,
        "Mobile video must retain useful height",
      );
      assert(
        mobileTransport.y + mobileTransport.height <= mobileTimeline.y + 1,
        "Timeline must not overlap playback controls",
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: path.join(platformRoot, ".cache/validation/workbench-mobile.png"),
      });
      await page.setViewportSize({ width: 1500, height: 1000 });
      const connection = await call("connections_save", {
          name: "测试连接",
          tool: "codex",
          mode: "api",
          apiKey: "test-fixture-only",
          model: "fixture",
        }),
        chat = await call("works_chat_create", {
          id: work.id,
          connection: connection.id,
          title: "后台连续性",
        });
      const queued = await call("works_chat_send", {
        id: work.id,
        chat: chat.id,
        prompt: "继续制作",
        requestKey: randomUUID(),
      });
      await page.getByRole("button", { name: "后台任务", exact: true }).click();
      await page.getByRole("progressbar", { name: "后台任务进度" }).waitFor();
      await db.pool.query("UPDATE tasks SET progress=$2 WHERE id=$1", [
        queued.id,
        { stage: "准备轻量预览音频", completed: 3, total: 8 },
      ]);
      await page.getByText("38% · 3/8", { exact: true }).waitFor();
      await page.evaluate(() => window.fixtureSockets.at(-1).close());
      await db.pool.query("UPDATE tasks SET progress=$2 WHERE id=$1", [
        queued.id,
        { stage: "准备轻量预览音频", completed: 5, total: 8 },
      ]);
      await page.getByText("63% · 5/8", { exact: true }).waitFor();
      assert.equal(
        actionRequests.length,
        0,
        "Browser actions and live updates must use WebSocket",
      );
      await page.close();
      const reopened = await context.newPage();
      await reopened.goto(origin + "/#/background");
      await reopened.getByRole("link", { name: /打开作品/ }).waitFor();
      assert.equal(
        (await db.one("SELECT state FROM tasks WHERE id=$1", [queued.id]))
          .state,
        "queued",
      );
      await reopened.getByRole("button", { name: "停止", exact: true }).click();
      await reopened.getByText("当前没有在后台运行的项目。").waitFor();
      await reopened.goto(origin + "/#/repository/" + repo.id);
      await reopened.getByLabel("MCP 测试操作").click();
      await reopened
        .getByRole("menuitem", { name: "移入回收站", exact: true })
        .click();
      const confirm = reopened.getByRole("dialog", { name: "移入回收站" });
      const trash = confirm.getByRole("button", {
        name: "移入回收站",
        exact: true,
      });
      await confirm.getByLabel("输入作品名称确认").fill("wrong");
      assert.equal(await trash.isDisabled(), true);
      await confirm.getByLabel("输入作品名称确认").fill(work.title);
      await trash.click();
      await confirm.waitFor({ state: "hidden" });
      assert.equal(
        (await db.one("SELECT deleted FROM works WHERE id=$1", [work.id]))
          .deleted,
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
      f.close();
    }
  },
);

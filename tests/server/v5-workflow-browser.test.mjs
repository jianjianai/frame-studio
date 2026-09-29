import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { fixture, repo as platformRoot } from "../mcp/helpers.mjs";
import { executeProject } from "../../scripts/project-execution.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";
import { PREVIEW_VERSION } from "../../server/preview-version.mjs";

const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "V5 browser: immutable references, visual before/after review, persistent drafts and conflict-safe inverse undo",
  { skip: !url, timeout: 180000 },
  async () => {
    assert.match(new URL(url).pathname, /frame_test/);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-v5-browser-"));
    const f = fixture({ browser: true, renderer: "canvas" });
    const report = path.join(platformRoot, ".cache/v5-review");
    fs.mkdirSync(report, { recursive: true });
    const db = await database(url, "v5-browser-fixture-password");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const port = Number(process.env.FRAME_TEST_PORT || 55730),
      origin = `http://127.0.0.1:${port}`;
    const { app, actions, repos, tasks } = await createApp({
      db,
      data,
      masterKey: "15".repeat(32),
      origin,
      scheduler: false,
    });
    let browser, page;
    const errors = [];
    const oldPreview = process.env.FRAME_WORK_PREVIEW;
    try {
      const repo = await actions.call("repositories_add", {
        name: "V5 verification",
      });
      fs.cpSync(
        f.file(""),
        path.join(data, "repos", repo.id, "projects/test-film"),
        { recursive: true },
      );
      await actions.works.discover(repo.id);
      const work = (await actions.call("works_page", { repo: repo.id }))
        .items[0];
      const { repo: branch, dir } = await repos.project(repo.id, work.project);
      const before = await repos.checkpoint(
        repo.id,
        work.project,
        "Before visual change",
      );
      const beforeFingerprint = await treeHash(dir);
      process.env.FRAME_WORK_PREVIEW = "1";
      const beforeBuilt = await executeProject(f.root, "test-film", "build");
      assert.equal(beforeBuilt.status, "passed");
      const beforeSource = fs.readFileSync(f.file("scene.ts"), "utf8");
      assert(beforeSource.includes("#e4ead9"));
      const changedSource = beforeSource.replace("#e4ead9", "#21283e");
      fs.writeFileSync(f.file("scene.ts"), changedSource);
      fs.writeFileSync(path.join(dir, "scene.ts"), changedSource);
      const after = await repos.checkpoint(
        repo.id,
        work.project,
        "Fixture AI color change",
      );
      const afterFingerprint = await treeHash(dir);
      const afterBuilt = await executeProject(f.root, "test-film", "build");
      assert.equal(afterBuilt.status, "passed");
      const runtime = await runtimeIdentity();
      const seedPreview = async (
        built,
        commit,
        fingerprint,
        historical = false,
      ) => {
        const id = randomUUID(),
          relative = "projects/test-film/exports/preview";
        fs.cpSync(built.output, path.join(data, "runs", id, relative), {
          recursive: true,
        });
        await db.pool.query(
          "INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint,source_commit,finished) VALUES($1,$2,'test-film','build','succeeded',$3,$4,$5,$6,now())",
          [
            id,
            repo.id,
            historical ? { version: commit } : {},
            {
              runtimeFingerprint: runtime.fingerprint,
              previewVersion: PREVIEW_VERSION,
              artifacts: [
                { name: "index.html", path: relative + "/index.html" },
              ],
            },
            fingerprint,
            commit,
          ],
        );
        return id;
      };
      const beforePreview = await seedPreview(
        beforeBuilt,
        before,
        beforeFingerprint,
        true,
      );
      const afterPreview = await seedPreview(
        afterBuilt,
        after,
        afterFingerprint,
      );
      const connection = await actions.call("connections_save", {
        name: "Fixture provider",
        tool: "codex",
        mode: "api",
        baseUrl: "https://fixture.example/v1",
        apiKey: "fixture-only-not-real",
        model: "fixture-model",
      });
      const chat = await actions.call("works_chat_create", {
        id: work.id,
        connection: connection.id,
        title: "V5 审片",
      });
      const turn = await actions.call("works_chat_send", {
        id: work.id,
        chat: chat.id,
        prompt: "将背景改为深蓝，保持运动和声音。",
        context: {
          time: 0.5,
          previewTask: beforePreview,
          sourceCommit: before,
        },
      });
      // Explicit stored outcome fixture; these UI tests do not call a paid model or claim AI actually ran.
      await db.pool.query(
        "UPDATE tasks SET state='succeeded',base_commit=$2,source_commit=$3,result=$4,finished=now() WHERE id=$1",
        [
          turn.id,
          before,
          after,
          {
            commit: after,
            previewTask: afterPreview,
            validation: [
              { check: "preview-build", status: "passed", durationMs: 5 },
            ],
            buildMetrics: afterBuilt.buildMetrics,
          },
        ],
      );
      await db.event(turn.id, "message", {
        id: "fixture-result",
        text: "背景已修改，可以对比本轮前后的画面。",
      });
      await repos.revisions.refresh(repo.id, work.project);
      await app.listen({ host: "127.0.0.1", port });
      browser = await launchBrowser();
      page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.goto(origin);
      await page
        .getByLabel("登录密码", { exact: true })
        .fill("v5-browser-fixture-password");
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page.goto(origin + "/#/work/" + work.id);
      await expect(page.locator(".preview-pane iframe")).toBeVisible();
      const frame = await page
        .locator(".preview-pane iframe")
        .elementHandle()
        .then((el) => el.contentFrame());
      await frame.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
      await frame.evaluate(() => window.__FRAME_STUDIO__.seek(0.75));
      await expect(
        page.getByRole("button", { name: "引用当前时间", exact: true }),
      ).toBeEnabled();
      await page
        .getByRole("button", { name: "引用当前时间", exact: true })
        .click();
      await expect(
        page.locator(".chat-composer .reference-version"),
      ).toContainText(after.slice(0, 7));
      const composer = page.locator(".chat-composer textarea");
      await composer.fill("保留这个带版本的草稿");
      await page
        .getByRole("button", { name: "素材", exact: true })
        .first()
        .click();
      await page.locator('[data-tool-key="ai"]').click();
      await expect(composer).toHaveValue("保留这个带版本的草稿");
      await expect(
        page.locator(".chat-composer .reference-version"),
      ).toContainText(after.slice(0, 7));
      await page.screenshot({
        path: path.join(report, "workspace-desktop.png"),
      });
      await composer.press("Control+Enter");
      await expect
        .poll(
          async () =>
            (
              await db.one(
                "SELECT count(*)::int AS n FROM tasks WHERE input->>'prompt'=$1",
                ["保留这个带版本的草稿"],
              )
            ).n,
        )
        .toBe(1);
      const sent = await db.one(
        "SELECT * FROM tasks WHERE input->>'prompt'=$1",
        ["保留这个带版本的草稿"],
      );
      assert.equal(sent.review_reference.sourceCommit, after);
      assert.equal(sent.input.context.previewTask, afterPreview);
      assert.equal(sent.execution.model, "fixture-model");
      await tasks.cancel(sent.id);
      await page
        .getByRole("button", { name: "查看本轮预览与修改", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "本轮修改与审片" });
      await expect(dialog.locator(".result-files")).toHaveCount(1);
      await expect(
        dialog.getByRole("button", { name: "从引用位置播放", exact: true }),
      ).toBeEnabled();
      const color = async () => {
        const target = await dialog
          .locator("iframe")
          .elementHandle()
          .then((el) => el.contentFrame());
        await target.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
        return target.evaluate(() => {
          window.__FRAME_STUDIO__.frame(0.5, false);
          const canvas = document.querySelector("canvas");
          return [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data];
        });
      };
      const afterColor = await color();
      await dialog
        .getByRole("button", { name: new RegExp("^修改前 ") })
        .click();
      await expect(dialog.locator("iframe")).toHaveCount(1);
      await expect(
        dialog.getByRole("button", { name: "从引用位置播放", exact: true }),
      ).toBeEnabled();
      const beforeColor = await color();
      assert.notDeepEqual(
        beforeColor,
        afterColor,
        "the comparison must load actual different source versions",
      );
      assert.equal(
        await repos.git(branch.root, ["rev-parse", "HEAD"]),
        after,
        "historical review must not restore source",
      );
      await page.screenshot({
        path: path.join(report, "result-before-after.png"),
      });
      fs.writeFileSync(
        path.join(dir, "later-edit.txt"),
        "Preserve subsequent work\n",
      );
      const later = await repos.checkpoint(
        repo.id,
        work.project,
        "Subsequent unrelated work",
      );
      await dialog
        .getByRole("button", { name: "刷新状态", exact: true })
        .click();
      await expect(dialog).toContainText("当前作品版本 " + later.slice(0, 7));
      await expect(
        dialog.getByRole("button", { name: "撤销本轮修改", exact: true }),
      ).toBeEnabled();
      await dialog
        .getByRole("button", { name: "撤销本轮修改", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (
              await db.one("SELECT state FROM work_undos WHERE task=$1", [
                turn.id,
              ])
            )?.state,
        )
        .toBe("succeeded");
      assert.equal(
        fs.readFileSync(path.join(dir, "scene.ts"), "utf8"),
        beforeSource,
      );
      assert.equal(
        fs.readFileSync(path.join(dir, "later-edit.txt"), "utf8"),
        "Preserve subsequent work\n",
      );
      assert.equal(await repos.git(branch.root, ["rev-parse", "HEAD^"]), later);
      await expect(dialog).toContainText("本次修改已撤销");
      await page.setViewportSize({ width: 430, height: 900 });
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: path.join(report, "result-mobile.png") });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      assert.deepEqual(errors, []);
      fs.writeFileSync(
        path.join(report, "evidence.json"),
        JSON.stringify(
          {
            beforeColor,
            afterColor,
            before,
            after,
            laterPreserved: true,
            duplicateAudioPlayers: false,
            type: "deterministic-browser-fixture",
            buildMetrics: afterBuilt.buildMetrics,
          },
          null,
          2,
        ),
      );
    } finally {
      if (page && errors.length)
        fs.writeFileSync(
          path.join(report, "errors.json"),
          JSON.stringify(errors),
        );
      await browser?.close();
      await app.close();
      f.close();
      fs.rmSync(data, { recursive: true, force: true });
      if (oldPreview === undefined) delete process.env.FRAME_WORK_PREVIEW;
      else process.env.FRAME_WORK_PREVIEW = oldPreview;
    }
  },
);

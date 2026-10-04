import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { executeProject } from "../../scripts/project-execution.mjs";
import { runtimeIdentity } from "../../scripts/runtime-identity.mjs";
import { PREVIEW_VERSION } from "../../server/preview-version.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { expect } from "@playwright/test";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { fixture, repo as root } from "../mcp/helpers.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL;
test(
  "audio GUI uses real API revisions: migration, multitrack edits, drag, undo, processors, conflict, responsive layout",
  { skip: !url, timeout: 150000 },
  async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-composition-"));
    const f = fixture({ browser: true }),
      db = await database(url, "composition-fixture-password");
    await db.pool.query(
      "TRUNCATE repos,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const port = Number(process.env.FRAME_TEST_PORT || 55749),
      origin = "http://127.0.0.1:" + port;
    const { app, actions, repos } = await createApp({
      db,
      data,
      masterKey: "31".repeat(32),
      origin,
      scheduler: false,
    });
    let browser, page;
    const errors = [];
    try {
      const repo = await actions.call("repositories_add", {
        name: "Composition acceptance",
      });
      fs.cpSync(
        f.file(""),
        path.join(data, "repos", repo.id, "projects/test-film"),
        { recursive: true },
      );
      await actions.works.discover(repo.id);
      const work = (await actions.call("works_page", { repo: repo.id }))
        .items[0];
      const initial = await actions.call("works_audio", { id: work.id });
      assert.equal(initial.declared, false);
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
      const taskId = randomUUID(),
        relative = "projects/test-film/exports/preview";
      fs.cpSync(built.output, path.join(data, "runs", taskId, relative), {
        recursive: true,
      });
      const { dir } = await repos.project(repo.id, work.project);
      const commit = await repos.checkpoint(
        repo.id,
        work.project,
        "Neutral fixture",
      );
      const runtime = await runtimeIdentity();
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint,source_commit,finished) VALUES($1,$2,'test-film','build','succeeded',$3,$4,$5,$6,now())",
        [
          taskId,
          repo.id,
          {},
          {
            runtimeFingerprint: runtime.fingerprint,
            previewVersion: PREVIEW_VERSION,
            artifacts: [{ name: "index.html", path: relative + "/index.html" }],
          },
          await treeHash(dir),
          commit,
        ],
      );
      await repos.revisions.refresh(repo.id, work.project);
      await app.listen({ host: "127.0.0.1", port });
      browser = await launchBrowser();
      page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
      page.on("pageerror", (e) => errors.push(e.message));
      page.setDefaultTimeout(15000);
      await page.goto(origin);
      await page
        .getByLabel("登录密码", { exact: true })
        .fill("composition-fixture-password");
      await page.getByRole("button", { name: "进入工作台" }).click();
      await page.goto(origin + "/#/work/" + work.id);
      await page.getByRole("button", { name: "音频", exact: true }).click();
      const editor = page.getByRole("region", { name: "多轨音频编辑器" });
      await expect(editor).toBeVisible();
      await editor.getByRole("button", { name: "音轨", exact: true }).click();
      await editor.getByLabel("名称", { exact: true }).fill("Music Bus");
      await editor
        .getByRole("button", { name: "保存混音", exact: true })
        .click();
      await expect(editor).toContainText("已保存");
      let saved = await actions.call("works_audio", { id: work.id });
      assert.equal(saved.document.tracks.at(-1).name, "Music Bus");
      // Real drag/trim with local undo; the save commits a single audio revision.
      await editor.getByRole("button", { name: "片段", exact: true }).click();
      const clip = editor.getByRole("button", { name: /音频片段/ }).last();
      await expect(clip).toBeVisible();
      await clip.click();
      await editor.getByLabel("时长秒", { exact: true }).fill("1");
      const box = await clip.boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width * 0.75,
        box.y + box.height * 0.5,
        { steps: 5 },
      );
      await page.mouse.up();
      await expect(
        editor.getByLabel("开始秒", { exact: true }),
      ).not.toHaveValue("0");
      await editor.getByTitle("撤销", { exact: true }).click();
      await expect(editor.getByLabel("开始秒", { exact: true })).toHaveValue(
        "0",
      );
      await expect(editor.getByLabel("时长秒", { exact: true })).toHaveValue(
        "1",
      );
      // The duration blur and the subsequent drag are two distinct undo steps.
      await editor.getByTitle("撤销", { exact: true }).click();
      await expect(editor.getByLabel("时长秒", { exact: true })).toHaveValue(
        "2",
      );
      await editor.getByTitle("重做", { exact: true }).click();
      await expect(editor.getByLabel("时长秒", { exact: true })).toHaveValue(
        "1",
      );
      await expect(editor.getByLabel("开始秒", { exact: true })).toHaveValue(
        "0",
      );
      await editor
        .getByRole("button", { name: "保存混音", exact: true })
        .click();
      await expect(editor).toContainText("已保存");
      await editor.getByRole("button", { name: "主输出", exact: true }).click();
      await editor.getByLabel("选择音频处理器").selectOption("limiter");
      await editor.getByRole("button", { name: "处理器", exact: true }).click();
      await editor
        .getByRole("button", { name: "保存混音", exact: true })
        .click();
      await expect(editor).toContainText("已保存");
      saved = await actions.call("works_audio", { id: work.id });
      assert.equal(saved.document.master.processors[0].type, "limiter");
      const changed = structuredClone(saved.document);
      changed.master.gain = 0.5;
      await actions.call("works_audio_edit", {
        id: work.id,
        expectedSha256: saved.sha256,
        operations: [{ op: "replace", document: changed }],
      });
      await editor.getByLabel("作品增益", { exact: true }).fill("0.8");
      await editor
        .getByRole("button", { name: "保存混音", exact: true })
        .click();
      await expect(editor).toContainText(/changed|冲突/i);
      assert.equal(
        (await actions.call("works_audio", { id: work.id })).document.master
          .gain,
        0.5,
      );
      await editor
        .getByRole("button", { name: "放弃未保存修改", exact: true })
        .click();
      await expect(editor.getByLabel("作品增益", { exact: true })).toHaveValue(
        "0.5",
      );
      await editor.getByLabel("作品增益", { exact: true }).fill("0.6");
      await editor.getByLabel("作品增益", { exact: true }).press("Tab");
      await expect
        .poll(() =>
          page.evaluate(
            (id) => !!sessionStorage.getItem("frame-audio-draft:" + id),
            work.id,
          ),
        )
        .toBe(true);
      page.once("dialog", (dialog) => dialog.accept());
      await page.reload();
      // The workbench restores the open audio panel itself.
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel("作品增益", { exact: true })).toHaveValue(
        "0.6",
      );
      await expect(editor).toContainText("未保存");
      await editor
        .getByRole("button", { name: "保存混音", exact: true })
        .click();
      await expect(editor).toContainText("已保存");
      fs.mkdirSync(path.join(root, ".cache/v7"), { recursive: true });
      await page.screenshot({
        path: path.join(root, ".cache/v7/audio-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(editor).toBeVisible();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: path.join(root, ".cache/v7/audio-mobile.png"),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await app.close();
      f.close();
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);

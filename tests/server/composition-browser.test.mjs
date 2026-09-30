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
  "composition GUI uses real API revisions: add, edit, drag trim, undo, conflict, responsive layout",
  { skip: !url, timeout: 150000 },
  async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-composition-"));
    const f = fixture({ browser: true, renderer: "composition" }),
      db = await database(url, "composition-fixture-password");
    await db.pool.query(
      "TRUNCATE repos,connections,github_accounts,auth_flows RESTART IDENTITY CASCADE",
    );
    const port = Number(process.env.FRAME_TEST_PORT || 55739),
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
      const initial = await actions.call("works_composition", { id: work.id });
      assert.equal(initial.document.clips.length, 0);
      const handoff = await actions.call("works_context", { id: work.id });
      assert.equal(handoff.authority.visual.mode, "document");
      assert.equal(handoff.composition.clips, 0);
      assert.equal(handoff.composition.document, undefined);
      assert.equal((await actions.call("works_context", { id: work.id, detail: true })).composition.document.clips.length, 0);
      const preview = await actions.call("works_composition_edit", {
        id: work.id, expectedSha256: initial.sha256, dryRun: true,
        operations: [{ op: "add", clip: { id: "proposed", source: { kind: "color", color: "#112233" }, start: 0, duration: 1 } }],
      });
      assert.equal(preview.dryRun, true);
      assert.equal(preview.document.clips.length, 1);
      assert.equal((await actions.call("works_composition", { id: work.id })).sha256, initial.sha256);
      assert.equal(
        (await actions.call("works_context", { id: work.id })).composition
          .sha256,
        initial.sha256,
      );
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
      await page.getByRole("button", { name: "合成", exact: true }).click();
      const editor = page.getByRole("region", { name: "混合合成编辑器" });
      await expect(editor).toBeVisible();
      await editor.getByLabel("新增图层类型").selectOption("color");
      await editor.getByRole("button", { name: "添加", exact: true }).click();
      const clip = editor.getByRole("button", {
        name: "选择片段 色块",
        exact: true,
      });
      await expect(clip).toBeVisible();
      await editor.getByLabel("名称", { exact: true }).fill("可编辑片段");
      await editor.getByLabel("持续秒数", { exact: true }).fill("1.5");
      await editor
        .getByRole("button", { name: "保存属性", exact: true })
        .click();
      await expect(
        editor.getByRole("button", {
          name: "选择片段 可编辑片段",
          exact: true,
        }),
      ).toBeVisible();
      let saved = await actions.call("works_composition", { id: work.id });
      assert.equal(saved.document.clips[0].duration, 1.5);
      // Real pointer movement persists one compare-and-swap operation.
      await editor
        .getByRole("button", { name: "选择片段 可编辑片段", exact: true })
        .scrollIntoViewIfNeeded();
      const box = await editor
        .getByRole("button", { name: "选择片段 可编辑片段", exact: true })
        .boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + box.width * 0.2,
        box.y + box.height / 2,
        { steps: 5 },
      );
      await page.mouse.up();
      await expect
        .poll(
          async () =>
            (await actions.call("works_composition", { id: work.id })).document
              .clips[0].start,
        )
        .toBeGreaterThan(0)
        .catch(async (e) => {
          console.log("EDITOR", await editor.innerText());
          throw e;
        });
      await editor
        .getByRole("button", { name: "撤销合成修改", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await actions.call("works_composition", { id: work.id })).document
              .clips[0].start,
        )
        .toBe(0);
      // Trim with the actual end handle, then undo back to the original source phase.
      await editor
        .getByLabel("片段出点", { exact: true })
        .scrollIntoViewIfNeeded();
      const handle = await editor
        .getByLabel("片段出点", { exact: true })
        .boundingBox();
      await page.mouse.move(
        handle.x + handle.width / 2,
        handle.y + handle.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(handle.x - 60, handle.y + handle.height / 2, {
        steps: 5,
      });
      await page.mouse.up();
      await expect
        .poll(
          async () =>
            (await actions.call("works_composition", { id: work.id })).document
              .clips[0].duration,
        )
        .toBeLessThan(1.5);
      await editor
        .getByRole("button", { name: "撤销合成修改", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await actions.call("works_composition", { id: work.id })).document
              .clips[0].duration,
        )
        .toBe(1.5);
      // Clearing a previously saved loop must reach the authoritative document.
      await editor.getByLabel("循环素材秒数", { exact: true }).fill("0.5");
      await editor
        .getByRole("button", { name: "保存属性", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await actions.call("works_composition", { id: work.id })).document
              .clips[0].loop,
        )
        .toBe(0.5);
      await editor.getByLabel("循环素材秒数", { exact: true }).fill("0");
      await editor
        .getByRole("button", { name: "保存属性", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await actions.call("works_composition", { id: work.id })).document
              .clips[0].loop,
        )
        .toBeUndefined();
      saved = await actions.call("works_composition", { id: work.id });
      await actions.call("works_composition_edit", {
        id: work.id,
        expectedSha256: saved.sha256,
        operations: [
          {
            op: "update",
            id: saved.document.clips[0].id,
            patch: { name: "AI 修改" },
          },
        ],
      });
      await editor.getByLabel("名称", { exact: true }).fill("过期修改");
      await editor
        .getByRole("button", { name: "保存属性", exact: true })
        .click();
      await expect(editor).toContainText(/版本冲突|changed|冲突|stale/i);
      assert.equal(
        (await actions.call("works_composition", { id: work.id })).document
          .clips[0].name,
        "AI 修改",
      );
      await editor.getByRole("button", { name: "刷新", exact: true }).click();
      await expect(
        editor.getByRole("button", { name: "选择片段 AI 修改", exact: true }),
      ).toBeVisible();
      fs.mkdirSync(path.join(root, ".cache/v6"), { recursive: true });
      await page.screenshot({
        path: path.join(root, ".cache/v6/composition-desktop.png"),
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
        path: path.join(root, ".cache/v6/composition-mobile.png"),
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

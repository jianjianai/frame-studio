import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { command } from "../../server/process.mjs";

/** Exercise the built workbench over its real authenticated WebSocket API and Git worktree. */
export async function sourceControlFlow({ page, call, work, data, reportDir }) {
  fs.mkdirSync(reportDir, { recursive: true });
  const root = path.join(data, "works", work.id),
    prefix = `projects/${work.project}/`;
  const file = (name) => path.join(root, prefix, name);
  const git = (...args) => command("git", args, { cwd: root });
  const status = () => call("works_scm_status", { id: work.id });
  const rail = page.locator(".creation-toolbar");
  const panel = page.locator(".scm-panel");
  const refresh = async () => {
    await panel
      .getByRole("button", { name: "刷新源代码管理", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "刷新源代码管理", exact: true }),
    ).toBeEnabled();
  };
  const original = fs.readFileSync(file("scene.ts"), "utf8");
  await call("works_checkpoint", { id: work.id, name: "源代码管理验收基线" });
  fs.appendFileSync(file("scene.ts"), "\n// SCM first staged edit\n");
  fs.mkdirSync(file("notes"), { recursive: true });
  fs.writeFileSync(
    file("notes/审片 记录.md"),
    "# 未暂存审片记录\n  保留前导空格\n",
  );
  fs.writeFileSync(file("public/scm-fixture.bin"), Buffer.from([0, 1, 255, 4]));
  try {
    await assert.rejects(
      call("works_scm_change", {
        id: work.id,
        action: "stage",
        paths: [prefix + "scene.ts"],
      }),
      /expectedRevision|Invalid/,
    );
    await page.getByRole("button", { name: "作品菜单", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "源代码管理", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "源代码管理", exact: true }),
    ).toBeVisible();
    const message = panel.getByLabel("提交说明", { exact: true });
    await message.fill("精确提交开场修改");
    await page
      .getByRole("button", { name: "关闭源代码管理", exact: true })
      .click();
    await page.keyboard.press("Control+Shift+G");
    await expect(message).toHaveValue("精确提交开场修改");
    await panel
      .getByRole("button", { name: "查看更改：scene.ts", exact: true })
      .click();
    await expect(panel.locator(".scm-diff-table")).toContainText(
      "SCM first staged edit",
    );
    await panel
      .getByRole("button", { name: "暂存 scene.ts", exact: true })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "查看已暂存更改：scene.ts",
        exact: true,
      }),
    ).toBeVisible();
    fs.appendFileSync(file("scene.ts"), "// SCM later working edit\n");
    await refresh();
    await expect(
      panel.getByRole("button", { name: "查看更改：scene.ts", exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "查看更改：scene.ts", exact: true })
      .click();
    await expect(panel.locator(".scm-diff-table")).toContainText(
      "SCM later working edit",
    );
    await page.screenshot({
      path: path.join(reportDir, "scm-working-desktop.png"),
    });
    await message.press("Control+Enter");
    await expect(
      panel.getByRole("tab", { name: "历史", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      panel.getByRole("button", {
        name: "查看提交 精确提交开场修改",
        exact: true,
      }),
    ).toBeVisible();
    assert.match(
      await git("show", "HEAD:" + prefix + "scene.ts"),
      /SCM first staged edit/,
    );
    assert.doesNotMatch(
      await git("show", "HEAD:" + prefix + "scene.ts"),
      /SCM later working edit/,
    );
    assert.equal(
      await git("ls-tree", "HEAD", "--", prefix + "notes/审片 记录.md"),
      "",
    );
    await panel
      .getByRole("button", { name: "查看提交中的文件：scene.ts", exact: true })
      .click();
    await expect(panel.locator(".scm-diff-table")).toContainText(
      "SCM first staged edit",
    );
    await expect(panel.locator(".scm-diff-table")).not.toContainText(
      "SCM later working edit",
    );
    await panel
      .getByRole("button", { name: "展开文件差异", exact: true })
      .click();
    const expanded = page.getByRole("dialog", {
      name: "文件差异审阅",
      exact: true,
    });
    await expect(expanded).toBeVisible();
    if (
      await expanded
        .getByRole("button", { name: "切换为并排差异", exact: true })
        .count()
    )
      await expanded
        .getByRole("button", { name: "切换为并排差异", exact: true })
        .click();
    await expect(
      expanded.getByRole("table", { name: "并排文件差异", exact: true }),
    ).toBeVisible();
    await expanded
      .getByRole("button", { name: "差异自动换行", exact: true })
      .click();
    await page.screenshot({
      path: path.join(reportDir, "scm-diff-expanded.png"),
    });
    await expanded
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .press("Escape");
    await expect(expanded).toBeHidden();
    await expect(panel).toBeVisible();
    await page.screenshot({
      path: path.join(reportDir, "scm-history-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("dialog", { name: "源代码管理", exact: true }),
    ).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Source control must not overflow the mobile viewport",
    );
    await page.screenshot({
      path: path.join(reportDir, "scm-history-mobile.png"),
    });
    await page
      .getByRole("button", { name: "关闭源代码管理", exact: true })
      .click();
    await expect(
      rail.getByRole("button", { name: "作品工具菜单", exact: true }),
    ).toBeFocused();
    await page.setViewportSize({ width: 1500, height: 1000 });
    await rail.getByRole("button", { name: "源代码管理", exact: true }).click();
    await panel.getByRole("tab", { name: "变更", exact: false }).click();
    await expect(message).toHaveValue("");
    await panel
      .getByRole("textbox", { name: "筛选变更文件", exact: true })
      .fill("scm-fixture");
    await expect(
      panel.getByRole("button", { name: "查看更改：scene.ts", exact: true }),
    ).toHaveCount(0);
    await panel
      .getByRole("button", {
        name: "查看更改：public/scm-fixture.bin",
        exact: true,
      })
      .click();
    await expect(panel.locator(".scm-binary")).toContainText("二进制文件");
    await panel
      .getByRole("button", { name: "清除文件筛选", exact: true })
      .click();
    const discardButton = panel.getByRole("button", {
      name: "撤销 notes/审片 记录.md 的未暂存更改",
      exact: true,
    });
    await discardButton.click();
    const confirm = page.getByRole("dialog", {
      name: "撤销未暂存更改",
      exact: true,
    });
    await expect(confirm).toContainText("永久删除");
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    assert(fs.existsSync(file("notes/审片 记录.md")));
    await discardButton.click();
    fs.appendFileSync(file("notes/审片 记录.md"), "并行修改，不可删除\n");
    await confirm
      .getByRole("button", { name: "确认撤销此文件", exact: true })
      .click();
    await expect(confirm).toContainText("已变化");
    assert(
      fs.existsSync(file("notes/审片 记录.md")),
      "A stale confirmation must not delete a newly changed file",
    );
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await refresh();
    await discardButton.click();
    await confirm
      .getByRole("button", { name: "确认撤销此文件", exact: true })
      .click();
    await expect(confirm).toBeHidden();
    assert(!fs.existsSync(file("notes/审片 记录.md")));
    await panel
      .getByRole("button", { name: "暂存列表中的所有更改", exact: true })
      .click();
    await expect.poll(async () => (await status()).staged).toBe(2);
    await message.fill("保存剩余更改");
    await panel
      .getByRole("button", { name: "提交已暂存 (2)", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "命名版本", exact: true }),
    ).toBeEnabled();
    await panel.getByRole("button", { name: "命名版本", exact: true }).click();
    const naming = page.getByRole("dialog", {
      name: "创建命名版本",
      exact: true,
    });
    await naming.getByLabel("版本名称", { exact: true }).fill("审片确认");
    await naming
      .getByRole("button", { name: "创建命名版本", exact: true })
      .click();
    await expect(naming).toBeHidden();
    await expect(
      panel.getByRole("button", { name: "查看提交 审片确认", exact: true }),
    ).toBeVisible();
    assert.equal((await status()).total, 0);
    const currentHead = (await status()).head;
    await panel
      .getByRole("button", { name: "查看提交 源代码管理验收基线", exact: true })
      .click();
    await expect(
      panel.getByText("以下比较此提交", { exact: false }),
    ).toBeVisible();
    assert.equal(
      (await status()).head,
      currentHead,
      "Viewing history must not restore it",
    );
    assert(fs.readFileSync(file("scene.ts"), "utf8").startsWith(original));
    const manifest = fs.readFileSync(file("project.ts"), "utf8");
    fs.unlinkSync(file("project.ts"));
    await call("works_scm_change", {
      id: work.id,
      action: "stage",
      paths: [prefix + "project.ts"],
      expectedRevision: (await status()).revision,
    });
    await call("works_scm_change", {
      id: work.id,
      action: "commit",
      message: "测试恢复被删除的作品入口",
      expectedRevision: (await status()).revision,
    });
    await expect(
      panel.getByRole("button", {
        name: "查看提交 测试恢复被删除的作品入口",
        exact: true,
      }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "恢复版本 审片确认", exact: true })
      .click();
    const restoring = page.getByRole("dialog", {
      name: "恢复作品版本",
      exact: true,
    });
    await restoring
      .getByRole("button", { name: "保存当前内容并恢复", exact: true })
      .click();
    await expect(restoring).toBeHidden();
    assert.equal(fs.readFileSync(file("project.ts"), "utf8"), manifest);
    assert.notEqual(
      (await status()).head,
      currentHead,
      "Restore appends history rather than resetting the branch",
    );
    assert(
      (await call("works_versions", { id: work.id })).some(
        (version) => version.name === "测试恢复被删除的作品入口",
      ),
    );

    await page
      .getByRole("button", { name: "关闭源代码管理", exact: true })
      .click();
    await expect(
      rail.getByRole("button", { name: "源代码管理", exact: true }),
    ).toBeFocused();
  } catch (error) {
    await page
      .screenshot({
        path: path.join(reportDir, "scm-flow-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw error;
  }
}

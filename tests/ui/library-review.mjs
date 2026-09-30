import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { expect } from "@playwright/test";
import { launchBrowser } from "../../scripts/browser.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const output = path.join(root, ".cache/library-review");
fs.mkdirSync(output, { recursive: true });
const port = Number(process.env.FRAME_TEST_PORT || 55893);
const repo = { id: randomUUID(), name: "设计与科技", work_count: 27, url: "" };
const now = Date.now();
const works = Array.from({ length: 27 }, (_, index) => ({
  id: randomUUID(),
  repo: repo.id,
  project: "film-" + index,
  title:
    index === 0
      ? "从一句话到一部电影"
      : index === 1
        ? "光与声音的实验"
        : "创作练习 " + String(index).padStart(2, "0"),
  description:
    index === 0
      ? "用镜头、声音与节奏，讲述 AI 如何让想法成为作品。"
      : "持续创作，记录新的灵感。",
  status: ["draft", "review", "finished"][index % 3],
  storage_name: repo.name,
  created: new Date(now - index * 86400000).toISOString(),
  updated: new Date(now - index * 3600000).toISOString(),
  modified: new Date(now - index * 3600000).toISOString(),
  opened: index < 3 ? new Date(now - index * 120000).toISOString() : null,
  deleted: false,
  duration: 62 + index * 3,
  composition: { width: 1920, height: 1080 },
  activity: index === 0 ? { kind: "agent", state: "running" } : null,
  cover: index === 1 ? "/api/broken-cover" : null,
}));
works.push({
  ...works[2],
  id: randomUUID(),
  title: "回收站里的旧想法",
  deleted: true,
});
const state = { fail: false, failSave: false, calls: [] };
const errors = [],
  results = [];
let browser, server;
const action = (name, args) => {
  state.calls.push({ name, args });
  if (name === "agent_notifications")
    return { items: [], unread: 0, next: null };
  if (name === "github_accounts") return [];
  if (name === "repositories_page") return { items: [repo], total: 1 };
  if (name === "repositories_get") return repo;
  if (name === "works_page") {
    if (state.fail) throw Error("测试：连接暂时中断");
    let filtered = works.filter(
      (work) =>
        !!work.deleted === !!args.deleted &&
        (!args.repo || work.repo === args.repo) &&
        (!args.recent || work.opened) &&
        (!args.status || work.status === args.status) &&
        (!args.search || (work.title + work.description).includes(args.search)),
    );
    filtered.sort((a, b) =>
      args.sort === "title"
        ? a.title.localeCompare(b.title, "zh-CN")
        : String(
            b[
              args.sort === "created"
                ? "created"
                : args.sort === "opened"
                  ? "opened"
                  : "modified"
            ] || "",
          ).localeCompare(
            String(
              a[
                args.sort === "created"
                  ? "created"
                  : args.sort === "opened"
                    ? "opened"
                    : "modified"
              ] || "",
            ),
          ),
    );
    return {
      items: filtered.slice(
        args.offset || 0,
        (args.offset || 0) + (args.limit || 30),
      ),
      total: filtered.length,
    };
  }
  const work = works.find((work) => work.id === args.id);
  if (name === "works_update") {
    if (state.failSave) throw Error("测试：保存失败");
    Object.assign(work, args);
    return work;
  }
  if (name === "works_trash") {
    assert(!args.deleted || args.confirm === work.title);
    work.deleted = args.deleted;
    return work;
  }
  if (name === "works_duplicate") {
    const copy = { ...work, id: randomUUID(), title: args.title, opened: null };
    works.push(copy);
    return copy;
  }
  throw Error("Unexpected API: " + name);
};
try {
  server = await createServer({
    configFile: path.join(root, "studio/vite.config.mjs"),
    configLoader: "native",
    cacheDir: path.join(output, "vite"),
    server: { host: "127.0.0.1", port, strictPort: true },
    logLevel: "error",
  });
  await server.listen();
  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 940 },
  });
  await context.addInitScript(() => {
    window.open = () => null;
  });
  await context.route("**/api/**", (route) =>
    route.request().url().endsWith("/api/me")
      ? route.fulfill({ json: { admin: true, localMode: true } })
      : route.fulfill({ status: 404, body: "" }),
  );
  await context.routeWebSocket("**/api/ws", (socket) =>
    socket.onMessage((text) => {
      const value = JSON.parse(String(text));
      if (value.type === "unsubscribe") return;
      try {
        socket.send(
          JSON.stringify({
            type: value.type === "subscribe" ? "update" : "result",
            id: value.id,
            result: action(value.name, value.args || {}),
          }),
        );
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: value.type === "subscribe" ? "update" : "result",
            id: value.id,
            error: error.message,
          }),
        );
      }
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  const library = page.locator(".library-page"),
    cards = library.locator(".library-work");
  const check = async (name, callback) => {
    await callback();
    results.push(name);
    console.log("PASS", name);
  };
  await page.goto("http://127.0.0.1:" + port + "/#/library");
  await check("全部作品入口、真实分页参数、卡片与封面回退", async () => {
    await expect(cards).toHaveCount(24);
    await expect(
      library.getByRole("heading", { name: "作品库", exact: true }),
    ).toBeVisible();
    await expect(library.getByRole("status")).toContainText("共 27 部作品");
    await expect(cards.nth(1).locator("img")).toHaveCount(0);
    assert.equal(
      await cards.first().locator(".work-open").getAttribute("target"),
      "_blank",
    );
    await page.screenshot({
      path: path.join(output, "library-grid.png"),
      fullPage: false,
    });
    await library.getByRole("button", { name: "下一页" }).click();
    await expect(cards).toHaveCount(3);
    assert(
      state.calls.some(
        (call) => call.name === "works_page" && call.args.offset === 24,
      ),
    );
    await library.getByRole("button", { name: "上一页" }).click();
    await expect(cards).toHaveCount(24);
  });
  await check("列表切换保留、跨页排序和状态筛选", async () => {
    await library.getByRole("button", { name: "列表视图" }).click();
    await expect(library.locator(".work-list")).toBeVisible();
    await page.reload();
    await expect(library.locator(".work-list")).toBeVisible();
    await library.getByLabel("作品排序").selectOption("title");
    await expect
      .poll(
        () =>
          state.calls.filter((call) => call.name === "works_page").at(-1).args
            .sort,
      )
      .toBe("title");
    await library.getByLabel("制作状态筛选").selectOption("review");
    await expect(cards).toHaveCount(9);
    await expect(cards.first().locator(".library-work-status")).toContainText(
      "待审片",
    );
    await page.screenshot({
      path: path.join(output, "library-list.png"),
      fullPage: false,
    });
    await library
      .getByRole("button", { name: "清除筛选", exact: true })
      .click();
  });
  await check(
    "菜单键盘、点击外部关闭、失败保留输入、作品信息保存",
    async () => {
      const menuButton = cards.first().getByRole("button", { name: /操作$/ });
      await menuButton.click();
      await expect(library.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(library.getByRole("menu")).toHaveCount(0);
      await expect(menuButton).toBeFocused();
      await menuButton.click();
      await library
        .getByRole("heading", { name: "作品库", exact: true })
        .click();
      await expect(library.getByRole("menu")).toHaveCount(0);
      await menuButton.click();
      await library.getByRole("menuitem", { name: "编辑作品信息" }).click();
      const dialog = page.getByRole("dialog", {
        name: "作品信息",
        exact: true,
      });
      await dialog.getByLabel("作品名称").fill("已保存的新作品名");
      state.failSave = true;
      await dialog.getByRole("button", { name: "保存作品信息" }).click();
      await expect(dialog.getByLabel("作品名称")).toHaveValue(
        "已保存的新作品名",
      );
      await expect(dialog.getByRole("alert").first()).toContainText("保存失败");
      state.failSave = false;
      await dialog
        .getByLabel("制作状态", { exact: true })
        .selectOption("finished");
      await dialog.getByRole("button", { name: "保存作品信息" }).click();
      await expect(dialog).toHaveCount(0);
      await library
        .getByLabel("搜索作品", { exact: true })
        .fill("已保存的新作品名");
      await expect(cards).toHaveCount(1);
      await expect(library).toContainText("已保存的新作品名");
      await page.getByRole("button", { name: "关闭通知" }).click();
    },
  );
  await check("创建副本与浏览器拦截新窗口后的打开入口", async () => {
    await cards.first().getByRole("button", { name: /操作$/ }).click();
    await library.getByRole("menuitem", { name: "创建副本" }).click();
    const dialog = page.getByRole("dialog", {
      name: "创建作品副本",
      exact: true,
    });
    await dialog.getByLabel("副本名称").fill("创作副本");
    await dialog.getByRole("button", { name: "创建并打开副本" }).click();
    await expect(dialog.getByRole("link", { name: "打开副本" })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭弹窗" }).click();
  });
  await check("移入回收站精确确认、直接恢复、最近范围独立", async () => {
    await library
      .getByLabel("搜索作品", { exact: true })
      .fill("已保存的新作品名");
    await expect(cards).toHaveCount(1);
    await cards.first().getByRole("button", { name: /操作$/ }).click();
    await library.getByRole("menuitem", { name: "移入回收站" }).click();
    const dialog = page.getByRole("dialog", {
      name: "移入回收站",
      exact: true,
    });
    await expect(
      dialog.getByRole("button", { name: "移入回收站", exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel("输入作品名称确认").fill("已保存的新作品名");
    await dialog
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await expect(cards).toHaveCount(0);
    await library.getByRole("button", { name: "回收站", exact: true }).click();
    await expect(cards).toHaveCount(2);
    await expect(library.locator(".work-open[href]")).toHaveCount(0);
    await cards
      .filter({ hasText: "已保存的新作品名" })
      .getByRole("button", { name: "恢复作品" })
      .click();
    await expect(cards).toHaveCount(1);
    await library
      .getByRole("button", { name: "最近打开", exact: true })
      .click();
    await expect(cards).toHaveCount(3);
  });
  await check("搜索空状态、错误与重试、新建入口与仓库页", async () => {
    await library.getByLabel("搜索作品", { exact: true }).fill("不存在的作品");
    await expect(library.locator(".empty")).toContainText("没有符合");
    state.fail = true;
    await library.getByLabel("搜索作品", { exact: true }).fill("连接错误");
    await expect(library.getByRole("alert")).toContainText("连接暂时中断");
    await expect(library.locator(".empty")).toHaveCount(0);
    state.fail = false;
    await library.getByRole("button", { name: "重试加载作品" }).click();
    await expect(library.getByRole("alert")).toHaveCount(0);
    await library
      .getByRole("button", { name: "新建作品", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "新建作品", exact: true });
    await expect(dialog.getByLabel("所属仓库", { exact: true })).toHaveValue(
      repo.id,
    );
    await dialog.getByRole("button", { name: "关闭弹窗" }).click();
    await library.getByRole("link", { name: "管理作品仓库" }).click();
    await expect(library.locator(".repository-card")).toHaveCount(1);
    if (await page.getByRole("button", { name: "关闭通知" }).count())
      await page.getByRole("button", { name: "关闭通知" }).click();
    await page.screenshot({
      path: path.join(output, "repositories.png"),
      fullPage: false,
    });
    await library.locator(".repository-card").click();
    await expect(
      library.getByRole("heading", { name: repo.name, exact: true }),
    ).toBeVisible();
    await library.getByRole("button", { name: "回收站", exact: true }).click();
    await expect(cards).toHaveCount(1);
  });
  await check("窄屏卡片和列表布局无横向溢出", async () => {
    await page.goto("http://127.0.0.1:" + port + "/#/library");
    await library
      .getByRole("button", { name: "全部作品", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const label of ["列表视图", "卡片视图"]) {
      await library.getByRole("button", { name: label }).click();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Page must fit narrow viewport",
      );
    }
    if (await page.getByRole("button", { name: "关闭通知" }).count())
      await page.getByRole("button", { name: "关闭通知" }).click();
    await page.screenshot({
      path: path.join(output, "library-mobile.png"),
      fullPage: false,
    });
  });
  assert.deepEqual(errors, []);
  console.log("Library checks passed:", results.length);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        results,
        errors,
        api: "simulated",
        ui: "real",
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await server?.close();
}

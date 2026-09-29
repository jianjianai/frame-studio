import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
const base = process.env.FRAME_SMOKE_URL || "http://127.0.0.1:45842";
const password = process.env.FRAME_SMOKE_PASSWORD;
if (!password)
  throw new Error("Set FRAME_SMOKE_PASSWORD for the isolated test instance");
const login = await fetch(base + "/api/login", {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
assert.equal(login.status, 200, await login.clone().text());
const cookie = login.headers.get("set-cookie").split(";")[0];
const request = async (route, body) => {
  const r = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await r.json();
  assert.equal(r.status, 200, JSON.stringify(value));
  return value;
};
const api = (name, args = {}) => request("/api/action", { name, args });
const wait = async (id) => {
  for (let i = 0; i < 360; i++) {
    const { task } = await api("task_get", { id });
    if (!["queued", "running", "cancelling", "publishing"].includes(task.state)) {
      assert.equal(task.state, "succeeded", JSON.stringify(task));
      return task;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Task timeout");
};
const title = "作品平台验收-" + Date.now();
const work = await api("works_create", {
  title,
  duration: 2,
  category: "验收",
});
console.log("Created work", work.id);
assert.equal(fs.existsSync(`/data/repos/${work.repo}/package.json`), false);
const initial = await api("works_read", { id: work.id, path: "scene.ts" });
const version = await api("works_checkpoint", {
  id: work.id,
  name: "初始版本",
});
await api("works_write", {
  id: work.id,
  path: "scene.ts",
  expectedSha256: initial.sha256,
  content: initial.content + "\n// changed\n",
});
await api("works_restore", { id: work.id, version: version.id });
assert.equal(
  (await api("works_read", { id: work.id, path: "scene.ts" })).sha256,
  initial.sha256,
);
const svg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><!-- ${work.id} --><circle cx="40" cy="40" r="30" fill="#718c51"/></svg>`,
);
const upload = await api("upload_begin", {
  name: "验收参考.svg",
  bytes: svg.length,
  sha256: createHash("sha256").update(svg).digest("hex"),
  license: "原创测试图形",
  mime: "image/svg+xml",
});
await api("upload_chunk", {
  id: upload.id,
  offset: 0,
  base64: svg.toString("base64"),
});
const asset = await api("upload_finish", { id: upload.id });
assert(
  (await api("assets_list", { unused: true })).some((a) => a.id === asset.id),
);
await api("works_use_asset", { id: work.id, asset: asset.id });
assert(
  !(await api("assets_list", { unused: true })).some((a) => a.id === asset.id),
);
const speech = await api("works_speech", {
  id: work.id,
  engine: (await api("engines_list"))[0].id,
  text: "你好，这是作品管理平台。",
});
assert(Number(speech.asset.bytes) > 1000);
const refs = await api("works_assets", { id: work.id }),
  voice = refs
    .find((a) => a.id === speech.asset.id)
    .refs.find((r) => r.work === work.id);
const meta = await api("works_read", { id: work.id, path: "project.ts" });
const source = meta.content.replace(
  "load: () => import('./scene')",
  `audioTracks: [{id:'voice',name:'旁白',kind:'file',src:'films/${work.project}/${voice.path.slice(7)}'}], load: () => import('./scene')`,
);
assert.notEqual(source, meta.content, "scaffold has editable loader");
await api("works_write", {
  id: work.id,
  path: "project.ts",
  expectedSha256: meta.sha256,
  content: source,
});
const copy = await api("works_duplicate", { id: work.id, title: "作品副本" });
assert.equal(
  (await api("works_assets", { id: copy.id })).filter((a) => a.id === asset.id)
    .length,
  1,
);
await api("works_trash", { id: copy.id, deleted: true });
await api("works_trash", { id: copy.id, deleted: false });
const build = await wait(
  (await api("works_task", { id: work.id, kind: "build" })).id,
);
assert.equal(build.result.previewVersion, 3);
const preview = await request("/api/tasks/" + build.id + "/preview", {});
const browser = await chromium.launch({
  executablePath: process.env.FRAME_BROWSER || "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
  ],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.addCookies([
    { name: "frame_session", value: cookie.split("=")[1], url: base },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/#/works");
  await page
    .getByRole("button", { name: "打开 " + title, exact: true })
    .waitFor();
  await page.screenshot({
    path: "/evidence/works-library.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "打开 " + title, exact: true })
    .click();
  await page.getByRole("heading", { name: "一起创作" }).waitFor();
  const element = await page
      .locator("iframe.work-preview-frame")
      .elementHandle(),
    frame = await element.contentFrame();
  await frame.getByTestId("play-toggle").waitFor();
  assert.equal(
    await frame.locator(".sidebar,.player-heading,.inspector").count(),
    0,
  );
  assert.equal(await frame.evaluate(() => window.origin), "null");
  await frame.getByTestId("play-toggle").click();
  await page.waitForTimeout(1000);
  assert.equal(await frame.locator("[role=alert]").count(), 0);
  await frame.getByTestId("play-toggle").click();
  await page.screenshot({ path: "/evidence/works-editor.png", fullPage: true });
  await page.getByRole("button", { name: "作品资料", exact: true }).click();
  await page.getByLabel("作品简介").fill("从作品库直接开始创作");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "作品资料已保存" })
    .waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "一起创作" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/#/works");
  await page.getByRole("heading", { name: "作品库", exact: true }).waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "/evidence/works-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
const render = await api("works_task", {
  id: work.id,
  kind: "render",
  input: { width: 1280, start: 0, end: 2 },
});
for (let i = 0; i < 30; i++) {
  if ((await api("task_get", { id: render.id })).task.state === "running")
    break;
  await new Promise((r) => setTimeout(r, 500));
}
if (process.env.FRAME_SMOKE_RESTART) {
  execFileSync("docker", ["restart", process.env.FRAME_SMOKE_RESTART], {
    stdio: "pipe",
  });
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(base + "/healthz")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}
const rendered = await wait(render.id);
assert(rendered.result.artifacts.some((a) => a.name.endsWith(".mp4")));
const frameTask = await wait(
  (
    await api("works_task", {
      id: work.id,
      kind: "frame",
      input: { width: 320 },
    })
  ).id,
);
assert(frameTask.result.artifacts.some((a) => a.name.endsWith(".png")));
fs.writeFileSync(
  "/evidence/works-smoke.json",
  JSON.stringify(
    {
      work,
      build: build.id,
      preview: preview.url,
      render: rendered.id,
      frame: frameTask.id,
      speechBytes: speech.asset.bytes,
      version: version.id,
      copy: copy.id,
    },
    null,
    2,
  ),
);
console.log(
  "PASS: work lifecycle, versions, assets, Chinese speech, isolated player, mobile UI, browser closure and controller restart, video and frame export",
);

import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "@playwright/test";
const base = process.env.FRAME_SMOKE_URL;
if (!base || !process.env.FRAME_SMOKE_PASSWORD)
  throw new Error("Explicit smoke URL and password required");
const browser = await chromium.launch(
  process.env.FRAME_BROWSER
    ? { executablePath: process.env.FRAME_BROWSER }
    : {},
);
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("browser:", m.text());
  });
  await page.goto(base);
  await page
    .locator("input[type=password]")
    .fill(process.env.FRAME_SMOKE_PASSWORD);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page
    .getByRole("heading", { name: "每一个想法，都有自己的舞台。" })
    .waitFor({ timeout: 15000 });
  for (const name of [
    "素材库",
    "语音工作室",
    "AI 创作",
    "任务",
    "设置",
    "项目",
  ]) {
    await page.getByRole("button", { name, exact: true }).first().click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({
    path: ".cache/platform-desktop.png",
    fullPage: true,
  });
  const evidence = JSON.parse(
    fs.readFileSync(
      process.env.FRAME_SMOKE_OUTPUT || ".cache/platform-smoke.json",
      "utf8",
    ),
  );
  const preview = evidence.preview.url.replace(
    "index.html#",
    "index.html?debug#",
  );
  await page.evaluate((url) => {
    const iframe = document.createElement("iframe");
    iframe.id = "smoke-preview";
    iframe.sandbox = "allow-scripts allow-downloads";
    iframe.src = url;
    iframe.style = "width:1000px;height:700px";
    document.body.replaceChildren(iframe);
  }, preview);
  const frame = page.frameLocator("#smoke-preview");
  await frame.locator("canvas").first().waitFor({ timeout: 20000 });
  const contentFrame = await page
    .locator("#smoke-preview")
    .elementHandle()
    .then((e) => e.contentFrame());
  try {
    await contentFrame.waitForFunction(
      () => window.__FRAME_STUDIO__?.ready,
      undefined,
      { timeout: 20000 },
    );
  } catch (e) {
    console.log(
      await contentFrame.evaluate(() => ({
        text: document.body.innerText,
        api: window.__FRAME_STUDIO__?.getDiagnostics?.(),
      })),
    );
    console.log(failures);
    throw e;
  }
  const bounds = await frame
    .locator("canvas")
    .first()
    .evaluate((c) => ({ width: c.width, height: c.height }));
  assert.ok(bounds.width >= 640 && bounds.height >= 360);
  await page.screenshot({
    path: ".cache/platform-preview.png",
    fullPage: true,
  });
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ status: "passed", canvas: bounds }));
} finally {
  await browser.close();
}

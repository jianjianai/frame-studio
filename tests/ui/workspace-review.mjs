import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { fixture, repo as root } from "../mcp/helpers.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
import { mockApi } from "./review-fixture.mjs";
import { layoutChecks, responsiveChecks } from "./review-layout.mjs";
import { flowChecks, libraryChecks } from "./review-flows.mjs";
import { populateTimelineFixture, timelineChecks } from "./review-timeline.mjs";
import { persistenceChecks } from "./review-persistence.mjs";
const reportDir = path.join(root, ".cache/frontend-validation/workspace");
fs.mkdirSync(reportDir, { recursive: true });
const results = [],
  errors = [],
  h = { reportDir, results, errors };
let browser, ui, player, f;
const prior = Object.fromEntries(
  ["FRAME_WORK_PREVIEW", "FRAME_PROJECT", "VITE_FRAME_PREVIEW_AUDIO"].map(
    (k) => [k, process.env[k]],
  ),
);
try {
  f = fixture({ browser: true, renderer: "canvas" });
  populateTimelineFixture(f);
  const originalProject = fs.readFileSync(f.file("project.ts"), "utf8");
  process.env.FRAME_WORK_PREVIEW = "1";
  process.env.FRAME_PROJECT = "test-film";
  process.env.VITE_FRAME_PREVIEW_AUDIO = "0";
  const port = Number(process.env.FRAME_UI_TEST_PORT || 55473);
  player = await createServer({
    configFile: path.join(f.root, "vite.config.ts"),
    root: f.root,
    cacheDir: path.join(f.root, ".cache/vite"),
    // Production previews allow opaque sandbox origins; mirror that only on this isolated test server.
    server: { host: "127.0.0.1", port: port + 1, strictPort: true, cors: true },
    logLevel: "warn",
  });
  await player.listen();
  h.playerUrl = `http://127.0.0.1:${port + 1}/`;
  ui = await createServer({
    configFile: path.join(root, "studio/vite.config.mjs"),
    cacheDir: path.join(reportDir, "vite"),
    server: { host: "127.0.0.1", port, strictPort: true },
    logLevel: "warn",
  });
  await ui.listen();
  h.uiUrl = `http://127.0.0.1:${port}`;
  browser = await launchBrowser();
  h.context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  h.context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  h.state = await mockApi(h.context, h.playerUrl, h.uiUrl);
  h.page = await h.context.newPage();
  await h.page.goto(h.uiUrl);
  h.player = () => h.page.frameLocator('iframe[title="作品播放器"]');
  h.frame = () => h.page.frames().find((f) => f.url().startsWith(h.playerUrl));
  h.screenshot = async (n) =>
    h.page.screenshot({ path: path.join(reportDir, n + ".png") });
  h.check = async (name, fn) => {
    const at = Date.now();
    try {
      await fn();
      results.push({ name, status: "passed", ms: Date.now() - at });
      console.log("PASS", name);
    } catch (e) {
      results.push({ name, status: "failed", error: e.stack });
      await h.screenshot("failure-" + results.length).catch(() => {});
      throw e;
    }
  };
  h.more = async (name) => {
    await h.page.locator(".work-more > summary").click();
    await h.page
      .locator(".work-more-menu")
      .getByRole("button", { name, exact: true })
      .click();
  };
  h.closeModal = async () =>
    h.page
      .locator("dialog[open]")
      .last()
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();
  await layoutChecks(h);
  await timelineChecks(h);
  assert.equal(
    fs.readFileSync(f.file("project.ts"), "utf8"),
    originalProject,
    "Timeline gestures must not rewrite source code",
  );
  await flowChecks(h);
  await persistenceChecks(h);
  await responsiveChecks(h);
  await libraryChecks(h);
  assert.deepEqual([...errors, ...h.state.errors], []);
  console.log("ALL WORKSPACE CHECKS PASSED");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(reportDir, "results.json"),
    JSON.stringify(
      {
        results,
        errors: [...errors, ...(h.state?.errors || [])],
        scope: "Real UI/player/WebM; simulated API state",
        finished: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await ui?.close();
  await player?.close();
  f?.close();
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

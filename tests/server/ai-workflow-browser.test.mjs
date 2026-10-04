import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";
import { browserOptions } from "../../scripts/browser.mjs";
import { treeHash } from "../../server/project-files.mjs";
import { nativeWorkflowFixture } from "./ai-workflow-fixture.mjs";
import { until } from "./ai-test-fixture.mjs";

test("Real T3 WebUI on HTTP isolates same-remote works, freezes references, edits the canonical source and validates in place", {
  skip: !process.env.FRAME_TEST_DATABASE_URL, timeout: 480000,
}, async t => {
  const f = await nativeWorkflowFixture(t), [work, other] = f.works, options = browserOptions();
  const browser = await chromium.launch({ ...options, args: [...options.args,
    "--host-resolver-rules=MAP frame.insecure.test 127.0.0.1", "--no-proxy-server"] });
  f.registerBrowser(browser);
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }), errors = [], commands = [];
  let nativePhase = false;
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/ai/") && response.url().includes("/api/auth/session") && !response.ok()) void response.text().then(body => errors.push("Native auth diagnostic: " + JSON.stringify({ url: response.url(), status: response.status(), body }))).catch(() => {});
  });
  page.on("console", message => { if (nativePhase && message.type() === "error") {
    errors.push(message.text());
    for (const argument of message.args()) void argument.evaluate(value => value instanceof Error ? { message: value.message, stack: value.stack, cause: String(value.cause) } : null)
      .then(value => { if (value) errors.push(JSON.stringify(value)); }).catch(() => {});
  } });
  page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
    if (typeof payload !== "string") return;
    try { for (const value of [].concat(JSON.parse(payload))) if (value.tag === "orchestration.dispatchCommand") commands.push(value.payload); }
    catch { /* Ping/binary frames do not carry native turn commands. */ }
  }));
  const composer = async native => {
    const editor = native.getByTestId("composer-editor"), expand = native.getByRole("button", { name: "Expand composer", exact: true });
    const state = await Promise.race([editor.waitFor({ timeout: 45000 }).then(() => "open"),
      expand.waitFor({ timeout: 45000 }).then(() => "collapsed")]);
    if (state === "collapsed") await expand.click();
    await editor.waitFor({ timeout: 45000 });
    return editor;
  };
  const opened = async selected => {
    await page.goto(f.origin + "/#/work/" + selected.id);
    const open = page.getByRole("button", { name: "打开 AI 对话", exact: true });
    if (await open.count()) await open.click();
    const element = page.locator('iframe[title^="T3 Code ·"]'); await element.waitFor({ timeout: 45000 });
    const native = await (await element.elementHandle()).contentFrame();
    await Promise.race([composer(native),
      native.getByText("T3 Code could not load.", { exact: true }).waitFor({ timeout: 45000 }).then(() => { throw Error("Native bootstrap blocked the composer"); }),
      native.getByText("Something went wrong.", { exact: true }).waitFor({ timeout: 45000 }).then(() => { throw Error("Native route initialization blocked the composer"); })]);
    await native.waitForFunction(() => document.documentElement.dataset.frameEmbedded === "true");
    assert.equal(await native.getByLabel("Current project chats").count(), 1);
    return native;
  };
  const submitted = async (native, text, count) => {
    const editor = await composer(native); await editor.fill(text);
    await native.getByRole("button", { name: "Send message", exact: true }).click({ timeout: 45000 });
    await native.getByText("FRAME_NATIVE_WORKFLOW_RUNNING", { exact: true }).last().waitFor({ timeout: 45000 });
    assert.equal((await f.captured()).filter(row => row.kind === "accepted-turn").length, count - 1,
      "Native incremental text reaches the actual UI before source/preview tools complete");
    const result = await until(async () => {
      const rows = await f.captured(), failed = rows.find(row => ["owned-turn-error", "protocol-error"].includes(row.kind));
      if (failed) throw Error(JSON.stringify(failed));
      return rows.filter(row => row.kind === "accepted-turn")[count - 1];
    }, "Native CLI did not accept the actual composer turn", 90000);
    await native.getByText("FRAME_NATIVE_WORKFLOW_COMPLETE", { exact: false }).last().waitFor({ timeout: 45000 });
    return result;
  };
  try {
    t.diagnostic("Real HTTP login and canonical player");
    await page.goto(f.origin);
    await page.getByLabel("登录密码", { exact: true }).fill("owned-native-workflow-password");
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page.getByLabel("登录密码", { exact: true }).waitFor({ state: "detached" });
    nativePhase = true;
    await page.addInitScript(({ workId, asset }) => { if (window === window.top) sessionStorage.setItem("frame.assets:" + workId, JSON.stringify([asset])); },
      { workId: work.id, asset: { id: f.ownAsset.id, name: f.ownAsset.name } });
    await page.evaluate(({ workId, asset }) => sessionStorage.setItem("frame.assets:" + workId, JSON.stringify([asset])),
      { workId: work.id, asset: { id: f.ownAsset.id, name: f.ownAsset.name } });
    let native = await opened(work);
    assert.deepEqual(await native.evaluate(() => ({ secure: isSecureContext, hostname: location.hostname })), { secure: false, hostname: "frame.insecure.test" });
    const player = await (await page.locator('iframe[title="作品播放器"]').elementHandle()).contentFrame();
    await player.waitForFunction(() => window.__FRAME_LIVE_STATUS__?.state === "ready" && window.__FRAME_LIVE_STATUS__?.compiledRevision, undefined, { timeout: 45000 });
    const shown = await player.evaluate(() => window.__FRAME_LIVE_STATUS__);
    assert.equal(shown.sourceRevision, await treeHash(work.canonical, { includeExecutableMode: true }));
    await page.getByRole("button", { name: "引用当前画面", exact: true }).click({ timeout: 45000 });
    await f.services.ai.workspace.start(work.id);
    const accepted = await submitted(native, "FRAME WORKFLOW: edit only this project and read its frozen frame and asset reference.", 1);
    assert.equal(accepted.cwd, work.ready.cwd); assert.equal(accepted.scenePath, path.join(work.canonical, "scene.ts"));
    assert.match(accepted.prompt, /Frozen source:/); assert.match(accepted.prompt, new RegExp(f.ownAsset.id));
    assert.match(await fs.readFile(accepted.scenePath, "utf8"), /FRAME_NATIVE_WORKFLOW_APPLIED/);
    const frozen = await f.db.all("SELECT * FROM ai_message_contexts WHERE work_id=$1", [work.id]);
    assert.equal(frozen.length, 1); assert.equal(frozen[0].envelope.reviewReference.sourceRevision, shown.sourceRevision);
    assert.equal(frozen[0].envelope.reviewReference.compiledRevision, shown.compiledRevision);
    const frozenFolder = path.join(f.data, "ai", work.id, "references/messages", frozen[0].message_id);
    assert.equal(await fs.readFile(path.join(frozenFolder, "source/scene.ts"), "utf8"), work.sceneBefore,
      "Frozen source remains the exact version reviewed before the native edit");
    const manifest = JSON.parse(await fs.readFile(path.join(frozenFolder, "manifest.json"), "utf8"));
    assert.equal(manifest.materials.find(material => material.id === f.ownAsset.id)?.sha256, f.ownAsset.sha);
    assert.equal(accepted.frameAssets.find(material => material.id === f.ownAsset.id)?.sha, f.ownAsset.sha);
    assert.equal((await f.db.one("SELECT count(*) AS n FROM ai_message_assets WHERE work_id=$1 AND asset=$2", [work.id, f.ownAsset.id])).n, "1");
    const nativeTurn = commands.find(command => command.type === "thread.turn.start"); assert(nativeTurn);
    assert.equal(nativeTurn.message.messageId, frozen[0].message_id);
    const replay = await f.client.dispatch(nativeTurn); assert(replay);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await f.captured()).filter(row => row.kind === "accepted-turn").length, 1, "Native durable command receipts prevent provider replay");
    const report = await until(async () => {
      const rows = await f.services.ai.store.listValidations(work.id, { states: ["passed"] });
      const revision = await treeHash(work.canonical, { includeExecutableMode: true });
      return rows.find(row => row.revision === revision);
    }, "Canonical edited source did not pass in-place validation", 150000);
    assert.deepEqual(report.result.validation.map(item => item.name), ["scope", "structure", "project-tests", "project-types", "runtime"]);
    await player.waitForFunction(revision => window.__FRAME_LIVE_STATUS__?.sourceRevision === revision && window.__FRAME_LIVE_STATUS__?.state === "ready", report.revision, { timeout: 45000 });
    assert.equal((await f.db.one("SELECT count(*) AS n FROM tasks")).n, "0");
    const embeddedUrl = new URL(native.url());
    assert.match(embeddedUrl.searchParams.get("frameNonce"), /^[A-Za-z0-9_-]{24,128}$/,
      "Native navigation retains the FRAME bootstrap nonce");
    await Promise.all([native.waitForNavigation({ waitUntil: "domcontentloaded" }), native.evaluate(() => location.reload())]);
    await composer(native);
    await native.waitForFunction(() => document.documentElement.dataset.frameEmbedded === "true");
    assert.equal(new URL(native.url()).searchParams.get("frameNonce"), embeddedUrl.searchParams.get("frameNonce"));
    await native.getByText("FRAME_NATIVE_WORKFLOW_COMPLETE", { exact: false }).last().waitFor({ timeout: 45000 });
    assert.equal((await f.captured()).filter(row => row.kind === "accepted-turn").length, 1);
    t.diagnostic("Second same-remote project creates a native draft in its own physical directory");
    native = await opened(other);
    const second = await submitted(native, "FRAME OTHER WORK: edit this physical project only.", 2);
    assert.equal(second.cwd, other.ready.cwd); assert.equal(second.scenePath, path.join(other.canonical, "scene.ts"));
    assert.notEqual(second.threadId, accepted.threadId);
    const otherFrozen = await f.db.all("SELECT * FROM ai_message_contexts WHERE work_id=$1", [other.id]);
    assert.equal(otherFrozen.length, 1); assert.notEqual(otherFrozen[0].thread_id, frozen[0].thread_id);
    native = await opened(work);
    await native.getByRole("button", { name: "New chat", exact: true }).click();
    await composer(native);
    const third = await submitted(native, "FRAME SAME WORK NEW CHAT: continue in this existing physical directory.", 3);
    assert.equal(third.cwd, work.ready.cwd); assert.notEqual(third.threadId, accepted.threadId);
    const credentials = (await f.captured()).filter(row => row.kind === "launch" && row.frameCredentialInjected);
    assert.equal(new Set(credentials.map(row => row.frameCredentialHash)).size, 3, "Each work/thread gets its own native tool credential");
    assert.ok(credentials.every(row => !row.hasMasterKey && !row.hasDatabaseUrl && !row.hasTestDatabaseUrl));
    t.diagnostic("Actual native terminal subprocess metadata gates only its own work");
    const ownThread = (await f.services.ai.store.getMessage({ workId: work.id, threadId: frozen[0].thread_id, messageId: frozen[0].message_id })).threadId;
    await f.client.rpc("terminal.open", { threadId: ownThread, terminalId: "frame-owned-terminal", cwd: work.ready.cwd, cols: 80, rows: 24 });
    await f.client.rpc("terminal.write", { threadId: ownThread, terminalId: "frame-owned-terminal", data: "sleep 30\n" });
    await until(async () => (await f.services.ai.manager.observe(work.id)).activeTerminals === 1, "Native subprocess did not enter the work activity gate", 10000);
    assert.equal((await f.services.ai.manager.observe(other.id)).activeTerminals, 0);
    await f.services.ai.manager.cancelWork(work.id);
    await until(async () => (await f.services.ai.manager.observe(work.id)).activeTerminals === 0, "Owned terminal did not close", 10000);
    t.diagnostic("The independent full native workbench reloads and sends in the same current conversation");
    const [standalone] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "在新标签页打开 T3 Code", exact: true }).click()]);
    await composer(standalone);
    assert.equal(await standalone.evaluate(() => document.documentElement.dataset.frameEmbedded), undefined);
    assert.equal(new URL(standalone.url()).pathname.startsWith("/ai/works/"), false);
    await standalone.reload(); await composer(standalone);
    assert.equal((await f.captured()).filter(row => row.kind === "accepted-turn").length, 3);
    const fourth = await submitted(standalone, "FRAME FULL WORKBENCH: continue this current chat in its canonical project without a player reference.", 4);
    assert.equal(fourth.threadId, third.threadId);
    assert.equal(fourth.cwd, work.ready.cwd); assert.equal(fourth.scenePath, path.join(work.canonical, "scene.ts"));
    assert.equal(fourth.frameContext.project, work.project);
    assert.equal(fourth.frameContext.task, null);
    assert.deepEqual(fourth.frameContext.request, {}); assert.deepEqual(fourth.frameContext.reference, {});
    assert.equal(fourth.frameContext.focus.time, null);
    assert.doesNotMatch(fourth.prompt, /Frozen source:|FRAME work reference/);
    assert.match(await fs.readFile(fourth.scenePath, "utf8"), new RegExp(fourth.turnId));
    assert.equal((await f.db.one("SELECT count(*) AS n FROM tasks")).n, "0");
    assert.equal(new Set((await f.captured()).filter(row => row.kind === "launch" && row.frameCredentialInjected)
      .map(row => row.frameCredentialHash)).size, 3, "Continuing the same native thread reuses its scoped credential");
    assert.deepEqual(errors, []);
  } catch (error) {
    t.diagnostic(JSON.stringify({ failure: error.message, errors, nativeLog: f.nativeLog(),
      captured: await f.captured(), pages: await Promise.all(page.context().pages().map(async tab => ({ url: tab.url(), frames: await Promise.all(tab.frames().map(async frame => ({ url: frame.url(), body: await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "unavailable") }))) }))) }));
    throw error;
  }
});

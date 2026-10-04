import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { hash, vault } from "../../server/security.mjs";
import { seedSpeech } from "../../server/speech.mjs";
import { Retention } from "../../server/retention.mjs";
import { launchBrowser } from "../../scripts/browser.mjs";
const url = process.env.FRAME_TEST_DATABASE_URL,
  password = "test-password-at-least-14",
  key = "44".repeat(32);
function wave() {
  const frames = 2400,
    b = Buffer.alloc(44 + frames * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    b.writeInt16LE(
      Math.sin((i * 2 * Math.PI * 440) / 24000) * 4000,
      44 + i * 2,
    );
  return b;
}
async function fixture(origin = "http://frame.test") {
  const requests = [],
    models = new Map(),
    data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-speech-")),
    old = process.env.FRAME_SPEECH_URL;
  const mock = http.createServer(async (req, res) => {
    const bytes = [];
    for await (const b of req) bytes.push(b);
    const route = new URL(req.url, "http://local"),
      id = route.pathname.split("/")[2];
    res.setHeader("Content-Type", "application/json");
    if (route.pathname === "/v1/audio/speech") {
      const a = JSON.parse(Buffer.concat(bytes));
      requests.push(a);
      if (a.input === "invalid-output") return res.end("not audio");
      res.setHeader("Content-Type", "audio/wav");
      return res.end(wave());
    }
    if (route.pathname === "/models")
      return res.end(
        JSON.stringify([
          ...["builtin", "melo", "piper"].map((id) => ({ id, builtin: true, ready: true, voices: id === "builtin" ? ["zf_xiaobei"] : ["0"] })),
          ...models.values(),
        ]),
      );
    if (req.method === "POST") {
      models.set(id, {
        id,
        builtin: false,
        ready: false,
        voices: [],
        files: [],
      });
    } else if (req.method === "PUT") {
      const m = models.get(id),
        file = route.searchParams.get("path");
      m.files.push(file);
      if (file.startsWith("voices/")) m.voices.push(path.basename(file, ".pt"));
      m.ready =
        m.files.includes("config.json") &&
        m.files.includes("model.pth") &&
        m.voices.length > 0;
    } else if (req.method === "DELETE") models.delete(id);
    res.end(JSON.stringify({ ok: true, id }));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  process.env.FRAME_SPEECH_URL = `http://127.0.0.1:${mock.address().port}`;
  const db = await database(url, password);
  await db.pool.query(
    "TRUNCATE engines,assets,repos,github_accounts,auth_flows,tokens,sessions RESTART IDENTITY CASCADE",
  );
  const legacy = randomUUID();
  await db.pool.query(
    "INSERT INTO engines(id,name,config,enabled) VALUES($1,'Old Kokoro',$2,false)",
    [
      legacy,
      vault(key).encrypt({
        url: process.env.FRAME_SPEECH_URL + "/v1",
        model: "builtin",
        voice: "zf_xiaobei",
        apiKey: "",
      }),
    ],
  );
  const { app, actions, ai } = await createApp({
    db,
    data,
    masterKey: key,
    origin,
    scheduler: false,
  });
  return {
    app,
    actions,
    ai,
    db,
    data,
    requests,
    legacy,
    base: process.env.FRAME_SPEECH_URL,
    async close() {
      await db.pool.query("DELETE FROM engines WHERE builtin IS NULL");
      await app.close();
      await new Promise((r) => mock.close(r));
      fs.rmSync(data, { recursive: true, force: true });
      old === undefined
        ? delete process.env.FRAME_SPEECH_URL
        : (process.env.FRAME_SPEECH_URL = old);
    },
  };
}
test(
  "speech: immutable ready built-ins, isolated auditions, explicit narration, MCP and task AI access",
  { skip: !url, timeout: 60000 },
  async () => {
    const f = await fixture(),
      { app, db, actions, data } = f,
      call = (n, a = {}) => actions.call(n, a);
    try {
      let engines = await call("engines_list");
      assert.equal(engines.length, 3);
      assert(engines.every((e) => e.builtin && e.enabled));
      const kokoro = engines.find((e) => e.builtinKey === "kokoro");
      assert.equal(kokoro.id, f.legacy);
      assert.equal(kokoro.voices.length, 8);
      await seedSpeech(db, vault(key));
      assert.equal((await call("engines_list")).length, 3);
      for (const e of engines) {
        await assert.rejects(call("engines_delete", { id: e.id }), /不能删除/);
        await assert.rejects(
          call("engines_save", {
            id: e.id,
            name: "change",
            url: e.config.url,
            model: e.config.model,
            voice: e.config.voice,
          }),
          /不能修改/,
        );
        await assert.rejects(
          call("engines_local", {
            model: e.config.model,
            voice: e.config.voice,
          }),
          /无需添加/,
        );
        assert.equal((await call("models_delete", { id: e.config.model })).ok, true);
        await assert.rejects(
          call("engines_save", {
            name: "copy",
            url: e.config.url + "/",
            model: e.config.model,
            voice: e.config.voice,
          }),
          /无需添加/,
        );
      }
      const repo = await call("repositories_add", { name: "speech-test-repo" });
      const input = {
        engine: kokoro.id,
        text: "临时试听",
        voice: "zm_yunxi",
        speed: 1.25,
      };
      await assert.rejects(
        call("speech_test", { ...input, repo: repo.id }),
        /Unrecognized key/,
      );
      const preview = await call("speech_test", input);
      assert(preview.temporary);
      assert(!preview.asset);
      assert.equal((await db.one("SELECT count(*) FROM assets")).count, "0");
      assert.equal(f.requests.at(-1).voice, "zm_yunxi");
      assert.equal(f.requests.at(-1).speed, 1.25);
      const file = path.join(data, "runs", preview.task, preview.path);
      assert(fs.existsSync(file));
      assert.equal((await app.inject({ url: preview.url })).statusCode, 401);
      await db.pool.query(
        "UPDATE tasks SET expires=now()-interval '1 second' WHERE id=$1",
        [preview.task],
      );
      const retention = new Retention(db, data);
      await retention.tick();
      assert(!fs.existsSync(file));
      const generated = await call("speech_generate", {
        ...input,
        repo: repo.id,
      });
      assert(generated.asset.id);
      assert.equal((await db.one("SELECT count(*) FROM assets")).count, "1");
      const work = await call("works_create", {
        repo: repo.id,
        title: "正式配音",
      });
      const narration = await call("works_speech", { id: work.id, ...input });
      const reference = await db.one(
        "SELECT path FROM asset_refs WHERE asset=$1 AND project=$2",
        [narration.asset.id, work.project],
      );
      assert(reference);
      assert(
        fs.existsSync(
          path.join(
            data,
            "works",
            work.id,
            "projects",
            work.project,
            reference.path,
          ),
        ),
      );
      await assert.rejects(
        call("speech_test", { ...input, text: "invalid-output" }),
        /有效的/,
      );
      const custom = await call("engines_save", {
        name: "custom",
        url: f.base + "/v1",
        model: "custom",
        voice: "v",
        apiKey: "private-test-key",
      });
      engines = await call("engines_list");
      assert(!JSON.stringify(engines).includes("private-test-key"));
      assert.equal(
        engines.find((e) => e.id === custom.id).config.configured,
        true,
      );
      const nativeRoot = (await f.ai.work.prepare(work.id)).workspace.workspaceRoot;
      const token = "speech-native-credential";
      f.ai.manager.threadContext = async credential => credential === token ? {
        kind: "ai", repo: work.repo, project: work.project,
        aiWork: work.id, aiThread: "native-speech-agent", runRoot: nativeRoot,
      } : null;
      const agent = (name, args) =>
        app.inject({
          method: "POST",
          url: "/api/agent/action",
          headers: { authorization: "Bearer " + token },
          payload: { name, args },
        });
      assert.equal(
        (await agent("engine_add", { id: custom.id, name: "bad" })).statusCode,
        403,
      );
      const aiAdded = await agent("engine_add", {
        name: "AI custom",
        url: f.base + "/v1",
        model: "ai",
        voice: "v",
      });
      assert.equal(aiAdded.statusCode, 200, aiAdded.body);
      const aiTest = await agent("engine_test", input);
      assert.equal(aiTest.statusCode, 200, aiTest.body);
      assert(
        fs.existsSync(path.join(nativeRoot, aiTest.json().path)),
      );
      assert.equal((await db.one("SELECT count(*) FROM assets")).count, "2");
      const tok = await call("tokens_create", { name: "mcp-speech" }),
        headers = {
          authorization: "Bearer " + tok.token,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        };
      const rpc = (method, params) =>
        app.inject({
          method: "POST",
          url: "/mcp",
          headers,
          payload: { jsonrpc: "2.0", id: 1, method, params },
        });
      const list = await rpc("tools/list", {});
      assert.equal(list.statusCode, 200, list.body);
      for (const name of [
        "frame_engines_save",
        "frame_engines_delete",
        "frame_speech_test",
      ])
        assert(list.body.includes(name));
      const audition = await rpc("tools/call", {
        name: "frame_speech_test",
        arguments: input,
      });
      assert.equal(audition.statusCode, 200, audition.body);
      assert.match(audition.body, /"type":"audio"/);
      assert.equal((await db.one("SELECT count(*) FROM assets")).count, "2");
      await call("engines_delete", { id: custom.id });
      assert.equal((await db.one("SELECT count(*) FROM assets")).count, "2");
    } finally {
      await f.close();
    }
  },
);
test(
  "speech settings browser: built-in audition, voice/speed, custom API lifecycle, guided model upload and mobile",
  { skip: !url, timeout: 90000 },
  async () => {
    const port = Number(process.env.FRAME_SPEECH_TEST_PORT || process.env.FRAME_TEST_PORT || 55186),
      origin = `http://127.0.0.1:${port}`,
      f = await fixture(origin);
    let browser;
    try {
      await f.app.listen({ host: "127.0.0.1", port });
      browser = await launchBrowser();
      const ctx = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
        }),
        page = await ctx.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      assert(
        (
          await ctx.request.post(origin + "/api/login", {
            headers: { Origin: origin },
            data: { password },
          })
        ).ok(),
      );
      await page.goto(origin + "/#/settings");
      await page.getByRole("button", { name: "语音引擎", exact: true }).click();
      await page
        .locator(".speech-card")
        .filter({ hasText: "Kokoro 中文" })
        .waitFor();
      assert.equal(await page.locator(".speech-card").count(), 3);
      assert.equal(
        await page
          .locator(".speech-card")
          .getByRole("button", { name: "配置" })
          .count(),
        0,
      );
      await page
        .locator(".speech-card")
        .filter({ hasText: "Kokoro 中文" })
        .getByRole("button", { name: "试听", exact: true })
        .click();
      const audition = page.getByRole("dialog", { name: "试听 · Kokoro 中文" });
      await audition
        .getByLabel("声线", { exact: true })
        .selectOption("zm_yunxi");
      await audition.getByLabel("语速", { exact: true }).press("Home");
      for (let i = 0; i < 15; i++)
        await audition.getByLabel("语速", { exact: true }).press("ArrowRight");
      await audition
        .getByRole("button", { name: "生成试听", exact: true })
        .click();
      await audition.locator("audio").waitFor();
      await audition.locator("audio").evaluate((a) => a.play());
      assert.equal((await f.db.one("SELECT count(*) FROM assets")).count, "0");
      assert.equal(f.requests.at(-1).speed, 1.25);
      await audition.getByRole("button", { name: "关闭弹窗" }).click();
      await page.screenshot({
        path: path.join(process.cwd(), ".cache/validation/speech-desktop.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "添加自定义引擎", exact: true })
        .click();
      await page.getByRole("button", { name: /连接语音 API/ }).click();
      let dialog = page.getByRole("dialog");
      for (const [name, value] of [
        ["引擎名称", "Browser custom"],
        ["服务地址", f.base + "/v1"],
        ["模型名称", "browser"],
        ["默认声线", "v"],
      ])
        await dialog.getByLabel(name, { exact: true }).fill(value);
      await dialog
        .getByRole("button", { name: "添加自定义引擎", exact: true })
        .click();
      await page
        .locator(".speech-card")
        .filter({ hasText: "Browser custom" })
        .waitFor();
      await page
        .getByRole("button", { name: "删除 Browser custom", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "确认删除" })
        .click();
      await page.getByText("还没有自定义引擎", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "添加自定义引擎", exact: true })
        .click();
      await page.getByRole("button", { name: /上传本地模型/ }).click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("引擎名称", { exact: true })
        .fill("上传的自定义声音");
      await dialog.getByLabel("选择模型文件").setInputFiles([
        {
          name: "config.json",
          mimeType: "application/json",
          buffer: Buffer.from("{}"),
        },
        {
          name: "model.pth",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("mock-weights"),
        },
        {
          name: "zf_custom.pt",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("mock-voice"),
        },
      ]);
      await dialog
        .getByRole("button", { name: "保存自定义引擎", exact: true })
        .click();
      await page
        .locator(".speech-card")
        .filter({ hasText: "上传的自定义声音" })
        .waitFor();
      await page
        .locator(".speech-card")
        .filter({ hasText: "上传的自定义声音" })
        .getByRole("button", { name: "配置", exact: true })
        .click();
      dialog = page.getByRole("dialog", { name: "配置自定义引擎" });
      assert.equal(
        await dialog.getByLabel("服务地址", { exact: true }).count(),
        0,
      );
      assert.equal(
        await dialog.getByLabel("API 密钥", { exact: true }).count(),
        0,
      );
      await dialog
        .getByLabel("默认声线", { exact: true })
        .selectOption("zf_custom");
      await dialog
        .getByRole("button", { name: "保存配置", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /推荐模型 ·/ }).click();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: path.join(process.cwd(), ".cache/validation/speech-mobile.png"),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await f.close();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { vault } from "../../server/security.mjs";
import { seedSpeech, speechOperations } from "../../server/speech.mjs";

test("recommended speech models require explicit download, expose progress and can be removed", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-model-api-"));
  const old = process.env.FRAME_SPEECH_URL;
  const state = { id: "builtin", ready: false, voices: [], download: { state: "missing" } };
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push([req.method, req.url]);
    res.setHeader("content-type", "application/json");
    if (req.url === "/models") return res.end(JSON.stringify([state]));
    if (req.url === "/models/builtin/download") {
      state.download = { state: "downloading", receivedBytes: 10, totalBytes: 100 };
      return res.end(JSON.stringify(state.download));
    }
    if (req.method === "DELETE") { state.ready = false; state.download = { state: "missing" }; }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.FRAME_SPEECH_URL = `http://127.0.0.1:${server.address().port}`;
  const db = await sqliteDatabase(path.join(data, "db.sqlite"));
  const secrets = vault("77".repeat(32));
  const handlers = new Map();
  try {
    await seedSpeech(db, secrets);
    speechOperations({ db, data, secrets, assets: {}, add: (name, _description, _schema, fn) => handlers.set(name, fn) });
    const engines = await handlers.get("engines_list")();
    assert.equal(engines.length, 3);
    assert.equal(calls.length, 0, "Listing engines must not initiate model downloads");
    const engine = engines.find((e) => e.config.model === "builtin");
    await assert.rejects(handlers.get("speech_test")({ engine: engine.id, text: "你好", speed: 1 }), /下载或上传/);
    assert.equal((await handlers.get("models_download")({ id: "builtin" })).state, "downloading");
    assert.equal((await handlers.get("models_list")())[0].download.receivedBytes, 10);
    state.ready = true;
    assert.equal((await handlers.get("models_delete")({ id: "builtin" })).ok, true);
    assert.equal((await handlers.get("models_list")())[0].ready, false);
  } finally {
    await db.pool.end();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(data, { recursive: true, force: true });
    if (old === undefined) delete process.env.FRAME_SPEECH_URL;
    else process.env.FRAME_SPEECH_URL = old;
  }
});

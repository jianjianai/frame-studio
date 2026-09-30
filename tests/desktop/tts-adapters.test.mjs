import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { hash } from "../../server/security.mjs";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { createApp } from "../../server/app.mjs";
const wave = () => {
  const b = Buffer.alloc(244);
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
  b.writeUInt32LE(200, 40);
  return b;
};
test(
  "TTS integration: real app/SQLite/HTTP/MCP with fake provider; audition/adoption/final schema, migration and cancellation",
  { timeout: 30000 },
  async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-tts-contract-")),
      requests = [];
    let began;
    const waiting = new Promise((resolve) => (began = resolve));
    const provider = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const b of req) chunks.push(b);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ url: req.url, input });
      if (input.input === "cancel-me") {
        began();
        return;
      }
      if (req.url.endsWith("/get_voice"))
        return res.end(
          JSON.stringify({
            base_resp: { status_code: 0 },
            system_voice: [{ voice_id: "zh-voice", voice_name: "中文旁白" }],
          }),
        );
      if (req.url.endsWith("/t2a_v2"))
        return res.end(
          JSON.stringify({
            base_resp: { status_code: 0 },
            data: { audio: wave().toString("hex") },
          }),
        );
      if (req.url.endsWith("/api/v3/tts/unidirectional/sse")) {
        const audio = input.req_params?.audio_params;
        // Validate the documented protocol at the HTTP boundary, rather than
        // accepting arbitrary mock bodies that would fail against the service.
        if (
          !audio ||
          ![64000, 160000].includes(audio.bit_rate) ||
          audio.sample_rate !== 24000 ||
          Object.hasOwn(input.req_params, "sample_rate")
        ) {
          res.writeHead(400);
          return res.end("Invalid Doubao audio parameters");
        }
        res.setHeader("content-type", "text/event-stream");
        return res.end(
          `data: ${JSON.stringify({ code: 0, data: wave().toString("base64") })}\n\ndata: {"code":20000000}\n\n`,
        );
      }
      res.setHeader("content-type", "audio/wav");
      res.end(wave());
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${provider.address().port}/v1`;
    let app;
    try {
      const db = await sqliteDatabase(path.join(data, "test.sqlite"));
      const f = await createApp({
        db,
        data,
        masterKey: "83".repeat(32),
        origin: "http://127.0.0.1:57821",
        localMode: true,
        scheduler: false,
      });
      app = f.app;
      const call = (name, args = {}) => f.actions.call(name, args);
      const repo = await call("repositories_add", { name: "tts-fixture" });
      const legacy = await call("engines_save", {
        name: "legacy",
        url,
        model: "legacy",
        voice: "v",
      });
      const oldPreview = await call("speech_test", {
        engine: legacy.id,
        text: "旧接口",
        speed: 1.2,
      });
      assert.equal(oldPreview.mime, "audio/wav");
      assert.equal(requests.at(-1).input.speed, 1.2);
      const adapter = await call("engines_save", {
        name: "MiniMax fixture",
        provider: "minimax",
        url,
        model: "speech-2.8-hd",
        voice: "zh-voice",
        apiKey: "fixture-key-never-a-real-credential",
      });
      // Old callers updating a name must preserve the adapter and encrypted key.
      await call("engines_save", {
        id: adapter.id,
        name: "renamed",
        url,
        model: "speech-2.8-hd",
        voice: "zh-voice",
      });
      const list = await call("engines_list"),
        row = list.find((e) => e.id === adapter.id);
      assert.equal(row.provider, "minimax");
      assert(row.capabilities.fields.pronunciation);
      assert(!JSON.stringify(list).includes("fixture-key-never"));
      const catalog = await call("engines_discover", { engine: adapter.id });
      assert.equal(catalog.source, "live");
      assert.equal(catalog.voices[0].id, "zh-voice");
      const input = {
        engine: adapter.id,
        text: "重庆，新的旅程。",
        options: {
          emotion: "calm",
          pronunciation: [{ word: "重庆", phonetic: "(chong2)(qing4)" }],
          pauses: [{ after: 3, seconds: 0.5 }],
        },
        requestId: randomUUID(),
      };
      const preview = await call("speech_test", input);
      assert.equal(preview.applied.options.emotion, "calm");
      assert.equal(requests.at(-1).input.voice_setting.emotion, "calm");
      assert.equal(
        (await call("speech_status", { requestId: input.requestId })).state,
        "succeeded",
      );
      await assert.rejects(call("speech_test", input), /请求 ID/);
      const count = requests.length;
      const work = await call("works_create", {
        repo: repo.id,
        title: "TTS 旁白测试",
      });
      const adopted = await call("works_speech_adopt", {
        task: preview.task,
        id: work.id,
        name: "旁白",
      });
      assert(adopted.resynthesized === false);
      assert.equal(requests.length, count);
      const final = await call("works_speech", {
        ...input,
        requestId: randomUUID(),
        id: work.id,
      });
      assert.deepEqual(final.applied, preview.applied);
      assert(final.asset.id);
      const doubao = await call("engines_save", {
        name: "Doubao protocol fixture",
        provider: "doubao",
        url: url.replace(/\/v1$/, ""),
        model: "seed-tts-2.0",
        voice: "zh_female_vv_uranus_bigtts",
        apiKey: "fixture-doubao-not-a-real-credential",
      });
      const doubaoInput = {
        engine: doubao.id,
        text: "让每一句旁白，自然地讲述故事。",
        speed: 0.95,
        options: { instructions: "自然中文", pitch: -2 },
      };
      const doubaoPreview = await call("speech_test", doubaoInput);
      const doubaoFinal = await call("works_speech", {
        ...doubaoInput,
        id: work.id,
      });
      assert.deepEqual(doubaoFinal.applied, doubaoPreview.applied);
      assert.equal(requests.at(-1).input.req_params.audio_params.speech_rate, -5);
      assert.deepEqual(JSON.parse(requests.at(-1).input.req_params.additions), {
        context_texts: ["自然中文"],
        post_process: { pitch: -2 },
      });
      await assert.rejects(
        call("engines_save", {
          id: adapter.id,
          name: "wrong credential target",
          provider: "elevenlabs",
          url,
          model: "eleven_multilingual_v2",
          voice: "v",
        }),
        /原密钥不能/,
      );
      await assert.rejects(
        call("engines_save", {
          id: adapter.id,
          name: "wrong endpoint",
          url: url + "/other",
          model: "speech-2.8-hd",
          voice: "v",
        }),
        /原密钥不能/,
      );
      const emptyVoice = await call("engines_save", {
        name: "Eleven catalog first",
        provider: "elevenlabs",
        url,
        model: "eleven_v4",
      });
      assert.equal(
        (await call("engines_list")).find((e) => e.id === emptyVoice.id).config
          .voice,
        "",
      );
      const beforeEmptyVoice = requests.length;
      await assert.rejects(
        call("speech_test", { engine: emptyVoice.id, text: "先选择音色" }),
        /所选音色/,
      );
      assert.equal(
        requests.length,
        beforeEmptyVoice,
        "missing default voice must fail before provider request",
      );
      const agentId = randomUUID(),
        agentToken = "fixture-task-only";
      await db.pool.query(
        "INSERT INTO tasks(id,repo,project,kind,state,input) VALUES($1,$2,$3,$4,$5,$6)",
        [agentId, repo.id, work.project, "agent", "running", {}],
      );
      await db.pool.query("INSERT INTO agent_tokens(task,hash) VALUES($1,$2)", [
        agentId,
        hash(agentToken),
      ]);
      const bridge = await app.inject({
        method: "POST",
        url: "/api/agent/action",
        headers: {
          host: "127.0.0.1:57821",
          authorization: "Bearer " + agentToken,
          "content-type": "application/json",
        },
        payload: {
          name: "speech",
          args: { ...input, requestId: randomUUID() },
        },
      });
      assert.equal(bridge.statusCode, 200, bridge.body);
      assert.equal(bridge.json().applied.options.emotion, "calm");
      assert(bridge.json().requestId);
      assert.deepEqual(bridge.json().warnings, []);
      const cancelledId = randomUUID();
      const run = call("speech_test", {
        engine: legacy.id,
        text: "cancel-me",
        requestId: cancelledId,
      });
      const rejected = assert.rejects(run, (e) => e.code === "TTS_CANCELLED");
      await waiting;
      const cancel = await call("speech_cancel", { requestId: cancelledId });
      assert(cancel.cancelRequested);
      await rejected;
      assert.equal(
        (await call("speech_status", { requestId: cancelledId })).state,
        "cancelled",
      );
      const tok = await call("tokens_create", { name: "isolated-mcp-test" });
      const headers = {
        host: "127.0.0.1:57821",
        origin: "http://127.0.0.1:57821",
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
      const tools = await rpc("tools/list", {});
      assert.equal(tools.statusCode, 200, tools.body);
      for (const name of [
        "frame_speech_providers",
        "frame_engines_discover",
        "frame_speech_cancel",
      ])
        assert(tools.body.includes(name));
      assert(tools.body.includes("pronunciation"));
      const mcp = await rpc("tools/call", {
        name: "frame_speech_test",
        arguments: { ...input, requestId: randomUUID() },
      });
      assert.equal(mcp.statusCode, 200);
      assert(mcp.body.includes("calm"));
      const described = await app.inject({
        url: "/api/actions/works_speech",
        headers,
      });
      assert.equal(described.statusCode, 200, described.body);
      assert(described.body.includes("options"));
    } finally {
      await app?.close();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      fs.rmSync(data, { recursive: true, force: true });
    }
  },
);

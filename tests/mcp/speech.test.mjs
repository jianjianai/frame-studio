import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fixture, repo, memoryClient, call, waitForJob } from "./helpers.mjs";
import { ProjectService } from "../../scripts/project-service.mjs";
import { produceNarration } from "../../scripts/narration.mjs";
import {
  initSpeech,
  speechStatus,
  listSpeechVoices,
  readSpeech,
} from "../../scripts/speech.mjs";
import {
  resolveSpeech,
  readSpeechConfig,
  speechTemplate,
  runSpeechWorker,
} from "../../scripts/speech-providers.mjs";
import { azureSsml, escapeXml } from "../../scripts/speech-worker.mjs";
import { probeMedia } from "../../scripts/production-media.mjs";
import { loadRemoteConfig } from "../../scripts/mcp/remote-config.mjs";
import { startRemoteServer } from "../../scripts/mcp/remote-http.mjs";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

function wav() {
  const frames = 4800,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    bytes.writeInt16LE(Math.round(Math.sin(i * 0.04) * 2000), 44 + i * 2);
  return bytes;
}
function custom(f) {
  fs.writeFileSync(
    f.file("scripts/provider.mjs"),
    `export async function synthesize(){ return Uint8Array.from(Buffer.from('${wav().toString("base64")}', 'base64')); }`,
  );
  const config = {
    version: 1,
    defaultProvider: "local",
    providers: {
      local: { type: "custom", module: "scripts/provider.mjs", voice: "one" },
    },
    speakers: { alice: { voice: "alice" }, bob: { voice: "bob" } },
  };
  fs.writeFileSync(f.file("production/speech.json"), JSON.stringify(config));
  return config;
}
const savePlan = (f, plan) =>
  fs.writeFileSync(f.file("production/narration.json"), JSON.stringify(plan));

test("speech setup is project-local, atomic, non-overwriting and respects read-only/allowlist", () => {
  const f = fixture();
  try {
    const ws = new ProjectService(f.root);
    assert.equal(speechStatus(ws, "test-film").configured, false);
    assert.equal(initSpeech(ws, "test-film", {}).applied, true);
    assert.equal(speechStatus(ws, "test-film").providers[0].type, "edge");
    assert.throws(
      () => initSpeech(ws, "test-film", {}),
      /already|changed|exists|Read/i,
    );
    assert.throws(
      () =>
        initSpeech(
          new ProjectService(f.root, { readOnly: true }),
          "test-film",
          {},
        ),
      /read-only/i,
    );
    assert.throws(
      () =>
        speechStatus(
          new ProjectService(f.root, { projects: ["other"] }),
          "test-film",
        ),
      /allowlist/i,
    );
    assert.equal(fs.existsSync(path.join(f.root, "production")), false);
  } finally {
    f.close();
  }
});

test("project environment stays isolated; profiles, credentials and endpoint never leak into status/cache identities", async () => {
  const f = fixture();
  try {
    const ws = new ProjectService(f.root);
    const config = speechTemplate("openai");
    config.providers.openai.apiKeyEnv = "FRAME_TEST_SPEECH_KEY";
    config.providers.openai.baseUrlEnv = "FRAME_TEST_SPEECH_URL";
    fs.writeFileSync(f.file("production/speech.json"), JSON.stringify(config));
    fs.writeFileSync(
      path.join(f.root, ".env"),
      "FRAME_TEST_SPEECH_KEY=root-secret\nFRAME_TEST_SPEECH_URL=https://speech.example/v1\n",
    );
    fs.writeFileSync(f.file(".env"), "FRAME_TEST_SPEECH_KEY=project-secret\n");
    const resolved = resolveSpeech(ws, "test-film", {}, {}, config);
    assert.equal(resolved.runtime.apiKey, "project-secret");
    assert.equal(process.env.FRAME_TEST_SPEECH_KEY, undefined);
    const status = JSON.stringify(speechStatus(ws, "test-film"));
    assert.ok(
      !status.includes("project-secret") &&
        !status.includes("root-secret") &&
        !status.includes("speech.example"),
    );
    fs.writeFileSync(f.file(".env"), "FRAME_TEST_SPEECH_KEY=rotated-secret\n");
    assert.equal(
      resolveSpeech(ws, "test-film", {}, {}, config).fingerprint,
      resolved.fingerprint,
    );
    fs.appendFileSync(
      f.file(".env"),
      "FRAME_TEST_SPEECH_URL=https://different.example/v1\n",
    );
    assert.notEqual(
      resolveSpeech(ws, "test-film", {}, {}, config).fingerprint,
      resolved.fingerprint,
    );
    config.providers.openai.apiKey = "must-not-be-saved";
    fs.writeFileSync(f.file("production/speech.json"), JSON.stringify(config));
    assert.throws(() => readSpeechConfig(ws, "test-film"), /credentials/);
    delete config.providers.openai.apiKey;
    config.providers.openai.apiKeyEnv = "FRAME_MCP_BEARER_TOKEN";
    fs.writeFileSync(f.file("production/speech.json"), JSON.stringify(config));
    assert.throws(() => readSpeechConfig(ws, "test-film"), /Invalid speech/);
  } finally {
    f.close();
  }
});

test(
  "multi-speaker measured dialogue caches per sentence, normalizes WAV and invalidates only changed voices or code",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const config = custom(f);
      const plan = {
        mode: "sequential",
        gap: 0.25,
        sentences: [
          { id: "one", speaker: "alice", text: "第一句" },
          { id: "two", speaker: "bob", text: "第二句" },
        ],
      };
      savePlan(f, plan);
      const run = () =>
        produceNarration(f.root, "test-film", "production/narration.json");
      const first = await run();
      assert.equal(first.cacheHits, 0);
      assert.equal(first.sentences[1].start, 0.35);
      assert.equal(first.sentences[1].voice, "bob");
      const probe = await probeMedia(first.voicePath);
      assert.equal(probe.streams[0].sample_rate, "48000");
      assert.equal(probe.streams[0].channels, 2);
      assert.equal((await run()).cacheHits, 2);
      config.speakers.bob.voice = "new-bob";
      fs.writeFileSync(
        f.file("production/speech.json"),
        JSON.stringify(config),
      );
      assert.equal((await run()).cacheHits, 1);
      fs.appendFileSync(
        f.file("scripts/provider.mjs"),
        "\n// provider version changed\n",
      );
      assert.equal((await run()).cacheHits, 0);
      plan.sentences[0].budget = 0.01;
      savePlan(f, plan);
      await assert.rejects(run, /time budget/);
      assert.equal(
        new ProjectService(f.root).operation("test-film").busy,
        false,
      );
      const inline = readSpeech(
        new ProjectService(f.root),
        "test-film",
        first.version,
        { inlineAudio: true },
      );
      assert.equal(inline.data.subarray(0, 4).toString(), "RIFF");
      assert.throws(
        () => readSpeech(new ProjectService(f.root), "test-film", "../secret"),
        /Invalid/,
      );
    } finally {
      f.close();
    }
  },
);

test("all sentence validation happens before synthesis; source audio and overlapping timelines remain explicit", async () => {
  const f = fixture();
  try {
    custom(f);
    fs.writeFileSync(f.file("production/source.wav"), wav());
    const plan = {
      sentences: [
        { id: "one", text: "一", start: 0, audio: "production/source.wav" },
        { id: "two", text: "二", start: 0.05, audio: "production/source.wav" },
      ],
    };
    savePlan(f, plan);
    const run = () =>
      produceNarration(f.root, "test-film", "production/narration.json");
    await assert.rejects(run, /overlap/);
    plan.allowOverlap = true;
    savePlan(f, plan);
    assert.ok(Math.abs((await run()).duration - 0.15) < 0.0001);
    plan.mode = "sequential";
    savePlan(f, plan);
    await assert.rejects(run, /remove sentence.start/);
    delete plan.mode;
    delete plan.sentences[1].audio;
    plan.sentences[1].speaker = "missing";
    savePlan(f, plan);
    await assert.rejects(run, /Unknown speech speaker/);
    plan.sentences[1].speaker = "alice";
    plan.sentences[1].settings = { apiKey: "secret" };
    savePlan(f, plan);
    await assert.rejects(run, /credentials/);
  } finally {
    f.close();
  }
});

test(
  "OpenAI-compatible HTTP adapter sends real Speech requests, bounds responses, rejects redirects and does not retry or leak secrets",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let requests = 0,
      behavior = "ok",
      received;
    const server = http.createServer(async (req, res) => {
      requests++;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received = {
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks)),
      };
      if (behavior === "error") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "project-secret must never leak" },
          }),
        );
      } else if (behavior === "redirect") {
        res.writeHead(307, { Location: "/stolen" });
        res.end();
      } else if (behavior === "huge") {
        res.writeHead(200, { "Content-Length": String(64 * 1024 * 1024) });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        res.end(wav());
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const config = speechTemplate("openai");
      config.providers.openai.apiKeyEnv = "FRAME_TEST_SPEECH_KEY";
      config.providers.openai.baseUrlEnv = "FRAME_TEST_SPEECH_URL";
      fs.writeFileSync(
        f.file("production/speech.json"),
        JSON.stringify(config),
      );
      fs.writeFileSync(
        f.file(".env"),
        `FRAME_TEST_SPEECH_KEY=project-secret\nFRAME_TEST_SPEECH_URL=http://127.0.0.1:${server.address().port}/v1\n`,
      );
      const plan = {
        mode: "sequential",
        sentences: [{ id: "one", text: "SDK 验证" }],
      };
      savePlan(f, plan);
      const first = await produceNarration(
        f.root,
        "test-film",
        "production/narration.json",
      );
      assert.equal(first.status, "passed");
      assert.equal(requests, 1);
      assert.equal(received.url, "/v1/audio/speech");
      assert.equal(received.headers.authorization, "Bearer project-secret");
      assert.equal(received.body.response_format, "wav");
      assert.equal(received.body.input, "SDK 验证");
      const ws = new ProjectService(f.root),
        resolved = resolveSpeech(ws, "test-film", {}, {}, config);
      for (const mode of ["error", "redirect", "huge"]) {
        behavior = mode;
        const before = requests;
        await assert.rejects(
          () =>
            runSpeechWorker({
              action: "synthesize",
              runtime: resolved.runtime,
              text: "test",
            }),
          (error) =>
            !error.message.includes("project-secret") &&
            (error.code?.startsWith("TTS_") || /failed|limit/i.test(error.message)),
        );
        assert.equal(
          requests,
          before + 1,
          "must not retry or follow redirects",
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      f.close();
    }
  },
);

test(
  "provider cancellation and timeout terminate even uncooperative custom code without publishing",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const config = custom(f);
      fs.writeFileSync(
        f.file("scripts/provider.mjs"),
        "export async function synthesize(){ while(true) {} }",
      );
      const resolved = resolveSpeech(
        new ProjectService(f.root),
        "test-film",
        {},
        {},
        config,
      );
      const controller = new AbortController();
      const pending = runSpeechWorker(
        { action: "synthesize", runtime: resolved.runtime, text: "hello" },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 150);
      await assert.rejects(pending, /cancelled/);
      await assert.rejects(
        () =>
          runSpeechWorker(
            { action: "synthesize", runtime: resolved.runtime, text: "hello" },
            { timeoutMs: 150 },
          ),
        /timed out/,
      );
      assert.equal(fs.existsSync(f.file("public/narration")), false);
      assert.equal(escapeXml('<x>&"\u0000'), "&lt;x&gt;&amp;&quot;");
      const ssml = azureSsml('<audio src="evil">', "zh-CN-XiaoxiaoNeural", {
        style: "cheerful",
        rate: "+5%",
      });
      assert.ok(ssml.includes("&lt;audio") && !ssml.includes("<audio"));
    } finally {
      f.close();
    }
  },
);

test(
  "MCP starts real speech jobs with project lock, returns native audio, and read-only clients cannot synthesize",
  { timeout: 30000 },
  async () => {
    const f = fixture({ browser: true });
    let connection;
    try {
      custom(f);
      connection = await memoryClient(f.root);
      const status = await call(connection.client, "frame_speech_status", {
        project: "test-film",
      });
      assert.equal(status.configured, true);
      const started = await call(connection.client, "frame_narrate", {
        project: "test-film",
        text: "hello",
        speaker: "alice",
      });
      const job = await waitForJob(connection.client, "test-film", started.id);
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      const result = JSON.parse(
        fs.readFileSync(
          f.file(`exports/mcp/${started.id}/result.json`),
          "utf8",
        ),
      );
      const audio = await connection.client.callTool({
        name: "frame_read_speech",
        arguments: {
          project: "test-film",
          version: result.version,
          inlineAudio: true,
        },
      });
      assert.notEqual(audio.isError, true);
      assert.equal(audio.content[0].type, "audio");
      assert.equal(
        Buffer.from(audio.content[0].data, "base64").subarray(0, 4).toString(),
        "RIFF",
      );
      const wrong = await connection.client.callTool({
        name: "frame_narrate",
        arguments: {
          project: "test-film",
          input: "production/narration.json",
          text: "no",
        },
      });
      assert.equal(wrong.isError, true);
      await connection.close();
      connection = await memoryClient(f.root, { readOnly: true });
      const names = (await connection.client.listTools()).tools.map(
        (t) => t.name,
      );
      assert.ok(
        names.includes("frame_read_speech") &&
          !names.includes("frame_narrate") &&
          !names.includes("frame_init_speech"),
      );
    } finally {
      await connection?.close();
      f.close();
    }
  },
);

test(
  "CLI speech setup/status/audition and static voice discovery share the same domain",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const command = (...args) =>
        spawnSync(
          process.execPath,
          [
            path.join(repo, "scripts/film.mjs"),
            "speech",
            "test-film",
            ...args,
            "--json",
          ],
          { cwd: f.root, windowsHide: true, encoding: "utf8", timeout: 20000 },
        );
      const init = command("init", "--provider", "edge");
      assert.equal(init.status, 0, init.stderr);
      assert.equal(JSON.parse(command("status").stdout).configured, true);
      custom(f);
      const say = command("say", "--text", "你好", "--speaker", "bob");
      assert.equal(say.status, 0, say.stderr);
      assert.equal(JSON.parse(say.stdout).sentences[0].voice, "bob");
      const voices = await listSpeechVoices(
        new ProjectService(f.root),
        "test-film",
        { provider: "openai", limit: 2 },
      );
      assert.equal(voices.voices.length, 2);
      assert.equal(voices.nextOffset, 2);
    } finally {
      f.close();
    }
  },
);

test(
  "HTTP speech discovery and native audio use authenticated scoped downloads with Range and HEAD",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let app, client;
    try {
      custom(f);
      const result = await produceNarration(f.root, "test-film", undefined, {
        plan: { mode: "sequential", sentences: [{ id: "one", text: "hello" }] },
      });
      const config = loadRemoteConfig(f.root, {
        env: {
          FRAME_MCP_PUBLIC_URL: "http://127.0.0.1:8787",
          FRAME_MCP_PORT: "0",
          FRAME_MCP_AUTH_MODE: "bearer",
          FRAME_MCP_BEARER_TOKEN: randomBytes(32).toString("hex"),
          FRAME_MCP_PROJECTS: "test-film",
        },
      });
      app = await startRemoteServer(config);
      config.publicUrl = app.url;
      config.resource = app.url + "/mcp";
      client = new Client({ name: "speech-test", version: "1" });
      const headers = { Authorization: "Bearer " + config.bearerToken };
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.resource), {
          requestInit: { headers },
        }),
      );
      const output = await call(client, "frame_read_speech", {
        project: "test-film",
        version: result.version,
      });
      const link = output.remoteArtifacts[0].uri;
      assert.equal((await fetch(link)).status, 401);
      const partial = await fetch(link, {
        headers: { ...headers, Range: "bytes=0-3" },
      });
      assert.equal(partial.status, 206);
      assert.equal(await partial.text(), "RIFF");
      const head = await fetch(link, { method: "HEAD", headers });
      assert.equal(head.status, 200);
      assert.equal(
        Number(head.headers.get("content-length")),
        fs.statSync(result.voicePath).size,
      );
      const inline = await client.callTool({
        name: "frame_read_speech",
        arguments: {
          project: "test-film",
          version: result.version,
          inlineAudio: true,
        },
      });
      assert.equal(inline.content[0].type, "audio");
      assert.equal(
        (
          await fetch(app.url + "/artifacts/test-film/production/speech.json", {
            headers,
          })
        ).status,
        404,
      );
      assert.equal(
        (await fetch(link.replace("/test-film/", "/other/"), { headers }))
          .status,
        404,
      );
    } finally {
      await client?.close();
      await app?.close();
      f.close();
    }
  },
);

test(
  "MCP cancellation stops speech workers and releases the same project for later jobs",
  { timeout: 30000 },
  async () => {
    const f = fixture({ browser: true });
    let connection;
    try {
      custom(f);
      fs.writeFileSync(
        f.file("scripts/provider.mjs"),
        "export async function synthesize(){ while(true){} }",
      );
      connection = await memoryClient(f.root);
      const job = await call(connection.client, "frame_narrate", {
        project: "test-film",
        text: "long-running",
      });
      const busy = await connection.client.callTool({
        name: "frame_narrate",
        arguments: { project: "test-film", text: "conflict" },
      });
      assert.equal(busy.structuredContent.error.code, "PROJECT_BUSY");
      const stopped = await call(connection.client, "frame_cancel_job", {
        project: "test-film",
        jobId: job.id,
      });
      assert.equal(stopped.status, "cancelled");
      assert.equal(
        new ProjectService(f.root).operation("test-film").busy,
        false,
      );
      assert.equal(fs.existsSync(f.file("public/narration")), false);
    } finally {
      await connection?.close();
      f.close();
    }
  },
);


test(
  "CLI and local MCP transmit the same MiniMax expression settings through real HTTP test service",
  { timeout: 30000 },
  async () => {
    const f = fixture({ browser: true }),
      requests = [];
    let connection;
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          base_resp: { status_code: 0 },
          data: { audio: wav().toString("hex") },
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const config = speechTemplate("minimax", "zh-voice");
      config.providers.minimax.apiKeyEnv = "FRAME_TEST_MINIMAX_KEY";
      config.providers.minimax.baseUrlEnv = "FRAME_TEST_MINIMAX_URL";
      fs.writeFileSync(
        f.file("production/speech.json"),
        JSON.stringify(config),
      );
      fs.writeFileSync(
        f.file(".env"),
        `FRAME_TEST_MINIMAX_KEY=fixture-only
FRAME_TEST_MINIMAX_URL=http://127.0.0.1:${server.address().port}/v1
`,
      );
      const text = "重庆，新的旅程开始。",
        options = {
          emotion: "calm",
          language: "Chinese",
          pronunciation: [{ word: "重庆", phonetic: "(chong2)(qing4)" }],
          pauses: [{ after: 3, seconds: 0.5 }],
        };
      const child = spawn(
        process.execPath,
        [
          path.join(repo, "scripts/film.mjs"),
          "speech",
          "test-film",
          "say",
          "--text",
          text,
          "--speed",
          "0.95",
          "--options",
          JSON.stringify(options),
          "--json",
        ],
        { cwd: f.root, windowsHide: true },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      const [code] = await once(child, "exit");
      assert.equal(code, 0, err + out);
      assert.equal(JSON.parse(out).status, "passed");
      const cliRequest = requests.at(-1);
      assert.equal(cliRequest.voice_setting.emotion, "calm");
      assert.equal(cliRequest.text, "重庆，<#0.50#>新的旅程开始。");
      connection = await memoryClient(f.root);
      const privateFile = await connection.client.callTool({
        name: "frame_read_file",
        arguments: { project: "test-film", path: ".env" },
      });
      assert.equal(privateFile.isError, true);
      assert(!JSON.stringify(privateFile).includes("fixture-only"));
      const tools = (await connection.client.listTools()).tools;
      assert(
        tools.find((t) => t.name === "frame_narrate").inputSchema.properties
          .options.properties.pronunciation,
      );
      // A changed punctuation forces a new request rather than a cache hit.
      const started = await call(connection.client, "frame_narrate", {
        project: "test-film",
        text: text + "！",
        speed: 0.95,
        options,
      });
      const job = await waitForJob(connection.client, "test-film", started.id);
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      assert.deepEqual(requests.at(-1).voice_setting, cliRequest.voice_setting);
      assert.deepEqual(
        requests.at(-1).pronunciation_dict,
        cliRequest.pronunciation_dict,
      );
      const before = requests.length;
      const invalid = await produceNarration(f.root, "test-film", undefined, {
        plan: {
          mode: "sequential",
          settings: { instructions: "unsupported" },
          sentences: [{ id: "bad", text }],
        },
      }).catch((e) => e);
      assert(invalid instanceof Error);
      assert.equal(requests.length, before);
    } finally {
      await connection?.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      f.close();
    }
  },
);

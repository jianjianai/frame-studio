import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PlatformClient, platformUrl } from "../../scripts/platform/client.mjs";
import { runPlatformCli } from "../../scripts/platform-cli.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
async function fixture(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const record = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    requests.push(record);
    try {
      await handler(record, res);
    } catch (error) {
      json(res, { error: error.message }, 500);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const client = (f, options = {}) =>
  new PlatformClient({
    base: f.base,
    token: "test-private-token",
    pollMs: 10,
    timeoutMs: 2000,
    ...options,
  });
function cliProcess(args, env = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/platform-cli.mjs", ...args],
      {
        env: { ...process.env, FRAME_URL: "", FRAME_TOKEN: "", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}
test("platform CLI help is offline, JSON clean and failures do not expose stacks", async () => {
  const help = await cliProcess(["--help", "--json"]);
  assert.equal(help.code, 0);
  assert.match(JSON.parse(help.out).help, /download/);
  assert.equal(help.err, "");
  const invalid = await cliProcess(["works_page"]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.out, "");
  assert.equal(JSON.parse(invalid.err).code, "CONFIG_REQUIRED");
  assert(!invalid.err.includes(" at "));
});
for (const value of [
  "ftp://host",
  "http://example.com",
  "https://user:pass@host",
  "https://host?q=1",
  "https://host#token",
])
  test(
    "platform URL rejects unsafe credential transport: " +
      value.replace("user:pass", "userinfo"),
    () => assert.throws(() => platformUrl(value)),
  );
test("platform URL normalizes prefixes and explicitly permits private test HTTP", () => {
  assert.equal(platformUrl("https://host/frame///"), "https://host/frame");
  assert.equal(platformUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(
    platformUrl("http://test.internal", true),
    "http://test.internal",
  );
});
test("wait submits once, drains incremental event pages and emits only final JSON", async () => {
  let polls = 0;
  const f = await fixture(({ body }, res) => {
    if (body.name === "works_task")
      return json(res, { id: "task-one", kind: "render", state: "queued" });
    assert.equal(body.name, "task_get");
    polls++;
    json(res, {
      task: { id: "task-one", kind: "render", state: "succeeded" },
      events:
        polls === 1
          ? Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }))
          : [{ id: "101" }],
    });
  });
  try {
    const result = await client(f).run(
      "frame_works_task",
      { id: "work" },
      true,
    );
    assert.equal(result.state, "succeeded");
    assert.equal(polls, 2);
    assert.equal(
      f.requests.filter((r) => r.body.name === "works_task").length,
      1,
    );
    assert.equal(f.requests.at(-1).body.args.after, 100);
  } finally {
    await f.close();
  }
});
for (const state of ["failed", "cancelled", "publish_failed", "future-unknown"])
  test("wait never reports success for " + state, async () => {
    const f = await fixture((_req, res) =>
      json(res, { task: { id: "t", state }, events: [] }),
    );
    try {
      await assert.rejects(
        client(f).wait("t"),
        (error) => error.task === "t" && error.code !== undefined,
      );
    } finally {
      await f.close();
    }
  });
test("browser wait handles preceding validation and build without repeated rebuilds", async () => {
  let browsers = 0;
  const f = await fixture(({ body }, res) => {
    if (body.name === "works_browser") {
      browsers++;
      return json(
        res,
        browsers < 3
          ? { state: "building", task: "t" + browsers }
          : { state: "ready", url: "/preview/test" },
      );
    }
    json(res, { task: { id: body.args.id, state: "succeeded" }, events: [] });
  });
  try {
    assert.equal(
      (
        await client(f).run(
          "works_browser",
          { id: "work", rebuild: true },
          true,
        )
      ).state,
      "ready",
    );
    assert.deepEqual(
      f.requests
        .filter((r) => r.body.name === "works_browser")
        .map((r) => r.body.args.rebuild),
      [true, false, false],
    );
  } finally {
    await f.close();
  }
});
test("timeouts and interruption stop only waiting, never cancel or resubmit work", async () => {
  const f = await fixture((_req, res) =>
    json(res, { task: { id: "t", state: "running" }, events: [] }),
  );
  try {
    await assert.rejects(client(f, { timeoutMs: 45 }).wait("t"), {
      code: "TIMEOUT",
      task: "t",
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client(f, { signal: controller.signal }).wait("t"), {
      code: "INTERRUPTED",
    });
    assert(f.requests.every((r) => r.body.name === "task_get"));
    const processResult = await cliProcess(
      ["wait", "t", "--timeout", ".04", "--poll", ".01"],
      { FRAME_URL: f.base, FRAME_TOKEN: "test" },
    );
    assert.equal(processResult.code, 124);
    assert.equal(processResult.out, "");
  } finally {
    await f.close();
  }
});
test("JSON body timeout is normalized after response headers arrive", async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"task":');
  });
  try {
    await assert.rejects(client(f, { timeoutMs: 35 }).request("/api/action"), {
      code: "TIMEOUT",
    });
  } finally {
    await f.close();
  }
});
test("foreign redirects do not receive credentials; HTML errors are bounded and explanatory", async () => {
  const f = await fixture(({ url }, res) => {
    if (url === "/redirect") {
      res.writeHead(302, { location: "/credential-target" });
      return res.end();
    }
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<h1>upstream failed</h1>");
  });
  try {
    await assert.rejects(client(f).request("/redirect"), {
      code: "NETWORK_ERROR",
    });
    assert.equal(f.requests.length, 1);
    await assert.rejects(client(f).request("/bad"), {
      code: "INVALID_RESPONSE",
      status: 502,
    });
  } finally {
    await f.close();
  }
});
test("token-file secrets are redacted even when a server echoes authorization", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-cli-secret-")),
    file = path.join(dir, "token");
  const secret = "private-test-file-token";
  fs.writeFileSync(file, secret, { mode: 0o600 });
  const f = await fixture((_req, res) =>
    json(res, { code: "BAD_INPUT", error: "rejected " + secret }, 400),
  );
  try {
    const result = await cliProcess(["works_page", "--token-file", file], {
      FRAME_URL: f.base,
    });
    assert.equal(result.code, 1);
    assert(!result.err.includes(secret));
    assert.match(result.err, /redacted/);
  } finally {
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("stdin, @file and frame_ aliases preserve one machine-readable response", async () => {
  const f = await fixture(({ body }, res) => json(res, body));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-cli-input-")),
    file = path.join(dir, "input.json");
  fs.writeFileSync(file, '\uFEFF{"id":"work"}');
  try {
    const env = { FRAME_URL: f.base, FRAME_TOKEN: "test" };
    const a = await cliProcess(
      ["frame_works_context", "-"],
      env,
      '{"id":"work"}',
    );
    const b = await cliProcess(["works_context", "@" + file], env);
    assert.equal(a.code, 0);
    assert.deepEqual(JSON.parse(a.out), JSON.parse(b.out));
    assert.equal(JSON.parse(a.out).name, "works_context");
    for (const args of [
      ["read", "w", "p", "--force"],
      ["works_page", "{}", "extra"],
      ["works_page", "--unknown"],
      ["works_page", "--timeout", "NaN"],
      ["actions", "--wait"],
      ["doctor", "--wait"],
      ["describe", "works_page", "--wait"],
      ["wait", "t", "--wait"],
    ])
      await assert.rejects(runPlatformCli(args, { env }), {
        code: "INVALID_ARGUMENT",
      });
  } finally {
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
for (const corrupt of [false, true])
  test(
    "artifact download is streaming, exclusive and cleans partial files: corrupt=" +
      corrupt,
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-cli-download-"));
      const bytes = Buffer.from("a genuine streamed artifact fixture"),
        artifact = "projects/film/exports/film.mp4",
        output = path.join(dir, "film.mp4");
      const f = await fixture(({ url }, res) =>
        url === "/api/action"
          ? json(res, {
              task: {
                id: "t",
                state: "succeeded",
                result: {
                  artifacts: [
                    {
                      path: artifact,
                      bytes: bytes.length,
                      sha256: corrupt ? "0".repeat(64) : digest(bytes),
                    },
                  ],
                },
              },
            })
          : res.end(bytes),
      );
      try {
        if (corrupt) {
          await assert.rejects(client(f).download("t", artifact, output), {
            code: "CHECKSUM_MISMATCH",
          });
          assert(!fs.existsSync(output));
        } else {
          const result = await client(f).download("t", artifact, output);
          assert.equal(result.sha256, digest(bytes));
          assert(result.checksumVerified);
          await assert.rejects(client(f).download("t", artifact, output), {
            code: "OUTPUT_EXISTS",
          });
          assert.deepEqual(fs.readFileSync(output), bytes);
          await client(f).download("t", artifact, output, { force: true });
          await assert.rejects(client(f).download("t", "../escape", output), {
            code: "INVALID_PATH",
          });
          await assert.rejects(
            client(f).download("t", "projects/film/exports/missing", output),
            { code: "ARTIFACT_NOT_FOUND" },
          );
        }
        assert(
          !fs.readdirSync(dir).some((name) => name.includes("frame-part")),
        );
      } finally {
        await f.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
test("chunked upload resumes exact source bytes and refuses another source", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-cli-upload-")),
    file = path.join(dir, "cue.wav"),
    bytes = Buffer.alloc(900000, 57);
  fs.writeFileSync(file, bytes);
  let meta,
    offset = 0;
  const chunks = [];
  const f = await fixture(({ body }, res) => {
    const { name, args } = body;
    if (name === "upload_begin") {
      meta = args;
      return json(res, { id: "up", offset });
    }
    if (name === "upload_status")
      return json(res, { id: "up", ...meta, offset });
    if (name === "upload_chunk") {
      assert.equal(args.offset, offset);
      const chunk = Buffer.from(args.base64, "base64");
      chunks.push(chunk);
      offset += chunk.length;
      return json(res, { offset });
    }
    assert.equal(name, "upload_finish");
    return json(res, { id: "asset", sha: meta.sha256 });
  });
  try {
    await assert.rejects(client(f).upload(file, { repo: "r" }), {
      code: "UPLOAD_METADATA_REQUIRED",
    });
    const asset = await client(f).upload(file, {
      repo: "r",
      license: "Original",
    });
    assert.equal(asset.id, "asset");
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(chunks.length, 2);
    offset = 768 * 1024;
    chunks.length = 0;
    await client(f).upload(file, {
      repo: "r",
      license: "Original",
      resume: "up",
    });
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], bytes.subarray(768 * 1024));
    fs.writeFileSync(file, "different bytes");
    await assert.rejects(
      client(f).upload(file, { repo: "r", license: "Original", resume: "up" }),
      { code: "UPLOAD_MISMATCH" },
    );
    assert.equal(
      f.requests.filter((r) => r.body.name === "upload_begin").length,
      1,
    );
  } finally {
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

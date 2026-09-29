import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { PlatformClient } from "../../scripts/platform/client.mjs";
const token = "test-only-toolkit-token";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cliPath = new URL("../../scripts/platform-cli.mjs", import.meta.url);
function runCli(args, env = {}, input = "") {
  const child = spawn(process.execPath, [cliPath.pathname, ...args], {
    env: { ...process.env, FRAME_URL: "", FRAME_TOKEN: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  child.stdin.end(input);
  const result = once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
  }));
  return { child, result };
}
async function serverFixture(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const args = text ? JSON.parse(text) : null;
    requests.push({
      route: req.url,
      args,
      authorization: req.headers.authorization,
    });
    try {
      await handler(req, res, args);
    } catch (error) {
      if (!res.headersSent)
        res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    url,
    client: new PlatformClient({ url, token }),
    env: { FRAME_URL: url, FRAME_TOKEN: token },
  };
}
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-platform-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const status = (id, state = "succeeded", extra = {}) => ({
  task: {
    id,
    state,
    kind: "render",
    project: "fixture",
    result: null,
    ...extra,
  },
  events: [],
  nextAfter: "0",
  hasMore: false,
  done: !["queued", "running", "publishing"].includes(state),
  pollAfterMs: 10,
});

test("CLI offline help aliases, malformed inputs and invalid options are stack-free", async () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const run = await runCli(args).result;
    assert.equal(run.code, 0);
    assert.match(run.stdout, /FRAME/);
    assert.equal(run.stderr, "");
  }
  for (const args of [
    ["works_write", "{bad"],
    ["works_list", "[]"],
    ["works_list", "null"],
    ["works_list", "{}", "extra"],
    ["works_list", "--force"],
    ["works_write", "{}", "--wait"],
  ]) {
    const run = await runCli(args).result;
    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.doesNotThrow(() => JSON.parse(run.stderr));
    assert(!run.stderr.includes("at file:"));
  }
});

test("CLI accepts JSON, @file and stdin without stdout progress or credential leaks", async (t) => {
  const dir = temp(t),
    file = path.join(dir, "args.json");
  fs.writeFileSync(file, '{"search":"中文"}');
  const f = await serverFixture(t, (_req, res, body) =>
    json(res, { operation: body.name, args: body.args }),
  );
  for (const [input, stdin] of [
    ['{"search":"中文"}', ""],
    ["@" + file, ""],
    ["-", '{"search":"中文"}'],
  ]) {
    const run = await runCli(["frame_works_list", input], f.env, stdin).result;
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      operation: "works_list",
      args: { search: "中文" },
    });
    assert.equal(run.stderr, "");
  }
  assert(f.requests.every((r) => r.authorization === "Bearer " + token));
});

test("client validates URL and blocks redirects; errors redact tokens and ignore HTML bodies", async (t) => {
  for (const url of [
    "file:///tmp/test",
    "http://u:p@example.test",
    "http://example.test/?token=a",
    "not-a-url",
  ])
    assert.throws(() => new PlatformClient({ url, token }), {
      code: "INVALID_URL",
    });
  const f = await serverFixture(t, (req, res) => {
    if (req.url.includes("redirect")) {
      res.writeHead(302, { location: "/evil" });
      res.end();
    } else if (req.url.includes("html")) {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("PRIVATE_PROXY_BODY");
    } else json(res, { error: "Denied " + token, code: "AUTH_REQUIRED" }, 401);
  });
  await assert.rejects(f.client.request("api/redirect"), {
    code: "NETWORK_ERROR",
  });
  assert(!f.requests.some((r) => r.route === "/evil"));
  await assert.rejects(
    f.client.request("api/html"),
    (error) =>
      error.code === "INVALID_RESPONSE" &&
      !error.message.includes("PRIVATE_PROXY_BODY"),
  );
  await assert.rejects(
    f.client.request("api/denied"),
    (error) => error.status === 401 && !error.message.includes(token),
  );
});

test("wait drains final event pages with bigint cursors and publication failure is terminal", async (t) => {
  const id = randomUUID(),
    cursors = [];
  const f = await serverFixture(t, (_req, res, body) => {
    cursors.push(body.args.after);
    const first = body.args.after === "0";
    json(res, {
      ...status(id, "publish_failed"),
      events: [
        { id: first ? "9007199254740993" : "9007199254740994", kind: "state" },
      ],
      nextAfter: first ? "9007199254740993" : "9007199254740994",
      hasMore: first,
    });
  });
  const events = [],
    result = await f.client.wait(id, {
      onEvents: (rows) => events.push(...rows),
    });
  assert.equal(result.task.state, "publish_failed");
  assert.equal(events.length, 2);
  assert.deepEqual(cursors, ["0", "9007199254740993"]);
  assert(f.requests.every((r) => r.args.name === "task_status"));
  const run = await runCli(["wait", id, "--events"], f.env).result;
  assert.equal(run.code, 1);
  assert.equal(JSON.parse(run.stdout).task.state, "publish_failed");
  assert.match(run.stderr, /9007199254740994/);
});

test("wait timeout exits 2 and SIGINT exits 130 without cancelling remote work", async (t) => {
  const id = randomUUID();
  let started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const f = await serverFixture(t, (_req, res, body) => {
    started();
    json(res, status(id, "queued"));
  });
  const timed = await runCli(["wait", id, "--timeout-ms", "60"], f.env).result;
  assert.equal(timed.code, 2, timed.stderr);
  assert.equal(
    JSON.parse(timed.stderr.trim().split("\n").at(-1)).code,
    "WAIT_TIMED_OUT",
  );
  const run = runCli(["wait", id, "--timeout-ms", "10000"], f.env);
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 150));
  run.child.kill("SIGINT");
  assert.equal((await run.result).code, 130);
  assert(f.requests.every((r) => r.args.name === "task_status"));
});

test("network requests are bounded and mutations are never automatically retried", async (t) => {
  const f = await serverFixture(t, () => {});
  const client = new PlatformClient({ url: f.url, token, timeoutMs: 60 });
  await assert.rejects(client.call("works_create", { title: "example" }), {
    code: "REQUEST_TIMED_OUT",
  });
  assert.equal(f.requests.length, 1);
});

test("download streams exact bytes, preserves existing output and publishes with no-clobber semantics", async (t) => {
  const dir = temp(t),
    id = randomUUID(),
    bytes = Buffer.alloc(1024 * 1024, 7),
    output = path.join(dir, "movie.mp4");
  const artifact = {
    name: "movie.mp4",
    path: "projects/fixture/exports/movie.mp4",
    bytes: bytes.length,
  };
  const f = await serverFixture(t, (req, res) => {
    if (req.url === "/api/action")
      json(res, status(id, "succeeded", { result: { artifacts: [artifact] } }));
    else {
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": bytes.length,
      });
      res.end(bytes);
    }
  });
  const result = await f.client.download(id, "movie.mp4", output);
  assert.equal(result.sha256, sha(bytes));
  assert(fs.readFileSync(output).equals(bytes));
  await assert.rejects(f.client.download(id, "movie.mp4", output), {
    code: "OUTPUT_EXISTS",
  });
  fs.writeFileSync(output, "old");
  await f.client.download(id, artifact.path, output, { force: true });
  assert(fs.readFileSync(output).equals(bytes));
  assert(!fs.readdirSync(dir).some((name) => name.includes("frame-download")));
});

test("truncated download and output races never clobber an existing file or leave partial output", async (t) => {
  const dir = temp(t),
    id = randomUUID(),
    target = path.join(dir, "movie.mp4");
  let race = false;
  const f = await serverFixture(t, (req, res) => {
    if (req.url === "/api/action")
      json(
        res,
        status(id, "succeeded", {
          result: {
            artifacts: [
              {
                name: "movie.mp4",
                path: "projects/fixture/exports/movie.mp4",
                bytes: 4,
              },
            ],
          },
        }),
      );
    else {
      if (race) fs.writeFileSync(target, "external");
      res.writeHead(200);
      res.end(race ? "1234" : "12");
    }
  });
  fs.writeFileSync(target, "old");
  await assert.rejects(
    f.client.download(id, "movie.mp4", target, { force: true }),
    { code: "ARTIFACT_SIZE_MISMATCH" },
  );
  assert.equal(fs.readFileSync(target, "utf8"), "old");
  fs.unlinkSync(target);
  race = true;
  await assert.rejects(f.client.download(id, "movie.mp4", target), {
    code: "EEXIST",
  });
  assert.equal(fs.readFileSync(target, "utf8"), "external");
  assert(!fs.readdirSync(dir).some((name) => name.includes("frame-download")));
});

test("upload resumes after a committed chunk's response was lost; completed sessions are reusable", async (t) => {
  const dir = temp(t),
    file = path.join(dir, "asset.bin"),
    bytes = Buffer.alloc(900000, 11);
  fs.writeFileSync(file, bytes);
  const repo = randomUUID(),
    asset = { id: randomUUID() };
  let meta,
    received = Buffer.alloc(0),
    lose = true,
    complete = false;
  const f = await serverFixture(t, (_req, res, body) => {
    const a = body.args;
    if (body.name === "upload_begin") {
      meta = a;
      json(res, { id: a.requestKey, offset: 0, chunkBytes: 768 * 1024 });
    } else if (body.name === "upload_status")
      json(res, {
        ...meta,
        id: a.id,
        state: complete ? "complete" : "uploading",
        offset: received.length,
        chunkBytes: 768 * 1024,
        result: complete ? asset : null,
      });
    else if (body.name === "upload_chunk") {
      assert.equal(a.offset, received.length);
      received = Buffer.concat([received, Buffer.from(a.base64, "base64")]);
      if (lose) {
        lose = false;
        res.destroy();
      } else json(res, { offset: received.length });
    } else {
      assert.equal(sha(received), meta.sha256);
      complete = true;
      json(res, asset);
    }
  });
  let uploadId;
  await assert.rejects(
    f.client.upload(file, { repo, license: "Original" }),
    (error) => {
      uploadId = error.uploadId;
      return Boolean(uploadId);
    },
  );
  assert.equal(received.length, 768 * 1024);
  assert.deepEqual(await f.client.upload(file, { resume: uploadId }), asset);
  assert(received.equals(bytes));
  const count = f.requests.length;
  assert.deepEqual(await f.client.upload(file, { resume: uploadId }), asset);
  assert.equal(f.requests.length, count + 1);
  fs.writeFileSync(file, Buffer.alloc(bytes.length, 12));
  await assert.rejects(f.client.upload(file, { resume: uploadId }), {
    code: "UPLOAD_MISMATCH",
  });
});

test("works_browser --wait returns the final preview URL and accepts already-ready previews", async (t) => {
  const work = randomUUID(),
    task = randomUUID();
  let browserCalls = 0;
  const ready = {
    state: "ready",
    task,
    work,
    url: "https://frame.example/preview/fixture/index.html?ai=1",
  };
  const f = await serverFixture(t, (_req, res, body) => {
    if (body.name === "task_status") json(res, status(task));
    else {
      browserCalls++;
      json(res, browserCalls === 1 ? { state: "building", task } : ready);
    }
  });
  const first = await runCli(
    ["works_browser", JSON.stringify({ id: work }), "--wait"],
    f.env,
  ).result;
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), ready);
  assert.equal(
    f.requests.filter((r) => r.args.name === "task_status").length,
    1,
  );
  const second = await runCli(
    ["frame_works_browser", JSON.stringify({ id: work }), "--wait"],
    f.env,
  ).result;
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), ready);
  assert.equal(
    f.requests.filter((r) => r.args.name === "task_status").length,
    1,
    "ready previews do not wait or rebuild",
  );
  assert.equal(
    f.requests[2].args.args.rebuild,
    false,
    "completion never requests another rebuild",
  );
});

test("remote plaintext HTTP requires explicit opt-in before sending credentials", () => {
  assert.throws(
    () => new PlatformClient({ url: "http://example.test", token: "fixture" }),
    { code: "INSECURE_TRANSPORT" },
  );
  assert.doesNotThrow(
    () =>
      new PlatformClient({
        url: "http://example.test",
        token: "fixture",
        allowHttp: true,
      }),
  );
  assert.doesNotThrow(
    () => new PlatformClient({ url: "http://[::1]:5178", token: "fixture" }),
  );
});

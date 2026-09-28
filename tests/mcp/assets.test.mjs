import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import sharp from "sharp";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { fixture, repo, memoryClient, call } from "./helpers.mjs";
import { ProjectService } from "../../scripts/project-service.mjs";
import { sha256 } from "../../scripts/mcp/workspace.mjs";
import {
  AssetTransfers,
  CHUNK_BYTES,
  MAX_ASSET_BYTES,
  decodeChunk,
} from "../../scripts/asset-transfer.mjs";
import {
  publicAddress,
  assetUrl,
  openPublicAsset,
} from "../../scripts/asset-network.mjs";
import { loadRemoteConfig } from "../../scripts/mcp/remote-config.mjs";
import { startRemoteServer } from "../../scripts/mcp/remote-http.mjs";

const png = () =>
  sharp({
    create: { width: 320, height: 180, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
const meta = (bytes, filename = "测试图片.png") => ({
  filename,
  bytes: bytes.length,
  sha256: sha256(bytes),
  license: "Original test material; CC0",
});
const service = (f, options) =>
  new AssetTransfers(new ProjectService(f.root), options);
function config(f, overrides = {}) {
  return loadRemoteConfig(f.root, {
    env: {
      FRAME_MCP_PUBLIC_URL: "http://127.0.0.1:8787",
      FRAME_MCP_PORT: "0",
      FRAME_MCP_AUTH_MODE: "bearer",
      FRAME_MCP_BEARER_TOKEN: randomBytes(32).toString("hex"),
      FRAME_MCP_PROJECTS: "*",
      ...overrides,
    },
  });
}
async function runCli(f, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repo, "scripts/asset-cli.mjs"),
        "test-film",
        ...args,
        "--json",
      ],
      { cwd: f.root, env: { ...process.env, ...env }, windowsHide: true },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (s) => (stdout += s));
    child.stderr.on("data", (s) => (stderr += s));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("binary upload resumes after lost acknowledgements, rejects changed retries and commits exact bytes once", async () => {
  const f = fixture(),
    bytes = await png();
  try {
    let assets = service(f, { owner: "grant-a" });
    const state = assets.begin("test-film", meta(bytes));
    const id = state.uploadId;
    assert.throws(
      () => service(f, { owner: "grant-b" }).status("test-film", id),
      { code: "UPLOAD_DENIED" },
    );
    assets.chunk(
      "test-film",
      id,
      0,
      bytes.subarray(0, 64),
      sha256(bytes.subarray(0, 64)),
    );
    assert.equal(
      assets.chunk("test-film", id, 0, bytes.subarray(0, 64)).replayed,
      true,
    );
    assert.throws(() => assets.chunk("test-film", id, 0, Buffer.alloc(64)), {
      code: "CHUNK_CONFLICT",
    });
    assert.throws(() => assets.chunk("test-film", id, 80, bytes.subarray(64)), {
      code: "OFFSET_MISMATCH",
    });
    await assert.rejects(assets.complete("test-film", id), {
      code: "UPLOAD_INCOMPLETE",
    });
    // An unacknowledged tail must be discarded when the server resumes.
    fs.appendFileSync(
      assets.file("test-film", id, "payload.part"),
      "interrupted tail",
    );
    assets = service(f, { owner: "grant-a" });
    assert.equal(assets.status("test-film", id).receivedBytes, 64);
    assets.chunk("test-film", id, 64, bytes.subarray(64));
    const result = await assets.complete("test-film", id);
    assert.equal(result.status, "completed");
    assert.deepEqual(fs.readFileSync(result.asset.absolutePath), bytes);
    assert.equal(result.asset.sha256, sha256(bytes));
    assert.equal(
      (await assets.complete("test-film", id)).asset.url,
      result.asset.url,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(f.file("public/assets.json"))).filter(
        (a) => a.transferId === id,
      ).length,
      1,
    );
    const read = assets.read("test-film", result.asset.path, {
      metadataOnly: false,
      offset: 13,
      length: 80,
    });
    assert.deepEqual(
      Buffer.from(read.dataBase64, "base64"),
      bytes.subarray(13, 93),
    );
    assert.equal(read.chunkSha256, sha256(bytes.subarray(13, 93)));
    assert.equal(
      fs.existsSync(assets.file("test-film", id, "payload.part")),
      false,
    );
  } finally {
    f.close();
  }
});

test("upload limits, hash/signature validation, read-only and path boundaries fail without publishing", async () => {
  const f = fixture(),
    bytes = await png();
  try {
    const assets = service(f);
    assert.throws(
      () =>
        assets.begin("test-film", {
          ...meta(bytes),
          filename: "../escape.png",
        }),
      { code: "INVALID_FILENAME" },
    );
    assert.throws(
      () => assets.begin("test-film", { ...meta(bytes), filename: "con.png" }),
      { code: "INVALID_PATH" },
    );
    assert.throws(
      () => assets.begin("test-film", { ...meta(bytes), filename: "run.exe" }),
      { code: "UNSUPPORTED_ASSET" },
    );
    assert.throws(
      () =>
        new AssetTransfers(
          new ProjectService(f.root, { readOnly: true }),
        ).begin("test-film", meta(bytes)),
      { code: "READ_ONLY" },
    );
    assert.throws(() => decodeChunk("data:image/png;base64,AA=="), {
      code: "INVALID_BASE64",
    });
    assert.throws(() => decodeChunk("AB=="), { code: "INVALID_BASE64" });
    const bad = assets.begin("test-film", {
      ...meta(bytes),
      sha256: "0".repeat(64),
    });
    assets.chunk("test-film", bad.uploadId, 0, bytes);
    await assert.rejects(assets.complete("test-film", bad.uploadId), {
      code: "CHECKSUM_MISMATCH",
    });
    await assets.abort("test-film", bad.uploadId);
    const fake = Buffer.from("<html>not a PNG file</html>");
    await assert.rejects(
      assets.upload("test-film", {
        ...meta(fake),
        dataBase64: fake.toString("base64"),
      }),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(f.file("public/assets.json"))),
      [],
    );
    await assets.prune("test-film");
    const large = assets.begin("test-film", {
      ...meta(bytes),
      bytes: MAX_ASSET_BYTES,
    });
    assert.throws(
      () =>
        assets.begin("test-film", { ...meta(bytes), bytes: MAX_ASSET_BYTES }),
      { code: "UPLOAD_QUOTA" },
    );
    assert.throws(
      () =>
        assets.chunk(
          "test-film",
          large.uploadId,
          0,
          Buffer.alloc(CHUNK_BYTES + 1),
        ),
      { code: "INVALID_CHUNK" },
    );
    await assets.abort("test-film", large.uploadId);
  } finally {
    f.close();
  }
});

test("commit recovery reuses its catalog entry, expired uploads prune only their own cache and links are rejected", async () => {
  const f = fixture(),
    bytes = await png();
  let now = Date.now();
  try {
    const assets = service(f, { now: () => now });
    const created = await assets.upload("test-film", {
      ...meta(bytes),
      dataBase64: bytes.toString("base64"),
    });
    const state = assets.load("test-film", created.uploadId);
    state.status = "committing";
    assets.save(state);
    fs.writeFileSync(
      assets.file("test-film", state.uploadId, "payload.part"),
      bytes,
    );
    assert.equal(
      (await assets.complete("test-film", state.uploadId)).status,
      "completed",
    );
    const active = assets.begin("test-film", meta(bytes));
    const foreign = service(f, { owner: "other" }).begin(
      "test-film",
      meta(bytes),
    );
    now += 25 * 3600000;
    assert.throws(() => assets.chunk("test-film", active.uploadId, 0, bytes), {
      code: "UPLOAD_STATE",
    });
    const removed = await assets.prune("test-film");
    assert.ok(removed.removed.includes(active.uploadId));
    assert.ok(!removed.removed.includes(foreign.uploadId));
    assert.ok(fs.existsSync(created.asset.absolutePath));
    const linked = assets.begin("test-film", meta(bytes));
    const payload = assets.file("test-film", linked.uploadId, "payload.part");
    fs.unlinkSync(payload);
    fs.linkSync(created.asset.absolutePath, payload);
    assert.throws(() => assets.chunk("test-film", linked.uploadId, 0, bytes), {
      code: "UNSAFE_LINK",
    });
    fs.unlinkSync(payload);
  } finally {
    f.close();
  }
});

test("URL downloads run in background, preserve bytes, enforce byte limits and cancel without publishing", async () => {
  const f = fixture(),
    bytes = await png();
  const response = (chunks, headers = {}) =>
    Object.assign(Readable.from(chunks), { headers });
  const assets = service(f, {
    openUrl: async () =>
      response([bytes.subarray(0, 100), bytes.subarray(100)], {
        "content-length": String(bytes.length),
      }),
  });
  try {
    const started = assets.fetch("test-film", {
      url: "https://example.com/material.png?private-signature=hidden",
      ...meta(bytes),
      maxBytes: 4096,
    });
    assert.equal(started.status, "fetching");
    const result = await assets.wait("test-film", started.uploadId, 20000);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(result.asset.absolutePath), bytes);
    assert.equal(result.asset.source, "https://example.com/material.png");
    const tooLarge = assets.fetch("test-film", {
      url: "https://example.com/too-large.png",
      ...meta(bytes),
      maxBytes: 12,
    });
    assert.equal(
      (await assets.wait("test-film", tooLarge.uploadId, 20000)).status,
      "failed",
    );
    await assets.abort("test-film", tooLarge.uploadId);
    const slow = service(f, {
      openUrl: async (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        ),
    });
    const pending = slow.fetch("test-film", {
      url: "https://example.com/slow.png",
      ...meta(bytes),
    });
    assert.equal(
      (await slow.abort("test-film", pending.uploadId)).status,
      "aborted",
    );
    await slow.close();
  } finally {
    await assets.close();
    f.close();
  }
});

test("HTTPS downloader pins public DNS, revalidates redirects and refuses local/mixed-address hosts", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "2001:db8::1",
    "100.64.0.1",
    "192.168.1.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  assert.throws(() => assetUrl("http://example.com/a.png"), {
    code: "INVALID_URL",
  });
  assert.throws(() => assetUrl("https://user:password@example.com/a.png"), {
    code: "INVALID_URL",
  });
  await assert.rejects(openPublicAsset("https://127.0.0.1/a.png"), {
    code: "URL_DENIED",
  });
  const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  let calls = 0;
  const request = (url, options, callback) => {
    calls++;
    assert.equal(options.agent, false);
    options.lookup(url.hostname, { all: true }, (_error, records) =>
      assert.deepEqual(records, [{ address: "8.8.8.8", family: 4 }]),
    );
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () =>
      callback(
        Object.assign(Readable.from([]), {
          statusCode: 302,
          headers: { location: "https://127.0.0.1/private" },
        }),
      );
    return req;
  };
  await assert.rejects(
    openPublicAsset("https://example.com/a.png", { lookup, request }),
    { code: "URL_DENIED" },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    openPublicAsset("https://example.com/a.png", {
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      request,
    }),
    { code: "URL_DENIED" },
  );
});

test("MCP exposes binary transfer tools and returns actionable receipts and byte chunks", async () => {
  const f = fixture(),
    bytes = await png();
  const session = await memoryClient(f.root);
  try {
    const result = await call(session.client, "frame_upload_asset", {
      project: "test-film",
      filename: "from-mcp.png",
      license: "CC0",
      sha256: sha256(bytes),
      dataBase64: bytes.toString("base64"),
    });
    assert.equal(result.status, "completed");
    const read = await call(session.client, "frame_read_asset", {
      project: "test-film",
      path: result.asset.path,
      metadataOnly: false,
    });
    assert.deepEqual(Buffer.from(read.dataBase64, "base64"), bytes);
    const unknown = await session.client.callTool({
      name: "frame_asset_upload",
      arguments: { project: "test-film", action: "chunk" },
    });
    assert.equal(unknown.isError, true);
  } finally {
    await session.close();
    f.close();
  }
});

test(
  "HTTP raw upload survives service restart, protects scopes/owners, streams Range and works with remote CLI",
  { timeout: 60000 },
  async () => {
    const f = fixture(),
      bytes = await png(),
      cfg = config(f);
    let app, client;
    try {
      app = await startRemoteServer(cfg);
      cfg.publicUrl = app.url;
      cfg.resource = app.url + "/mcp";
      cfg.origins = [app.url];
      const req = (suffix, method = "GET", body, headers = {}) =>
        fetch(app.url + suffix, {
          method,
          headers: { Authorization: "Bearer " + cfg.bearerToken, ...headers },
          body,
        });
      let r = await req(
        "/uploads/test-film",
        "POST",
        JSON.stringify(meta(bytes)),
        { "Content-Type": "application/json" },
      );
      assert.equal(r.status, 200);
      const state = await r.json(),
        upload = "/uploads/test-film/" + state.uploadId;
      r = await req(upload, "PATCH", bytes.subarray(0, 70), {
        "Content-Type": "application/octet-stream",
        "Upload-Offset": "0",
      });
      assert.equal(r.status, 200);
      await app.close();
      app = await startRemoteServer(cfg);
      cfg.publicUrl = app.url;
      cfg.resource = app.url + "/mcp";
      cfg.origins = [app.url];
      assert.equal((await (await req(upload)).json()).receivedBytes, 70);
      assert.equal((await fetch(app.url + upload)).status, 401);
      const token = cfg.bearerToken;
      cfg.bearerToken = randomBytes(32).toString("hex");
      assert.equal((await req(upload)).status, 403);
      cfg.bearerToken = token;
      cfg.bearerScopes = ["frame:read"];
      assert.equal(
        (
          await req(upload, "PATCH", bytes.subarray(70), {
            "Content-Type": "application/octet-stream",
            "Upload-Offset": "70",
          })
        ).status,
        403,
      );
      cfg.bearerScopes = ["frame:read", "frame:write"];
      r = await req(upload, "PATCH", bytes.subarray(70), {
        "Content-Type": "application/octet-stream",
        "Upload-Offset": "70",
      });
      assert.equal(r.status, 200);
      r = await req(upload + "/complete", "POST");
      const finished = await r.json();
      assert.equal(finished.status, "completed", JSON.stringify(finished));
      const download = `/assets/test-film/${finished.asset.path}`;
      assert.equal((await fetch(app.url + download)).status, 401);
      r = await req(download, "GET", undefined, { Range: "bytes=10-29" });
      assert.equal(r.status, 206);
      assert.deepEqual(
        Buffer.from(await r.arrayBuffer()),
        bytes.subarray(10, 30),
      );
      assert.equal(
        (await req(download, "HEAD")).headers.get("content-length"),
        String(bytes.length),
      );
      assert.equal((await req("/assets/test-film/project.ts")).status, 404);
      client = new Client({ name: "asset-test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(cfg.resource), {
          requestInit: { headers: { Authorization: "Bearer " + token } },
        }),
      );
      const read = await call(client, "frame_read_asset", {
        project: "test-film",
        path: finished.asset.path,
      });
      assert.ok(read.remoteArtifacts[0].uri.includes("/assets/test-film/"));
      const source = f.file("source.png");
      fs.writeFileSync(source, bytes);
      const cli = await runCli(
        f,
        ["upload", source, "--license", "CC0", "--endpoint", app.url],
        { FRAME_MCP_BEARER_TOKEN: token },
      );
      assert.equal(cli.code, 0, cli.stderr);
      const uploaded = JSON.parse(cli.stdout);
      assert.equal(uploaded.asset.sha256, sha256(bytes));
      const resumed = await runCli(
        f,
        [
          "upload",
          source,
          "--resume",
          uploaded.uploadId,
          "--endpoint",
          app.url,
        ],
        { FRAME_MCP_BEARER_TOKEN: token },
      );
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).asset.url, uploaded.asset.url);
    } finally {
      await client?.close();
      await app?.close();
      f.close();
    }
  },
);

test("proxy fake DNS resolves through public DNS while private results and interrupted lookups stay blocked", async () => {
  let dnsCalls = 0;
  const publicDns = async () => {
    dnsCalls++;
    return [{ address: "8.8.8.8", family: 4 }];
  };
  const lookup = async () => [{ address: "198.18.0.12", family: 4 }];
  const request = (_url, options, callback) => {
    options.lookup("example.com", {}, (_error, address) =>
      assert.equal(address, "8.8.8.8"),
    );
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () =>
      callback(
        Object.assign(Readable.from([Buffer.from("verified")]), {
          statusCode: 200,
          headers: {},
        }),
      );
    return req;
  };
  const response = await openPublicAsset("https://example.com/asset.png", {
    lookup,
    publicDns,
    request,
  });
  const body = [];
  for await (const chunk of response) body.push(chunk);
  assert.equal(Buffer.concat(body).toString(), "verified");
  assert.equal(dnsCalls, 1);
  await assert.rejects(
    openPublicAsset("https://198.18.0.12/file.png", { publicDns, request }),
    { code: "URL_DENIED" },
  );
  assert.equal(dnsCalls, 1);
  await assert.rejects(
    openPublicAsset("https://example.com/asset.png", {
      lookup,
      publicDns: async () => [{ address: "127.0.0.1", family: 4 }],
      request,
    }),
    { code: "URL_DENIED" },
  );
  const controller = new AbortController();
  const pending = openPublicAsset("https://example.com/asset.png", {
    signal: controller.signal,
    lookup: () => new Promise(() => {}),
  });
  controller.abort(new Error("lookup cancelled"));
  await assert.rejects(pending, /lookup cancelled/);
});

function modelBytes(binarySize = 2 * CHUNK_BYTES) {
  const text = JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ byteLength: binarySize }],
  });
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
  const bytes = Buffer.alloc(12 + 8 + json.length + 8 + binarySize);
  bytes.write("glTF");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.write("JSON", 16);
  json.copy(bytes, 20);
  bytes.writeUInt32LE(binarySize, 20 + json.length);
  bytes.write("BIN\0", 24 + json.length);
  randomBytes(binarySize).copy(bytes, 28 + json.length);
  return bytes;
}

test("multi-megabyte GLB transfers preserve all binary chunks and requestId deduplicates retries", async () => {
  const f = fixture(),
    bytes = modelBytes(),
    assets = service(f);
  try {
    const options = { ...meta(bytes, "model.glb"), requestId: randomUUID() };
    const first = assets.begin("test-film", options);
    assert.equal(assets.begin("test-film", options).uploadId, first.uploadId);
    assert.throws(
      () => assets.begin("test-film", { ...options, license: "changed" }),
      { code: "UPLOAD_CONFLICT" },
    );
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
      assets.chunk(
        "test-film",
        first.uploadId,
        offset,
        bytes.subarray(offset, offset + CHUNK_BYTES),
      );
    const result = await assets.complete("test-film", first.uploadId);
    assert.deepEqual(fs.readFileSync(result.asset.absolutePath), bytes);
    assert.equal(assets.begin("test-film", options).status, "completed");
    const image = await png(),
      small = {
        ...meta(image),
        requestId: randomUUID(),
        dataBase64: image.toString("base64"),
      };
    const uploaded = await assets.upload("test-film", small);
    assert.equal(
      (await assets.upload("test-film", small)).asset.url,
      uploaded.asset.url,
    );
    const gltf = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "http://localhost/private.bin" }],
      }),
    );
    await assert.rejects(
      assets.upload("test-film", {
        ...meta(gltf, "external.gltf"),
        dataBase64: gltf.toString("base64"),
      }),
      { code: "EXTERNAL_RESOURCE" },
    );
  } finally {
    f.close();
  }
});

test(
  "remote CLI resumes a partially acknowledged multi-megabyte source",
  { timeout: 60000 },
  async () => {
    const f = fixture(),
      bytes = modelBytes(),
      cfg = config(f);
    let app;
    try {
      app = await startRemoteServer(cfg);
      cfg.publicUrl = app.url;
      cfg.resource = app.url + "/mcp";
      const source = f.file("large.glb");
      fs.writeFileSync(source, bytes);
      const headers = { Authorization: "Bearer " + cfg.bearerToken };
      const response = await fetch(app.url + "/uploads/test-film", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(meta(bytes, "large.glb")),
      });
      const state = await response.json();
      const chunk = await fetch(
        app.url + "/uploads/test-film/" + state.uploadId,
        {
          method: "PATCH",
          headers: {
            ...headers,
            "Content-Type": "application/octet-stream",
            "Upload-Offset": "0",
          },
          body: bytes.subarray(0, CHUNK_BYTES),
        },
      );
      assert.equal(chunk.status, 200);
      const result = await runCli(
        f,
        ["upload", source, "--resume", state.uploadId, "--endpoint", app.url],
        { FRAME_MCP_BEARER_TOKEN: cfg.bearerToken },
      );
      assert.equal(result.code, 0, result.stderr);
      const completed = JSON.parse(result.stdout);
      assert.equal(completed.asset.sha256, sha256(bytes));
      assert.deepEqual(fs.readFileSync(completed.asset.absolutePath), bytes);
    } finally {
      await app?.close();
      f.close();
    }
  },
);

test("local CLI imports original bytes and reports machine-readable results", async () => {
  const f = fixture(),
    bytes = await png();
  try {
    const source = f.file("local.png");
    fs.writeFileSync(source, bytes);
    const result = await runCli(f, ["upload", source, "--license", "CC0"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      fs.readFileSync(JSON.parse(result.stdout).asset.absolutePath),
      bytes,
    );
  } finally {
    f.close();
  }
});

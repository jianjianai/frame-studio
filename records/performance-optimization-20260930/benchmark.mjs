import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { ProjectService } from "../../scripts/project-service.mjs";
import { inputManifest } from "../../scripts/production-input.mjs";
import { listSource } from "../../server/project-text.mjs";
import { projectAssets } from "../../scripts/project-assets.mjs";
import { memoryClient } from "../../tests/mcp/helpers.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const owned = path.join(root, ".cache/performance-audit", randomUUID());
fs.mkdirSync(owned, { recursive: true });
const out =
  process.env.FRAME_PERF_OUTPUT ||
  path.join(root, "records/performance-optimization-20260930/results.json");
const result = {
  baseline: process.env.FRAME_PERF_BASELINE || "working checkout",
  node: process.version,
  started: new Date().toISOString(),
  fixture:
    "isolated synthetic local work; warm filesystem; no production mutation",
  measurements: [],
};
function summary(samples) {
  const a = [...samples].sort((a, b) => a - b);
  return {
    n: a.length,
    minMs: +a[0].toFixed(2),
    medianMs: +a[Math.floor(a.length / 2)].toFixed(2),
    maxMs: +a.at(-1).toFixed(2),
    samplesMs: samples.map((v) => +v.toFixed(2)),
  };
}
async function measure(name, fn, n = 5) {
  const samples = [];
  let value;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    value = await fn();
    samples.push(performance.now() - t);
  }
  const row = { name, ...summary(samples) };
  result.measurements.push(row);
  console.log(JSON.stringify(row));
  return value;
}
function trackedSync(fn) {
  let bytes = 0,
    calls = 0;
  const original = fs.readSync;
  fs.readSync = function (...args) {
    const n = original.apply(this, args);
    bytes += n;
    calls++;
    return n;
  };
  const t = performance.now();
  let value;
  try {
    value = fn();
  } finally {
    fs.readSync = original;
  }
  return {
    elapsedMs: +(performance.now() - t).toFixed(2),
    syncReadBytes: bytes,
    syncReadCalls: calls,
    value,
  };
}
async function timerDelay(fn) {
  let last = performance.now(),
    maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  try {
    await new Promise((r) => setTimeout(r, 15));
    const start = performance.now();
    const value = await fn();
    const elapsed = performance.now() - start;
    await new Promise((r) => setTimeout(r, 15));
    return {
      elapsedMs: +elapsed.toFixed(2),
      timerDelayMs: +Math.max(0, maxGap - 10).toFixed(2),
      value,
    };
  } finally {
    clearInterval(timer);
  }
}
function media(file, mib) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  const block = Buffer.alloc(1024 * 1024, 37);
  try {
    for (let i = 0; i < mib; i++) fs.writeSync(fd, block);
  } finally {
    fs.closeSync(fd);
  }
}
let app, local;
try {
  if (
    !/\/frame_test[^/]*$/.test(
      new URL(process.env.FRAME_TEST_DATABASE_URL).pathname,
    )
  )
    throw Error("Use an isolated frame_test database only");
  const db = await database(
    process.env.FRAME_TEST_DATABASE_URL,
    "performance-fixture-only-1234",
  );
  const created = await createApp({
    db,
    data: path.join(owned, "data"),
    masterKey: "7a".repeat(32),
    origin: "http://frame.perf",
    scheduler: false,
  });
  app = created.app;
  const actions = created.actions;
  const repo = await actions.call("repositories_add", {
    name: "Synthetic performance fixture",
  });
  const work = await actions.call("works_create", {
    repo: repo.id,
    title: "Performance fixture",
    duration: 2,
    fps: 12,
  });
  const { repo: r, dir } = await created.repos.project(work.repo, work.project);
  const token = await actions.call("tokens_create", { name: "fixture only" });
  const headers = {
    authorization: "Bearer " + token.token,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  let rpcId = 0;
  async function rpc(method, params = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
    });
    if (response.statusCode !== 200) throw Error(response.body);
    const message = response.headers["content-type"]?.includes(
      "text/event-stream",
    )
      ? response.body
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => JSON.parse(l.slice(5)))
          .find((v) => v.id === rpcId)
      : response.json();
    if (message.error || message.result?.isError)
      throw Error(JSON.stringify(message));
    return {
      result: message.result,
      wireBytes: Buffer.byteLength(response.body),
    };
  }
  await measure(
    "platform MCP initialize",
    () =>
      rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "frame-perf", version: "1" },
      }),
    3,
  );
  const tools = await measure("platform MCP tools/list repeated", () =>
    rpc("tools/list"),
  );
  result.discovery = {
    toolCount: tools.result.tools.length,
    wireBytes: tools.wireBytes,
  };
  await measure(
    "platform MCP cheap tool engines_list",
    () => rpc("tools/call", { name: "frame_engines_list", arguments: {} }),
    10,
  );
  await measure(
    "platform action cheap tool engines_list",
    () => actions.call("engines_list", {}),
    10,
  );
  await measure(
    "platform MCP works_context compact",
    () =>
      rpc("tools/call", {
        name: "frame_works_context",
        arguments: { id: work.id },
      }),
    5,
  );
  const status = await actions.call("works_context", { id: work.id });
  result.contextWireBytes = Buffer.byteLength(JSON.stringify(status));
  const workspace = new ProjectService(r.root, { projects: [work.project] });
  const asset = path.join(dir, "public/perf-large.bin");
  const scene = path.join(dir, "scene.ts");
  const base = fs.readFileSync(scene, "utf8");
  let revision = 0;
  for (const mib of [0, 64, 512]) {
    if (mib) media(asset, mib);
    else if (fs.existsSync(asset)) fs.unlinkSync(asset);
    await measure(
      "platform batch edit " + mib + " MiB media",
      async () => {
        const current = workspace.textFile(work.project, "scene.ts");
        const content = base + "\n// benchmark revision " + ++revision + "\n";
        const timed = await timerDelay(() =>
          actions.call("works_edit", {
            id: work.id,
            changes: [
              { path: "scene.ts", expectedSha256: current.sha256, content },
            ],
          }),
        );
        result.measurements.push({
          name: "platform edit timer delay " + mib + " MiB",
          timerDelayMs: timed.timerDelayMs,
        });
        return timed.value;
      },
      3,
    );
    const hash = trackedSync(() => workspace.fingerprint(work.project));
    result.measurements.push({
      name: "one input fingerprint " + mib + " MiB",
      elapsedMs: hash.elapsedMs,
      syncReadBytes: hash.syncReadBytes,
      syncReadCalls: hash.syncReadCalls,
    });
  }
  const current = workspace.textFile(work.project, "scene.ts");
  let bytes = 0,
    calls = 0;
  const original = fs.readSync;
  fs.readSync = function (...args) {
    const n = original.apply(this, args);
    bytes += n;
    calls++;
    return n;
  };
  const t = performance.now();
  await actions.call("works_patch_batch", {
    id: work.id,
    changes: [
      {
        path: "scene.ts",
        expectedSha256: current.sha256,
        replacements: [
          {
            find: "// benchmark revision " + revision,
            replace: "// benchmark revision " + ++revision,
            count: 1,
          },
        ],
      },
    ],
  });
  fs.readSync = original;
  result.measurements.push({
    name: "platform batch patch 512 MiB sync IO",
    elapsedMs: +(performance.now() - t).toFixed(2),
    syncReadBytes: bytes,
    syncReadCalls: calls,
  });
  fs.unlinkSync(asset);
  // File pagination runs against the platform's actual operation.
  const files = path.join(dir, "public/perf-files");
  fs.mkdirSync(files, { recursive: true });
  let count = 0;
  for (const desired of [100, 2000, 8000]) {
    for (; count < desired; count++)
      fs.writeFileSync(
        path.join(files, String(count).padStart(5, "0") + ".txt"),
        "performance file\n".repeat(4),
      );
    await measure(
      "platform files page 1 of " + desired,
      () =>
        actions.call("works_files_page", { id: work.id, limit: 60, offset: 0 }),
      3,
    );
    await measure(
      "platform files page 2 of " + desired,
      () =>
        actions.call("works_files_page", {
          id: work.id,
          limit: 60,
          offset: 60,
        }),
      3,
    );
    await measure(
      "platform search absent " + desired,
      () =>
        actions.call("works_search", {
          id: work.id,
          query: "NO_MATCH_PERFORMANCE_TOKEN",
          limit: 30,
        }),
      2,
    );
    await measure(
      "platform compact context cold asset scan " + desired,
      () => {
        created.assets.scans?.clear();
        return actions.call("works_context", { id: work.id });
      },
      2,
    );
  }
  fs.rmSync(files, { recursive: true });
  // Checkpoint listing reads complete JSON bodies even though it returns only metadata.
  const history = path.join(dir, ".history/checkpoints");
  fs.mkdirSync(history, { recursive: true });
  const existing = fs.readdirSync(history).length;
  for (let i = existing; i < 60; i++)
    fs.writeFileSync(
      path.join(history, randomUUID() + ".json"),
      JSON.stringify({
        checkpoint: randomUUID(),
        time: new Date().toISOString(),
        label: "synthetic",
        fingerprint: "a".repeat(64),
        files: {
          "large.txt": {
            content: "a".repeat(1024 * 1024),
            sha256: "b".repeat(64),
          },
        },
      }),
    );
  await measure(
    "local history 60 checkpoints approximately 1 MiB each",
    () => workspace.history(work.project),
    3,
  );
  // Local MCP: shared engine + scripts are included in every fingerprint.
  const localRoot = path.join(owned, "local");
  fs.mkdirSync(localRoot, { recursive: true });
  for (const name of ["src", "scripts", "public", "docs", "templates"])
    if (fs.existsSync(path.join(root, name)))
      fs.cpSync(path.join(root, name), path.join(localRoot, name), {
        recursive: true,
      });
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
    "pnpm-workspace.yaml",
    "AGENTS.md",
  ])
    if (fs.existsSync(path.join(root, name)))
      fs.copyFileSync(path.join(root, name), path.join(localRoot, name));
  fs.mkdirSync(path.join(localRoot, "projects"), { recursive: true });
  fs.cpSync(dir, path.join(localRoot, "projects", work.project), {
    recursive: true,
    filter: (source) =>
      !path
        .relative(dir, source)
        .split(path.sep)
        .some((part) => [".history", ".cache"].includes(part)),
  });
  const localWs = new ProjectService(localRoot, { projects: [work.project] });
  local = await memoryClient(localRoot, {
    readOnly: false,
    projects: [work.project],
  });
  const localTools = await measure(
    "local persistent MCP tools/list",
    () => local.client.listTools(),
    5,
  );
  result.localDiscovery = {
    toolCount: localTools.tools.length,
    wireBytes: Buffer.byteLength(JSON.stringify(localTools)),
  };
  await measure(
    "local persistent MCP frame_renderers",
    () => local.client.callTool({ name: "frame_renderers", arguments: {} }),
    10,
  );
  const localAsset = path.join(
    localRoot,
    "projects",
    work.project,
    "public/perf-large.bin",
  );
  media(localAsset, 512);
  const localHash = trackedSync(() => localWs.fingerprint(work.project));
  result.measurements.push({
    name: "local MCP fingerprint shared inputs plus 512 MiB",
    elapsedMs: localHash.elapsedMs,
    syncReadBytes: localHash.syncReadBytes,
  });
  const delayed = await timerDelay(() =>
    local.client.callTool({
      name: "frame_checkpoint",
      arguments: { project: work.project, label: "performance fixture" },
    }),
  );
  if (delayed.value.isError) throw Error(JSON.stringify(delayed.value));
  result.measurements.push({
    name: "local MCP checkpoint 512 MiB",
    elapsedMs: delayed.elapsedMs,
    timerDelayMs: delayed.timerDelayMs,
  });
  // Measure both manifest preparation and the real bounded-memory output copy.
  for (const mib of [512, 1024]) {
    if (mib !== 512) media(localAsset, mib);
    const assetOutput = path.join(
      localRoot,
      "projects",
      work.project,
      "exports",
      "asset-memory-" + mib,
    );
    const plugin = projectAssets({ project: work.project });
    plugin.configResolved({
      root: localRoot,
      build: { write: true, outDir: assetOutput },
    });
    const emitted = [];
    global.gc?.();
    const before = process.memoryUsage();
    const peak = { rss: before.rss, arrayBuffers: before.arrayBuffers };
    const observeMemory = () => {
      const memory = process.memoryUsage();
      peak.rss = Math.max(peak.rss, memory.rss);
      peak.arrayBuffers = Math.max(peak.arrayBuffers, memory.arrayBuffers);
    };
    const timer = setInterval(observeMemory, 5);
    try {
      const assetsStart = performance.now();
      await plugin.generateBundle.call(
        {
          emitFile: (file) => {
            emitted.push(file);
            return String(emitted.length);
          },
        },
        {},
        {},
      );
      observeMemory();
      const prepared = process.memoryUsage();
      result.measurements.push({
        name: "projectAssets generateBundle " + mib + " MiB",
        elapsedMs: +(performance.now() - assetsStart).toFixed(2),
        emittedBytes: emitted.reduce(
          (s, f) => s + Buffer.byteLength(f.source),
          0,
        ),
        rssDelta: prepared.rss - before.rss,
        arrayBuffersDelta: prepared.arrayBuffers - before.arrayBuffers,
      });
      const copyStart = performance.now();
      await plugin.writeBundle({ dir: assetOutput }, {});
      observeMemory();
      const copied = path.join(
        assetOutput,
        "films",
        work.project,
        "perf-large.bin",
      );
      const handle = await fs.promises.open(copied, "r");
      let samplesIntact;
      try {
        const sample = Buffer.alloc(16);
        const first = await handle.read(sample, 0, sample.length, 0);
        samplesIntact =
          first.bytesRead === 16 && sample.every((byte) => byte === 37);
        const last = await handle.read(
          sample,
          0,
          sample.length,
          mib * 1024 * 1024 - sample.length,
        );
        samplesIntact &&=
          last.bytesRead === 16 && sample.every((byte) => byte === 37);
      } finally {
        await handle.close();
      }
      const copiedBytes = fs.statSync(copied).size;
      if (copiedBytes !== mib * 1024 * 1024 || !samplesIntact)
        throw Error("Asset copy did not preserve fixture bytes");
      result.measurements.push({
        name: "projectAssets output copy " + mib + " MiB",
        elapsedMs: +(performance.now() - copyStart).toFixed(2),
        copiedBytes,
        samplesIntact,
        emittedBytes: emitted.reduce(
          (s, f) => s + Buffer.byteLength(f.source),
          0,
        ),
        peakRssDelta: peak.rss - before.rss,
        peakArrayBuffersDelta: peak.arrayBuffers - before.arrayBuffers,
        reusableBufferBytes: 1024 * 1024,
      });
    } finally {
      clearInterval(timer);
      fs.rmSync(assetOutput, { recursive: true, force: true });
    }
  }
  result.finished = new Date().toISOString();
} catch (error) {
  result.error = error.stack;
  throw error;
} finally {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  await local?.close();
  await app?.close();
  fs.rmSync(owned, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      output: out,
      discovery: result.discovery,
      localDiscovery: result.localDiscovery,
      error: result.error,
    }),
  );
}

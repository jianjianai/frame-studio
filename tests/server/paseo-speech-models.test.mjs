import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSharedSpeechModels,
  loadOfficialSpeechModels,
  prepareDaemonSpeechModels,
  SHARED_SPEECH_STATE,
} from "../../integrations/paseo/speech-models.mjs";

const catalogue = [
  {
    id: "stt",
    extractedDir: "stt-model",
    requiredFiles: ["weights.bin"],
    archiveUrl: "https://example.invalid/stt.tar.bz2",
    defaultFor: "stt",
  },
  {
    id: "optional",
    extractedDir: "optional-model",
    requiredFiles: ["weights.bin"],
    archiveUrl: "https://example.invalid/optional.tar.bz2",
  },
  {
    id: "tts",
    extractedDir: "tts-model",
    requiredFiles: ["weights.bin", "data"],
    archiveUrl: "https://example.invalid/tts.tar.bz2",
    defaultFor: "tts",
  },
];
async function temporary(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "frame-shared-speech-"));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  return data;
}
async function until(check) {
  const limit = Date.now() + 5000;
  while (Date.now() < limit) {
    const result = await check();
    if (result) return result;
    await delay(10);
  }
  throw Error("Timed out waiting for shared speech fixture");
}
async function readState(root) {
  const text = await fs
    .readFile(path.join(root, SHARED_SPEECH_STATE), "utf8")
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  return text ? JSON.parse(text) : { state: null };
}
const missing = (file) =>
  fs.stat(file).then(
    () => false,
    (error) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );
async function writeModel(root, model) {
  for (const relative of model.requiredFiles) {
    const file = path.join(root, model.extractedDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (relative === "data" || relative === "espeak-ng-data")
      await fs.mkdir(file, { recursive: true });
    else await fs.writeFile(file, "finite fixture weights");
  }
}
function factory(data, downloader, extra = {}) {
  return createSharedSpeechModels({
    data,
    catalog: catalogue,
    downloader,
    heartbeatMs: 40,
    staleMs: 500,
    pollMs: 10,
    ...extra,
  });
}

test("shared speech has one writer across factories, publishes whole directories, and reuses ready state", async (t) => {
  const data = await temporary(t),
    calls = [];
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  const downloader = async ({ modelsDir, modelIds, signal }) => {
    calls.push(modelIds[0]);
    if (calls.length === 1)
      await new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        gate.then(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        });
      });
    await writeModel(
      modelsDir,
      catalogue.find((model) => model.id === modelIds[0]),
    );
  };
  const first = factory(data, downloader),
    second = factory(data, downloader);
  t.after(() => Promise.all([first.close(), second.close()]));
  const [root, sameRoot] = await Promise.all([first.start(), second.start()]);
  assert.equal(root, sameRoot);
  await until(() => calls.length === 1);
  assert.equal((await readState(root)).state, "preparing");
  assert.equal(await missing(path.join(root, "stt-model")), true);
  unblock();
  await until(async () => (await readState(root)).state === "ready");
  await until(() => missing(path.join(root, ".frame-speech-lock")));
  assert.deepEqual(calls, ["stt", "tts", "optional"]);
  assert.deepEqual(
    new Set((await readState(root)).completedModelIds),
    new Set(["stt", "tts", "optional"]),
  );
  const before = await fs.readFile(path.join(root, SHARED_SPEECH_STATE));
  const stamp = (await fs.stat(path.join(root, SHARED_SPEECH_STATE))).mtimeMs;
  await first.start();
  await delay(100);
  assert.equal(
    (await fs.stat(path.join(root, SHARED_SPEECH_STATE))).mtimeMs,
    stamp,
  );
  assert.deepEqual(
    await fs.readFile(path.join(root, SHARED_SPEECH_STATE)),
    before,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(await fs.readdir(path.join(root, ".frame-staging")), []);
});

test("prefilled archives are linked without copying and preserved after official extraction cleanup", async (t) => {
  const data = await temporary(t),
    root = path.join(data, "paseo-models"),
    archive = path.join(root, ".downloads", "stt.tar.bz2");
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, "trusted archive fixture");
  const original = await fs.stat(archive);
  const cache = factory(data, async ({ modelsDir, modelIds }) => {
    if (modelIds[0] === "stt") {
      const staged = path.join(modelsDir, ".downloads", "stt.tar.bz2"),
        linked = await fs.stat(staged);
      assert.equal(linked.ino, original.ino);
      assert.equal(linked.dev, original.dev);
      assert.equal(linked.nlink, 2);
      await fs.unlink(staged); // The official downloader removes its archive after verification.
    }
    await writeModel(
      modelsDir,
      catalogue.find((model) => model.id === modelIds[0]),
    );
  });
  t.after(() => cache.close());
  await cache.start();
  await until(async () => (await readState(root)).state === "ready");
  await until(() => missing(path.join(root, ".frame-speech-lock")));
  assert.equal(await fs.readFile(archive, "utf8"), "trusted archive fixture");
  assert.equal((await fs.stat(archive)).nlink, 1);
});

test("download failure is safe, retains completed defaults, and retries only missing models", async (t) => {
  const data = await temporary(t),
    calls = [];
  let fail = true;
  const cache = factory(data, async ({ modelsDir, modelIds }) => {
    const id = modelIds[0];
    calls.push(id);
    if (id === "tts" && fail) throw Error("private-token=DO_NOT_EXPOSE");
    await writeModel(
      modelsDir,
      catalogue.find((model) => model.id === id),
    );
  });
  t.after(() => cache.close());
  const root = await cache.start();
  await until(async () => (await readState(root)).state === "error");
  await until(() => missing(path.join(root, ".frame-speech-lock")));
  assert.deepEqual((await readState(root)).completedModelIds, ["stt"]);
  assert.equal(
    JSON.stringify(await readState(root)).includes("DO_NOT_EXPOSE"),
    false,
  );
  fail = false;
  await cache.start();
  await until(async () => (await readState(root)).state === "ready");
  assert.deepEqual(calls, ["stt", "tts", "tts", "optional"]);
});

test("lease loss aborts only that job, preserves shared status, and later start gets a fresh signal", async (t) => {
  const data = await temporary(t);
  let leader = true,
    calls = 0;
  const cache = factory(
    data,
    async ({ modelsDir, modelIds, signal }) => {
      calls++;
      if (calls === 1) await delay(10000, undefined, { signal });
      assert.equal(signal.aborted, false);
      await writeModel(
        modelsDir,
        catalogue.find((model) => model.id === modelIds[0]),
      );
    },
    {
      assertLeadership: async () => {
        if (!leader) throw Error("Controller lease lost");
      },
    },
  );
  t.after(() => cache.close());
  const root = await cache.start();
  await until(() => calls === 1);
  const before = await fs.readFile(
    path.join(root, SHARED_SPEECH_STATE),
    "utf8",
  );
  leader = false;
  await until(() => missing(path.join(root, ".frame-speech-lock")));
  assert.equal(
    await fs.readFile(path.join(root, SHARED_SPEECH_STATE), "utf8"),
    before,
  );
  leader = true;
  await cache.start();
  await until(async () => (await readState(root)).state === "ready");
  assert.equal(calls, 4);
});

test("model publication checks the lease again after staged-file validation", async (t) => {
  const data = await temporary(t),
    root = path.join(data, "paseo-models");
  let downloaded = false,
    inspected = false,
    leader = true;
  const cache = factory(
    data,
    async ({ modelsDir, modelIds }) => {
      await writeModel(
        modelsDir,
        catalogue.find((model) => model.id === modelIds[0]),
      );
      downloaded = true;
    },
    {
      heartbeatMs: 10000,
      staleMs: 60000,
      assertLeadership: async () => {
        if (downloaded && inspected) leader = false;
        if (downloaded) inspected = true;
        if (!leader)
          throw Error("Lease changed while validating staged weights");
      },
    },
  );
  t.after(() => cache.close());
  await cache.start();
  await until(() => downloaded);
  await until(() => missing(path.join(root, ".frame-speech-lock")));
  assert.equal(inspected, true);
  assert.equal(leader, false);
  assert.equal(await missing(path.join(root, "stt-model")), true);
  assert.equal((await readState(root)).state, "preparing");
});

test("close during start cannot launch a late task; close during download aborts and cleans owned resources", async (t) => {
  const data = await temporary(t);
  let calls = 0;
  const early = factory(data, async () => {
    calls++;
  });
  const pendingStart = early.start();
  await early.close();
  await assert.rejects(pendingStart, /closed/);
  assert.equal(calls, 0);
  const cache = factory(data, async ({ signal }) => {
    calls++;
    await delay(10000, undefined, { signal });
  });
  const root = await cache.start();
  await until(() => calls === 1);
  await cache.close();
  assert.equal(await missing(path.join(root, ".frame-speech-lock")), true);
  assert.deepEqual(await fs.readdir(path.join(root, ".frame-staging")), []);
  assert.equal((await readState(root)).state, "error");
  await assert.rejects(cache.start(), /closed/);
});

test("stale lock recovery is bounded and a waiter never deletes a live foreign lock", async (t) => {
  const data = await temporary(t),
    root = path.join(data, "paseo-models"),
    lock = path.join(root, ".frame-speech-lock");
  await fs.mkdir(root);
  await fs.writeFile(lock, '{"owner":"prior-controller"}');
  const old = new Date(Date.now() - 5000);
  await fs.utimes(lock, old, old);
  const cache = factory(data, async ({ modelsDir, modelIds }) =>
    writeModel(
      modelsDir,
      catalogue.find((model) => model.id === modelIds[0]),
    ),
  );
  t.after(() => cache.close());
  await cache.start();
  await until(async () => (await readState(root)).state === "ready");
  await until(() => missing(lock));
  await fs.rm(path.join(root, "stt-model"), { recursive: true });
  await fs.writeFile(lock, '{"owner":"live-foreign-controller"}');
  const waiting = factory(
    data,
    async () => {
      throw Error("Must not download");
    },
    { staleMs: 10000 },
  );
  await waiting.start();
  await delay(50);
  await waiting.close();
  assert.equal(
    await fs.readFile(lock, "utf8"),
    '{"owner":"live-foreign-controller"}',
  );
});

test("invalid catalogue and installed import errors publish bounded safe failures instead of hanging", async (t) => {
  const data = await temporary(t),
    cache = factory(data, async () => {}, {
      catalog: [{ ...catalogue[0], extractedDir: "../escape" }],
    });
  const root = await cache.start();
  await until(async () => (await readState(root)).state === "error");
  assert.deepEqual((await readState(root)).modelIds, []);
  await cache.close();
  const brokenData = await temporary(t),
    brokenRoot = path.join(brokenData, "paseo-models");
  const broken = createSharedSpeechModels({
    data: brokenData,
    runtimeRoot: path.join(brokenData, "missing-runtime"),
  });
  await broken.start();
  await until(async () => (await readState(brokenRoot)).state === "error");
  assert.deepEqual((await readState(brokenRoot)).modelIds, []);
  await broken.close();
});

test("native models directory defaults are persisted but all custom native settings remain authoritative", async (t) => {
  const data = await temporary(t),
    home = path.join(data, "native"),
    shared = path.join(data, "paseo-models");
  const env = {
    PASEO_HOME: home,
    FRAME_PASEO_SHARED_MODELS: shared,
    FRAME_PASEO_SHARED_MODELS_READONLY: "1",
  };
  await fs.mkdir(home);
  const file = path.join(home, "config.json"),
    config = {
      arbitrary: { retained: true },
      providers: { local: { threads: 4 }, custom: { unchanged: true } },
    };
  await fs.writeFile(file, JSON.stringify(config));
  await prepareDaemonSpeechModels(env);
  assert.deepEqual(JSON.parse(await fs.readFile(file)), {
    ...config,
    providers: {
      ...config.providers,
      local: { threads: 4, modelsDir: shared },
    },
  });
  const custom = {
    providers: {
      local: { modelsDir: path.join(data, "custom"), stt: "choice" },
    },
  };
  await fs.writeFile(file, JSON.stringify(custom));
  await prepareDaemonSpeechModels(env);
  assert.deepEqual(JSON.parse(await fs.readFile(file)), custom);
  await fs.writeFile(file, JSON.stringify(config));
  await prepareDaemonSpeechModels({
    ...env,
    PASEO_LOCAL_MODELS_DIR: path.join(data, "override"),
  });
  assert.deepEqual(JSON.parse(await fs.readFile(file)), config);
  await prepareDaemonSpeechModels({
    ...env,
    FRAME_PASEO_SHARED_MODELS_READONLY: "0",
  });
  assert.deepEqual(JSON.parse(await fs.readFile(file)), config);
  await fs.link(file, path.join(home, "linked-config"));
  await assert.rejects(prepareDaemonSpeechModels(env), /configuration file/);
});

async function patchedWaitModule(t) {
  const data = await temporary(t);
  const patch = await fs.readFile(
    new URL(
      "../../integrations/paseo/patches/0004-frame-shared-speech-wait.patch",
      import.meta.url,
    ),
    "utf8",
  );
  const marker =
    "diff --git a/packages/server/src/server/speech/providers/local/frame-shared-model-wait.ts ";
  assert.equal(patch.split(marker).length, 2);
  const source = patch
    .split(marker)[1]
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  const original =
    /import\s*\{[^}]*\}\s*from\s*"\.\/sherpa\/model-catalog\.js";/;
  assert.match(stripped, original);
  const file = path.join(data, "shared-wait.mjs");
  await fs.writeFile(
    file,
    stripped.replace(
      original,
      "const models = " +
        JSON.stringify(catalogue) +
        "; const getSherpaOnnxModelSpec = id => { const item = models.find(m => m.id === id); if (!item) throw Error('Invalid model'); return item; };",
    ),
  );
  return import(pathToFileURL(file).href);
}
function mode(t, root) {
  const before = {
    root: process.env.FRAME_PASEO_SHARED_MODELS,
    flag: process.env.FRAME_PASEO_SHARED_MODELS_READONLY,
  };
  process.env.FRAME_PASEO_SHARED_MODELS = root;
  process.env.FRAME_PASEO_SHARED_MODELS_READONLY = "1";
  t.after(() => {
    for (const [key, value] of [
      ["FRAME_PASEO_SHARED_MODELS", before.root],
      ["FRAME_PASEO_SHARED_MODELS_READONLY", before.flag],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
async function saveState(root, state, completed = []) {
  await fs.writeFile(
    path.join(root, SHARED_SPEECH_STATE),
    JSON.stringify({
      version: 1,
      state,
      modelIds: catalogue.map((m) => m.id),
      completedModelIds: completed,
    }),
  );
}

test("official Frame wait is gated to the exact shared directory and requires no model writes/network", async (t) => {
  const api = await patchedWaitModule(t),
    root = await temporary(t);
  mode(t, root);
  assert.equal(api.isFrameSharedSpeechModelDirectory(root), true);
  assert.equal(
    api.isFrameSharedSpeechModelDirectory(path.join(root, "custom")),
    false,
  );
  assert.equal(api.isFrameSharedSpeechModelDirectory(null), false);
  await saveState(root, "preparing");
  const abort = new AbortController();
  const pending = api.waitForFrameSharedSpeechModels({
    modelsDir: root,
    modelIds: ["stt"],
    signal: abort.signal,
  });
  await delay(30);
  assert.equal(await missing(path.join(root, "stt-model")), true);
  await writeModel(root, catalogue[0]);
  const result = await pending;
  assert.equal(result.stt, path.join(root, "stt-model"));
  assert.equal((await readState(root)).state, "preparing"); // Optional model does not block defaults.
  assert.deepEqual(
    (await fs.readdir(root)).sort(),
    [SHARED_SPEECH_STATE, "stt-model"].sort(),
  );
});

test("official shared error is safe, completed defaults remain usable, and producer retry recovers", async (t) => {
  const api = await patchedWaitModule(t),
    root = await temporary(t);
  mode(t, root);
  await saveState(root, "error", ["stt"]);
  await writeModel(root, catalogue[0]);
  assert.equal(
    (
      await api.waitForFrameSharedSpeechModels({
        modelsDir: root,
        modelIds: ["stt"],
      })
    ).stt,
    path.join(root, "stt-model"),
  );
  await assert.rejects(
    api.waitForFrameSharedSpeechModels({ modelsDir: root, modelIds: ["tts"] }),
    /Chat remains available/,
  );
  assert.equal(await api.shouldRetryFrameSharedSpeechWait(root), false);
  await saveState(root, "preparing", ["stt"]);
  assert.equal(await api.shouldRetryFrameSharedSpeechWait(root), true);
  const pending = api.waitForFrameSharedSpeechModels({
    modelsDir: root,
    modelIds: ["tts"],
  });
  await writeModel(
    root,
    catalogue.find((m) => m.id === "tts"),
  );
  assert.equal((await pending).tts, path.join(root, "tts-model"));
});

test("official ready-file check observes cancellation before returning ready", async (t) => {
  const api = await patchedWaitModule(t),
    root = await temporary(t);
  mode(t, root);
  await writeModel(root, catalogue[0]);
  let checks = 0;
  const signal = {
    throwIfAborted() {
      if (++checks === 2)
        throw new DOMException("Closing during file checks", "AbortError");
    },
  };
  await assert.rejects(
    api.waitForFrameSharedSpeechModels({
      modelsDir: root,
      modelIds: ["stt"],
      signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(checks, 2);
});

test("official shared waits abort promptly and reject malformed state without exposing its contents", async (t) => {
  const api = await patchedWaitModule(t),
    root = await temporary(t);
  mode(t, root);
  await saveState(root, "preparing");
  const abort = new AbortController();
  const pending = api.waitForFrameSharedSpeechModels({
    modelsDir: root,
    modelIds: ["stt"],
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await fs.writeFile(
    path.join(root, SHARED_SPEECH_STATE),
    '{"secret":"NEVER_PUBLIC"}',
  );
  await assert.rejects(
    api.waitForFrameSharedSpeechModels({ modelsDir: root, modelIds: ["stt"] }),
    (error) => !error.message.includes("NEVER_PUBLIC"),
  );
});

test("actual installed pinned speech API resolves its compiled layout without model downloads", async (t) => {
  const runtimeRoot =
    process.env.FRAME_PASEO_ROOT || path.resolve(".cache/paseo-runtime");
  const native = await loadOfficialSpeechModels(runtimeRoot);
  assert.deepEqual(
    native.catalog.map((m) => m.id),
    [
      "parakeet-tdt-0.6b-v2-int8",
      "kokoro-en-v0_19",
      "parakeet-tdt-0.6b-v3-int8",
    ],
  );
  assert.equal(typeof native.downloader, "function");
  const data = await temporary(t),
    root = path.join(data, "paseo-models");
  for (const model of native.catalog) await writeModel(root, model);
  const cache = createSharedSpeechModels({ data, runtimeRoot });
  t.after(() => cache.close());
  const oldFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches++;
    throw Error("No model network allowed in installed API proof");
  };
  try {
    assert.equal(await cache.start(), root);
    await delay(100);
    assert.equal(await missing(path.join(root, ".frame-speech-lock")), true);
    assert.equal(await missing(path.join(root, SHARED_SPEECH_STATE)), true);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const SHARED_SPEECH_STATE = ".frame-speech-state.json";
const safeFailure = "共享语音模型准备失败，重新打开作品可重试；聊天仍可使用。";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
async function regular(file) {
  const value = await fs.lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (value?.isSymbolicLink()) throw Error("Speech cache cannot follow links");
  return value;
}
async function directory(file) {
  await fs.mkdir(file, { recursive: true });
  if (!(await regular(file))?.isDirectory())
    throw Error("Invalid speech cache directory");
}
async function atomicJson(file, value, beforeRename = async () => {}) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    await beforeRename();
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || !catalog.length || catalog.length > 20)
    throw Error("Invalid official speech catalogue");
  const seen = new Set();
  for (const item of catalog) {
    if (
      !object(item) ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item.id) ||
      seen.has(item.id) ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(item.extractedDir) ||
      !Array.isArray(item.requiredFiles) ||
      !item.requiredFiles.length ||
      item.requiredFiles.some(
        (file) =>
          typeof file !== "string" ||
          file
            .split("/")
            .some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                !/^[a-zA-Z0-9._-]+$/.test(part),
            ),
      )
    ) {
      throw Error("Invalid official speech model specification");
    }
    seen.add(item.id);
    const url = new URL(item.archiveUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error("Invalid official speech archive");
  }
  // Current pinned catalogue has two defaults and one optional STT model; warm defaults first.
  return [
    ...catalog.filter((item) => item.defaultFor),
    ...catalog.filter((item) => !item.defaultFor),
  ];
}
async function hasModel(root, model) {
  const base = path.join(root, model.extractedDir);
  if (!(await regular(base))?.isDirectory()) return false;
  for (const relative of model.requiredFiles) {
    let current = base;
    for (const [index, part] of relative.split("/").entries()) {
      current = path.join(current, part);
      const item = await regular(current);
      if (
        !item ||
        (index < relative.split("/").length - 1
          ? !item.isDirectory()
          : !(item.isDirectory() || (item.isFile() && item.size > 0)))
      )
        return false;
    }
  }
  return true;
}

/** Resolve the actual installed pinned server layout; this does not download or initialize models. */
export async function loadOfficialSpeechModels(runtimeRoot) {
  const base = path.resolve(
    runtimeRoot || process.env.FRAME_PASEO_ROOT || ".cache/paseo-runtime",
  );
  const file = path.join(
    base,
    "node_modules/@getpaseo/server/dist/server/server/speech/providers/local/models.js",
  );
  const module = await import(pathToFileURL(file).href);
  if (
    typeof module.listLocalSpeechModels !== "function" ||
    typeof module.ensureLocalSpeechModels !== "function"
  ) {
    throw Error("Installed official speech model API is unavailable");
  }
  const require = createRequire(file);
  const logger = require("pino")({ level: "silent" }); // Raw downloader errors may contain private proxy configuration.
  return {
    catalog: validateCatalog(module.listLocalSpeechModels()),
    downloader: (options) =>
      module.ensureLocalSpeechModels({ ...options, logger }),
  };
}

/** Default only; an explicit native directory or environment choice remains authoritative and editable. */
export async function prepareDaemonSpeechModels(env = process.env) {
  const shared = env.FRAME_PASEO_SHARED_MODELS;
  if (env.FRAME_PASEO_SHARED_MODELS_READONLY !== "1" || !shared) return;
  if (!path.isAbsolute(shared))
    throw Error("Shared speech model directory must be absolute");
  if (env.PASEO_LOCAL_MODELS_DIR !== undefined) return;
  const home = env.PASEO_HOME || path.join(env.HOME, ".paseo");
  const file = path.join(home, "config.json");
  const value = await regular(file);
  if (
    value &&
    (!value.isFile() || value.nlink !== 1 || value.size > 2 * 1024 * 1024)
  )
    throw Error("Invalid native speech configuration file");
  const config = value ? JSON.parse(await fs.readFile(file, "utf8")) : {};
  if (
    !object(config) ||
    (config.providers !== undefined && !object(config.providers)) ||
    (config.providers?.local !== undefined && !object(config.providers.local))
  )
    throw Error("Invalid native speech configuration");
  if (config.providers?.local?.modelsDir !== undefined) return;
  await directory(home);
  await atomicJson(file, {
    ...config,
    providers: {
      ...config.providers,
      local: { ...config.providers?.local, modelsDir: shared },
    },
  });
}

/** One trusted background writer. Complete model directories publish atomically to read-only consumers. */
export function createSharedSpeechModels({
  data,
  runtimeRoot,
  assertLeadership = async () => {},
  downloader,
  catalog,
  heartbeatMs = 5000,
  staleMs = 60000,
  pollMs = 250,
} = {}) {
  if (!data || !path.isAbsolute(data))
    throw Error("Speech cache data root must be absolute");
  if (
    ![heartbeatMs, staleMs, pollMs].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    staleMs <= heartbeatMs
  )
    throw Error("Invalid speech cache timing");
  const root = path.join(data, "paseo-models");
  const lockFile = path.join(root, ".frame-speech-lock");
  let job = null,
    closed = false,
    activeAbort = null,
    initialization = null,
    officialPromise = null;
  const official = () =>
    (officialPromise ||=
      downloader && catalog
        ? Promise.resolve({ downloader, catalog: validateCatalog(catalog) })
        : loadOfficialSpeechModels(runtimeRoot).catch((error) => {
            officialPromise = null;
            throw error;
          }));

  async function run(abort) {
    const signal = abort.signal,
      owner = randomUUID();
    let handle = null,
      identity = null,
      timer,
      staging,
      models = [],
      complete = [];
    async function owns() {
      if (!handle || !identity) return false;
      const value = await regular(lockFile);
      return (
        !!value && value.dev === identity.dev && value.ino === identity.ino
      );
    }
    async function fence() {
      signal.throwIfAborted();
      await assertLeadership();
      if (!(await owns())) throw Error("Speech model cache ownership changed");
      signal.throwIfAborted();
    }
    async function state(value, error) {
      await fence();
      await atomicJson(
        path.join(root, SHARED_SPEECH_STATE),
        {
          version: 1,
          state: value,
          modelIds: models.map((model) => model.id),
          completedModelIds: [...complete],
          ...(error ? { error } : {}),
        },
        fence,
      );
    }
    async function claim() {
      for (;;) {
        signal.throwIfAborted();
        await assertLeadership();
        try {
          handle = await fs.open(lockFile, "wx", 0o600);
          identity = await handle.stat();
          await handle.writeFile(JSON.stringify({ owner }));
          return;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const value = await regular(lockFile);
          if (
            value &&
            (!value.isFile() || value.nlink !== 1 || value.size > 1024)
          )
            throw Error("Invalid speech model cache lock");
          if (value && Date.now() - value.mtimeMs > staleMs) {
            const retired = lockFile + ".stale-" + owner;
            try {
              await fs.rename(lockFile, retired);
              const moved = await regular(retired);
              if (
                moved?.dev !== value.dev ||
                moved?.ino !== value.ino ||
                Date.now() - moved.mtimeMs <= staleMs
              ) {
                // Never replace a new owner. A displaced old writer is fenced before each publication.
                await fs.link(retired, lockFile).catch((error) => {
                  if (error.code !== "EEXIST") throw error;
                });
              }
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            } finally {
              await fs.rm(retired, { force: true });
            }
          }
          await delay(pollMs, undefined, { signal });
        }
      }
    }
    try {
      // Most starts reuse a complete cache without claiming or rewriting its readiness state.
      // Import failure is reported under the lock rather than leaving consumers waiting forever.
      let api;
      try {
        api = await official();
        models = api.catalog;
        if (
          (
            await Promise.all(models.map((model) => hasModel(root, model)))
          ).every(Boolean)
        )
          return;
      } catch {
        /* Acquire ownership before publishing the bounded failure. */
      }
      await claim();
      let heartbeatBusy = false;
      timer = setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void fence()
          .then(() => handle.utimes(new Date(), new Date()))
          .catch(() =>
            abort.abort(new Error("Speech cache controller lease ended")),
          )
          .finally(() => {
            heartbeatBusy = false;
          });
      }, heartbeatMs);
      timer.unref();
      api ||= await official();
      models = api.catalog;
      complete = [];
      for (const model of models)
        if (await hasModel(root, model)) complete.push(model.id);
      if (complete.length === models.length) return;
      await state("preparing");
      staging = path.join(root, ".frame-staging", owner);
      await directory(staging);
      await directory(path.join(staging, ".downloads"));
      for (const model of models) {
        await fence();
        if (!complete.includes(model.id)) {
          // A crashed producer may leave another staging link. Extraction only reads this input;
          // never remove those unknown stages or reject a reusable archive because of their links.
          const filename = path.basename(new URL(model.archiveUrl).pathname);
          const archive = path.join(root, ".downloads", filename);
          const existing = await regular(archive);
          if (existing) {
            if (!existing.isFile() || !existing.size)
              throw Error("Invalid prefilled speech archive");
            await fs.link(archive, path.join(staging, ".downloads", filename));
          }
          await api.downloader({
            modelsDir: staging,
            modelIds: [model.id],
            signal,
          });
          await fence();
          if (!(await hasModel(staging, model)))
            throw Error("Official speech download is incomplete");
          const target = path.join(root, model.extractedDir);
          if (await regular(target))
            throw Error("Incomplete published speech cache needs repair");
          await fence();
          await fs.rename(path.join(staging, model.extractedDir), target);
          complete.push(model.id);
          await state("preparing");
        }
      }
      await state("ready");
    } catch {
      // Only the current controller lease may publish status. Preserve completed model progress.
      try {
        await assertLeadership();
        if (await owns())
          await atomicJson(
            path.join(root, SHARED_SPEECH_STATE),
            {
              version: 1,
              state: "error",
              modelIds: models.map((model) => model.id),
              completedModelIds: [...complete],
              error: signal.aborted
                ? "共享语音模型准备已暂停，重新打开作品后会继续。"
                : safeFailure,
            },
            async () => {
              await assertLeadership();
              if (!(await owns()))
                throw Error("Speech model cache ownership changed");
            },
          );
      } catch {
        /* A fenced owner must not change shared state. */
      }
    } finally {
      clearInterval(timer);
      if (staging)
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      try {
        if (await owns()) await fs.unlink(lockFile);
      } catch {
        /* A stale lock is safely recoverable. */
      }
      await handle?.close().catch(() => {});
    }
  }
  return {
    async start() {
      if (closed) throw Error("Speech model cache is closed");
      initialization ||= (async () => {
        await directory(root);
        await directory(path.join(root, ".downloads"));
        await directory(path.join(root, ".frame-staging"));
      })().catch((error) => {
        initialization = null;
        throw error;
      });
      await initialization;
      if (closed) throw Error("Speech model cache is closed");
      if (!job) {
        activeAbort = new AbortController(); // Each retry gets a fresh lease signal.
        const current = run(activeAbort);
        job = current.finally(() => {
          if (job === tracked) {
            job = null;
            activeAbort = null;
          }
        });
        const tracked = job;
      }
      return root;
    },
    async close() {
      if (closed) return;
      closed = true;
      activeAbort?.abort(
        new DOMException("Speech model cache closed", "AbortError"),
      );
      await job;
    },
  };
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { confined, problem } from "./security.mjs";
import {
  speechInputShape,
  ttsProviders,
  ttsProviderIds,
  ttsCapabilities,
} from "../scripts/tts-capabilities.mjs";
import { synthesizeTts, discoverTts } from "../scripts/tts-adapters.mjs";

export const builtinSpeech = JSON.parse(
  fs.readFileSync(new URL("../speech/catalog.json", import.meta.url), "utf8"),
);
const localUrl = () =>
  (process.env.FRAME_SPEECH_URL || "http://speech:8000").replace(/\/$/, "");
const uuid = z.string().uuid();
const modelId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64);
const normalize = (url) => new URL(url).href.replace(/\/$/, "");
const builtinConfig = (b) => ({
  url: localUrl() + "/v1",
  model: b.model,
  voice: b.voice,
  apiKey: "",
});
const builtinTarget = (c) =>
  normalize(c.url) === normalize(localUrl() + "/v1") &&
  builtinSpeech.find((b) => b.model === c.model);
export async function seedSpeech(db, secrets) {
  // Preserve old IDs, including aliases referenced by existing AI conversations.
  const rows = await db.all("SELECT * FROM engines ORDER BY created,id");
  for (const b of builtinSpeech) {
    const matches = rows.filter((r) =>
      r.builtin
        ? r.builtin === b.key
        : builtinTarget(secrets.decrypt(r.config))?.key === b.key,
    );
    if (!matches.length) matches.push({ id: b.id });
    for (const r of matches)
      await db.pool.query(
        "INSERT INTO engines(id,name,config,enabled,builtin) VALUES($1,$2,$3,true,$4) ON CONFLICT(id) DO UPDATE SET name=$2,config=$3,enabled=true,builtin=$4",
        [r.id, b.name, secrets.encrypt(builtinConfig(b)), b.key],
      );
  }
}
async function local(route, options = {}) {
  let response;
  try {
    response = await fetch(localUrl() + route, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(180000)])
        : AbortSignal.timeout(180000),
    });
  } catch {
    throw problem(502, "本地语音服务暂时不可用，请稍后重试");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw problem(
      response.status >= 500 ? 502 : response.status,
      typeof body.detail === "string" ? body.detail : "本地语音服务请求失败",
    );
  }
  return response.json();
}
const inputShape = speechInputShape;
export function speechOperations({ add, db, data, secrets, assets }) {
  const resolve = async (id) => {
    const row = await db.one(
      "SELECT * FROM engines WHERE id=$1 AND enabled=true",
      [id],
    );
    if (!row) throw problem(404, "语音引擎不可用");
    const builtin = builtinSpeech.find((b) => b.key === row.builtin);
    return {
      row,
      builtin,
      config: builtin ? builtinConfig(builtin) : secrets.decrypt(row.config),
    };
  };
  const jobs = new Map();
  const synthesize = async (a) => {
    const requestId = a.requestId || randomUUID();
    for (const [id, j] of jobs)
      if (j.finished && Date.now() - j.finished > 600000) jobs.delete(id);
    if (jobs.has(requestId))
      throw problem(
        409,
        "此请求 ID 已使用，请查询 speech_status，不要重复合成",
      );
    if ([...jobs.values()].filter((j) => !j.finished).length >= 8)
      throw problem(429, "语音任务繁忙，请稍后重试");
    if (jobs.size >= 200) {
      const oldest = [...jobs].find(([, j]) => j.finished);
      if (oldest) jobs.delete(oldest[0]);
    }
    const controller = new AbortController(),
      start = Date.now();
    const job = {
      state: "running",
      phase: "preparing",
      receivedBytes: 0,
      controller,
      started: start,
    };
    jobs.set(requestId, job);
    try {
      const { row, builtin, config: c } = await resolve(a.engine),
        voice = a.voice || c.voice;
      if (builtin || normalize(c.url) === normalize(localUrl() + "/v1")) {
        const installed = (
          await local("/models", { signal: controller.signal })
        ).find((m) => m.id === c.model);
        if (!installed?.ready)
          throw problem(409, "请先在语音模型列表下载或上传该模型");
      }
      if (
        builtin &&
        !builtin.voices.some((v) => v.id === voice) &&
        !(
          builtin.speakerCount &&
          /^\d+$/.test(voice) &&
          Number(voice) < builtin.speakerCount
        )
      )
        throw problem(400, "该引擎不支持所选声线");
      const result = await synthesizeTts(
        { ...c, provider: builtin ? "local" : c.provider || "compatible" },
        a,
        {
          signal: controller.signal,
          onProgress: (p) => Object.assign(job, p),
        },
      );
      controller.signal.throwIfAborted();
      Object.assign(job, {
        state: "succeeded",
        phase: "completed",
        finished: Date.now(),
      });
      return {
        ...result,
        elapsedMs: Date.now() - start,
        row,
        voice,
        requestId,
      };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      Object.assign(job, {
        state: cancelled ? "cancelled" : "failed",
        phase: cancelled ? "cancelled" : "failed",
        finished: Date.now(),
        error: {
          code: cancelled ? "TTS_CANCELLED" : error.code || "TTS_FAILED",
          message: cancelled ? "语音合成已取消" : error.message,
        },
      });
      if (cancelled && error.code !== "TTS_CANCELLED")
        throw Object.assign(problem(409, "语音合成已取消"), {
          code: "TTS_CANCELLED",
        });
      throw error;
    } finally {
      delete job.controller;
    }
  };
  add(
    "speech_providers",
    "Discover speech provider presets and model-specific real capabilities; no credentials or network calls",
    {},
    () => ({
      schemaVersion: 1,
      providers: ttsProviders.map((p) => ({
        ...p,
        capabilities: ttsCapabilities(p.id, p.model, p.voice),
      })),
    }),
  );
  add(
    "speech_status",
    "Inspect a synthesis request by requestId; transient status expires after ten minutes, not a billing receipt",
    { requestId: uuid },
    ({ requestId }) => {
      const j = jobs.get(requestId);
      if (!j || (j.finished && Date.now() - j.finished > 600000))
        throw problem(404, "语音请求状态不存在或已过期");
      const { controller, ...state } = j;
      return {
        requestId,
        ...state,
        elapsedMs: (j.finished || Date.now()) - j.started,
      };
    },
  );
  add(
    "speech_cancel",
    "Cancel local work and abort the provider connection. An accepted remote request can still be billed; no automatic retry",
    { requestId: uuid },
    ({ requestId }) => {
      const j = jobs.get(requestId);
      if (!j) throw problem(404, "语音请求不存在");
      j.controller?.abort();
      return { requestId, cancelRequested: !!j.controller, state: j.state };
    },
  );
  add(
    "engines_discover",
    "Read model/voice catalogs for an already configured engine; read-only, supports ElevenLabs cursor/search; unsupported catalogs remain manual",
    {
      engine: uuid,
      cursor: z.string().max(500).optional(),
      search: z.string().max(200).optional(),
    },
    async (a) => {
      const { builtin, config } = await resolve(a.engine);
      if (builtin)
        return {
          source: "builtin",
          voices: builtin.voices,
          models: [{ id: config.model }],
          nextCursor: null,
        };
      return discoverTts(config, a);
    },
  );
  add(
    "engines_list",
    "List available speech engines, voices, languages and immutable built-ins; never returns credentials",
    {},
    async () => {
      const seen = new Set(),
        rows = await db.all(
          "SELECT * FROM engines ORDER BY (builtin IS NULL),created,id",
        ),
        result = [];
      for (const r of rows) {
        if (r.builtin && seen.has(r.builtin)) continue;
        seen.add(r.builtin);
        const b = builtinSpeech.find((b) => b.key === r.builtin),
          c = b ? builtinConfig(b) : secrets.decrypt(r.config);
        result.push({
          ...r,
          builtin: !!b,
          builtinKey: b?.key,
          kind: b
            ? "builtin"
            : normalize(c.url) === normalize(localUrl() + "/v1")
              ? "local"
              : "external",
          description: b?.description,
          languages: b?.languages,
          voices: b?.voices,
          speakerCount: b?.speakerCount,
          license: b?.license,
          source: b?.source,
          provider: b ? "local" : c.provider || "compatible",
          capabilities: ttsCapabilities(
            b ? "local" : c.provider || "compatible",
            c.model,
            c.voice,
          ),
          config: {
            url: c.url,
            model: c.model,
            voice: c.voice,
            provider: c.provider || "compatible",
            configured: !!c.apiKey,
          },
        });
      }
      return result;
    },
  );
  add(
    "engines_save",
    "Create or edit a speech provider adapter. Omitted provider preserves existing config or defaults to compatible. ElevenLabs may omit default voice for catalog discovery; select one before synthesis. Use speech_providers first. Built-ins cannot be edited or duplicated.",
    {
      id: uuid.optional(),
      name: z.string().trim().min(1).max(120),
      url: z.string().url(),
      model: z.string().trim().min(1).max(150),
      voice: z.string().trim().max(150).optional(),
      apiKey: z.string().max(8000).optional(),
      provider: z
        .enum(ttsProviderIds.filter((id) => id !== "local"))
        .optional(),
      enabled: z.boolean().default(true),
    },
    async (a) => {
      const u = new URL(a.url);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw problem(400, "API 地址必须是 HTTP(S) 服务地址");
      const old = a.id
        ? await db.one("SELECT * FROM engines WHERE id=$1", [a.id])
        : null;
      if (a.id && !old) throw problem(404, "语音引擎不存在");
      if (old?.builtin || builtinTarget(a))
        throw problem(409, "内置引擎已预置，无需添加且不能修改");
      const prior = old ? secrets.decrypt(old.config) : {},
        id = a.id || randomUUID();
      const provider = a.provider || prior.provider || "compatible";
      const voice = a.voice ?? prior.voice ?? "";
      if (!voice && provider !== "elevenlabs")
        throw problem(
          400,
          "请填写默认声线；ElevenLabs 可先保存，再发现账号音色",
        );
      const sameTarget =
        provider === (prior.provider || "compatible") &&
        prior.url &&
        normalize(prior.url) === normalize(a.url);
      if (prior.apiKey && !sameTarget && a.apiKey === undefined)
        throw problem(
          400,
          "更换提供商或服务地址时，请明确提供新密钥或空字符串清除；原密钥不能转交给新服务",
        );
      const config = {
        provider,
        url: normalize(a.url),
        model: a.model,
        voice,
        apiKey: a.apiKey === undefined ? prior.apiKey || "" : a.apiKey,
      };
      await db.pool.query(
        "INSERT INTO engines(id,name,config,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$2,config=$3,enabled=$4",
        [id, a.name, secrets.encrypt(config), a.enabled],
      );
      return { id };
    },
  );
  add(
    "engines_delete",
    "Delete a custom speech engine configuration; built-ins are immutable and generated audio is preserved",
    { id: uuid },
    async ({ id }) => {
      const row = await db.one("SELECT builtin FROM engines WHERE id=$1", [id]);
      if (!row) throw problem(404, "语音引擎不存在");
      if (row.builtin) throw problem(409, "内置语音引擎不能删除");
      await db.pool.query(
        "DELETE FROM engines WHERE id=$1 AND builtin IS NULL",
        [id],
      );
      return { deleted: id };
    },
  );
  add(
    "speech_test",
    "Preview temporary speech (24 hours). Discover capabilities via engines_list/speech_providers and voices via engines_discover. options are model-specific; unsupported controls fail unless fallback=omit (warnings returned). Send requestId for progress/cancellation. No synthesis retries.",
    inputShape,
    async (a) => {
      const s = await synthesize(a),
        id = randomUUID(),
        relative = `projects/speech-test/exports/preview.${s.ext}`,
        root = path.join(data, "runs", id),
        target = path.join(root, relative),
        expiresAt = new Date(Date.now() + 86400000).toISOString();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, s.bytes);
      try {
        await db.pool.query(
          "INSERT INTO tasks(id,project,kind,state,input,result,finished,expires) VALUES($1,'speech-test','speech-test','succeeded',$2,$3,now(),$4)",
          [
            id,
            { engine: a.engine, voice: s.voice },
            {
              speech: {
                applied: s.applied,
                mime: s.mime,
                name: s.row.name,
                license:
                  "Generated with " +
                  s.row.name +
                  (builtinSpeech.find((x) => x.key === s.row.builtin)
                    ? "; " +
                      builtinSpeech.find((x) => x.key === s.row.builtin)
                        .license +
                      "; " +
                      builtinSpeech.find((x) => x.key === s.row.builtin).source
                    : ""),
              },
              artifacts: [
                {
                  name: `preview.${s.ext}`,
                  path: relative,
                  bytes: s.bytes.length,
                },
              ],
            },
            expiresAt,
          ],
        );
      } catch (e) {
        fs.rmSync(root, { recursive: true, force: true });
        throw e;
      }
      return {
        requestId: s.requestId,
        applied: s.applied,
        warnings: s.warnings,
        task: id,
        url: `/api/tasks/${id}/file/${relative}`,
        path: relative,
        bytes: s.bytes.length,
        mime: s.mime,
        elapsedMs: s.elapsedMs,
        expiresAt,
        temporary: true,
      };
    },
  );
  add(
    "speech_adopt",
    "Save the exact audition audio in a work without a second synthesis",
    {
      task: uuid,
      repo: uuid,
      project: modelId,
      name: z.string().trim().min(1).max(180),
    },
    async (a) =>
      db.lock("artifact:" + a.task, async () => {
        const task = await db.one(
          "SELECT * FROM tasks WHERE id=$1 AND kind='speech-test' AND state='succeeded'",
          [a.task],
        );
        if (
          !task ||
          task.cleaned ||
          !task.expires ||
          new Date(task.expires) <= new Date()
        )
          throw problem(410, "试听文件已过期，请重新生成试听");
        if (!task.result?.speech?.license)
          throw problem(409, "该试听为旧版本生成，请重新试听后采用");
        const artifact = task.result.artifacts?.find((file) =>
          /^projects\/speech-test\/exports\/preview\.(wav|mp3)$/.test(
            file.path,
          ),
        );
        if (!artifact) throw problem(404, "试听文件不存在");
        const key = "speech-adopt:" + a.task + ":" + a.repo + ":" + a.project;
        const adopted = await db.setting(key);
        let asset = adopted?.asset ? await assets.get(adopted.asset) : null;
        if (asset?.deleted)
          throw problem(409, "已采用的素材在回收站中，请先恢复");
        if (!asset) {
          const file = confined(path.join(data, "runs", a.task), artifact.path);
          const ext = path.extname(file);
          asset = await assets.register(file, {
            name: a.name + (a.name.endsWith(ext) ? "" : ext),
            mime: task.result.speech.mime,
            license: task.result.speech.license,
            repo: a.repo,
          });
          await db.setting(key, { asset: asset.id });
        }
        await assets.attach(asset.id, a.repo, a.project);
        return { asset, adopted: true, resynthesized: false };
      }),
  );
  add(
    "speech_generate",
    "Generate final narration into a repository; use speech_test for temporary auditions",
    { ...inputShape, repo: uuid, project: modelId.optional() },
    async (a) => {
      const s = await synthesize(a),
        file = path.join(data, "uploads", randomUUID());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, s.bytes);
      try {
        const b = builtinSpeech.find((x) => x.key === s.row.builtin);
        const asset = await assets.register(file, {
          name: `speech-${Date.now()}.${s.ext}`,
          mime: s.mime,
          license: `Generated with ${s.row.name}${b ? `; ${b.license}; ${b.source}` : ""}`,
          repo: a.repo,
        });
        if (a.project) await assets.attach(asset.id, a.repo, a.project);
        return {
          asset,
          elapsedMs: s.elapsedMs,
          requestId: s.requestId,
          applied: s.applied,
          warnings: s.warnings,
        };
      } finally {
        fs.unlinkSync(file);
      }
    },
  );
  add(
    "models_list",
    "List optional recommended and custom local models, installation state and download progress",
    {},
    () => local("/models"),
  );
  add(
    "models_download",
    "Download a recommended speech model into persistent storage; returns immediately, inspect models_list for progress",
    { id: modelId },
    (a) => local("/models/" + a.id + "/download", { method: "POST" }),
  );
  add(
    "models_create",
    "Create a custom Kokoro model slot for config.json, model.pth and voice tensors",
    { id: modelId },
    (a) => local("/models/" + a.id, { method: "POST" }),
  );
  add(
    "models_delete",
    "Remove downloaded model files; custom models require removing every referencing custom engine",
    { id: modelId },
    async (a) => {
      for (const row of await db.all(
        "SELECT config FROM engines WHERE builtin IS NULL",
      )) {
        const c = secrets.decrypt(row.config);
        if (
          c.model === a.id &&
          normalize(c.url) === normalize(localUrl() + "/v1")
        )
          throw problem(409, "请先删除使用该模型的自定义引擎");
      }
      return local("/models/" + a.id, { method: "DELETE" });
    },
  );
  add(
    "engines_local",
    "Create a custom uploaded Kokoro engine; built-ins are already available",
    {
      model: modelId,
      voice: z.string().min(1).max(150),
      name: z.string().trim().min(1).max(120).optional(),
    },
    async (a) => {
      if (builtinSpeech.some((b) => b.model === a.model))
        throw problem(409, "内置引擎已经可用，无需添加");
      const model = (await local("/models")).find((m) => m.id === a.model);
      if (!model?.ready || !model.voices.includes(a.voice))
        throw problem(409, "请上传完整模型并选择已有声线");
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO engines(id,name,config) VALUES($1,$2,$3)",
        [
          id,
          a.name || "Kokoro · " + a.model,
          secrets.encrypt({
            url: localUrl() + "/v1",
            model: a.model,
            voice: a.voice,
            apiKey: "",
          }),
        ],
      );
      return { id };
    },
  );
}

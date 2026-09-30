import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { confined, problem } from "./security.mjs";

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
      signal: AbortSignal.timeout(180000),
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
const inputShape = {
  engine: uuid,
  text: z.string().trim().min(1).max(4000),
  voice: z.string().min(1).max(150).optional(),
  speed: z.number().min(0.5).max(2).default(1),
};
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
  const synthesize = async (a) => {
    const { row, builtin, config: c } = await resolve(a.engine),
      start = Date.now(),
      voice = a.voice || c.voice;
    if (builtin || normalize(c.url) === normalize(localUrl() + "/v1")) {
      const installed = (await local("/models")).find((m) => m.id === c.model);
      if (!installed?.ready) throw problem(409, "请先在语音模型列表下载或上传该模型");
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
    let response;
    try {
      response = await fetch(c.url.replace(/\/$/, "") + "/audio/speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(c.apiKey ? { Authorization: "Bearer " + c.apiKey } : {}),
        },
        body: JSON.stringify({
          model: c.model,
          voice,
          input: a.text,
          speed: a.speed,
          response_format: "wav",
        }),
        signal: AbortSignal.timeout(180000),
        redirect: "error",
      });
    } catch {
      throw problem(502, "语音合成连接失败或超时，请检查引擎后重试");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw problem(502, "语音引擎返回 HTTP " + response.status);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw problem(413, "语音结果超过 64 MiB");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const wav =
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WAVE";
    const mp3 =
      bytes.subarray(0, 3).toString() === "ID3" ||
      (bytes[0] === 255 && (bytes[1] & 224) === 224);
    if (!wav && !mp3) throw problem(502, "引擎没有返回有效的 WAV 或 MP3 音频");
    return {
      bytes,
      ext: wav ? "wav" : "mp3",
      mime: wav ? "audio/wav" : "audio/mpeg",
      elapsedMs: Date.now() - start,
      row,
      voice,
    };
  };
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
          config: { ...c, apiKey: undefined, configured: !!c.apiKey },
        });
      }
      return result;
    },
  );
  add(
    "engines_save",
    "Create or edit a custom OpenAI-compatible speech engine. Built-ins cannot be edited or duplicated.",
    {
      id: uuid.optional(),
      name: z.string().trim().min(1).max(120),
      url: z.string().url(),
      model: z.string().trim().min(1).max(150),
      voice: z.string().trim().min(1).max(150),
      apiKey: z.string().max(8000).optional(),
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
      const config = {
        url: normalize(a.url),
        model: a.model,
        voice: a.voice,
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
    "Preview speech as a temporary audio file. Never adds assets or changes a work. Expires after 24 hours.",
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
        return { asset, elapsedMs: s.elapsedMs };
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

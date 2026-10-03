import { randomUUID } from "../src/browser/uuid.mjs";
import { ttsProviders, ttsCapabilities } from "../scripts/tts-capabilities.mjs";
import "./speech.css";
import { useState, useEffect, useRef, useId } from "react";
import {
  Plus,
  Play,
  Upload,
  Mic,
  Settings2,
  Trash2,
  Check,
  ArrowLeft,
  Download,
} from "lucide-react";
import {
  api,
  request,
  useQuery,
  Button,
  Field,
  Form,
  Modal,
  ErrorNote,
  Loading,
} from "./ui";

const expressionLabels = {
  language: "语言提示",
  emotion: "情感",
  pitch: "音调（半音）",
  stability: "稳定性",
  similarity: "音色相似度",
  style: "风格强度",
  previousText: "上一段正文",
  nextText: "下一段正文",
};
function ExpressionLines({ label, value = [], set, kind }) {
  const encode = (v) =>
    v
      .map((p) =>
        kind === "pauses"
          ? `${p.after}=${p.seconds}`
          : kind === "dictionaries"
            ? `${p.id}=${p.version}`
            : `${p.word}=${p.phonetic}`,
      )
      .join("\n");
  const [draft, setDraft] = useState(() => encode(value));
  return (
    <Field label={label}>
      <textarea
        rows={3}
        value={draft}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const pairs = text
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => {
              const i = l.indexOf("=");
              return [i < 0 ? l : l.slice(0, i), i < 0 ? "" : l.slice(i + 1)];
            });
          set(
            pairs.length
              ? pairs.map(([a, b]) =>
                  kind === "pauses"
                    ? { after: Number(a), seconds: Number(b) }
                    : kind === "dictionaries"
                      ? { id: a.trim(), version: b.trim() }
                      : { word: a.trim(), phonetic: b.trim() },
                )
              : undefined,
          );
        }}
      />
    </Field>
  );
}
export function useSpeechJob() {
  const active = useRef(null),
    [requestId, setRequestId] = useState(null),
    [status, setStatus] = useState(null),
    [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    if (!requestId) return;
    let stopped = false,
      timer;
    const poll = async () => {
      try {
        const s = await api("speech_status", { requestId });
        if (!stopped) setStatus(s);
      } catch {
      } finally {
        if (!stopped) timer = setTimeout(poll, 700);
      }
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [requestId]);
  useEffect(
    () => () => {
      if (active.current)
        api("speech_cancel", { requestId: active.current }).catch(() => {});
    },
    [],
  );
  return {
    requestId,
    status,
    cancelling,
    start: () => {
      const id = randomUUID();
      active.current = id;
      setRequestId(id);
      setStatus({ phase: "preparing" });
      setCancelling(false);
      return id;
    },
    finish: () => {
      active.current = null;
      setRequestId(null);
      setCancelling(false);
    },
    cancel: async () => {
      if (!active.current) return;
      setCancelling(true);
      try {
        await api("speech_cancel", { requestId: active.current });
      } catch (error) {
        setCancelling(false);
        throw error;
      }
    },
  };
}
export function SpeechProgress({ job, error }) {
  const phases = {
    preparing: "正在检查引擎与模型",
    connecting: "正在连接语音服务",
    receiving: "正在接收音频",
    validating: "正在验证音频",
    completed: "合成完成，正在保存结果",
    cancelled: "已取消",
    failed: "合成失败",
  };
  return (
    <div className="speech-feedback" role="status">
      <progress aria-label="语音合成进度" />
      <span>
        {phases[job.status?.phase] || "正在合成"}
        {job.status?.receivedBytes > 0
          ? ` · ${(job.status.receivedBytes / 1024).toFixed(0)} KiB`
          : ""}
      </span>
      <Button
        type="button"
        disabled={job.cancelling}
        onClick={() => job.cancel().catch((e) => error(e.message))}
      >
        {job.cancelling ? "正在取消…" : "取消合成"}
      </Button>
      <small>取消会终止本地等待；远端已接受的请求仍可能计费。</small>
    </div>
  );
}
export function SpeechControls({
  engine,
  voice,
  setVoice,
  speed,
  setSpeed,
  options = {},
  setOptions = () => {},
  disabled = false,
}) {
  const id = useId(),
    [catalog, setCatalog] = useState(null),
    [discovering, setDiscovering] = useState(false),
    [error, setError] = useState(""),
    discoveryGeneration = useRef(0);
  const catalogKey = JSON.stringify([
    engine?.id,
    engine?.provider,
    engine?.config?.provider,
    engine?.config?.url,
    engine?.config?.model,
  ]);
  useEffect(() => {
    ++discoveryGeneration.current;
    setCatalog(null);
    setDiscovering(false);
    setError("");
    return () => {
      ++discoveryGeneration.current;
    };
  }, [catalogKey]);
  const discover = async (cursor) => {
    const generation = ++discoveryGeneration.current;
    setDiscovering(true);
    setError("");
    try {
      const next = await api("engines_discover", {
        engine: engine.id,
        ...(cursor ? { cursor } : {}),
      });
      if (generation !== discoveryGeneration.current) return;
      setCatalog(
        cursor
          ? {
              ...next,
              models: catalog.models,
              voices: [
                ...new Map(
                  [...catalog.voices, ...next.voices].map((voice) => [
                    voice.id,
                    voice,
                  ]),
                ).values(),
              ],
            }
          : next,
      );
    } catch (e) {
      if (generation === discoveryGeneration.current) setError(e.message);
    } finally {
      if (generation === discoveryGeneration.current) setDiscovering(false);
    }
  };
  const caps = ttsCapabilities(
    engine?.provider || engine?.config?.provider || "compatible",
    engine?.config?.model,
    voice,
  );
  const fields = caps.fields,
    voices = catalog?.voices || engine?.voices || caps.voices;
  const set = (key, value) =>
    setOptions((current) => {
      const next = { ...current };
      if (value === undefined || value === "") delete next[key];
      else next[key] = value;
      return next;
    });
  return (
    <fieldset disabled={disabled} className="speech-expression">
      <div className="speech-controls">
        <Field label="声线">
          {engine?.builtin && voices?.length ? (
            <select
              aria-label="声线"
              name="voice"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            >
              {!voices.some((v) => v.id === voice) && (
                <option value={voice}>{voice}</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name || v.id}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                name="voice"
                required
                value={voice}
                list={id}
                onChange={(e) => setVoice(e.target.value)}
                placeholder="音色 ID，或从目录选择"
              />
              <datalist id={id}>
                {voices?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} {v.description}
                  </option>
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label={`语速 · ${Number(speed).toFixed(2)}×`}>
          <input
            aria-label="语速"
            name="speed"
            type="range"
            min={caps.speed.min}
            max={caps.speed.max}
            step="0.05"
            value={speed}
            disabled={caps.speed.min === caps.speed.max}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </Field>
      </div>
      {!engine?.builtin && (
        <div className="row">
          <Button
            type="button"
            disabled={discovering}
            onClick={() => discover()}
          >
            {discovering ? "读取音色…" : "发现音色与模型"}
          </Button>
          {catalog && (
            <small>
              {catalog.source === "live"
                ? "实时服务目录"
                : "文档目录 / 手动配置"}{" "}
              · {voices.length} 条音色{catalog.hint ? ` · ${catalog.hint}` : ""}
            </small>
          )}
          {catalog?.nextCursor && (
            <Button
              type="button"
              disabled={discovering}
              onClick={() => discover(catalog.nextCursor)}
            >
              更多音色
            </Button>
          )}
        </div>
      )}
      <ErrorNote error={error} />
      <small>{caps.textHints}</small>
      {Object.keys(options).some((key) => !fields[key]) && (
        <div className="row">
          <small>当前音色不支持部分已填写控制。请清除后重新试听。</small>
          <Button
            type="button"
            onClick={() =>
              setOptions((current) =>
                Object.fromEntries(
                  Object.entries(current).filter(([key]) => fields[key]),
                ),
              )
            }
          >
            清除不支持的控制
          </Button>
        </div>
      )}
      {catalog?.models?.length > 0 && (
        <details>
          <summary>服务模型目录 · {catalog.models.length} 个</summary>
          <ul>
            {catalog.models.map((m) => (
              <li key={m.id}>
                <code>{m.id}</code> · {m.name || m.id}
                {m.languages?.length ? ` · ${m.languages.join("、")}` : ""}
              </li>
            ))}
          </ul>
          <small>
            修改默认模型请返回引擎设置；目录表示账号可见，不保证所有音色适用。
          </small>
        </details>
      )}
      <details className="speech-direction" key={engine?.id}>
        <summary>
          旁白表达 ·{" "}
          {Object.keys(fields).length
            ? "按模型能力调节"
            : "此引擎仅支持基础合成"}
        </summary>
        {!!fields.instructions && (
          <>
            <div className="row">
              <Button
                type="button"
                onClick={() =>
                  set(
                    "instructions",
                    "用自然流畅的普通话叙述，语气亲切，短句清晰，避免逐字朗读和过度播音腔。",
                  )
                }
              >
                自然中文
              </Button>
              <Button
                type="button"
                onClick={() =>
                  set(
                    "instructions",
                    "用沉稳、克制的电影旁白语气说普通话。情绪随语义逐渐展开，关键处轻微重音，句间自然呼吸；避免夸张广告腔和每句拖长。",
                  )
                }
              >
                电影旁白
              </Button>
              <Button
                type="button"
                onClick={() => set("instructions", undefined)}
              >
                清除指令
              </Button>
            </div>
            <Field label="语气与表达指令">
              <textarea
                aria-label="语气与表达指令"
                rows={4}
                maxLength={2000}
                value={options.instructions || ""}
                onChange={(e) => set("instructions", e.target.value)}
              />
            </Field>
            <small>
              {fields.instructions.hint ||
                "模型尽力执行表达指令；先试听一小段确认实际效果。"}
            </small>
          </>
        )}
        <div className="speech-controls">
          {Object.entries(fields)
            .filter(([key]) => expressionLabels[key])
            .map(([key, f]) => (
              <Field key={key} label={expressionLabels[key]}>
                {f.values ? (
                  <select
                    value={options[key] ?? ""}
                    onChange={(e) =>
                      set(
                        key,
                        e.target.value === ""
                          ? undefined
                          : f.kind === "enum-number"
                            ? Number(e.target.value)
                            : e.target.value,
                      )
                    }
                  >
                    <option value="">服务默认</option>
                    {f.values.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : f.kind === "number" ? (
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={key === "pitch" ? 1 : 0.05}
                    value={options[key] ?? ""}
                    placeholder="服务默认"
                    onChange={(e) =>
                      set(
                        key,
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                      )
                    }
                  />
                ) : (
                  <textarea
                    rows={2}
                    maxLength={4000}
                    value={options[key] || ""}
                    onChange={(e) => set(key, e.target.value)}
                  />
                )}
              </Field>
            ))}
        </div>
        {fields.pronunciation && (
          <ExpressionLines
            key={engine?.id + "pronunciation"}
            label="发音字典 · 每行 词语=带调拼音，如 重庆=(chong2)(qing4)"
            value={options.pronunciation}
            set={(v) => set("pronunciation", v)}
            kind="pronunciation"
          />
        )}
        {fields.pauses && (
          <ExpressionLines
            key={engine?.id + "pauses"}
            label={`显式停顿 · 每行 原文字符偏移=秒数，最长 ${fields.pauses.max} 秒`}
            value={options.pauses}
            set={(v) => set("pauses", v)}
            kind="pauses"
          />
        )}
        {fields.dictionaries && (
          <ExpressionLines
            key={engine?.id + "dictionaries"}
            label="已有发音字典 · 每行 id=version，最多 3 个"
            value={options.dictionaries}
            set={(v) => set("dictionaries", v)}
            kind="dictionaries"
          />
        )}
        <small>
          未提供的控制由服务自行决定。不支持的控制不会自动发送。换引擎后重新试听，音色与模型共同决定效果。
        </small>
      </details>
    </fieldset>
  );
}
function Audition({ engine, onClose }) {
  const [voice, setVoice] = useState(engine.config.voice),
    [speed, setSpeed] = useState(1),
    [options, setOptions] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
  const job = useSpeechJob();
  return (
    <Modal title={`试听 · ${engine.name}`} onClose={onClose}>
      <p>试听不会保存到素材库或作品，临时音频 24 小时后自动清理。</p>
      <Form
        busy={busy}
        submit="生成试听"
        onSubmit={async (a) => {
          setBusy(true);
          setError("");
          setResult(null);
          try {
            const requestId = job.start();
            setResult(
              await api("speech_test", {
                engine: engine.id,
                text: a.text,
                voice,
                speed,
                options,
                requestId,
              }),
            );
          } catch (e) {
            setError(e.message);
            throw e;
          } finally {
            job.finish();
            setBusy(false);
          }
        }}
      >
        <SpeechControls
          engine={engine}
          voice={voice}
          setVoice={setVoice}
          speed={speed}
          setSpeed={setSpeed}
          options={options}
          setOptions={setOptions}
          disabled={busy}
        />
        <Field label="试听文字">
          <textarea
            name="text"
            rows="4"
            maxLength="4000"
            required
            defaultValue={
              engine.builtinKey === "piper"
                ? "Every idea deserves a voice. Welcome to FRAME, where your stories come to life."
                : "你好，欢迎来到 FRAME。让每一个想法，都有自己的声音。"
            }
          />
        </Field>
      </Form>
      {busy && <SpeechProgress job={job} error={setError} />}
      <ErrorNote error={error} />
      {result && (
        <div className="speech-result">
          <strong>
            <Check size={16} /> 试听已就绪
          </strong>
          {result.warnings?.map((w) => (
            <p key={w.field} role="alert">
              {w.field}：{w.reason}
            </p>
          ))}
          <audio key={result.url} controls autoPlay src={result.url} />
          <small>
            合成耗时 {(result.elapsedMs / 1000).toFixed(1)} 秒 ·
            仅供试听，不会入库
          </small>
        </div>
      )}
    </Modal>
  );
}
function ExternalEditor({ engine, model, onSaved }) {
  const [provider, setProvider] = useState(
    engine.config?.provider || "compatible",
  );
  const preset = ttsProviders.find((p) => p.id === provider) || ttsProviders[0];
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [apiKey, setApiKey] = useState(""),
    [keyReset, setKeyReset] = useState(false);
  const clearDraftKey = () => {
    if (apiKey) setKeyReset(true);
    setApiKey("");
  };
  return (
    <Form
      busy={busy}
      submit={engine.id ? "保存配置" : "添加自定义引擎"}
      onSubmit={async (a) => {
        setBusy(true);
        setError("");
        try {
          const { apiKey, ...fields } = a;
          const result = await api("engines_save", {
            ...fields,
            provider,
            enabled: a.enabled === "true",
            ...(apiKey
              ? { apiKey }
              : provider !== (engine.config?.provider || "compatible") ||
                  (engine.config?.url &&
                    a.url.replace(/\/$/, "") !==
                      engine.config.url.replace(/\/$/, ""))
                ? { apiKey: "" }
                : {}),
            ...(engine.id ? { id: engine.id } : {}),
          });
          onSaved(result.id);
        } catch (e) {
          setError(e.message);
          throw e;
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        {engine.kind === "local"
          ? "管理这套本地声音的名称、默认声线和启用状态。"
          : "选择提供商适配器，再填写已有的服务配置。保存后发现音色并先试听一段代表性旁白。"}
      </p>
      {engine.config?.configured && (
        <small>
          原提供商和原地址下留空保留密钥；切换提供商或地址时，留空将清除密钥，需填写该服务已有的正确配置。
        </small>
      )}
      {engine.kind !== "local" && (
        <>
          <Field label="提供商">
            <select
              aria-label="提供商"
              value={provider}
              disabled={busy}
              onChange={(e) => {
                clearDraftKey();
                setProvider(e.target.value);
              }}
            >
              {ttsProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <small>{preset.note}</small>
          {preset.docs && (
            <a href={preset.docs} target="_blank" rel="noreferrer">
              官方接口说明 ↗
            </a>
          )}
        </>
      )}
      <Field label="引擎名称">
        <input
          name="name"
          required
          disabled={busy}
          maxLength="120"
          defaultValue={engine.name}
          placeholder="例如：我的语音服务"
        />
      </Field>
      {engine.kind === "local" ? (
        <>
          <input type="hidden" name="url" value={engine.config.url} />
          <input type="hidden" name="model" value={engine.config.model} />
          <Field label="默认声线">
            <select
              name="voice"
              aria-label="默认声线"
              disabled={busy}
              defaultValue={engine.config.voice}
            >
              {(model?.voices || [engine.config.voice]).map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          <div key={provider}>
            <Field label="服务地址">
              <input
                name="url"
                type="url"
                required
                disabled={busy}
                onChange={clearDraftKey}
                defaultValue={
                  provider === engine.config?.provider ||
                  (!engine.config?.provider && provider === "compatible")
                    ? engine.config?.url
                    : preset.url
                }
                placeholder="https://服务地址/v1"
                readOnly={engine.kind === "local"}
              />
            </Field>
            <small>
              填写该提供商的 API 基础地址，路径由适配器补齐；不要填完整合成
              URL。
            </small>
            <div className="speech-controls">
              <Field label="模型名称">
                <input
                  name="model"
                  required
                  disabled={busy}
                  list="tts-model-presets"
                  defaultValue={
                    provider === engine.config?.provider ||
                    (!engine.config?.provider && provider === "compatible")
                      ? engine.config?.model
                      : preset.model
                  }
                  readOnly={engine.kind === "local"}
                />
              </Field>
              <Field
                label={
                  provider === "elevenlabs"
                    ? "默认声线 · 可先保存，再发现账号音色"
                    : "默认声线"
                }
              >
                <input
                  name="voice"
                  disabled={busy}
                  required={provider !== "elevenlabs"}
                  defaultValue={
                    provider === engine.config?.provider ||
                    (!engine.config?.provider && provider === "compatible")
                      ? engine.config?.voice
                      : preset.voice
                  }
                />
              </Field>
            </div>
            <datalist id="tts-model-presets">
              {preset.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </datalist>
          </div>
          <Field label="API 密钥">
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              disabled={busy}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setKeyReset(false);
              }}
              placeholder={
                engine.config?.configured
                  ? "已配置，留空保留原密钥"
                  : "无需密钥的服务可留空"
              }
            />
          </Field>
          {keyReset && (
            <small role="status">
              更换提供商或地址已清除未保存的密钥，请为当前服务重新填写。
            </small>
          )}
        </>
      )}
      {engine.id && (
        <Field label="状态">
          <select
            name="enabled"
            disabled={busy}
            defaultValue={String(engine.enabled)}
          >
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
        </Field>
      )}
      {!engine.id && <input type="hidden" name="enabled" value="true" />}
      <ErrorNote error={error} />
    </Form>
  );
}
function LocalEditor({ draft, models, refresh, onSaved }) {
  const [id] = useState(
      () => draft?.id || "voice-" + randomUUID().slice(0, 8),
    ),
    [created, setCreated] = useState(!!draft),
    [name, setName] = useState(draft?.id || ""),
    [voice, setVoice] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(null);
  const model = models?.find((m) => m.id === id) || draft;
  return (
    <div>
      <p>上传自有 Kokoro 模型，再将它保存为一个自定义引擎。</p>
      <Field label="引擎名称">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength="120"
          placeholder="给这套声音起一个名字"
        />
      </Field>
      <div className="speech-upload">
        <strong>1. 上传模型文件</strong>
        <p>
          需要 config.json、model.pth，以及 voices 目录中的至少一个 .pt
          声线文件。可分批选择，重复文件会替换。
        </p>
        <label className="button">
          <Upload size={16} /> 选择文件
          <input
            aria-label="选择模型文件"
            className="visually-hidden"
            type="file"
            multiple
            accept=".json,.pth,.pt"
            disabled={busy}
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = "";
              if (!files.length) return;
              setBusy(true);
              setError("");
              setProgress({ done: 0, total: files.length, file: "准备上传" });
              try {
                const prepared = files.map((file) => {
                  const target = ["config.json", "model.pth"].includes(
                    file.name,
                  )
                    ? file.name
                    : /^[a-z][a-z0-9_]{0,79}\.pt$/.test(file.name)
                      ? "voices/" + file.name
                      : null;
                  if (!target) throw Error("不支持的模型文件：" + file.name);
                  return { file, target };
                });
                if (!created) {
                  await api("models_create", { id });
                  setCreated(true);
                }
                for (let i = 0; i < prepared.length; i++) {
                  const { file, target } = prepared[i];
                  setProgress({
                    done: i,
                    total: files.length,
                    file: file.name,
                  });
                  const form = new FormData();
                  form.append("path", target);
                  form.append("file", file);
                  await request(`/api/models/${id}/upload`, {
                    method: "POST",
                    body: form,
                  });
                }
                setProgress({
                  done: files.length,
                  total: files.length,
                  file: "上传完成",
                });
                refresh();
              } catch (e) {
                setError(e.message);
                refresh();
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {progress && (
          <div role="status">
            <progress max={progress.total} value={progress.done} />
            <small>
              {progress.file} · {progress.done}/{progress.total}
            </small>
          </div>
        )}
        {created && (
          <p>
            {model?.ready ? "模型已就绪" : "等待完整的模型文件"} ·{" "}
            {model?.voices?.length || 0} 条声线
          </p>
        )}
      </div>
      <strong>2. 选择默认声线并保存</strong>
      <Field label="默认声线">
        <select
          value={voice || model?.voices?.[0] || ""}
          onChange={(e) => setVoice(e.target.value)}
          disabled={!model?.voices?.length}
        >
          <option value="" disabled>
            上传后选择
          </option>
          {model?.voices?.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </Field>
      <ErrorNote error={error} />
      <div className="form-actions">
        <Button
          className="primary"
          disabled={
            busy || !name.trim() || !model?.ready || !model?.voices?.length
          }
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const result = await api("engines_local", {
                model: id,
                voice: voice || model.voices[0],
                name: name.trim(),
              });
              onSaved(result.id);
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存自定义引擎
        </Button>
      </div>
    </div>
  );
}
export function SpeechSettings({ notify }) {
  const engines = useQuery("engines_list", {}, 1),
    models = useQuery("models_list"),
    [tab, setTab] = useState("builtin"),
    [audition, setAudition] = useState(null),
    [editor, setEditor] = useState(null),
    [method, setMethod] = useState(""),
    [remove, setRemove] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const builtins = engines.data?.filter((e) => e.builtin) || [],
    custom = engines.data?.filter((e) => !e.builtin) || [];
  const downloading = models.data?.some((m) =>
    ["downloading", "extracting"].includes(m.download?.state),
  );
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(models.refresh, 1500);
    return () => clearInterval(timer);
  }, [downloading]);
  const drafts =
    models.data?.filter(
      (m) =>
        !m.builtin &&
        !engines.data?.some(
          (e) => e.kind === "local" && e.config.model === m.id,
        ),
    ) || [];
  const saved = () => {
    engines.refresh();
    models.refresh();
    setEditor(null);
    setTab("custom");
    notify("自定义引擎已保存，可以试听了");
  };
  return (
    <div className="speech-settings">
      <div className="section-head">
        <div>
          <h2>语音引擎</h2>
          <p>按需下载推荐模型，或添加自定义模型与语音服务。</p>
        </div>
        <Button
          icon={Plus}
          onClick={() => {
            setMethod("");
            setEditor({});
          }}
        >
          添加自定义引擎
        </Button>
      </div>
      <div className="speech-tabs" aria-label="引擎分类">
        <Button
          aria-pressed={tab === "builtin"}
          onClick={() => setTab("builtin")}
        >
          推荐模型 · {builtins.length}
        </Button>
        <Button
          aria-pressed={tab === "custom"}
          onClick={() => setTab("custom")}
        >
          自定义引擎 · {custom.length}
        </Button>
      </div>
      <ErrorNote error={engines.error} />
      {engines.loading && !engines.data && <Loading />}
      <p className="speech-hint">
        {tab === "builtin"
          ? "模型首次使用前需要下载，安装后离线运行；更新平台会保留已下载模型。"
          : "连接外部服务或上传自有模型。AI 也可以通过 MCP / CLI 添加和测试自定义引擎。"}
      </p>
      <div className="speech-grid">
        {(tab === "builtin" ? builtins : custom).map((e) => {
          const model = models.data?.find((m) => m.id === e.config.model);
          const job = model?.download;
          const active = ["downloading", "extracting"].includes(job?.state);
          const installed = e.kind === "external" || model?.ready;
          return (
            <article className="speech-card" key={e.id}>
              <div className="section-head">
                <span className="speech-icon">
                  <Mic size={22} />
                </span>
                <span className="speech-badge">
                  {e.builtin
                    ? installed
                      ? "已安装"
                      : active
                        ? "下载中"
                        : "未安装"
                    : e.enabled
                      ? "已启用"
                      : "已停用"}
                </span>
              </div>
              <h3>{e.name}</h3>
              <p>
                {e.description ||
                  `${e.kind === "local" ? "本地模型" : "外部服务"} · ${e.config.model}`}
              </p>
              <div className="speech-tags">
                {e.languages?.map((l) => (
                  <span key={l}>{l}</span>
                ))}
                <span>
                  {e.voices
                    ? `${e.voices.length} 条${e.speakerCount ? "精选" : ""}声线`
                    : `默认声线：${e.config.voice}`}
                </span>
                {e.builtin && <span>本地运行</span>}
              </div>
              {e.source && (
                <a
                  className="speech-source"
                  href={e.source}
                  target="_blank"
                  rel="noreferrer"
                >
                  模型来源与许可 ↗
                </a>
              )}
              {active && (
                <div role="status">
                  <progress
                    max={job.totalBytes || undefined}
                    value={job.totalBytes ? job.receivedBytes : undefined}
                  />
                  <small>
                    {job.state === "extracting"
                      ? "正在解压并校验模型"
                      : `已下载 ${(job.receivedBytes / 1048576).toFixed(1)} MiB${job.totalBytes ? ` / ${(job.totalBytes / 1048576).toFixed(1)} MiB` : ""}`}
                  </small>
                </div>
              )}
              {job?.error && <ErrorNote error={job.error} />}
              <div className="speech-card-actions">
                {e.builtin && !installed && (
                  <Button
                    icon={Download}
                    className="primary"
                    disabled={busy || active || !!models.error}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api("models_download", { id: e.config.model });
                        models.refresh();
                      } catch (error) {
                        notify(error.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {active
                      ? "下载中…"
                      : job?.state === "failed"
                        ? "重试下载"
                        : "下载模型"}
                  </Button>
                )}
                <Button
                  icon={Play}
                  className="primary"
                  disabled={!e.enabled || !installed}
                  onClick={() => setAudition(e)}
                >
                  试听
                </Button>
                {e.builtin && installed && (
                  <Button
                    icon={Trash2}
                    aria-label={`移除 ${e.name} 模型`}
                    onClick={() => {
                      setError("");
                      setRemove({ model });
                    }}
                  />
                )}
                {!e.builtin && (
                  <>
                    <Button
                      icon={Settings2}
                      onClick={() => {
                        setMethod("external");
                        setEditor(e);
                      }}
                    >
                      配置
                    </Button>
                    <Button
                      icon={Trash2}
                      aria-label={`删除 ${e.name}`}
                      onClick={() => {
                        setError("");
                        setRemove({ engine: e });
                      }}
                    />
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {tab === "custom" && !custom.length && (
        <div className="speech-empty">
          <Mic size={28} />
          <h3>还没有自定义引擎</h3>
          <p>需要更多服务或自有模型时，在这里添加。</p>
        </div>
      )}
      <ErrorNote error={models.error} />
      {tab === "custom" && drafts.length > 0 && (
        <div className="speech-drafts">
          <h3>尚未完成的本地模型</h3>
          {drafts.map((m) => (
            <div className="settings-row" key={m.id}>
              <div>
                <strong>{m.id}</strong>
                <p>{m.ready ? "文件已就绪，可保存为引擎" : "等待模型文件"}</p>
              </div>
              <div className="row">
                <Button
                  onClick={() => {
                    setMethod("local");
                    setEditor({ draft: m });
                  }}
                >
                  继续设置
                </Button>
                <Button
                  aria-label={`删除模型 ${m.id}`}
                  icon={Trash2}
                  onClick={() => {
                    setError("");
                    setRemove({ model: m });
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {editor && (
        <Modal
          title={editor.id ? "配置自定义引擎" : "添加自定义引擎"}
          onClose={() => setEditor(null)}
        >
          {!method ? (
            <div className="speech-methods">
              <Button onClick={() => setMethod("external")}>
                <Settings2 />
                <strong>连接语音 API</strong>
                <span>已有服务地址、模型与声线</span>
              </Button>
              <Button onClick={() => setMethod("local")}>
                <Upload />
                <strong>上传本地模型</strong>
                <span>上传 Kokoro 权重，在当前工作台运行</span>
              </Button>
            </div>
          ) : (
            <>
              {!editor.id && !editor.draft && (
                <Button icon={ArrowLeft} onClick={() => setMethod("")}>
                  更换接入方式
                </Button>
              )}
              {method === "external" ? (
                <ExternalEditor
                  engine={editor}
                  model={models.data?.find(
                    (m) => m.id === editor.config?.model,
                  )}
                  onSaved={saved}
                />
              ) : (
                <LocalEditor
                  draft={editor.draft}
                  models={models.data}
                  refresh={models.refresh}
                  onSaved={saved}
                />
              )}
            </>
          )}
        </Modal>
      )}
      {audition && (
        <Audition engine={audition} onClose={() => setAudition(null)} />
      )}
      {remove && (
        <Modal
          title={remove.engine ? "删除自定义引擎" : "移除模型文件"}
          onClose={() => setRemove(null)}
        >
          <p>
            确认删除“{remove.engine?.name || remove.model.id}”？
            {remove.engine
              ? "已经生成的配音和模型文件会保留。"
              : "这会移除模型文件；已生成的配音会保留，推荐模型可以重新下载。"}
          </p>
          <ErrorNote error={error} />
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api(remove.engine ? "engines_delete" : "models_delete", {
                  id: remove.engine?.id || remove.model.id,
                });
                setRemove(null);
                engines.refresh();
                models.refresh();
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            确认删除
          </Button>
        </Modal>
      )}
    </div>
  );
}

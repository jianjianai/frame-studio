import { useState, useEffect } from "react";
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

export function SpeechControls({ engine, voice, setVoice, speed, setSpeed }) {
  return (
    <div className="speech-controls">
      <Field label="声线">
        {engine?.voices?.length ? (
          <select
            aria-label="声线"
            name="voice"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
          >
            {engine.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            name="voice"
            required
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            placeholder="服务提供的声线 ID"
          />
        )}
      </Field>
      <Field label={`语速 · ${Number(speed).toFixed(2)}×`}>
        <input
          aria-label="语速"
          name="speed"
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
      </Field>
    </div>
  );
}
function Audition({ engine, onClose }) {
  const [voice, setVoice] = useState(engine.config.voice),
    [speed, setSpeed] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
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
            setResult(
              await api("speech_test", {
                engine: engine.id,
                text: a.text,
                voice,
                speed,
              }),
            );
          } catch (e) {
            setError(e.message);
            throw e;
          } finally {
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
      {busy && (
        <div className="speech-feedback" role="status">
          <progress aria-label="试听生成进度" />
          <span>正在合成，首次使用该引擎需要加载模型…</span>
        </div>
      )}
      <ErrorNote error={error} />
      {result && (
        <div className="speech-result">
          <strong>
            <Check size={16} /> 试听已就绪
          </strong>
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
            enabled: a.enabled === "true",
            ...(apiKey ? { apiKey } : {}),
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
          : "连接兼容 OpenAI Speech 的服务。添加后可以先试听，再在作品中使用。"}
      </p>
      <Field label="引擎名称">
        <input
          name="name"
          required
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
          <Field label="服务地址">
            <input
              name="url"
              type="url"
              required
              defaultValue={engine.config?.url}
              placeholder="https://服务地址/v1"
              readOnly={engine.kind === "local"}
            />
          </Field>
          <small>填写 API 基础地址，无需附加 /audio/speech。</small>
          <div className="speech-controls">
            <Field label="模型名称">
              <input
                name="model"
                required
                defaultValue={engine.config?.model}
                readOnly={engine.kind === "local"}
              />
            </Field>
            <Field label="默认声线">
              <input
                name="voice"
                required
                defaultValue={engine.config?.voice}
              />
            </Field>
          </div>
          <Field label="API 密钥">
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              placeholder={
                engine.config?.configured
                  ? "已配置，留空保留原密钥"
                  : "无需密钥的服务可留空"
              }
            />
          </Field>
        </>
      )}
      {engine.id && (
        <Field label="状态">
          <select name="enabled" defaultValue={String(engine.enabled)}>
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
      () => draft?.id || "voice-" + crypto.randomUUID().slice(0, 8),
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
      <p>
        上传自有 Kokoro 模型，再将它保存为一个自定义引擎。
      </p>
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
  const downloading = models.data?.some((m) => ["downloading", "extracting"].includes(m.download?.state));
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
                {e.builtin ? installed ? "已安装" : active ? "下载中" : "未安装" : e.enabled ? "已启用" : "已停用"}
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
            {active && <div role="status">
              <progress max={job.totalBytes || undefined} value={job.totalBytes ? job.receivedBytes : undefined} />
              <small>{job.state === "extracting" ? "正在解压并校验模型" : `已下载 ${(job.receivedBytes / 1048576).toFixed(1)} MiB${job.totalBytes ? ` / ${(job.totalBytes / 1048576).toFixed(1)} MiB` : ""}`}</small>
            </div>}
            {job?.error && <ErrorNote error={job.error} />}
            <div className="speech-card-actions">
              {e.builtin && !installed && <Button icon={Download} className="primary" disabled={busy || active || !!models.error} onClick={async () => {
                setBusy(true);
                try { await api("models_download", { id: e.config.model }); models.refresh(); }
                catch (error) { notify(error.message); }
                finally { setBusy(false); }
              }}>{active ? "下载中…" : job?.state === "failed" ? "重试下载" : "下载模型"}</Button>}
              <Button
                icon={Play}
                className="primary"
                disabled={!e.enabled || !installed}
                onClick={() => setAudition(e)}
              >
                试听
              </Button>
              {e.builtin && installed && <Button icon={Trash2} aria-label={`移除 ${e.name} 模型`} onClick={() => { setError(""); setRemove({ model }); }} />}
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
        ); })}
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

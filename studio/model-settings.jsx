import { useEffect, useState } from "react";
import {
  Plus,
  Search,
  Settings2,
  RefreshCw,
  Check,
  ChevronRight,
  Link,
  Eye,
  EyeOff,
  Trash2,
  Power,
  Cpu,
  X,
  Download,
} from "lucide-react";
import {
  api,
  useQuery,
  useAction,
  Button,
  Field,
  Form,
  Modal,
  ErrorNote,
  Loading,
  Empty,
  date,
} from "./ui";
import {
  providerModels,
  providerAvailable,
} from "../src/contracts/ai-models.mjs";
import { useAiPreferences } from "./ai-preferences";
import { ModelPicker } from "./model-picker";

const payload = (provider, patch = {}) => ({
  id: provider.id,
  ...(provider.revision ? { expectedRevision: provider.revision } : {}),
  name: provider.name,
  tool: provider.tool,
  mode: provider.mode || "api",
  baseUrl: provider.baseUrl || "",
  model: provider.model || "",
  models:
    provider.models || providerModels(provider).filter((model) => model.id),
  enabled: provider.enabled !== false,
  ...patch,
});
const providerLabel = (provider) =>
  provider.enabled === false
    ? "已停用"
    : providerAvailable(provider)
      ? "已配置"
      : "待连接";

export function ConnectionForm({ initial, onClose, onSave }) {
  const [tool, setTool] = useState(initial.tool || "codex"),
    [mode, setMode] = useState(initial.mode || "api"),
    [showKey, setShowKey] = useState(false);
  return (
    <Modal title={initial.id ? "编辑提供商" : "添加提供商"} onClose={onClose}>
      <Form
        submit="保存提供商"
        onSubmit={async (values) => {
          const { name, baseUrl = "", apiKey, model } = values;
          const saved = await api("connections_save", {
            ...(initial.id ? payload(initial) : {}),
            name,
            tool,
            mode,
            baseUrl: mode === "api" ? baseUrl.trim() : "",
            ...(apiKey ? { apiKey } : {}),
            ...(!initial.id
              ? {
                  model: model?.trim() || "",
                  models: model?.trim()
                    ? [
                        {
                          id: model.trim(),
                          name: model.trim().slice(0, 100),
                          enabled: true,
                        },
                      ]
                    : [],
                }
              : {}),
          });
          onSave(saved);
        }}
      >
        <p className="settings-help">
          一个提供商共用一组连接凭据，可以添加多个模型。聊天栏将按这里的名称分组。
        </p>
        <Field label="提供商名称">
          <input
            name="name"
            defaultValue={initial.name || ""}
            placeholder="例如：OpenAI、团队 API、备用服务"
            required
            maxLength={100}
            autoFocus
          />
        </Field>
        <div className="settings-form-grid">
          <Field label="创作工具 / API 协议">
            <select
              value={tool}
              disabled={!!initial.id}
              onChange={(event) => setTool(event.target.value)}
            >
              <option value="codex">Codex · Responses API</option>
              <option value="claude">Claude Code · Messages API</option>
            </select>
          </Field>
          <Field label="认证方式">
            <select
              value={mode}
              disabled={!!initial.id}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="api">API 密钥</option>
              <option value="official">官方账号登录</option>
            </select>
          </Field>
        </div>
        {initial.id && (
          <p className="settings-help">
            更换创作工具或认证方式时，请新建提供商，以免旧会话混用凭据。
          </p>
        )}
        {mode === "api" ? (
          <>
            <Field label="API 地址">
              <input
                name="baseUrl"
                type="url"
                defaultValue={initial.baseUrl || ""}
                placeholder={
                  tool === "codex"
                    ? "https://api.openai.com/v1"
                    : "https://api.anthropic.com"
                }
              />
            </Field>
            <p className="settings-help">
              留空使用官方地址。填写接口根地址，不包含 /responses 或
              /messages；仅支持与所选工具兼容的接口。
            </p>
            <Field label="API 密钥">
              <div className="secret-input">
                <input
                  aria-label="API 密钥"
                  name="apiKey"
                  type={showKey ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder={
                    initial.configured ? "留空保留已保存密钥" : "输入 API 密钥"
                  }
                  required={!initial.configured}
                  maxLength={10000}
                />
                <button
                  type="button"
                  aria-label={showKey ? "隐藏密钥" : "显示输入的密钥"}
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
            <p className="settings-help">
              已保存密钥不会回传浏览器；此按钮只显示本次输入。
            </p>
          </>
        ) : (
          <p className="settings-callout">
            保存后，通过提供商详情中的“登录官方账号”完成授权，无需输入 API
            密钥。
          </p>
        )}
        {!initial.id && (
          <Field label="初始模型 ID（可稍后添加）">
            <input
              name="model"
              maxLength={200}
              placeholder="填写提供商给出的真实模型 ID"
            />
          </Field>
        )}
      </Form>
    </Modal>
  );
}

function DiscoverDialog({ provider, result, onClose, onSave }) {
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState([]);
  const existing = new Set((provider.models || []).map((model) => model.id));
  const filtered = result.models.filter((model) =>
    `${model.name} ${model.id}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <Modal title="从提供商添加模型" onClose={onClose}>
      <Form
        submit={`添加所选模型（${selected.length}）`}
        disabled={!selected.length}
        onSubmit={async () => {
          const additions = result.models.filter(
            (model) => selected.includes(model.id) && !existing.has(model.id),
          );
          const models = [...(provider.models || []), ...additions];
          if (models.length > 200)
            throw new Error("每个提供商最多保存 200 个模型，请减少选择");
          await api(
            "connections_save",
            payload(provider, {
              models,
              model:
                provider.model ||
                (provider.mode === "official" ? "" : additions[0]?.id || ""),
            }),
          );
          onSave();
        }}
      >
        <p className="settings-help">{result.message}</p>
        {result.truncated && (
          <p className="settings-callout">
            目录已截取，未列出的模型可通过 ID 手动添加。
          </p>
        )}
        <label className="settings-search">
          <Search size={15} />
          <input
            aria-label="搜索发现的模型"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索模型…"
          />
        </label>
        <div className="discover-models">
          {filtered.map((model) => (
            <label key={model.id} className="discover-model">
              <input
                type="checkbox"
                checked={existing.has(model.id) || selected.includes(model.id)}
                disabled={existing.has(model.id)}
                onChange={(event) =>
                  setSelected((old) =>
                    event.target.checked
                      ? [...old, model.id]
                      : old.filter((id) => id !== model.id),
                  )
                }
              />
              <span>
                <strong>{model.name}</strong>
                <small>{model.id}</small>
              </span>
              {existing.has(model.id) && <small>已添加</small>}
            </label>
          ))}
          {!filtered.length && <Empty>没有匹配的模型，可手动添加。</Empty>}
        </div>
      </Form>
    </Modal>
  );
}

export function ProviderSettings({ notify, LoginDialog }) {
  const connections = useQuery("connections_list", {}, 1),
    [selectedId, setSelectedId] = useState(""),
    [search, setSearch] = useState(""),
    [modelSearch, setModelSearch] = useState("");
  const [edit, setEdit] = useState(null),
    [login, setLogin] = useState(null),
    [adding, setAdding] = useState(false),
    [discovery, setDiscovery] = useState(null);
  const [run, busy] = useAction(notify),
    [pendingModel, setPendingModel] = useState(null);
  const providers = connections.data || [];
  const selected =
    providers.find((provider) => provider.id === selectedId) || providers[0];
  const filtered = providers.filter((provider) =>
    `${provider.name} ${provider.tool} ${provider.baseUrl}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  useEffect(() => {
    setModelSearch("");
  }, [selected?.id]);
  const saveModels = (models, preferred = selected.model) =>
    run(async () => {
      let model = preferred || "";
      if (model && !models.some((entry) => entry.id === model && entry.enabled))
        model = models.find((entry) => entry.enabled)?.id || "";
      if (selected.mode !== "official" && !model && selected.enabled !== false)
        throw new Error("至少保留一个启用的模型，或先停用此提供商");
      await api("connections_save", payload(selected, { models, model }));
      connections.refresh();
    });
  const testModel = (provider, model) =>
    run(async () => {
      setPendingModel(model ?? "");
      try {
        const result = await api("connections_test", {
          id: provider.id,
          ...(model === undefined ? {} : { model }),
        });
        notify(`${result.message} · ${Math.round(result.elapsedMs)} ms`);
      } finally {
        setPendingModel(null);
        connections.refresh();
      }
    });
  return (
    <section className="provider-settings">
      <div className="settings-section-heading">
        <div>
          <h2>提供商与模型</h2>
          <p>管理创作连接，在聊天中随时选择模型。</p>
        </div>
        <Button
          className="primary"
          icon={Plus}
          onClick={() => setEdit({ tool: "codex", mode: "api" })}
        >
          添加提供商
        </Button>
      </div>
      <ErrorNote error={connections.error} />
      {connections.error && (
        <Button onClick={connections.refresh}>重新加载提供商</Button>
      )}
      {connections.loading && !connections.data ? (
        <Loading />
      ) : !providers.length ? (
        <Empty
          action={
            <Button onClick={() => setEdit({ tool: "codex", mode: "api" })}>
              连接第一个提供商
            </Button>
          }
        >
          连接官方账号或兼容 API，然后添加可用模型。
        </Empty>
      ) : (
        <div className="provider-workspace">
          <aside className="provider-sidebar" aria-label="提供商列表">
            <label className="settings-search">
              <Search size={14} />
              <input
                aria-label="搜索提供商"
                placeholder="搜索提供商"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="provider-list">
              {filtered.map((provider) => (
                <button
                  type="button"
                  key={provider.id}
                  className={`provider-list-item ${selected?.id === provider.id ? "selected" : ""}`}
                  aria-pressed={selected?.id === provider.id}
                  disabled={busy}
                  onClick={() => setSelectedId(provider.id)}
                >
                  <span
                    className={`provider-dot ${providerAvailable(provider) ? "ready" : ""}`}
                  />
                  <span>
                    <strong>{provider.name}</strong>
                    <small>
                      {providerLabel(provider)} ·{" "}
                      {
                        providerModels(provider).filter(
                          (model) => model.enabled !== false,
                        ).length
                      }{" "}
                      个模型
                    </small>
                  </span>
                  <ChevronRight size={13} />
                </button>
              ))}
              {!filtered.length && (
                <p className="settings-help">没有匹配的提供商</p>
              )}
            </div>
          </aside>
          {selected && (
            <div className="provider-detail" key={selected.id}>
              <div className="provider-detail-heading">
                <div className="provider-mark">
                  <Cpu size={22} />
                </div>
                <div>
                  <h3>{selected.name}</h3>
                  <p>
                    {selected.tool === "claude" ? "Claude Code" : "Codex"} ·{" "}
                    {selected.mode === "official" ? "官方账号" : "API 密钥"}
                  </p>
                </div>
                <span
                  className={`badge ${providerAvailable(selected) ? "ready" : ""}`}
                >
                  {providerLabel(selected)}
                </span>
              </div>
              <div className="provider-endpoint">
                {selected.mode === "official"
                  ? "由官方创作工具管理登录"
                  : selected.baseUrl || "官方 API 地址"}
              </div>
              <div className="provider-actions">
                <Button
                  icon={Settings2}
                  disabled={busy}
                  onClick={() => setEdit(selected)}
                >
                  编辑连接
                </Button>
                <Button
                  icon={RefreshCw}
                  disabled={busy || !selected.configured}
                  title="API 测试会向所选模型发送少量请求，可能产生费用"
                  onClick={() => testModel(selected)}
                >
                  {selected.mode === "official" ? "检查登录" : "测试默认模型"}
                </Button>
                {selected.mode === "official" && (
                  <Button
                    icon={Link}
                    disabled={busy}
                    onClick={() => setLogin(selected)}
                  >
                    {selected.configured ? "重新登录" : "登录官方账号"}
                  </Button>
                )}
                <Button
                  icon={Power}
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api("connections_enabled", {
                        id: selected.id,
                        enabled: selected.enabled === false,
                      });
                      connections.refresh();
                    })
                  }
                >
                  {selected.enabled === false ? "启用提供商" : "停用提供商"}
                </Button>
              </div>
              {selected.enabled === false && (
                <p className="settings-callout">
                  此提供商不会用于新任务。历史对话仍保留，已经运行的任务不受影响。
                </p>
              )}
              {selected.lastTest && (
                <div
                  className={`provider-test ${selected.lastTest.ok ? "passed" : "failed"}`}
                  role="status"
                >
                  <strong>
                    {selected.lastTest.ok ? "测试成功" : "上次测试失败"}
                  </strong>
                  <span>
                    {selected.lastTest.model || "官方登录"} ·{" "}
                    {date(selected.lastTest.at)} · {selected.lastTest.elapsedMs}{" "}
                    ms
                  </span>
                  <p>{selected.lastTest.message}</p>
                </div>
              )}
              <div className="provider-model-heading">
                <div>
                  <h3>模型目录</h3>
                  <p>显示名用于选择，模型 ID 原样发送给提供商。</p>
                </div>
                <div className="row">
                  <Button
                    icon={Download}
                    disabled={
                      busy ||
                      selected.mode === "official" ||
                      !selected.configured
                    }
                    title={
                      selected.mode === "official"
                        ? "官方登录请手动添加模型 ID"
                        : "从已保存的 API 地址读取 /models"
                    }
                    onClick={() =>
                      run(async () =>
                        setDiscovery({
                          provider: selected,
                          result: await api("connections_discover", {
                            id: selected.id,
                          }),
                        }),
                      )
                    }
                  >
                    发现模型
                  </Button>
                  <Button
                    icon={Plus}
                    disabled={busy}
                    onClick={() => setAdding(true)}
                  >
                    添加模型
                  </Button>
                </div>
              </div>
              <Field label="提供商默认模型">
                <select
                  value={selected.model || ""}
                  disabled={busy}
                  onChange={(event) =>
                    saveModels(selected.models || [], event.target.value)
                  }
                >
                  <option value="" disabled={selected.mode !== "official"}>
                    工具默认模型
                  </option>
                  {(selected.models || [])
                    .filter((model) => model.enabled !== false)
                    .map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                </select>
              </Field>
              <label className="settings-search">
                <Search size={14} />
                <input
                  aria-label="搜索此提供商的模型"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="搜索名称或模型 ID"
                />
              </label>
              <div className="provider-models">
                {(selected.models || [])
                  .filter((model) =>
                    `${model.name} ${model.id}`
                      .toLowerCase()
                      .includes(modelSearch.toLowerCase()),
                  )
                  .map((model) => (
                    <div className="provider-model" key={model.id}>
                      <input
                        type="checkbox"
                        aria-label={`启用模型 ${model.name}`}
                        checked={model.enabled !== false}
                        disabled={busy}
                        onChange={(event) =>
                          saveModels(
                            selected.models.map((entry) =>
                              entry.id === model.id
                                ? { ...entry, enabled: event.target.checked }
                                : entry,
                            ),
                          )
                        }
                      />
                      <span className="provider-model-name">
                        <strong>
                          {model.name}
                          {selected.model === model.id && (
                            <small className="model-default">默认</small>
                          )}
                        </strong>
                        <code>{model.id}</code>
                      </span>
                      <Button
                        disabled={
                          busy ||
                          model.enabled === false ||
                          !selected.configured
                        }
                        title="测试会发送少量请求，可能产生费用"
                        aria-label={`测试模型 ${model.name}`}
                        onClick={() => testModel(selected, model.id)}
                      >
                        {pendingModel === model.id ? "测试中…" : "测试"}
                      </Button>
                      <Button
                        icon={Trash2}
                        disabled={busy}
                        aria-label={`移除模型 ${model.name}`}
                        title="仅移出目录，不删除历史对话"
                        onClick={() =>
                          saveModels(
                            selected.models.filter(
                              (entry) => entry.id !== model.id,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
              </div>
              {!selected.models?.length && (
                <p className="settings-callout">
                  {selected.mode === "official"
                    ? "当前使用工具默认模型；可以手动添加账号支持的模型。"
                    : "尚未添加模型。请发现或手动添加，再设置默认模型。"}
                </p>
              )}
              <p className="settings-help">
                停用或移除模型不会删除历史消息。已排队任务若引用停用模型，会明确失败，不会改用其他模型。
              </p>
            </div>
          )}
        </div>
      )}
      {edit && (
        <ConnectionForm
          initial={edit}
          onClose={() => setEdit(null)}
          onSave={(saved) => {
            connections.refresh();
            setSelectedId(saved.id);
            setEdit(null);
            notify("提供商已保存");
          }}
        />
      )}
      {login && (
        <LoginDialog
          kind={login.tool}
          target={login.id}
          notify={notify}
          onSuccess={connections.refresh}
          onClose={() => {
            setLogin(null);
            connections.refresh();
          }}
        />
      )}
      {adding && selected && (
        <Modal title="添加模型" onClose={() => setAdding(false)}>
          <Form
            submit="添加模型"
            onSubmit={async ({ id, name }) => {
              id = id.trim();
              if ((selected.models || []).some((model) => model.id === id))
                throw new Error("此模型 ID 已存在");
              const models = [
                ...(selected.models || []),
                { id, name: name.trim() || id.slice(0, 100), enabled: true },
              ];
              await api(
                "connections_save",
                payload(selected, {
                  models,
                  model:
                    selected.model || (selected.mode === "official" ? "" : id),
                }),
              );
              setAdding(false);
              connections.refresh();
            }}
          >
            <Field label="模型 ID">
              <input
                name="id"
                required
                autoFocus
                maxLength={200}
                placeholder="提供商提供的真实模型 ID"
              />
            </Field>
            <Field label="显示名称">
              <input
                name="name"
                maxLength={100}
                placeholder="可选，例如：主力创作"
              />
            </Field>
            <p className="settings-help">仅添加目录项，不会立即调用模型。</p>
          </Form>
        </Modal>
      )}
      {discovery && (
        <DiscoverDialog
          {...discovery}
          onClose={() => setDiscovery(null)}
          onSave={() => {
            setDiscovery(null);
            connections.refresh();
            notify("所选模型已添加");
          }}
        />
      )}
    </section>
  );
}

export function GeneralAiSettings() {
  const [preferences, savePreferences] = useAiPreferences(),
    connections = useQuery("connections_list", {}, 1);
  return (
    <section className="general-ai-settings">
      <div className="settings-section-heading">
        <div>
          <h2>创作偏好</h2>
          <p>保存在当前浏览器，不修改服务器凭据或其他人的设置。</p>
        </div>
      </div>
      <div className="preference-row">
        <div>
          <h3>新对话默认模型</h3>
          <p>已有对话继续使用自己的提供商。模型不可用时会提示重新选择。</p>
        </div>
        <div className="preference-model">
          <ModelPicker
            connections={connections.data || []}
            selection={preferences.defaultSelection}
            onChange={(defaultSelection) =>
              savePreferences({ defaultSelection })
            }
            loading={connections.loading}
          />
          <Button onClick={() => savePreferences({ defaultSelection: null })}>
            清除默认
          </Button>
        </div>
      </div>
      <div className="preference-row">
        <div>
          <h3>发送快捷键</h3>
          <p>中文输入法选字不会触发发送。Shift + Enter 始终换行。</p>
        </div>
        <select
          aria-label="发送快捷键"
          value={preferences.sendShortcut}
          onChange={(event) =>
            savePreferences({ sendShortcut: event.target.value })
          }
        >
          <option value="mod-enter">Ctrl / ⌘ + Enter 发送</option>
          <option value="enter">Enter 发送</option>
        </select>
      </div>
      <div className="preference-row">
        <div>
          <h3>聊天文字大小</h3>
          <p>应用于消息和创作输入框。</p>
        </div>
        <select
          aria-label="聊天文字大小"
          value={preferences.fontSize}
          onChange={(event) =>
            savePreferences({ fontSize: Number(event.target.value) })
          }
        >
          {[13, 14, 15, 16].map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
        </select>
      </div>
      <div className="preference-row">
        <div>
          <h3>运行中的新要求</h3>
          <p>
            新消息排队执行，不会冒充对当前任务的即时补充。关闭聊天栏不会停止服务器上的创作。
          </p>
        </div>
        <span className="badge">排队执行</span>
      </div>
    </section>
  );
}

export function ToolSettings({ notify }) {
  const tools = useQuery("tools_info", {}, 15000),
    [upgrade, setUpgrade] = useState(null);
  return (
    <section>
      <div className="settings-section-heading">
        <div>
          <h2>创作工具</h2>
          <p>工具负责执行，提供商负责模型和凭据；两者独立配置。</p>
        </div>
      </div>
      <ErrorNote error={tools.error} />
      {tools.loading && !tools.data && <Loading />}
      {tools.data?.map((tool) => (
        <div className="settings-row" key={tool.tool}>
          <div>
            <h3>{tool.tool === "codex" ? "Codex" : "Claude Code"}</h3>
            <p>{tool.version}</p>
            {tool.updates?.[0] && (
              <p>
                最近更新：{tool.updates[0].state}
                {tool.updates[0].error ? ` · ${tool.updates[0].error}` : ""}
              </p>
            )}
          </div>
          <Button onClick={() => setUpgrade(tool.tool)}>更新版本</Button>
        </div>
      ))}
      {upgrade && (
        <Modal title={`更新 ${upgrade}`} onClose={() => setUpgrade(null)}>
          <p>只影响后续新任务，更新失败保留当前版本。</p>
          <Form
            submit="安装版本"
            onSubmit={async ({ version }) => {
              await api("tools_update", { provider: upgrade, version });
              tools.refresh();
              setUpgrade(null);
              notify("工具更新已在后台开始");
            }}
          >
            <Field label="版本号">
              <input
                name="version"
                required
                pattern="[0-9]+\.[0-9]+\.[0-9]+.*"
                placeholder="填写明确的版本号"
              />
            </Field>
          </Form>
        </Modal>
      )}
    </section>
  );
}

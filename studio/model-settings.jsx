import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Search,
  Settings2,
  RefreshCw,
  ChevronRight,
  Link,
  Trash2,
  Power,
  Cpu,
  Download,
  Star,
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

import { ConnectionForm } from "./provider-connection";
export { ConnectionForm } from "./provider-connection";
import {
  providerPayload as payload,
  DiscoverDialog,
  ModelEditor,
  DeleteProviderDialog,
  ModelSummary,
} from "./provider-dialogs";
import { CodexCatalogStatus } from "./provider-catalog-status";
import "./provider-settings.css";
import "./provider-account.css";

const providerLabel = (provider) =>
  provider.enabled === false
    ? "已停用"
    : provider.state === "authorizing"
      ? "正在登录"
      : provider.state === "expired"
        ? "登录已过期"
        : provider.state === "unavailable"
          ? "CLI 不可用"
          : providerAvailable(provider)
            ? provider.mode !== "official" &&
              !provider.models?.some((m) => m.enabled !== false)
              ? "待添加模型"
              : provider.mode === "official"
                ? "已连接"
                : "已配置"
            : provider.mode === "official"
              ? "待登录"
              : "待连接";

const providerModelLabel = (provider) => {
  const count = providerModels(provider).filter(
    (model) => model.id && model.enabled !== false,
  ).length;
  return count
    ? `${count} 个模型`
    : provider.mode === "official"
      ? "工具默认"
      : "尚未添加模型";
};

export function ProviderSettings({ notify, LoginDialog, localMode = false }) {
  const connections = useQuery("connections_list", {}, 1),
    [selectedId, setSelectedId] = useState(""),
    [search, setSearch] = useState(""),
    [modelSearch, setModelSearch] = useState("");
  const [edit, setEdit] = useState(null),
    [login, setLogin] = useState(null),
    [modelEdit, setModelEdit] = useState(null),
    [deleting, setDeleting] = useState(null),
    [discovery, setDiscovery] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [run, actionBusy] = useAction(notify),
    [autoSync, setAutoSync] = useState(false),
    [pendingModel, setPendingModel] = useState(null);
  const syncAttempts = useRef(new Set());
  const busy = actionBusy || autoSync;
  const providers = connections.data || [];
  const selected =
    providers.find((provider) => provider.id === selectedId) || providers[0];
  const codexAccount =
    selected?.mode === "official" && selected.tool === "codex";
  useEffect(() => {
    if (
      !codexAccount ||
      !selected.configured ||
      selected.state !== "ready" ||
      busy ||
      login
    )
      return;
    const key = selected.id + ":" + selected.auth_generation;
    const catalog = selected.modelCatalog;
    if (
      syncAttempts.current.has(key) ||
      (!catalog?.error &&
        Date.now() - Date.parse(catalog?.fetchedAt || "") < 24 * 60 * 60 * 1000)
    )
      return;
    syncAttempts.current.add(key);
    setSyncError(null);
    setAutoSync(true);
    api("connections_sync_models", { id: selected.id })
      .catch((error) =>
        setSyncError({ id: selected.id, message: error.message }),
      )
      .finally(() => {
        setAutoSync(false);
        connections.refresh();
      });
  }, [
    selected?.id,
    selected?.auth_generation,
    selected?.configured,
    selected?.state,
    selected?.modelCatalog?.fetchedAt,
    selected?.modelCatalog?.error,
    codexAccount,
    busy,
    login,
  ]);
  const filtered = providers.filter((provider) =>
    `${provider.name} ${provider.tool} ${provider.baseUrl}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  useEffect(() => {
    setModelSearch("");
  }, [selected?.id]);
  const syncModels = () =>
    run(async () => {
      setSyncError(null);
      setAutoSync(true);
      try {
        const result = await api("connections_sync_models", {
          id: selected.id,
        });
        notify(`已同步 ${result.count} 个模型及参数`);
      } catch (error) {
        setSyncError({ id: selected.id, message: error.message });
        throw error;
      } finally {
        setAutoSync(false);
        connections.refresh();
      }
    });
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
          <p>Paseo 对话中的模型选择与界面偏好，在作品的 AI 面板内调整。</p>
          <p>
            {localMode
              ? "使用本机 Codex 和 Claude CLI；Codex 登录后自动同步模型与参数。请在终端登录官方账号。"
              : "连接 API 或 OpenAI 官方账号，自动获取模型与参数。手动配置仅作兜底。"}
          </p>
        </div>
        {!localMode && (
          <Button
            className="primary"
            icon={Plus}
            onClick={() => setEdit({ tool: "codex", mode: "api" })}
          >
            添加提供商
          </Button>
        )}
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
            <Button
              disabled={localMode}
              onClick={() => setEdit({ tool: "codex", mode: "api" })}
            >
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
                      {providerLabel(provider)} · {providerModelLabel(provider)}
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
                  disabled={
                    busy ||
                    !selected.configured ||
                    (selected.mode !== "official" && !selected.model)
                  }
                  title={
                    selected.mode === "official"
                      ? "确认账号登录，并更新 Codex 模型目录"
                      : "API 测试会向所选模型发送少量请求，可能产生费用"
                  }
                  onClick={() => testModel(selected)}
                >
                  {selected.mode === "official" ? "检查登录" : "测试默认模型"}
                </Button>
                {selected.mode === "official" && !localMode && (
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
              {codexAccount && (
                <CodexCatalogStatus
                  provider={selected}
                  syncing={autoSync}
                  error={syncError?.id === selected.id ? syncError.message : ""}
                  onSync={syncModels}
                  onLogin={() => setLogin(selected)}
                  localMode={localMode}
                />
              )}
              <div className="provider-model-heading">
                <div>
                  <h3>模型目录</h3>
                  <p>
                    {codexAccount ? "Codex 账号自动同步" : "API 自动填参"} ·
                    可查看来源和覆盖值 · {selected.models?.length || 0} / 200
                    个模型
                  </p>
                </div>
                <div className="row">
                  <Button
                    icon={codexAccount ? RefreshCw : Download}
                    disabled={
                      busy ||
                      (selected.mode === "official" && !codexAccount) ||
                      !selected.configured
                    }
                    title={
                      codexAccount
                        ? "读取已登录 Codex 的模型与能力参数，并保留手动配置"
                        : selected.mode === "official"
                          ? "官方登录请手动添加模型 ID"
                          : "从已保存的 API 地址读取 /models"
                    }
                    className="primary"
                    onClick={() =>
                      codexAccount
                        ? syncModels()
                        : setDiscovery({ provider: selected })
                    }
                  >
                    {codexAccount
                      ? autoSync
                        ? "正在同步…"
                        : "同步模型"
                      : "发现模型"}
                  </Button>
                  <Button
                    icon={Plus}
                    disabled={busy}
                    title="API 不支持目录或使用自定义模型 ID 时手动添加"
                    onClick={() =>
                      setModelEdit({ provider: selected, initial: {} })
                    }
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
                    {selected.mode === "official"
                      ? "工具默认模型"
                      : "请先获取并导入模型"}
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
                    <div
                      className={`provider-model ${model.enabled === false ? "disabled" : ""}`}
                      key={model.id}
                    >
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
                        {codexAccount &&
                          selected.modelCatalog?.defaultModel === model.id &&
                          selected.model !== model.id && (
                            <span className="model-recommended">工具推荐</span>
                          )}
                        <ModelSummary model={model} />
                      </span>
                      <Button
                        icon={Star}
                        className={
                          selected.model === model.id ? "is-default-model" : ""
                        }
                        disabled={
                          busy ||
                          model.enabled === false ||
                          selected.model === model.id
                        }
                        aria-label={`设为默认模型 ${model.name}`}
                        aria-pressed={selected.model === model.id}
                        title={
                          selected.model === model.id
                            ? "当前默认模型"
                            : "设为此提供商的默认模型"
                        }
                        onClick={() => saveModels(selected.models, model.id)}
                      />
                      <Button
                        icon={Settings2}
                        disabled={busy}
                        aria-label={`编辑模型参数 ${model.name}`}
                        title="查看自动规格或手动覆盖"
                        onClick={() =>
                          setModelEdit({ provider: selected, initial: model })
                        }
                      />
                      {selected.mode !== "official" && (
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
                      )}
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
              {!!selected.models?.length &&
                !selected.models.some((m) =>
                  `${m.name} ${m.id}`
                    .toLowerCase()
                    .includes(modelSearch.toLowerCase()),
                ) && <Empty>没有匹配的模型，试试其他名称或 ID。</Empty>}
              {!selected.models?.length && (
                <p className="settings-callout">
                  {codexAccount
                    ? autoSync
                      ? "正在自动获取模型与参数…"
                      : "登录后自动获取模型与参数，也可点击“同步模型”重试。"
                    : selected.mode === "official"
                      ? "当前使用工具默认模型；可以手动添加账号支持的模型。"
                      : "连接已保存。点击“发现模型”，勾选后即可导入；首次导入自动选择默认模型。"}
                </p>
              )}
              <p className="settings-help">
                发现模型也可更新已有规格，不覆盖手动值。停用或移除模型不会删除历史消息；任务不会暗中改用其他模型。
              </p>
              {!localMode && (
                <div className="provider-danger-zone">
                  <div>
                    <strong>删除此提供商</strong>
                    <p>清除连接凭据与模型目录，保留作品及历史对话。</p>
                  </div>
                  <Button
                    icon={Trash2}
                    className="danger"
                    disabled={busy}
                    onClick={() => setDeleting(selected)}
                  >
                    删除提供商
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {edit && (
        <ConnectionForm
          initial={edit}
          onClose={() => setEdit(null)}
          onSave={(saved) => {
            const created = !edit.id;
            connections.refresh();
            setSelectedId(saved.id);
            setEdit(null);
            notify("提供商已保存");
            if (created && saved.mode === "api")
              setDiscovery({ provider: saved });
            if (created && saved.mode === "official" && !localMode)
              setLogin(saved);
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
      {modelEdit && (
        <ModelEditor
          initial={modelEdit.initial}
          onClose={() => setModelEdit(null)}
          onSave={async (model) => {
            const provider = modelEdit.provider;
            if (
              !modelEdit.initial.id &&
              provider.models?.some((entry) => entry.id === model.id)
            )
              throw Error("此模型 ID 已存在，请编辑已有模型");
            const models = modelEdit.initial.id
              ? provider.models.map((entry) =>
                  entry.id === model.id ? model : entry,
                )
              : [...(provider.models || []), model];
            await api(
              "connections_save",
              payload(provider, {
                models,
                model:
                  provider.model ||
                  (provider.mode === "official" ? "" : model.id),
              }),
            );
            setModelEdit(null);
            connections.refresh();
            notify("模型已保存");
          }}
        />
      )}
      {discovery && (
        <DiscoverDialog
          {...discovery}
          onClose={() => setDiscovery(null)}
          onManual={(provider) => {
            setModelEdit({ provider, initial: {} });
            setDiscovery(null);
          }}
          onSave={({ added, updated }) => {
            setDiscovery(null);
            connections.refresh();
            notify(`已新增 ${added} 个模型，更新 ${updated} 个模型的规格`);
          }}
        />
      )}
      {deleting && (
        <DeleteProviderDialog
          provider={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(result) => {
            setDeleting(null);
            setSelectedId("");
            connections.refresh();
            notify(
              result.warning ||
                `提供商已删除，保留 ${result.preservedChats} 个历史对话`,
            );
          }}
        />
      )}
    </section>
  );
}

export { ToolSettings } from "./tool-settings.jsx";

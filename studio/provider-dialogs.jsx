import { useEffect, useId, useState } from "react";
import { Download, RefreshCw, Search, RotateCcw, Plus } from "lucide-react";
import {
  api,
  useQuery,
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
  providerModelSchema,
  mergeDiscoveredModels,
} from "../src/contracts/ai-models.mjs";
import {
  effectiveModelSpecs,
  modelSpecSource,
  formatModelTokens,
} from "../src/contracts/model-metadata.mjs";

export const providerPayload = (provider, patch = {}) => ({
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
  publicCatalog: provider.publicCatalog !== false,
  ...patch,
});
const sources = {
  api: "官方 / API 返回",
  catalog: "公共目录参考",
  manual: "手动覆盖",
  unknown: "未提供",
};
const specFields = [
  ["contextWindow", "上下文窗口", "tokens"],
  ["maxInputTokens", "最大输入", "tokens"],
  ["maxOutputTokens", "最大输出", "tokens"],
  ["vision", "图像理解", "boolean"],
  ["reasoning", "推理能力", "boolean"],
  ["reasoningEfforts", "支持的推理档位", "list"],
  ["defaultReasoningEffort", "默认推理档位", "effort"],
  ["toolCall", "工具调用", "boolean"],
  ["structuredOutput", "结构化输出", "boolean"],
  ["inputModalities", "输入类型", "list"],
  ["outputModalities", "输出类型", "list"],
  ["inputPrice", "输入价格", "price"],
  ["outputPrice", "输出价格", "price"],
  ["cacheReadPrice", "缓存读取价格", "price"],
  ["cacheWritePrice", "缓存写入价格", "price"],
];
const formatSpec = (value, kind) =>
  value == null
    ? "未提供"
    : kind === "tokens"
      ? `${formatModelTokens(value)} tokens`
      : kind === "boolean"
        ? value
          ? "支持"
          : "不支持"
        : kind === "price"
          ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} / 百万 tokens`
          : kind === "effort" ? value : value.join("、") || "未提供";

export function ModelSummary({ model }) {
  const spec = effectiveModelSpecs(model);
  const bits = [];
  if (spec.contextWindow)
    bits.push(`${formatModelTokens(spec.contextWindow)} 上下文`);
  else if (spec.maxInputTokens)
    bits.push(`${formatModelTokens(spec.maxInputTokens)} 输入`);
  if (spec.maxOutputTokens)
    bits.push(`${formatModelTokens(spec.maxOutputTokens)} 输出`);
  if (spec.vision) bits.push("视觉");
  if (spec.reasoning) bits.push(spec.defaultReasoningEffort ? `推理 · ${spec.defaultReasoningEffort}` : "推理");
  if (spec.toolCall) bits.push("工具");
  return (
    <span className="model-spec-summary">
      {bits.length ? bits.map((bit) => <span className="model-spec-tag" key={bit}>{bit}</span>) : "规格未提供 · 可手动补充"}
    </span>
  );
}

export function DiscoverDialog({ provider, onClose, onSave, onManual }) {
  const [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [attempt, setAttempt] = useState(0),
    [snapshot, setSnapshot] = useState(provider),
    [search, setSearch] = useState(""),
    [scope, setScope] = useState("all"),
    [selected, setSelected] = useState([]),
    [preferred, setPreferred] = useState(provider.model || "");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const latest = (await api("connections_list")).find(
          (entry) => entry.id === provider.id,
        );
        if (!latest) throw Error("提供商已删除，请关闭此窗口");
        const next = await api("connections_discover", { id: latest.id });
        if (active) {
          setSnapshot(latest);
          setResult(next);
          setSelected([]);
          setPreferred(latest.model || "");
        }
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [provider.id, attempt]);
  const existing = new Set((snapshot.models || []).map((entry) => entry.id));
  const filtered = (result?.models || []).filter(
    (entry) =>
      `${entry.name} ${entry.id}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()) &&
      (scope === "all" || existing.has(entry.id) === (scope === "existing")),
  );
  const additions = selected.filter((id) => !existing.has(id)).length;
  const updates = selected.length - additions;
  const remaining = 200 - existing.size - additions;
  const defaultOptions = [
    ...(snapshot.models || []).filter((entry) => entry.enabled !== false),
    ...(result?.models || []).filter(
      (entry) => selected.includes(entry.id) && !existing.has(entry.id),
    ),
  ];
  const defaultId = defaultOptions.some((entry) => entry.id === preferred)
    ? preferred
    : snapshot.mode === "official"
      ? ""
      : defaultOptions[0]?.id || "";
  function toggle(id, checked) {
    setSelected((old) =>
      checked
        ? [...new Set([...old, id])]
        : old.filter((value) => value !== id),
    );
  }
  function selectVisible() {
    setSelected((old) => {
      const next = new Set(old);
      let space =
        200 - existing.size - old.filter((id) => !existing.has(id)).length;
      for (const entry of filtered) {
        if (next.has(entry.id)) continue;
        if (existing.has(entry.id)) next.add(entry.id);
        else if (space > 0) {
          next.add(entry.id);
          space--;
        }
      }
      return [...next];
    });
  }
  return (
    <Modal title="从提供商添加模型" onClose={onClose} wide>
      <div className="catalog-intro">
        <span className="catalog-icon">
          <Download size={21} />
        </span>
        <div>
          <strong>{snapshot.name}</strong>
          <p>获取列表与规格 → 选择模型 → 导入使用</p>
        </div>
        <Button
          type="button"
          icon={RefreshCw}
          disabled={loading || saving}
          onClick={() => setAttempt((n) => n + 1)}
        >
          重新获取
        </Button>
      </div>
      {loading && (
        <div className="catalog-loading" role="status">
          <Loading />
          <p>正在读取模型目录与参数，不会发送生成请求…</p>
        </div>
      )}
      <ErrorNote error={error} />
      {!loading && result && !error && (
        <Form
          submit={
            updates
              ? `导入并更新（${selected.length}）`
              : `添加所选模型（${selected.length}）`
          }
          disabled={!selected.length || remaining < 0}
          onSubmit={async () => {
            setSaving(true);
            try {
              const models = mergeDiscoveredModels(
                snapshot.models || [],
                result.models,
                selected,
              );
              await api(
                "connections_save",
                providerPayload(snapshot, { models, model: defaultId }),
              );
              onSave({ added: additions, updated: updates });
            } finally {
              setSaving(false);
            }
          }}
        >
          <fieldset className="catalog-form-body" disabled={saving}>
            <p className="settings-help">{result.message}</p>
            {result.truncated && (
              <p className="settings-callout">
                当前是部分目录，可重新获取或手动补充；不会移除已保存的模型。
              </p>
            )}
            {result.warnings?.map((warning) => (
              <p className="settings-callout" key={warning}>
                {warning}
              </p>
            ))}
            <div className="catalog-filter-row">
              <label className="settings-search">
                <Search size={15} />
                <input
                  aria-label="搜索发现的模型"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索模型名称或 ID…"
                />
              </label>
              <select
                aria-label="筛选发现的模型"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="all">全部模型</option>
                <option value="new">尚未添加</option>
                <option value="existing">已添加 · 更新规格</option>
              </select>
            </div>
            <div className="catalog-selection-bar">
              <span>
                {filtered.length} 个结果 · 新增 {additions} · 更新 {updates}
              </span>
              <Button
                type="button"
                onClick={selectVisible}
                disabled={!filtered.length}
              >
                选择当前结果
              </Button>
              <Button
                type="button"
                onClick={() => setSelected([])}
                disabled={!selected.length}
              >
                清除选择
              </Button>
            </div>
            <div className="discover-models">
              {filtered.map((model) => (
                <label key={model.id} className="discover-model">
                  <input
                    type="checkbox"
                    aria-label={`选择模型 ${model.name}`}
                    checked={selected.includes(model.id)}
                    disabled={
                      !existing.has(model.id) &&
                      !selected.includes(model.id) &&
                      remaining <= 0
                    }
                    onChange={(e) => toggle(model.id, e.target.checked)}
                  />
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.id}</small>
                    <ModelSummary model={model} />
                  </span>
                  <span className="catalog-row-status">
                    <small>
                      {existing.has(model.id) ? "更新规格" : "可添加"}
                    </small>
                    <small>
                      {Object.values(model.metadata?.sources || {}).includes(
                        "catalog",
                      )
                        ? "含公共参考"
                        : Object.keys(model.metadata?.sources || {}).length
                          ? "API 参数"
                          : "仅 ID"}
                    </small>
                  </span>
                </label>
              ))}
              {!filtered.length && (
                <Empty>
                  没有匹配的模型。可以调整搜索条件，或手动添加模型 ID。
                </Empty>
              )}
            </div>
            {selected.length > 0 && (
              <Field label="导入后默认模型">
                <select
                  value={defaultId}
                  onChange={(e) => setPreferred(e.target.value)}
                >
                  {snapshot.mode === "official" && (
                    <option value="">工具默认模型</option>
                  )}
                  {defaultOptions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <p className="settings-help">
              剩余 {Math.max(0, remaining)}{" "}
              个目录名额。更新保留自定义名称、启停状态和手动覆盖。公共参数仅作参考，实际限额与价格以当前提供商为准。
            </p>
          </fieldset>
        </Form>
      )}
      <div className="catalog-fallback">
        <span>
          {error
            ? "连接已保存，可修正连接后重试，也可手动添加。"
            : "列表缺失或使用自定义别名？"}
        </span>
        <Button
          type="button"
          icon={Plus}
          disabled={loading || saving}
          onClick={() => onManual(snapshot)}
        >
          手动添加模型
        </Button>
      </div>
    </Modal>
  );
}

export function ModelEditor({ initial = {}, onClose, onSave }) {
  const effortListId = useId();
  const [overrides, setOverrides] = useState(initial.overrides || {});
  const draft = { ...initial, overrides },
    specs = effectiveModelSpecs(draft);
  const effortOptions = [...new Set([...(specs.reasoningEfforts || []), specs.defaultReasoningEffort].filter(Boolean))];
  const set = (key, value) => setOverrides((old) => ({ ...old, [key]: value }));
  const reset = (key) =>
    setOverrides((old) => {
      const next = { ...old };
      delete next[key];
      return next;
    });
  return (
    <Modal title={initial.id ? "模型参数" : "添加模型"} onClose={onClose} wide>
      <Form
        submit={initial.id ? "保存模型" : "添加模型"}
        onSubmit={async ({ id, name }) => {
          const model = providerModelSchema.parse({
            ...initial,
            id: initial.id || id.trim(),
            name: name.trim() || (initial.id || id.trim()).slice(0, 100),
            enabled: initial.enabled !== false,
            overrides,
          });
          await onSave(model);
        }}
      >
        {!initial.id && (
          <p className="settings-help">
            手动添加仅作兜底：通常从 API 获取即可自动填好规格。这里只需模型
            ID，其他项均可留空。
          </p>
        )}
        <div className="settings-form-grid">
          <Field label="模型 ID">
            <input
              name="id"
              defaultValue={initial.id || ""}
              readOnly={!!initial.id}
              required
              maxLength={200}
              autoFocus={!initial.id}
              placeholder="提供商给出的真实模型 ID"
            />
          </Field>
          <Field label="显示名称">
            <input
              name="name"
              defaultValue={initial.name || ""}
              maxLength={100}
              autoFocus={!!initial.id}
              placeholder="可选，默认使用模型名称"
            />
          </Field>
        </div>
        {initial.id && (
          <>
            {initial.metadata?.description && <p className="model-description">{initial.metadata.description}</p>}
            <div className="model-spec-grid">
              {specFields.slice(0, 3).map(([key, label, kind]) => (
                <div key={key}>
                  <span>{label}</span>
                  <strong>{formatSpec(specs[key], kind)}</strong>
                  <small>{sources[modelSpecSource(draft, key)]}</small>
                </div>
              ))}
            </div>
            <dl className="model-spec-list">
              {specFields.slice(3).map(([key, label, kind]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>
                    {formatSpec(specs[key], kind)}
                    <small>{sources[modelSpecSource(draft, key)]}</small>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="settings-help">
              {initial.metadata?.fetchedAt
                ? `规格获取于 ${date(initial.metadata.fetchedAt)}。`
                : "暂无自动规格。"}
              未提供不等于不支持；这些是模型规格，不会强行覆盖 Codex / Claude
              Code 的生成配置，也不代表已通过接口兼容性测试。
            </p>
          </>
        )}
        <details className="model-overrides">
          <summary>
            高级：手动补充或覆盖参数
            {Object.keys(overrides).length > 0
              ? `（${Object.keys(overrides).length} 项）`
              : ""}
          </summary>
          <p className="settings-help">
            已有值自动填入。编辑后标记为手动覆盖，同步不会覆盖它；“恢复自动”重新采用
            API 或目录数据。清空数值表示手动标为未知。价格单位为美元 / 百万
            tokens。
          </p>
          <div className="settings-form-grid">
            {specFields.map(([key, label, kind]) => (
              <div className="model-override-field" key={key}>
                <Field label={label}>
                  {kind === "boolean" ? (
                    <select
                      aria-label={`覆盖${label}`}
                      value={
                        Object.hasOwn(overrides, key)
                          ? String(overrides[key])
                          : "auto"
                      }
                      onChange={(e) =>
                        e.target.value === "auto"
                          ? reset(key)
                          : set(
                              key,
                              e.target.value === "null"
                                ? null
                                : e.target.value === "true",
                            )
                      }
                    >
                      <option value="auto">
                        自动 · {formatSpec(initial.metadata?.[key], kind)}
                      </option>
                      <option value="true">支持</option>
                      <option value="false">不支持</option>
                      <option value="null">未知</option>
                    </select>
                  ) : kind === "list" ? (
                    <input
                      aria-label={`覆盖${label}`}
                      value={(specs[key] || []).join(",")}
                      onChange={(e) => set(key, e.target.value ? [...new Set(e.target.value.split(",").map((v) => v.trim()).filter(Boolean))] : null)}
                      placeholder={key === "reasoningEfforts" ? "none,minimal,low,medium,high,xhigh,max,ultra" : "text,image,audio,video,pdf,file,embedding"}
                    />
                  ) : kind === "effort" ? (
                    <>
                    <input
                      aria-label={`覆盖${label}`}
                      value={specs[key] ?? ""}
                      maxLength={32}
                      list={effortListId}
                      onChange={(e) => set(key, e.target.value || null)}
                      placeholder="采用工具返回的默认值"
                    />
                    <datalist id={effortListId}>{effortOptions.map((effort) => <option key={effort} value={effort} />)}</datalist>
                    </>
                  ) : (
                    <input
                      aria-label={`覆盖${label}`}
                      type="number"
                      min={kind === "price" ? 0 : 1}
                      max={kind === "price" ? 1000000 : 1000000000}
                      step={kind === "price" ? "any" : 1}
                      value={specs[key] ?? ""}
                      onChange={(e) =>
                        set(
                          key,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                      placeholder="未提供，无需填写"
                    />
                  )}
                </Field>
                <div className="model-field-source">
                  <small>{sources[modelSpecSource(draft, key)]}</small>
                  {Object.hasOwn(overrides, key) && (
                    <Button
                      type="button"
                      icon={RotateCcw}
                      aria-label={`恢复自动${label}`}
                      onClick={() => reset(key)}
                    >
                      恢复自动
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      </Form>
    </Modal>
  );
}

export function DeleteProviderDialog({ provider, onClose, onDeleted }) {
  const usage = useQuery("connections_usage", { id: provider.id }, 1);
  const [name, setName] = useState("");
  const blocked =
    !usage.data ||
    usage.error ||
    usage.data.nativeActive ||
    usage.data.activeTasks > 0 ||
    usage.data.pendingLogins > 0;
  return (
    <Modal title="删除提供商" onClose={onClose}>
      <p className="settings-help">
        删除 <strong>{provider.name}</strong> 及其{" "}
        {provider.models?.length || 0}{" "}
        个模型目录项，并清除此连接的密钥与登录凭据。此操作不能撤销，作品内容会保留。
      </p>
      {usage.loading && !usage.data && <Loading />}
      <ErrorNote error={usage.error} />
      {usage.data && (
        <div className="provider-delete-impact">
          {usage.data.nativeActive && (
            <p role="alert">Paseo 正在使用此提供商创作，请先完成或停止。</p>
          )}
          {usage.data.activeTasks > 0 && (
            <p role="alert">
              还有 {usage.data.activeTasks}{" "}
              个任务正在使用此提供商，请先完成或停止任务。
            </p>
          )}
          {usage.data.pendingLogins > 0 && (
            <p role="alert">正在进行官方授权，请在授权结束后重试。</p>
          )}
        </div>
      )}
      {blocked && (
        <Button type="button" icon={RefreshCw} onClick={usage.refresh}>
          重新检查使用情况
        </Button>
      )}
      <Form
        submit="永久删除提供商"
        disabled={!!blocked || name !== provider.name}
        onSubmit={async () => {
          const result = await api("connections_delete", {
            id: provider.id,
            expectedRevision: provider.revision,
            confirmName: name,
          });
          onDeleted(result);
        }}
      >
        <Field label="输入提供商名称以确认">
          <input
            name="confirmName"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={provider.name}
            required
          />
        </Field>
      </Form>
    </Modal>
  );
}

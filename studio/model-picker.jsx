import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Search,
  Settings2,
  Star,
  Cpu,
  X,
} from "lucide-react";
import {
  providerModels,
  providerAvailable,
  modelSelectionKey,
} from "../src/contracts/ai-models.mjs";
import { useAiPreferences } from "./ai-preferences";
import { effectiveModelSpecs, formatModelTokens } from "../src/contracts/model-metadata.mjs";

export function ModelPicker({
  connections = [],
  selection,
  onChange,
  disabled = false,
  loading = false,
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [active, setActive] = useState(0);
  const [preferences, savePreferences] = useAiPreferences();
  const root = useRef(null),
    trigger = useRef(null),
    input = useRef(null),
    id = useId();
  const connection = connections.find(
    (entry) => entry.id === selection?.connection,
  );
  const chosen =
    connection &&
    providerModels(connection).find((entry) => entry.id === selection?.model);
  const groups = connections
    .map((provider) => ({
      provider,
      models: providerModels(provider)
        .filter((model) =>
          `${provider.name} ${provider.tool} ${model.name} ${model.id}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase().trim()),
        )
        .sort(
          (a, b) =>
            Number(
              preferences.favorites.includes(
                modelSelectionKey(provider.id, b.id),
              ),
            ) -
            Number(
              preferences.favorites.includes(
                modelSelectionKey(provider.id, a.id),
              ),
            ),
        ),
    }))
    .filter((group) => group.models.length);
  const rows = groups.flatMap(({ provider, models }) =>
    models.map((model) => ({
      provider,
      model,
      key: modelSelectionKey(provider.id, model.id),
      enabled: providerAvailable(provider) && model.enabled !== false,
    })),
  );
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (row) => {
    if (!row?.enabled) return;
    onChange({ connection: row.provider.id, model: row.model.id });
    close();
  };
  useEffect(() => {
    setActive(0);
    const list = document.getElementById(`${id}-list`);
    if (list) list.scrollTop = 0;
  }, [search, id]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const selectedIndex = rows.findIndex(
      (row) =>
        row.provider.id === selection?.connection &&
        row.model.id === selection?.model,
    );
    setActive(Math.max(0, selectedIndex));
    const frame = requestAnimationFrame(() => {
      const list = document.getElementById(`${id}-list`);
      if (selectedIndex <= 0 && list) list.scrollTop = 0;
      else
        document
          .getElementById(`${id}-option-${selectedIndex}`)
          ?.scrollIntoView({ block: "nearest" });
    });
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  let index = -1;
  return (
    <div
      className="model-picker"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          const next = rows.length
            ? (active + step + rows.length) % rows.length
            : 0;
          setActive(next);
          document
            .getElementById(`${id}-option-${next}`)
            ?.scrollIntoView({ block: "nearest" });
          input.current?.focus();
        }
        if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault();
          choose(rows[active]);
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="model-trigger"
        aria-label="选择模型"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-connection={selection?.connection || ""}
        title={
          connection
            ? `${connection.name} · ${chosen?.name || selection?.model || "工具默认模型"}`
            : "选择提供商与模型"
        }
        disabled={disabled || loading}
        onClick={() => {
          setSearch("");
          setOpen(!open);
        }}
      >
        <Cpu size={14} />
        <span>
          {loading
            ? "加载模型…"
            : chosen?.name ||
              (selection?.model ? `${selection.model}（不可用）` : "选择模型")}
        </span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="model-menu" role="dialog" aria-label="模型选择器">
          <div className="model-search">
            <Search size={15} />
            <input
              ref={input}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="搜索模型或提供商"
              placeholder="搜索模型或提供商…"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={
                rows[active] ? `${id}-option-${active}` : undefined
              }
            />
            <button type="button" aria-label="关闭模型选择" onClick={close}>
              <X size={14} />
            </button>
          </div>
          <div
            className="model-options"
            id={`${id}-list`}
            role="listbox"
            aria-label="按提供商分组的模型"
          >
            {groups.map(({ provider, models }) => (
              <div
                role="group"
                aria-label={provider.name}
                key={provider.id}
                className="model-group"
              >
                <div className="model-group-label">
                  <strong>{provider.name}</strong>
                  <span>
                    {provider.tool === "claude" ? "Claude Code" : "Codex"}
                  </span>
                </div>
                {models.map((model) => {
                  const rowIndex = ++index,
                    row = rows[rowIndex],
                    selected =
                      selection?.connection === provider.id &&
                      selection?.model === model.id;
                  const favorite = preferences.favorites.includes(row.key);
                  const specs = effectiveModelSpecs(model);
                  const specLabel = [
                    specs.contextWindow ? `${formatModelTokens(specs.contextWindow)} 上下文` : "",
                    specs.defaultReasoningEffort ? `推理 ${specs.defaultReasoningEffort}` : "",
                    specs.vision ? "视觉" : "",
                  ].filter(Boolean).join(" · ");
                  const recommended = provider.models?.find((entry) => entry.id === provider.modelCatalog?.defaultModel);
                  const unavailable =
                    provider.enabled === false
                      ? "提供商已停用"
                      : !providerAvailable(provider)
                        ? "需连接提供商"
                        : model.enabled === false
                          ? "模型已停用"
                          : "";
                  return (
                    <div
                      className={`model-option-row ${rowIndex === active ? "is-active" : ""}`}
                      key={row.key}
                    >
                      <button
                        type="button"
                        role="option"
                        id={`${id}-option-${rowIndex}`}
                        aria-selected={selected}
                        aria-disabled={!row.enabled}
                        title={unavailable || model.id || "由工具选择默认模型"}
                        className="model-option"
                        onMouseEnter={() => setActive(rowIndex)}
                        onClick={() => choose(row)}
                      >
                        <span>
                          <strong>{model.name}</strong>
                          <small>
                            {unavailable || model.id || (recommended ? `工具推荐：${recommended.name}` : "跟随创作工具默认设置")}
                          </small>
                          {specLabel && <small className="model-option-specs">{specLabel}</small>}
                        </span>
                        {selected && <Check size={15} />}
                      </button>
                      <button
                        type="button"
                        className={`model-star ${favorite ? "is-favorite" : ""}`}
                        aria-label={`${favorite ? "取消收藏" : "收藏"} ${provider.name} ${model.name}`}
                        aria-pressed={favorite}
                        onClick={() =>
                          savePreferences({
                            favorites: favorite
                              ? preferences.favorites.filter(
                                  (entry) => entry !== row.key,
                                )
                              : [...preferences.favorites, row.key],
                          })
                        }
                      >
                        <Star size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            {!rows.length && (
              <p className="model-empty">
                {connections.length ? "没有匹配的模型" : "尚未配置提供商"}
              </p>
            )}
          </div>
          <a
            className="model-settings-link"
            href="#/settings/ai"
            target="_blank"
            rel="noopener"
          >
            <Settings2 size={14} />
            管理提供商与模型<span>↗</span>
          </a>
        </div>
      )}
    </div>
  );
}

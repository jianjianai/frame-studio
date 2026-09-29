import { useState } from "react";
import { Eye, EyeOff, Check } from "lucide-react";
import { api, Field, Form, Modal } from "./ui";
import { providerPayload } from "./provider-dialogs";

const presets = [
  {
    id: "openai",
    name: "OpenAI",
    tool: "codex",
    baseUrl: "https://api.openai.com/v1",
    description: "Responses API",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    tool: "claude",
    baseUrl: "https://api.anthropic.com",
    description: "Messages API",
  },
  {
    id: "custom",
    name: "自定义 API",
    tool: "codex",
    baseUrl: "",
    description: "团队网关 / 兼容接口",
  },
];
export function ConnectionForm({ initial, onClose, onSave }) {
  const [tool, setTool] = useState(initial.tool || "codex"),
    [mode, setMode] = useState(initial.mode || "api"),
    [name, setName] = useState(initial.name || ""),
    [baseUrl, setBaseUrl] = useState(initial.baseUrl || ""),
    [preset, setPreset] = useState("custom"),
    [showKey, setShowKey] = useState(false),
    [publicCatalog, setPublicCatalog] = useState(
      initial.publicCatalog !== false,
    );
  return (
    <Modal title={initial.id ? "编辑提供商" : "添加提供商"} onClose={onClose}>
      <Form
        submit={!initial.id && mode === "api" ? "保存并获取模型" : "保存提供商"}
        onSubmit={async ({ apiKey, model }) => {
          const saved = await api("connections_save", {
            ...(initial.id ? providerPayload(initial) : {}),
            name,
            tool,
            mode,
            publicCatalog,
            baseUrl: mode === "api" ? baseUrl.trim() : "",
            ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
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
          await onSave(saved);
        }}
      >
        {!initial.id && (
          <>
            <p className="settings-help">
              选择连接类型，填入密钥。保存后自动获取模型及规格，无需逐个填写参数。
            </p>
            <div className="provider-presets" aria-label="提供商模板">
              {presets.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  aria-pressed={preset === entry.id}
                  onClick={() => {
                    setPreset(entry.id);
                    setTool(entry.tool);
                    setMode("api");
                    setBaseUrl(entry.baseUrl);
                    setName(entry.id === "custom" ? "" : entry.name);
                  }}
                >
                  <strong>
                    {entry.name}
                    {preset === entry.id && <Check size={12} />}
                  </strong>
                  <small>{entry.description}</small>
                </button>
              ))}
            </div>
          </>
        )}
        <Field label="提供商名称">
          <input
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
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
              onChange={(event) => {
                setTool(event.target.value);
                setPreset("custom");
              }}
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
            工具和认证方式绑定旧会话，更换时请新建提供商。留空密钥保留现有凭据。
          </p>
        )}
        {mode === "api" ? (
          <>
            <Field label="API 地址">
              <input
                name="baseUrl"
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={
                  tool === "codex"
                    ? "https://api.openai.com/v1"
                    : "https://api.anthropic.com"
                }
                maxLength={1000}
              />
            </Field>
            <p className="settings-help">
              留空使用官方地址。粘贴 /models、/responses 或 /messages
              地址也会自动整理为接口根地址。接口仍需支持所选协议，仅支持 Chat
              Completions 的服务不能用于 Codex。
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
              密钥加密存储，保存后不会回传浏览器；只向此提供商发送。获取目录不会发送生成请求。
            </p>
            <details className="model-overrides">
              <summary>高级选项与手动兜底</summary>
              <label className="provider-option">
                <input
                  type="checkbox"
                  checked={publicCatalog}
                  onChange={(event) => setPublicCatalog(event.target.checked)}
                />
                <span>
                  用公共模型目录补齐缺失规格
                  <small>
                    API 数据优先；服务端下载并缓存 models.dev 公共目录进行精确
                    ID 匹配，不向其发送密钥、连接地址或模型
                    ID。参考价格不代表网关实际收费，可关闭。
                  </small>
                </span>
              </label>
              {!initial.id && (
                <Field label="初始模型 ID（可稍后添加）">
                  <input
                    name="model"
                    maxLength={200}
                    placeholder="可留空，优先使用自动发现"
                  />
                </Field>
              )}
            </details>
          </>
        ) : (
          <p className="settings-callout">
            保存后通过“登录官方账号”授权。官方账号与 API
            密钥的可用模型范围不同，不会拿公共目录冒充账号权限；可使用工具默认模型，或手动补充账号支持的模型。
          </p>
        )}
      </Form>
    </Modal>
  );
}

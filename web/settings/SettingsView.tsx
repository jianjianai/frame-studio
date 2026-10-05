import { useEffect, useState } from "react";
import {
  Sparkles,
  AudioLines,
  Plug,
  Info,
  LogIn,
  LogOut,
  ExternalLink,
  Plus,
  Trash2,
  Pencil,
  Download,
  CheckCircle2,
  Loader2,
  Copy,
  KeyRound,
} from "lucide-react";
import { api, del, patch, formatBytes, useServerEvent } from "../lib/api";
import { Dialog, useAction, useConfirm, useToast } from "../lib/ui";
import { GithubIcon } from "../components/icons";
import "./settings.css";

const SECTIONS = [
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "speech", label: "语音", icon: AudioLines },
  { id: "github", label: "GitHub", icon: GithubIcon },
  { id: "mcp", label: "MCP 接入", icon: Plug },
  { id: "about", label: "关于", icon: Info },
];

export function SettingsView({ initial }: { initial?: string | null }) {
  const [section, setSection] = useState(initial || "ai");
  return (
    <div className="settings">
      <nav className="settings-nav">
        {SECTIONS.map((item) => (
          <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
            <item.icon size={15} /> {item.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {section === "ai" && <AiSettings />}
        {section === "speech" && <SpeechSettings />}
        {section === "github" && <GitHubSettings />}
        {section === "mcp" && <McpSettings />}
        {section === "about" && <About />}
      </div>
    </div>
  );
}

// ---- AI --------------------------------------------------------------------------
interface Profile {
  id: string;
  name: string;
  agent: "claude" | "codex";
  kind: "account" | "anthropic" | "openai";
  baseUrl?: string;
  models?: string[];
  defaultModel?: string;
  hasKey?: boolean;
  builtin?: boolean;
}
interface Preset {
  id: string;
  name: string;
  kind: "anthropic" | "openai";
  baseUrl: string;
  models: string[];
}

function AiSettings() {
  const [data, setData] = useState<{ profiles: Profile[]; presets: Preset[]; defaultProfile: string; autoCommit: boolean; permission: string } | null>(null);
  const [editing, setEditing] = useState<(Partial<Profile> & { apiKey?: string }) | null>(null);
  const [run] = useAction();
  const confirm = useConfirm();
  const load = () => api<typeof data>("/api/ai/profiles").then(setData);
  useEffect(() => {
    void load();
  }, []);
  if (!data) return null;
  const custom = data.profiles.filter((item) => !item.builtin);
  return (
    <>
      <h2>AI 账号</h2>
      <p className="muted">内置 AI 基于 Claude Code 和 Codex（通过 Agent Client Protocol 接入）。登录任意一个即可使用；本机已登录的 CLI 账号会自动识别。</p>
      <AccountCard agent="claude" title="Claude" description="使用 Claude 订阅（Pro / Max / Team）运行 Claude Code" />
      <AccountCard agent="codex" title="ChatGPT" description="使用 ChatGPT 订阅（Plus / Pro / Team）运行 Codex" />

      <h2>自定义 API</h2>
      <p className="muted">
        Anthropic 兼容接口由 Claude Code 驱动（如 DeepSeek、Kimi、GLM 提供的 Anthropic 兼容地址）；OpenAI 兼容接口由 Codex 驱动，需要支持 Responses API。
      </p>
      {custom.map((profile) => (
        <div className="setting-card" key={profile.id}>
          <KeyRound size={16} className="muted" />
          <div className="grow">
            <strong>{profile.name}</strong>
            <div className="muted small-text ellipsis">
              {profile.kind === "anthropic" ? "Anthropic 兼容 · Claude Code" : "OpenAI 兼容 · Codex"} · {profile.baseUrl || "官方地址"}{" "}
              {profile.models?.length ? "· " + profile.models.join("、") : ""}
            </div>
          </div>
          <button className="icon-btn" title="编辑" onClick={() => setEditing(profile)}>
            <Pencil size={14} />
          </button>
          <button
            className="icon-btn"
            title="删除"
            onClick={async () =>
              (await confirm(`删除「${profile.name}」？`, { danger: true, confirm: "删除" })) && run(() => del(`/api/ai/profiles/${profile.id}`).then(load))
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="row wrap">
        {data.presets.map((preset) => (
          <button
            key={preset.id}
            className="btn small"
            onClick={() => setEditing({ name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, models: preset.models })}
          >
            <Plus size={13} /> {preset.name}
          </button>
        ))}
      </div>

      <h2>偏好</h2>
      <label className="field">
        <span>新对话默认使用</span>
        <select
          className="select"
          value={data.defaultProfile}
          onChange={(event) => run(() => patch("/api/ai/settings", { defaultProfile: event.target.value }).then(load))}
        >
          {data.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>AI 默认权限（新对话生效，聊天中可随时切换）</span>
        <select
          className="select"
          value={data.permission}
          onChange={(event) => run(() => patch("/api/ai/settings", { permission: event.target.value }).then(load))}
        >
          <option value="ask">每次修改前询问</option>
          <option value="edits">自动修改作品文件，运行命令前询问（推荐）</option>
          <option value="auto">由 AI 判断，只在有风险时询问</option>
          <option value="full">完全信任，不再询问</option>
        </select>
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={data.autoCommit}
          onChange={(event) => run(() => patch("/api/ai/settings", { autoCommit: event.target.checked }).then(load))}
        />
        AI 每完成一轮修改自动保存版本（可在聊天中一键撤销）
      </label>
      {editing && <ProfileDialog value={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </>
  );
}

function AccountCard({ agent, title, description }: { agent: "claude" | "codex"; title: string; description: string }) {
  const toast = useToast();
  const [status, setStatus] = useState<{ loggedIn: boolean; detail?: string } | null>(null);
  const [login, setLogin] = useState<{ id: string; url: string; userCode?: string; needsCode: boolean } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api<{ loggedIn: boolean; detail?: string }>(`/api/ai/accounts/${agent}`).then(setStatus, () => setStatus({ loggedIn: false }));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useServerEvent((event) => {
    if (event.type !== "ai-login" || event.agent !== agent) return;
    setLogin(null);
    setBusy(false);
    const next = event.status as { loggedIn: boolean; detail?: string };
    setStatus(next);
    toast(next.loggedIn ? `${title} 已登录` : `登录未完成：${(event.output as string) || "请重试"}`, next.loggedIn ? "ok" : "error");
  });
  const start = async () => {
    setBusy(true);
    try {
      const flow = await api<{ id: string; url: string; userCode?: string; needsCode: boolean }>(`/api/ai/accounts/${agent}/login`, { method: "POST" });
      setLogin(flow);
      window.open(flow.url, "_blank", "noopener");
    } catch (error) {
      toast((error as Error).message, "error");
      setBusy(false);
    }
  };
  return (
    <div className="setting-card account">
      <div className={`account-logo ${agent}`}>{agent === "claude" ? "C" : "G"}</div>
      <div className="grow" style={{ minWidth: 0 }}>
        <strong>{title}</strong>
        <div className="muted small-text">{description}</div>
        {status?.loggedIn && (
          <div className="ok-text small-text">
            <CheckCircle2 size={12} /> 已登录{status.detail ? " · " + status.detail : ""}
          </div>
        )}
        {login && (
          <div className="login-steps">
            <p>
              1. 在打开的页面中登录并授权（没有自动打开？
              <a href={login.url} target="_blank" rel="noreferrer">
                点这里 <ExternalLink size={11} />
              </a>
              ）
            </p>
            {login.userCode && (
              <p>
                2. 输入设备码：<strong className="mono user-code">{login.userCode}</strong>
                <button className="icon-btn" title="复制" onClick={() => navigator.clipboard.writeText(login.userCode!)}>
                  <Copy size={12} />
                </button>
                <br />
                <span className="muted small-text">完成后这里会自动更新。若提示未启用设备码登录，请在 ChatGPT 安全设置中开启“Codex 设备码授权”。</span>
              </p>
            )}
            {login.needsCode && (
              <div className="row">
                <input className="input grow" placeholder="2. 粘贴授权完成后页面显示的代码" value={code} onChange={(event) => setCode(event.target.value)} />
                <button
                  className="btn primary"
                  disabled={!code.trim()}
                  onClick={() => api(`/api/ai/logins/${login.id}/code`, { body: { code } }).catch((error) => toast((error as Error).message, "error"))}
                >
                  完成
                </button>
              </div>
            )}
            <button
              className="link-btn"
              onClick={() => {
                void del(`/api/ai/logins/${login.id}`);
                setLogin(null);
                setBusy(false);
              }}
            >
              取消登录
            </button>
          </div>
        )}
      </div>
      {status === null ? (
        <Loader2 size={16} className="spin muted" />
      ) : status.loggedIn ? (
        <button className="btn small" onClick={() => api(`/api/ai/accounts/${agent}/logout`, { method: "POST" }).then(load)}>
          <LogOut size={13} /> 退出
        </button>
      ) : (
        !login && (
          <button className="btn small primary" disabled={busy} onClick={start}>
            {busy ? <span className="spinner" /> : <LogIn size={13} />} 登录
          </button>
        )
      )}
    </div>
  );
}

function ProfileDialog({ value, onClose, onSaved }: { value: Partial<Profile> & { apiKey?: string }; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ ...value, modelsText: (value.models ?? []).join("\n"), apiKey: "" });
  const [run, busy] = useAction();
  const save = () =>
    run(async () => {
      await api("/api/ai/profiles", {
        body: {
          ...form,
          models: form.modelsText
            .split(/[\n,，]/)
            .map((item) => item.trim())
            .filter(Boolean),
        },
      });
      onSaved();
      onClose();
    }, "已保存");
  return (
    <Dialog
      title={value.id ? "编辑 API" : "添加 API"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !form.name || (!value.id && !form.apiKey)} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <label className="field">
        <span>名称</span>
        <input className="input" value={form.name ?? ""} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </label>
      <label className="field">
        <span>接口类型</span>
        <select className="select" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "anthropic" })}>
          <option value="anthropic">Anthropic 兼容（Claude Code）</option>
          <option value="openai">OpenAI 兼容 Responses API（Codex）</option>
        </select>
      </label>
      <label className="field">
        <span>接口地址（留空使用官方地址）</span>
        <input
          className="input"
          placeholder={form.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
          value={form.baseUrl ?? ""}
          onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
        />
      </label>
      <label className="field">
        <span>API Key{value.id ? "（留空则不修改）" : ""}</span>
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={form.apiKey}
          onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
        />
      </label>
      <label className="field">
        <span>模型（每行一个，第一个为默认；留空使用 AI 自带的模型列表）</span>
        <textarea className="textarea mono" rows={3} value={form.modelsText} onChange={(event) => setForm({ ...form, modelsText: event.target.value })} />
      </label>
    </Dialog>
  );
}

// ---- speech -------------------------------------------------------------------
interface SpeechData {
  providers: { id: string; name: string; ready: boolean; detail?: string }[];
  defaultProvider: string;
  models: {
    id: string;
    name: string;
    description: string;
    languages: string[];
    size: number;
    installed: boolean;
    installing?: { progress: number | null; message: string } | null;
    license: string;
    homepage?: string;
  }[];
  openai: { baseUrl: string; model: string; voices: string[]; hasKey: boolean };
}

function SpeechSettings() {
  const [data, setData] = useState<SpeechData | null>(null);
  const [openai, setOpenai] = useState({ baseUrl: "", apiKey: "", model: "", voices: "" });
  const [run] = useAction();
  const confirm = useConfirm();
  const load = () =>
    api<SpeechData>("/api/speech/providers").then((value) => {
      setData(value);
      setOpenai((form) => ({ ...form, baseUrl: value.openai.baseUrl, model: value.openai.model, voices: value.openai.voices.join(", ") }));
    });
  useEffect(() => {
    void load();
  }, []);
  useServerEvent((event) => {
    if (event.type === "speech-models" || (event.type === "task" && (event.task as { kind: string }).kind === "speech-model")) void load();
  });
  if (!data) return null;
  return (
    <>
      <h2>语音引擎</h2>
      <p className="muted">配音与 AI 的 speech_synthesize 工具使用这里的引擎。本地模型完全离线运行，按需下载，不随程序内置。</p>
      {data.providers.map((provider) => (
        <div className="setting-card" key={provider.id}>
          <AudioLines size={16} className="muted" />
          <div className="grow">
            <strong>{provider.name}</strong>
            <div className="muted small-text">{provider.detail}</div>
          </div>
          {provider.ready ? <span className="badge ok">可用</span> : <span className="badge">未就绪</span>}
          <label className="row small-text">
            <input
              type="radio"
              name="default-provider"
              disabled={!provider.ready}
              checked={data.defaultProvider === provider.id}
              onChange={() => run(() => patch("/api/speech/settings", { defaultProvider: provider.id }).then(load))}
            />{" "}
            默认
          </label>
        </div>
      ))}
      <h2>本地模型</h2>
      {data.models.map((model) => (
        <div className="setting-card" key={model.id}>
          <div className="grow" style={{ minWidth: 0 }}>
            <strong>{model.name}</strong> <span className="faint small-text">{model.languages.join(" / ")}</span>
            <div className="muted small-text">{model.description}</div>
            <div className="faint small-text">
              约 {formatBytes(model.size)} · {model.license}
              {model.homepage && (
                <>
                  {" · "}
                  <a href={model.homepage} target="_blank" rel="noreferrer">
                    主页
                  </a>
                </>
              )}
            </div>
            {model.installing && (
              <div className="progress" style={{ marginTop: 6 }}>
                <div style={{ width: `${Math.round((model.installing.progress ?? 0) * 100)}%` }} />
              </div>
            )}
          </div>
          {model.installed ? (
            <button
              className="btn small"
              onClick={async () =>
                (await confirm(`删除模型 ${model.name}？`, { danger: true, confirm: "删除" })) && run(() => del(`/api/speech/models/${model.id}`).then(load))
              }
            >
              <Trash2 size={13} /> 删除
            </button>
          ) : model.installing ? (
            <span className="muted small-text">{model.installing.message}</span>
          ) : (
            <button className="btn small primary" onClick={() => run(() => api(`/api/speech/models/${model.id}/install`, { method: "POST" }).then(load))}>
              <Download size={13} /> 下载
            </button>
          )}
        </div>
      ))}
      <h2>OpenAI 兼容语音接口</h2>
      <p className="muted">OpenAI TTS，或任何提供 /v1/audio/speech 的服务（例如自行部署的 CosyVoice、Kokoro-FastAPI）。</p>
      <div className="field-grid">
        <label className="field">
          <span>接口地址</span>
          <input
            className="input"
            placeholder="https://api.openai.com/v1"
            value={openai.baseUrl}
            onChange={(event) => setOpenai({ ...openai, baseUrl: event.target.value })}
          />
        </label>
        <label className="field">
          <span>API Key{data.openai.hasKey ? "（已设置）" : ""}</span>
          <input className="input" type="password" value={openai.apiKey} onChange={(event) => setOpenai({ ...openai, apiKey: event.target.value })} />
        </label>
        <label className="field">
          <span>模型</span>
          <input
            className="input"
            placeholder="gpt-4o-mini-tts"
            value={openai.model}
            onChange={(event) => setOpenai({ ...openai, model: event.target.value })}
          />
        </label>
        <label className="field">
          <span>声音（逗号分隔）</span>
          <input
            className="input"
            placeholder="alloy, nova, shimmer"
            value={openai.voices}
            onChange={(event) => setOpenai({ ...openai, voices: event.target.value })}
          />
        </label>
      </div>
      <button
        className="btn"
        onClick={() =>
          run(
            () =>
              patch("/api/speech/settings", {
                openai: {
                  baseUrl: openai.baseUrl,
                  apiKey: openai.apiKey || undefined,
                  model: openai.model,
                  voices: openai.voices
                    .split(/[,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean),
                },
              }).then(load),
            "已保存",
          )
        }
      >
        保存
      </button>
    </>
  );
}

// ---- GitHub -----------------------------------------------------------------------
function GitHubSettings() {
  const [accounts, setAccounts] = useState<{ id: string; login: string; name: string; avatar: string }[]>([]);
  const [token, setToken] = useState("");
  const [run, busy] = useAction();
  const load = () => api<typeof accounts>("/api/github/accounts").then(setAccounts);
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <h2>GitHub 账号</h2>
      <p className="muted">
        用于同步作品库。在 GitHub 创建
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
          个人访问令牌 <ExternalLink size={11} />
        </a>
        ，授予仓库 Contents 读写权限（新建仓库还需要 Administration 权限），粘贴到下面。
      </p>
      {accounts.map((account) => (
        <div className="setting-card" key={account.id}>
          <img className="avatar-img" src={account.avatar} alt="" />
          <div className="grow">
            <strong>{account.login}</strong>
            <div className="muted small-text">{account.name}</div>
          </div>
          <button className="btn small" onClick={() => run(() => del(`/api/github/accounts/${account.id}`).then(load))}>
            移除
          </button>
        </div>
      ))}
      <div className="row">
        <input className="input grow" type="password" placeholder="github_pat_… 或 ghp_…" value={token} onChange={(event) => setToken(event.target.value)} />
        <button
          className="btn primary"
          disabled={!token || busy}
          onClick={() =>
            run(async () => {
              await api("/api/github/accounts", { body: { token } });
              setToken("");
              await load();
            }, "已添加")
          }
        >
          添加账号
        </button>
      </div>
    </>
  );
}

// ---- MCP ---------------------------------------------------------------------------
function McpSettings() {
  const toast = useToast();
  const [tokens, setTokens] = useState<{ id: string; name: string; readOnly: boolean; createdAt: string }[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [run] = useAction();
  const load = () => api<typeof tokens>("/api/mcp/tokens").then(setTokens);
  useEffect(() => {
    void load();
  }, []);
  const url = `${location.origin}/mcp`;
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("已复制", "ok"));
  const stdio = JSON.stringify({ mcpServers: { frame: { command: "node", args: ["<FRAME 目录>/bin/frame.mjs", "mcp"] } } }, null, 2);
  return (
    <>
      <h2>让外部 AI 使用 FRAME</h2>
      <p className="muted">内置 AI 已自动连接 FRAME 工具。Claude Desktop、Claude Code、Codex、Cursor 等外部工具也可以通过 MCP 制作作品。</p>
      <h3>HTTP（推荐）</h3>
      <div className="code-line">
        <code>{url}</code>
        <button className="icon-btn" onClick={() => copy(url)}>
          <Copy size={13} />
        </button>
      </div>
      <p className="muted small-text">请求头 Authorization: Bearer &lt;令牌&gt;。例如：</p>
      <pre className="code-block">{`claude mcp add --transport http frame ${url} --header "Authorization: Bearer <令牌>"`}</pre>
      <h3>stdio</h3>
      <pre className="code-block">{stdio}</pre>
      <h3>令牌</h3>
      {tokens.map((token) => (
        <div className="setting-card" key={token.id}>
          <KeyRound size={15} className="muted" />
          <div className="grow">
            <strong>{token.name}</strong> {token.readOnly && <span className="badge">只读</span>}
            <div className="faint small-text">{new Date(token.createdAt).toLocaleString()}</div>
          </div>
          <button className="btn small" onClick={() => run(() => del(`/api/mcp/tokens/${token.id}`).then(load))}>
            撤销
          </button>
        </div>
      ))}
      {created && (
        <div className="setting-card highlight">
          <div className="grow">
            <strong>新令牌（只显示这一次）</strong>
            <div className="mono small-text token-text">{created}</div>
          </div>
          <button className="btn small" onClick={() => copy(created)}>
            <Copy size={13} /> 复制
          </button>
        </div>
      )}
      <div className="row">
        <input className="input grow" placeholder="令牌名称，例如 Claude Desktop" value={name} onChange={(event) => setName(event.target.value)} />
        <button
          className="btn primary"
          onClick={() =>
            run(async () => {
              const token = await api<{ token: string }>("/api/mcp/tokens", { body: { name: name || "MCP" } });
              setCreated(token.token);
              setName("");
              await load();
            })
          }
        >
          创建令牌
        </button>
      </div>
    </>
  );
}

function About() {
  const [state, setState] = useState<{ version: string; home?: string } | null>(null);
  useEffect(() => {
    void api<{ version: string; home: string }>("/api/state").then(setState);
  }, []);
  return (
    <>
      <h2>FRAME Studio</h2>
      <p>版本 {state?.version}</p>
      <p className="muted">
        数据目录：<span className="mono">{state?.home}</span>
      </p>
      <p className="muted">作品是 Git 分支，素材库在 frame/materials 分支，导出文件在数据目录的 exports/ 中。</p>
    </>
  );
}

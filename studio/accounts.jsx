import { subscribe } from "./realtime";
import { WindowsCenterLink, LocalAiSettings } from "./desktop-settings";
import { useEffect, useState } from "react";
import {
  Plus,
  ExternalLink,
  RefreshCw,
  FolderGit2,
  Link,
  Settings2,
  Search,
  Cpu,
  SlidersHorizontal,
  Terminal,
  Shield,
  AudioLines,
  Activity,
  Monitor,
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
} from "./ui";
import {
  ProviderSettings,
  GeneralAiSettings,
  ToolSettings,
} from "./model-settings";
import "./ai-workbench.css";
import { SpeechSettings } from "./speech";
import { SystemStatus } from "./system-status";

export function LoginFlow({ kind, target, onClose, onSuccess, notify }) {
  const [flow, setFlow] = useState(null),
    [error, setError] = useState(""),
    [code, setCode] = useState("");
  const [run, busy] = useAction(notify);
  useEffect(() => {
    let done = false,
      timer;
    let stop;
    const watch = (id) => {
      stop = subscribe("auth_state", { id }, ({ result: row, error }) => {
        if (done) return;
        if (error) {
          setError(error);
          return;
        }
        setFlow(row);
        if (row.state === "succeeded") onSuccess?.();
      });
    };
    api("auth_begin", { kind, ...(target ? { target } : {}) })
      .then((row) => {
        if (!done) {
          setFlow(row);
          watch(row.id);
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      done = true;
      stop?.();
    };
  }, [kind, target]);
  return (
    <Modal
      title={`连接 ${kind === "github" ? "GitHub" : kind === "codex" ? "ChatGPT / Codex" : "Claude 官方账号"}`}
      onClose={onClose}
    >
      <ErrorNote error={error} />
      {!flow && !error && <Loading />}
      {flow?.state === "pending" && (
        <>
          <p>{flow.info.message || "正在向官方申请授权链接…"}</p>
          {flow.info.code && (
            <div className="device-code">
              <code>{flow.info.code}</code>
              <Button
                onClick={() =>
                  navigator.clipboard
                    .writeText(flow.info.code)
                    .then(() => notify("设备码已复制"))
                }
              >
                复制设备码
              </Button>
            </div>
          )}
          {flow.info.url && (
            <a
              className="button primary"
              href={flow.info.url}
              target="_blank"
              rel="noreferrer"
            >
              前往官方页面授权 <ExternalLink size={16} />
            </a>
          )}
          {flow.info.needsCode && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(() => api("auth_submit", { id: flow.id, code }));
              }}
            >
              <Field label="官方页面返回的验证码">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  required
                />
              </Field>
              <Button disabled={busy || !code.trim()}>完成授权</Button>
            </form>
          )}
          <p>
            凭据保存在服务器，关闭弹窗后授权等待会持续 15 分钟。Codex
            设备码登录需先在 ChatGPT 安全设置中启用。
          </p>
        </>
      )}
      {flow && flow.state !== "pending" && (
        <>
          <p role="status">
            {flow.state === "succeeded"
              ? "账号已连接，可以开始创作。"
              : flow.info.message || "授权已过期，请重新发起登录。"}
          </p>
          <Button onClick={onClose}>完成</Button>
        </>
      )}
    </Modal>
  );
}

export function GitHubAccounts({ notify }) {
  const accounts = useQuery("github_accounts"),
    [login, setLogin] = useState(null),
    [token, setToken] = useState(false),
    [run, busy] = useAction(notify);
  return (
    <>
      <div className="section-head">
        <div>
          <h2>GitHub 账号</h2>
          <p>为每个作品仓库选择账号；过期后可重新授权。</p>
        </div>
        <Button icon={Plus} onClick={() => setLogin({})}>
          登录 GitHub
        </Button>
      </div>
      <ErrorNote error={accounts.error} />
      {accounts.data?.map((a) => (
        <div className="settings-row" key={a.id}>
          <div className="row">
            <FolderGit2 size={24} />
            <strong>{a.login}</strong>
            <span className={"badge " + a.state}>
              {a.state === "ready" ? "已连接" : "需要重新登录"}
            </span>
          </div>
          <Button icon={RefreshCw} onClick={() => setLogin({ target: a.id })}>
            重新登录
          </Button>
        </div>
      ))}
      {!accounts.data?.length && (
        <Empty>连接账号后即可创建或选择 GitHub 作品仓库。</Empty>
      )}
      <Button onClick={() => setToken(true)}>使用访问令牌连接</Button>
      {token && (
        <Modal title="使用 GitHub 访问令牌" onClose={() => setToken(false)}>
          <Form
            busy={busy}
            onSubmit={(a) =>
              run(async () => {
                await api("github_token", a);
                accounts.refresh();
                setToken(false);
                notify("GitHub 已连接");
              })
            }
          >
            <Field label="访问令牌">
              <input name="token" type="password" required autoComplete="off" />
            </Field>
          </Form>
        </Modal>
      )}
      {login && (
        <LoginFlow
          kind="github"
          target={login.target}
          notify={notify}
          onSuccess={accounts.refresh}
          onClose={() => {
            setLogin(null);
            accounts.refresh();
          }}
        />
      )}
    </>
  );
}

export function ModelConnections(props) {
  return <ProviderSettings {...props} LoginDialog={LoginFlow} />;
}

function AccessTokens({ notify }) {
  const tokens = useQuery("tokens_list"),
    grants = useQuery("oauth_grants"),
    [newToken, setNewToken] = useState(""),
    [run, busy] = useAction(notify);
  return (
    <>
      <h2>MCP 与 CLI</h2>
      <p>
        远程 MCP 地址：<code>{location.origin}/mcp</code>。ChatGPT
        添加此地址并选择 OAuth， 在 FRAME 登录后授权即可，客户端 ID
        与密钥留空。其他 CLI 客户端也可以使用下方的 Bearer 令牌。
      </p>
      <h3>OAuth 连接</h3>
      <ErrorNote error={grants.error} />
      {grants.data?.map((g) => (
        <div className="settings-row" key={g.id}>
          <span>
            {g.name} ·{" "}
            {g.revoked
              ? "已撤销"
              : new Date(g.refresh_expires) < new Date()
                ? "已过期"
                : "已授权"}
          </span>
          <Button
            disabled={busy || g.revoked}
            onClick={() =>
              run(async () => {
                await api("oauth_revoke", { id: g.id });
                grants.refresh();
                notify("OAuth 连接已撤销");
              })
            }
          >
            撤销授权
          </Button>
        </div>
      ))}
      <Form
        busy={busy}
        submit="创建令牌"
        onSubmit={(a) =>
          run(async () => {
            const token = await api("tokens_create", a);
            setNewToken(token.token);
            tokens.refresh();
          })
        }
      >
        <Field label="令牌名称">
          <input name="name" required placeholder="例如：桌面 AI" />
        </Field>
      </Form>
      {newToken && (
        <div className="secret-once">
          <p>请立即保存，仅本次显示。</p>
          <code>{newToken}</code>
          <Button
            onClick={() =>
              navigator.clipboard
                .writeText(newToken)
                .then(() => notify("令牌已复制"))
            }
          >
            复制
          </Button>
        </div>
      )}
      {tokens.data?.map((t) => (
        <div className="settings-row" key={t.id}>
          <strong>{t.name}</strong>
          <Button
            onClick={() =>
              run(async () => {
                await api("tokens_revoke", { id: t.id });
                tokens.refresh();
              })
            }
          >
            撤销
          </Button>
        </div>
      ))}
      <div className="panel">
        <h3>工作台登录密码</h3>
        <p>仅由服务器环境变量 FRAME_ADMIN_PASSWORD 配置。网页不能修改密码。</p>
      </div>
    </>
  );
}
const settingsSections = [
  { id: "desktop", label: "Windows 控制中心", detail: "打开本机运行管理窗口", icon: Monitor },
  {
    id: "ai",
    label: "AI 模型",
    detail: "提供商、模型目录与连接测试",
    icon: Cpu,
  },
  {
    id: "general",
    label: "创作偏好",
    detail: "默认模型、快捷键与字体",
    icon: SlidersHorizontal,
  },
  {
    id: "github",
    label: "GitHub",
    detail: "内容仓库与账号授权",
    icon: FolderGit2,
  },
  {
    id: "speech",
    label: "语音引擎",
    detail: "配音服务与声音模型",
    icon: AudioLines,
  },
  {
    id: "tools",
    label: "创作工具",
    detail: "Codex 与 Claude Code 版本",
    icon: Terminal,
  },
  {
    id: "access",
    label: "访问设置",
    detail: "MCP、CLI 与授权令牌",
    icon: Shield,
  },
  {
    id: "system",
    label: "运行状态",
    detail: "任务、容量与服务健康",
    icon: Activity,
  },
];
const currentSettingsTab = () => {
  const tab = location.hash.split("/")[2];
  return settingsSections.some((section) => section.id === tab) ? tab : "ai";
};
export function Settings({ notify, localMode = false }) {
  const [tab, setTab] = useState(currentSettingsTab),
    [search, setSearch] = useState("");
  useEffect(() => {
    const update = () => setTab(currentSettingsTab());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const sections = settingsSections.filter(section => localMode ? !["tools", "access", "system"].includes(section.id) : section.id !== "desktop");
  const activeTab = sections.some(section => section.id === tab) ? tab : "ai";
  const matches = sections.filter((section) =>
    `${section.label} ${section.detail}`
      .toLowerCase()
      .includes(search.toLowerCase().trim()),
  );
  const open = (id) => {
    setTab(id);
    location.hash = "/settings/" + id;
    setSearch("");
  };
  return (
    <div className="settings-page">
      <header className="settings-page-heading">
        <div>
          <h1>设置</h1>
          <p>你的创作环境，由你掌控。</p>
        </div>
        <label className="settings-search">
          <Search size={16} />
          <input
            aria-label="搜索设置"
            placeholder="搜索设置…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-current={activeTab === id ? "page" : undefined}
              className={activeTab === id ? "selected" : ""}
              onClick={() => open(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <main className="settings-content">
          {search.trim() ? (
            <section className="settings-search-results">
              <h2>设置搜索</h2>
              {matches.map(({ id, label, detail, icon: Icon }) => (
                <button type="button" key={id} onClick={() => open(id)}>
                  <Icon size={18} />
                  <span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </span>
                  <span>→</span>
                </button>
              ))}
              {!matches.length && (
                <Empty>没有匹配的设置，请尝试“模型”“快捷键”或“语音”。</Empty>
              )}
            </section>
          ) : activeTab === "desktop" ? (
            <WindowsCenterLink />
          ) : activeTab === "ai" ? (
            localMode ? <LocalAiSettings notify={notify} /> : <ModelConnections notify={notify} />
          ) : activeTab === "general" ? (
            <GeneralAiSettings />
          ) : activeTab === "github" ? (
            <GitHubAccounts notify={notify} />
          ) : activeTab === "speech" ? (
            <SpeechSettings notify={notify} />
          ) : activeTab === "tools" ? (
            <ToolSettings notify={notify} />
          ) : activeTab === "system" ? (
            <SystemStatus />
          ) : (
            <AccessTokens notify={notify} />
          )}
        </main>
      </div>
    </div>
  );
}

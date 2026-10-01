import { subscribe } from "./realtime";
import { WindowsCenterLink, LocalAiSettings } from "./desktop-settings";
import { useEffect, useState } from "react";
import {
  Plus,
  Check,
  Copy,
  CheckCircle2,
  LoaderCircle,
  ExternalLink,
  RefreshCw,
  FolderGit2,
  Link,
  Settings2,
  Search,
  Cpu,
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
import { ProviderSettings, ToolSettings } from "./model-settings";
import "./ai-workbench.css";
import { SpeechSettings } from "./speech";
import { SystemStatus } from "./system-status";
import { AccessSettings } from "./access-settings";

export function LoginFlow({ kind, target, onClose, onSuccess, notify }) {
  const [flow, setFlow] = useState(null),
    [error, setError] = useState(""),
    [code, setCode] = useState(""),
    [opened, setOpened] = useState(false),
    [attempt, setAttempt] = useState(0),
    [copied, setCopied] = useState(false);
  const [run, busy] = useAction(notify);
  useEffect(() => {
    let done = false,
      stop,
      successDelivered = false;
    setFlow(null);
    setError("");
    setCode("");
    setOpened(false);
    setCopied(false);
    api("auth_begin", { kind, ...(target ? { target } : {}) })
      .then((row) => {
        if (done) return;
        setFlow(row);
        stop = subscribe(
          "auth_state",
          { id: row.id },
          ({ result: next, error: failure }) => {
            if (done) return;
            if (failure) {
              setError(failure);
              return;
            }
            setFlow(next);
            if (next.state === "succeeded" && !successDelivered) {
              successDelivered = true;
              onSuccess?.();
            }
          },
        );
      })
      .catch((err) => {
        if (!done) setError(err.message);
      });
    return () => {
      done = true;
      stop?.();
    };
  }, [kind, target, attempt]);
  const codex = kind === "codex",
    succeeded = flow?.state === "succeeded";
  const pending = flow?.state === "pending";
  const syncing = pending && flow.info.stage === "models";
  const catalogFailed = succeeded && flow.info.catalogSynced === false;
  const step = succeeded
    ? catalogFailed
      ? 2
      : 3
    : syncing
      ? 2
      : opened
        ? 1
        : 0;
  const retry = () => setAttempt((old) => old + 1);
  return (
    <Modal
      title={`连接 ${kind === "github" ? "GitHub" : codex ? "ChatGPT / Codex" : "Claude 官方账号"}`}
      onClose={onClose}
    >
      {codex && (
        <ol className="account-login-steps" aria-label="账号连接进度">
          {["打开授权页", "确认账号", "同步模型"].map((label, index) => (
            <li
              key={label}
              className={
                index < step
                  ? "complete"
                  : index === 2 && catalogFailed
                    ? "attention"
                    : index === step
                      ? "current"
                      : ""
              }
              aria-current={index === step ? "step" : undefined}
            >
              <span>{index < step ? <Check size={12} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}
      <ErrorNote error={error} />
      {!flow && !error && <Loading />}
      {pending && (
        <>
          <div className="account-login-message" role="status">
            {syncing && <LoaderCircle size={18} className="catalog-spin" />}
            <p>{flow.info.message || "正在准备官方授权链接…"}</p>
          </div>
          {flow.info.code && (
            <div className="account-device-code">
              <small>设备验证码</small>
              <div>
                <code>{flow.info.code}</code>
                <Button
                  icon={copied ? Check : Copy}
                  aria-label="复制设备码"
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(flow.info.code);
                      setCopied(true);
                      notify("设备码已复制");
                    })
                  }
                >
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>
            </div>
          )}
          {flow.info.url && (
            <a
              className="button primary account-authorize"
              href={flow.info.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpened(true)}
            >
              前往官方页面授权 <ExternalLink size={16} />
            </a>
          )}
          {flow.info.needsCode && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(() => api("auth_submit", { id: flow.id, code }));
              }}
            >
              <Field label="官方页面返回的验证码">
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="off"
                  required
                />
              </Field>
              <Button className="primary" disabled={busy || !code.trim()}>
                完成授权
              </Button>
            </form>
          )}
          <p className="settings-help account-login-hint">
            {syncing
              ? "登录已经完成，正在准备模型目录。此时关闭窗口也会继续同步。"
              : "授权完成后会自动更新，无需重复点击或刷新。关闭窗口后仍会继续等待授权。"}
          </p>
          {codex && !syncing && (
            <details className="account-login-help">
              <summary>设备码登录提示</summary>
              <p>
                若官方页面提示未启用设备码登录，请先在 ChatGPT
                安全设置中启用，再继续授权。授权等待最长 15 分钟。
              </p>
            </details>
          )}
        </>
      )}
      {succeeded && (
        <>
          <div className="account-login-result" role="status">
            <CheckCircle2 size={30} />
            <h3>{catalogFailed ? "登录成功，模型待同步" : "账号已连接"}</h3>
            <p>{flow.info.message || "可以开始创作。"}</p>
          </div>
          <Button className="primary account-authorize" onClick={onClose}>
            {codex ? "查看模型" : "完成"}
          </Button>
        </>
      )}
      {((error && !pending) || (flow && !pending && !succeeded)) && (
        <div className="account-login-failure">
          {!error && (
            <p role="alert">
              {flow.info.message || "授权已过期，请重新获取。"}
            </p>
          )}
          <div className="row">
            <Button className="primary" icon={RefreshCw} onClick={retry}>
              重新获取授权
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </div>
        </div>
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

const settingsSections = [
  {
    id: "desktop",
    label: "Windows 控制中心",
    detail: "打开本机运行管理窗口",
    icon: Monitor,
  },
  {
    id: "ai",
    label: "AI 模型",
    detail: "提供商、模型目录与连接测试",
    icon: Cpu,
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
  const sections = settingsSections.filter((section) =>
    localMode
      ? !["tools", "access", "system"].includes(section.id)
      : section.id !== "desktop",
  );
  const activeTab = sections.some((section) => section.id === tab) ? tab : "ai";
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
                <Empty>没有匹配的设置，请尝试“模型”“GitHub”或“语音”。</Empty>
              )}
            </section>
          ) : activeTab === "desktop" ? (
            <WindowsCenterLink />
          ) : activeTab === "ai" ? (
            localMode ? (
              <LocalAiSettings notify={notify} />
            ) : (
              <ModelConnections notify={notify} />
            )
          ) : activeTab === "github" ? (
            <GitHubAccounts notify={notify} />
          ) : activeTab === "speech" ? (
            <SpeechSettings notify={notify} />
          ) : activeTab === "tools" ? (
            <ToolSettings notify={notify} />
          ) : activeTab === "system" ? (
            <SystemStatus />
          ) : (
            <AccessSettings notify={notify} />
          )}
        </main>
      </div>
    </div>
  );
}

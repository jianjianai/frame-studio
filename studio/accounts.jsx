import { useEffect, useState } from "react";
import {
  Plus,
  ExternalLink,
  RefreshCw,
  FolderGit2,
  Link,
  Settings2,
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
import { SpeechSettings } from "./speech";

export function LoginFlow({ kind, target, onClose, onSuccess, notify }) {
  const [flow, setFlow] = useState(null),
    [error, setError] = useState(""),
    [code, setCode] = useState("");
  const [run, busy] = useAction(notify);
  useEffect(() => {
    let done = false,
      timer;
    const poll = async (id) => {
      try {
        const row = await api("auth_state", { id });
        if (done) return;
        setFlow(row);
        if (row.state === "pending") timer = setTimeout(() => poll(id), 1500);
        else if (row.state === "succeeded") onSuccess?.();
      } catch (e) {
        if (!done) setError(e.message);
      }
    };
    api("auth_begin", { kind, ...(target ? { target } : {}) })
      .then((row) => {
        if (!done) {
          setFlow(row);
          void poll(row.id);
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      done = true;
      clearTimeout(timer);
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

export function ModelConnections({ notify }) {
  const connections = useQuery("connections_list"),
    tools = useQuery("tools_info", {}, 15000),
    [edit, setEdit] = useState(null),
    [login, setLogin] = useState(null),
    [upgrade, setUpgrade] = useState(null),
    [run, busy] = useAction(notify);
  return (
    <>
      <div className="section-head">
        <div>
          <h2>AI 创作工具与模型</h2>
          <p>一个工具可连接多个模型提供商。每次对话保留自己的连接和上下文。</p>
        </div>
        <Button
          icon={Plus}
          onClick={() => setEdit({ tool: "codex", mode: "api" })}
        >
          添加连接
        </Button>
      </div>
      <ErrorNote error={connections.error} />
      <div className="connection-grid">
        {connections.data?.map((c) => (
          <article className="panel" key={c.id}>
            <div className="section-head">
              <h3>{c.name}</h3>
              <span className={"badge " + c.state}>
                {c.configured ? "已配置" : "待连接"}
              </span>
            </div>
            <p>
              {c.tool === "codex" ? "Codex" : "Claude Code"} ·{" "}
              {c.mode === "official" ? "官方账号" : c.baseUrl || "官方 API"}
            </p>
            <p>{c.model || "使用工具默认模型"}</p>
            <div className="row">
              <Button icon={Settings2} onClick={() => setEdit(c)}>
                配置
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await api("connections_test", { id: c.id });
                    notify(
                      result.message +
                        `（${(result.elapsedMs / 1000).toFixed(1)} 秒）`,
                    );
                    connections.refresh();
                  })
                }
              >
                {c.mode === "official" ? "检查登录" : "测试模型"}
              </Button>
              {c.mode === "official" && (
                <Button icon={Link} onClick={() => setLogin(c)}>
                  {c.configured ? "重新登录" : "登录官方账号"}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      {connections.data?.length === 0 && (
        <Empty>添加模型连接，让 AI 开始制作视频。</Empty>
      )}
      <div className="section-head">
        <h2>工具版本</h2>
      </div>
      {tools.data?.map((t) => (
        <div className="settings-row" key={t.tool}>
          <div>
            <strong>{t.tool === "codex" ? "Codex" : "Claude Code"}</strong>
            <p>{t.version}</p>
            {t.updates[0] && (
              <p>
                最近更新：{t.updates[0].state}
                {t.updates[0].error ? " · " + t.updates[0].error : ""}
              </p>
            )}
          </div>
          <Button onClick={() => setUpgrade(t.tool)}>更新版本</Button>
        </div>
      ))}
      {edit && (
        <ConnectionForm
          initial={edit}
          notify={notify}
          onClose={() => setEdit(null)}
          onSave={() => {
            connections.refresh();
            setEdit(null);
          }}
        />
      )}
      {login && (
        <LoginFlow
          kind={login.tool}
          target={login.id}
          notify={notify}
          onSuccess={connections.refresh}
          onClose={() => {
            connections.refresh();
            setLogin(null);
          }}
        />
      )}
      {upgrade && (
        <Modal title={`更新 ${upgrade}`} onClose={() => setUpgrade(null)}>
          <p>工具独立安装，更新失败保留原版本；后续新任务使用新版本。</p>
          <Form
            busy={busy}
            submit="安装版本"
            onSubmit={(a) =>
              run(async () => {
                await api("tools_update", {
                  provider: upgrade,
                  version: a.version,
                });
                tools.refresh();
                setUpgrade(null);
                notify("工具更新已在后台开始");
              })
            }
          >
            <Field label="版本号">
              <input
                name="version"
                placeholder="例如 0.158.0"
                pattern="[0-9]+\.[0-9]+\.[0-9]+.*"
                required
              />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}
function ConnectionForm({ initial, onClose, onSave, notify }) {
  const [mode, setMode] = useState(initial.mode),
    [tool, setTool] = useState(initial.tool),
    [run, busy] = useAction(notify);
  return (
    <Modal
      title={initial.id ? "编辑模型连接" : "添加模型连接"}
      onClose={onClose}
    >
      <Form
        busy={busy}
        onSubmit={(a) =>
          run(async () => {
            await api("connections_save", {
              ...a,
              tool,
              mode,
              ...(initial.id ? { id: initial.id } : {}),
            });
            onSave();
            notify("模型连接已保存");
          })
        }
      >
        <Field label="连接名称">
          <input
            name="name"
            defaultValue={initial.name}
            placeholder="例如：主力创作模型"
            required
            maxLength="100"
          />
        </Field>
        <Field label="创作工具">
          <select
            value={tool}
            disabled={!!initial.id}
            onChange={(e) => setTool(e.target.value)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </Field>
        <Field label="连接方式">
          <select
            value={mode}
            disabled={!!initial.id}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="api">API · 官方或兼容提供商</option>
            <option value="official">登录官方账号</option>
          </select>
        </Field>
        {mode === "api" && (
          <>
            <Field label="API 地址（留空使用官方）">
              <input
                name="baseUrl"
                type="url"
                defaultValue={initial.baseUrl}
                placeholder={
                  tool === "codex"
                    ? "https://api.openai.com/v1"
                    : "https://api.anthropic.com"
                }
              />
            </Field>
            <Field label="API 密钥">
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={initial.configured ? "留空保留已保存密钥" : ""}
                required={!initial.configured}
              />
            </Field>
          </>
        )}
        <Field label="模型（留空使用工具默认）">
          <input name="model" defaultValue={initial.model} />
        </Field>
      </Form>
    </Modal>
  );
}

function AccessTokens({ notify }) {
  const tokens = useQuery("tokens_list"),
    [newToken, setNewToken] = useState(""),
    [run, busy] = useAction(notify);
  return (
    <>
      <h2>MCP 与 CLI</h2>
      <p>
        远程 MCP 地址：<code>{location.origin}/mcp</code>。创建令牌后填入 AI
        客户端的 Bearer 认证。
      </p>
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
export function Settings({ notify }) {
  const [tab, setTab] = useState("ai"),
    [run] = useAction(notify);
  return (
    <>
      <div className="page-heading">
        <h1>设置</h1>
        <p>连接创作能力与内容仓库</p>
      </div>
      <div className="tabs">
        {[
          ["ai", "AI 模型"],
          ["github", "GitHub"],
          ["speech", "语音引擎"],
          ["access", "访问设置"],
        ].map(([id, label]) => (
          <Button
            key={id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="settings-body">
        {tab === "ai" ? (
          <ModelConnections notify={notify} />
        ) : tab === "github" ? (
          <GitHubAccounts notify={notify} />
        ) : tab === "speech" ? (
          <SpeechSettings notify={notify} />
        ) : (
          <AccessTokens notify={notify} />
        )}
      </div>
    </>
  );
}

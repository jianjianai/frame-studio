import { useState } from "react";
import {
  Copy,
  KeyRound,
  Link2,
  LockKeyhole,
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Unplug,
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
} from "./ui";
import "./access-settings.css";

const formatDate = (value) => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
};

function AccessSection({
  id,
  icon: Icon,
  title,
  detail,
  count,
  action,
  children,
}) {
  return (
    <section className="access-section" aria-labelledby={id}>
      <header className="access-section-heading">
        <span className="access-section-icon">
          <Icon size={19} />
        </span>
        <div>
          <h3 id={id}>
            {title}{" "}
            {count !== undefined && (
              <span className="access-count">{count}</span>
            )}
          </h3>
          <p>{detail}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function QueryNotice({ query }) {
  return (
    <>
      <ErrorNote error={query.error} />
      {query.error && (
        <Button type="button" icon={RefreshCw} onClick={query.refresh}>
          重新加载
        </Button>
      )}
      {query.loading && !query.data && !query.error && <Loading />}
    </>
  );
}

export function AccessSettings({ notify }) {
  const tokens = useQuery("tokens_list"),
    grants = useQuery("oauth_grants"),
    [creating, setCreating] = useState(false),
    [newToken, setNewToken] = useState(""),
    [revoking, setRevoking] = useState(""),
    [removed, setRemoved] = useState({ oauth: [], tokens: [] }),
    [run, busy] = useAction(notify);
  const endpoint = location.origin + "/mcp";
  const connections = (grants.data || []).filter(
    (grant) => !grant.revoked && !removed.oauth.includes(grant.id),
  );
  const activeTokens = (tokens.data || []).filter(
    (token) => !removed.tokens.includes(token.id),
  );
  const copy = async (value, message) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(message);
    } catch {
      notify("复制失败，请选中文本手动复制。", "error");
    }
  };
  const revoke = (kind, id) =>
    run(async () => {
      setRevoking(kind + ":" + id);
      try {
        await api(kind === "oauth" ? "oauth_revoke" : "tokens_revoke", { id });
        setRemoved((previous) => ({
          ...previous,
          [kind]: [...previous[kind], id],
        }));
        (kind === "oauth" ? grants : tokens).refresh();
        notify(kind === "oauth" ? "OAuth 连接已撤销" : "访问令牌已撤销");
      } finally {
        setRevoking("");
      }
    });
  const closeCreate = () => {
    setCreating(false);
    setNewToken("");
  };
  return (
    <div className="access-settings">
      <div className="settings-section-heading">
        <div>
          <h2>访问设置</h2>
          <p>连接外部 AI 工具，管理已授予的工作台访问权限。</p>
        </div>
      </div>

      <AccessSection
        id="access-connect"
        icon={Link2}
        title="连接 MCP 与 CLI"
        detail="一个地址，连接你的创作工具。"
      >
        <div className="access-endpoint">
          <div>
            <span>远程 MCP 地址</span>
            <code>{endpoint}</code>
          </div>
          <Button
            type="button"
            icon={Copy}
            onClick={() => copy(endpoint, "MCP 地址已复制")}
          >
            复制地址
          </Button>
        </div>
        <div className="access-methods">
          <div>
            <h4>
              <MessageSquare size={16} /> ChatGPT / OAuth 客户端
            </h4>
            <p>
              添加 MCP 地址，选择 OAuth，在 FRAME 登录并授权。客户端 ID
              与密钥留空。
            </p>
          </div>
          <div>
            <h4>
              <Terminal size={16} /> CLI / Bearer 客户端
            </h4>
            <p>
              创建访问令牌，并在客户端的 Bearer
              认证中填写。每个工具使用独立令牌，便于管理。
            </p>
          </div>
        </div>
        <p className="access-scope">
          授权的客户端可以读取和修改当前工作台的作品与素材，并启动创作和导出。
        </p>
      </AccessSection>

      <div className="access-credentials">
        <AccessSection
          id="access-oauth"
          icon={ShieldCheck}
          title="OAuth 连接"
          detail="查看已授权客户端，撤销后立即失去访问权限。"
          count={grants.data ? connections.length : undefined}
        >
          <QueryNotice query={grants} />
          {connections.length > 0 && (
            <ul className="access-list" aria-label="OAuth 连接列表">
              {connections.map((grant) => {
                const expired =
                  new Date(grant.refresh_expires).getTime() <= Date.now();
                return (
                  <li className="access-entry" key={grant.id}>
                    <div className="access-entry-info">
                      <div className="access-entry-title">
                        <strong>{grant.name}</strong>
                        <span
                          className={"badge " + (expired ? "expired" : "ready")}
                        >
                          {expired ? "已过期" : "已授权"}
                        </span>
                      </div>
                      <small>授权于 {formatDate(grant.created)}</small>
                      <small>
                        {expired ? "过期于" : "有效至"}{" "}
                        {formatDate(grant.refresh_expires)}
                      </small>
                    </div>
                    <Button
                      type="button"
                      icon={Unplug}
                      className="danger-text"
                      disabled={busy}
                      aria-label={"撤销授权 " + grant.name}
                      onClick={() => revoke("oauth", grant.id)}
                    >
                      {revoking === "oauth:" + grant.id
                        ? "撤销中…"
                        : "撤销授权"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {!grants.loading && !grants.error && !connections.length && (
            <div className="access-empty">
              <ShieldCheck size={26} />
              <strong>暂无 OAuth 连接</strong>
              <p>
                在 ChatGPT 或其他 OAuth 客户端添加上方 MCP
                地址，完成授权后会显示在这里。
              </p>
            </div>
          )}
        </AccessSection>

        <AccessSection
          id="access-tokens"
          icon={KeyRound}
          title="访问令牌"
          detail="用于支持 Bearer 认证的 MCP 与 CLI 客户端。"
          count={tokens.data ? activeTokens.length : undefined}
          action={
            <Button
              type="button"
              icon={Plus}
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              创建令牌
            </Button>
          }
        >
          <QueryNotice query={tokens} />
          {activeTokens.length > 0 && (
            <ul className="access-list" aria-label="访问令牌列表">
              {activeTokens.map((token) => (
                <li className="access-entry" key={token.id}>
                  <div className="access-entry-info">
                    <div className="access-entry-title">
                      <strong>{token.name}</strong>
                    </div>
                    <small>创建于 {formatDate(token.created)}</small>
                  </div>
                  <Button
                    type="button"
                    icon={Unplug}
                    className="danger-text"
                    disabled={busy}
                    aria-label={"撤销令牌 " + token.name}
                    onClick={() => revoke("tokens", token.id)}
                  >
                    {revoking === "tokens:" + token.id ? "撤销中…" : "撤销"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {!tokens.loading && !tokens.error && !activeTokens.length && (
            <div className="access-empty">
              <KeyRound size={26} />
              <strong>暂无访问令牌</strong>
              <p>
                为桌面 AI 或命令行工具创建一个令牌。令牌内容仅在创建时显示一次。
              </p>
            </div>
          )}
        </AccessSection>
      </div>

      <AccessSection
        id="access-password"
        icon={LockKeyhole}
        title="工作台登录密码"
        detail="由服务器管理员管理。如需修改，请在服务器端更新登录密码。"
      />

      {creating && (
        <Modal
          title={newToken ? "访问令牌已创建" : "创建访问令牌"}
          onClose={closeCreate}
        >
          {newToken ? (
            <div className="access-token-result">
              <p>请立即复制并妥善保存，关闭后无法再次查看。</p>
              <div className="secret-once">
                <code>{newToken}</code>
              </div>
              <div className="row">
                <Button
                  type="button"
                  className="primary"
                  icon={Copy}
                  onClick={() => copy(newToken, "令牌已复制")}
                >
                  复制令牌
                </Button>
                <Button type="button" onClick={closeCreate}>
                  完成
                </Button>
              </div>
            </div>
          ) : (
            <Form
              busy={busy}
              submit="创建令牌"
              onSubmit={(values) =>
                run(async () => {
                  const name = values.name.trim();
                  if (!name) throw new Error("请输入令牌名称。");
                  const result = await api("tokens_create", { name });
                  setNewToken(result.token);
                  tokens.refresh();
                  notify("访问令牌已创建，请复制保存");
                })
              }
            >
              <p>名称用于识别使用这个令牌的工具。</p>
              <Field label="令牌名称">
                <input
                  name="name"
                  required
                  maxLength={100}
                  autoFocus
                  autoComplete="off"
                  placeholder="例如：桌面 Codex"
                />
              </Field>
            </Form>
          )}
        </Modal>
      )}
    </div>
  );
}

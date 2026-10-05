import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Dialog, useToast } from "../lib/ui";

interface Account {
  id: string;
  login: string;
  name: string;
}
interface GitHubRepo {
  fullName: string;
  url: string;
  private: boolean;
  description: string;
}

/** Add a content repository: clone one from GitHub, create a new one, or publish the local one. */
export function RepoDialog({
  onClose,
  onDone,
  mode: initialMode = "clone",
}: {
  onClose: () => void;
  onDone: () => void;
  mode?: "clone" | "create" | "publish";
}) {
  const toast = useToast();
  const [mode, setMode] = useState(initialMode);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [account, setAccount] = useState("");
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("frame-works");
  const [isPrivate, setPrivate] = useState(true);
  const [remoteRepos, setRemoteRepos] = useState<GitHubRepo[]>([]);
  const [busy, setBusy] = useState(false);
  const loadAccounts = () =>
    api<Account[]>("/api/github/accounts").then((list) => {
      setAccounts(list);
      setAccount((current) => current || list[0]?.id || "");
    });
  useEffect(() => {
    void loadAccounts();
  }, []);
  useEffect(() => {
    if (account && mode === "clone") void api<GitHubRepo[]>(`/api/github/accounts/${account}/repos`).then(setRemoteRepos, () => setRemoteRepos([]));
  }, [account, mode]);
  const addAccount = async () => {
    setBusy(true);
    try {
      const created = await api<Account>("/api/github/accounts", { body: { token } });
      setToken("");
      await loadAccounts();
      setAccount(created.id);
      toast(`已添加 GitHub 账号 ${created.login}`, "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "clone") await api("/api/repos", { body: { url, account } });
      else if (mode === "create") await api("/api/repos", { body: { create: true, account, name, private: isPrivate } });
      else await api("/api/repos/local/publish", { body: { account, name, private: isPrivate } });
      toast("作品库已就绪", "ok");
      onDone();
      onClose();
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="GitHub 作品库"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || (mode === "clone" ? !url : !account || !name)} onClick={submit}>
            {busy && <span className="spinner" />}
            {mode === "clone" ? "添加" : mode === "create" ? "创建" : "发布"}
          </button>
        </>
      }
    >
      <div className="mode-switch">
        <button className={mode === "clone" ? "active" : ""} onClick={() => setMode("clone")}>
          添加已有仓库
        </button>
        <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>
          新建仓库
        </button>
        <button className={mode === "publish" ? "active" : ""} onClick={() => setMode("publish")}>
          发布本地作品库
        </button>
      </div>
      <label className="field">
        <span>GitHub 账号</span>
        {accounts.length ? (
          <select className="select" value={account} onChange={(event) => setAccount(event.target.value)}>
            {accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.login}
              </option>
            ))}
            <option value="">（不使用账号，公开仓库）</option>
          </select>
        ) : (
          <div className="row">
            <input
              className="input grow"
              type="password"
              placeholder="GitHub 个人访问令牌（需要 repo / Contents 读写权限）"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button className="btn" disabled={!token || busy} onClick={addAccount}>
              添加
            </button>
          </div>
        )}
      </label>
      {mode === "clone" ? (
        <>
          <label className="field">
            <span>仓库地址</span>
            <input className="input" placeholder="https://github.com/用户名/仓库.git" value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          {remoteRepos.length > 0 && (
            <div className="repo-pick">
              {remoteRepos.map((item) => (
                <button key={item.fullName} className={url === item.url ? "active" : ""} onClick={() => setUrl(item.url)}>
                  <span className="ellipsis">{item.fullName}</span>
                  {item.private && <span className="badge">私有</span>}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <label className="field">
            <span>仓库名称</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="row">
            <input type="checkbox" checked={isPrivate} onChange={(event) => setPrivate(event.target.checked)} /> 私有仓库
          </label>
          {mode === "publish" && <p className="muted">本地作品库的全部作品会推送到新仓库，之后可以在多台电脑上同步。</p>}
        </>
      )}
    </Dialog>
  );
}

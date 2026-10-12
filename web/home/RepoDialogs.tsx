import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { api, del, formatBytes, patch } from "../lib/api";
import { Dialog, useAction, useToast } from "../lib/ui";
import type { Repo } from "../lib/types";
import { navigate } from "../App";

export interface Account {
  id: string;
  login: string;
  name: string;
  avatar: string;
}

/** What only this machine has of a repository, and what removing it takes along (server: routes/repos.mjs). */
interface UnlinkReport {
  error: string;
  pending: { branch: string; kind: "work" | "trash" | "library" | "branch"; work?: string; title: string; unsaved: number; ahead: number; behind: number }[];
  busy: string[];
  works: number;
  bytes: number;
  exports: { count: number; bytes: number };
  sessions: number;
  backups: number;
  failed?: string[];
}
type Pending = UnlinkReport["pending"][number];

const subject = (item: Pending) =>
  ({ work: `作品「${item.title}」`, trash: `回收站里的「${item.title}」`, library: item.title, branch: `分支 ${item.branch}` })[item.kind];
const diverged = (item: Pending) => item.ahead > 0 && item.behind > 0;
function problems(item: Pending) {
  const parts = [];
  if (item.unsaved) parts.push(`${item.unsaved} 个文件有未保存的修改`);
  if (diverged(item)) parts.push("本机和 GitHub 上都有新版本，需要先在作品中选择怎么处理");
  else if (item.ahead) parts.push(`${item.ahead} 个版本还没推送到 GitHub`);
  return parts.join("；");
}

/**
 * Remove a repository from this machine. The server lists what GitHub does not have yet;
 * that can be saved and pushed first, or knowingly given up.
 */
export function UnlinkDialog({ repo, onClose, onDone }: { repo: Repo; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [report, setReport] = useState<UnlinkReport | null>(null);
  const [failure, setFailure] = useState("");
  const [phase, setPhase] = useState<"" | "checking" | "syncing" | "removing">("checking");
  const [discard, setDiscard] = useState(false);
  const base = `/api/repos/${encodeURIComponent(repo.id)}`;
  const check = useCallback(async () => {
    setPhase("checking");
    setFailure("");
    try {
      setReport(await api<UnlinkReport>(`${base}/unlink`));
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setPhase("");
    }
  }, [base]);
  useEffect(() => void check(), [check]);

  const sync = async () => {
    setPhase("syncing");
    try {
      const next = await api<UnlinkReport>(`${base}/unlink/sync`, { method: "POST" });
      setReport(next);
      if (next.failed?.length) toast(`有内容没能同步：\n${next.failed.join("\n")}`, "error");
      else if (!next.pending.length) toast("已全部同步到 GitHub", "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setPhase("");
    }
  };
  const unlink = async () => {
    setPhase("removing");
    try {
      const { freed } = await del<{ freed: number }>(base + (discard ? "?discard=1" : ""));
      toast(`已取消链接「${repo.name}」${freed > 0 ? `，释放了 ${formatBytes(freed)}` : ""}`, "ok");
      onDone();
      onClose();
    } catch (error) {
      toast((error as Error).message, "error");
      setPhase("");
      void check();
    }
  };

  const pending = report?.pending ?? [];
  const blocked = Boolean(report?.busy.length);
  const risky = Boolean(report && (pending.length || report.error));
  const fixable = pending.some((item) => item.unsaved || (item.ahead && !item.behind));
  return (
    <Dialog
      title={`取消链接「${repo.name}」`}
      onClose={phase ? () => {} : onClose}
      width={560}
      footer={
        <>
          <button className="btn" disabled={Boolean(phase)} onClick={onClose}>
            取消
          </button>
          <button className="btn primary danger-fill" disabled={!report || blocked || Boolean(phase) || (risky && !discard)} onClick={unlink}>
            {phase === "removing" && <span className="spinner" />}
            取消链接
          </button>
        </>
      }
    >
      <p className="muted unlink-intro">只影响这台电脑：作品库从 FRAME 中移除，它在本机的数据会删除。GitHub 上的仓库和作品不受影响，以后可以随时重新连接。</p>
      {phase === "checking" && (
        <div className="unlink-checking">
          <span className="spinner" /> 正在对比本机和 GitHub 上的内容…
        </div>
      )}
      {failure && (
        <div className="home-notice danger">
          <CircleAlert size={15} />
          <div className="grow">
            {failure}{" "}
            <button className="link-btn" onClick={check}>
              重新检查
            </button>
          </div>
        </div>
      )}
      {report && phase !== "checking" && (
        <>
          {blocked && (
            <div className="home-notice danger">
              <CircleAlert size={15} />
              <div className="grow">
                {report.busy.map((line) => (
                  <div key={line}>{line}</div>
                ))}
                <div className="small-text">先停止再取消链接。</div>
              </div>
            </div>
          )}
          {report.error && (
            <div className="home-notice warn">
              <TriangleAlert size={15} />
              <div className="grow">
                无法连接 GitHub，不能确认本机的内容是否都已同步：{report.error}{" "}
                <button className="link-btn" onClick={check}>
                  重新检查
                </button>
              </div>
            </div>
          )}
          {pending.length > 0 ? (
            <div className="home-notice warn">
              <TriangleAlert size={15} />
              <div className="grow">
                <strong>这些内容只在这台电脑上，取消链接后会丢失：</strong>
                <ul className="unlink-list">
                  {pending.map((item) => (
                    <li key={item.branch}>
                      <span className="grow">
                        {subject(item)}
                        <span className="muted">：{problems(item)}</span>
                      </span>
                      {item.kind === "work" && diverged(item) && (
                        <button className="link-btn" onClick={() => navigate(`/work/${encodeURIComponent(repo.id)}/${encodeURIComponent(item.work!)}`)}>
                          打开处理
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {fixable && (
                  <button className="btn small" disabled={Boolean(phase) || blocked} onClick={sync}>
                    {phase === "syncing" && <span className="spinner" />}
                    保存并同步到 GitHub
                  </button>
                )}
              </div>
            </div>
          ) : (
            !report.error && (
              <div className="home-notice ok">
                <CircleCheck size={15} />
                <div className="grow">本机的内容都已经在 GitHub 上。</div>
              </div>
            )
          )}
          <div className="unlink-label">会从这台电脑删除</div>
          <ul className="unlink-facts">
            <li>
              <span className="grow">作品库副本{report.works ? `和已下载的 ${report.works} 个作品` : ""}</span>
              <span className="muted">{formatBytes(report.bytes)}</span>
            </li>
            {report.exports.count > 0 && (
              <li>
                <span className="grow">
                  导出的视频 {report.exports.count} 个<span className="warn-text">（只保存在这台电脑上）</span>
                </span>
                <span className="muted">{formatBytes(report.exports.bytes)}</span>
              </li>
            )}
            {report.sessions > 0 && (
              <li>
                <span className="grow">这些作品的 AI 对话 {report.sessions} 个</span>
              </li>
            )}
            {report.backups > 0 && (
              <li>
                <span className="grow">处理冲突时保留的本机备份 {report.backups} 个</span>
              </li>
            )}
          </ul>
          {risky && !blocked && (
            <label className="row unlink-discard">
              <input type="checkbox" checked={discard} onChange={(event) => setDiscard(event.target.checked)} />
              {report.error ? "仍然取消链接（无法确认的内容可能会丢失）" : "我知道这些内容会丢失，仍然取消链接"}
            </label>
          )}
        </>
      )}
    </Dialog>
  );
}

/** The GitHub account a repository syncs with (a new token, another account). */
export function AccountDialog({
  repo,
  accounts,
  onClose,
  onDone,
  onSettings,
}: {
  repo: Repo;
  accounts: Account[];
  onClose: () => void;
  onDone: () => void;
  onSettings: () => void;
}) {
  const [account, setAccount] = useState(repo.account);
  const [run, busy] = useAction();
  const save = async () => {
    if (await run(() => patch(`/api/repos/${encodeURIComponent(repo.id)}`, { account }), "已更换账号")) {
      onDone();
      onClose();
    }
  };
  return (
    <Dialog
      title="GitHub 账号"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || account === repo.account || !accounts.length} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <p className="muted">「{repo.name}」用这个账号和 GitHub 同步作品。令牌过期或换了账号时，在这里改用另一个。</p>
      {accounts.length ? (
        <label className="field">
          <span>同步使用的账号</span>
          <select className="select" value={account} onChange={(event) => setAccount(event.target.value)}>
            {accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.login}
                {item.name ? `（${item.name}）` : ""}
              </option>
            ))}
            <option value="">不使用账号（只能读取公开仓库）</option>
          </select>
        </label>
      ) : (
        <p>
          还没有添加 GitHub 账号。{" "}
          <button className="link-btn" onClick={onSettings}>
            去设置里添加
          </button>
        </p>
      )}
    </Dialog>
  );
}

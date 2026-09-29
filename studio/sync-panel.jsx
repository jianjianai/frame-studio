import { RefreshCw } from "lucide-react";
import { api, useQuery, useAction, Button, ErrorNote, date } from "./ui";

export function SyncPanel({ work, notify, onChange }) {
  return (
    <BranchSync
      work={work}
      repo={work.repo}
      notify={notify}
      onChange={onChange}
    />
  );
}
export function BranchSync({ work, repo, notify, onChange }) {
  const args = work ? { id: work.id } : { repo },
    operation = work ? "works_sync" : "repositories_sync",
    status = work ? "works_sync_status" : "repositories_check";
  const query = useQuery(status, args),
    [run, busy] = useAction(notify),
    state = query.data;
  const sync = (action) =>
    run(async () => {
      await api(operation, { ...args, action });
      onChange?.();
      query.refresh();
      notify(action === "push" ? "分支已推送" : "分支已拉取");
    });
  return (
    <>
      <p>
        {work
          ? "此作品的历史和同步独立于同仓库的其他作品。"
          : "仓库素材库独立保存在 frame/materials 分支，作品使用的素材同时保存在各自作品分支。"}
      </p>
      <p>
        分支：<code>{state?.branch || work?.branch || "frame/materials"}</code>
      </p>
      <ErrorNote error={query.error || state?.error} />
      <div className="sync-counts">
        <div>
          <strong>{state?.ahead ?? "—"}</strong>
          <span>本地领先</span>
        </div>
        <div>
          <strong>{state?.behind ?? "—"}</strong>
          <span>远端领先</span>
        </div>
        <div>
          <strong>{state?.dirty ?? "—"}</strong>
          <span>未提交文件</span>
        </div>
      </div>
      <p>最后检查远端：{date(state?.checked)}</p>
      {state?.remote && !state.remoteExists && (
        <p>远端还没有这个分支，首次推送会创建。</p>
      )}
      {state?.ahead > 0 && state?.behind > 0 && (
        <p className="error">分支已分叉，请先合并远端与本地的不同修改。</p>
      )}
      <div className="row">
        <Button
          icon={RefreshCw}
          disabled={busy || !state?.remote}
          onClick={() =>
            run(async () => {
              await api(status, { ...args, fetch: true });
              onChange?.();
              query.refresh();
            })
          }
        >
          刷新远端状态
        </Button>
        <Button
          disabled={
            busy || !state?.remoteExists || state?.dirty > 0 || state?.ahead > 0
          }
          onClick={() => sync("pull")}
        >
          拉取
        </Button>
        <Button
          className="primary"
          disabled={busy || !state?.remote || state?.behind > 0}
          onClick={() => sync("push")}
        >
          保存并推送
        </Button>
      </div>
      {!state?.remote && (
        <p>此仓库保存在服务器；在仓库设置中关联 GitHub 后即可同步。</p>
      )}
    </>
  );
}

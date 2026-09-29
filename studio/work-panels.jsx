import { useEffect, useRef, useState } from "react";
import {
  Upload,
  Download,
  Trash2,
  RefreshCw,
  ExternalLink,
  Check,
  Plus,
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
  Empty,
  bytes,
  date,
} from "./ui";
import { RepoPicker } from "./library";
import { SpeechControls } from "./speech";

export { Materials } from "./materials";
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
          <span>尚未上传的版本</span>
        </div>
        <div>
          <strong>{state?.behind ?? "—"}</strong>
          <span>可下载的远端版本</span>
        </div>
        <div>
          <strong>{state?.dirty ?? "—"}</strong>
          <span>尚未保存的文件</span>
        </div>
      </div>
      <p>最后检查远端：{date(state?.checked)}</p>
      {state?.remote && !state.remoteExists && (
        <p>远端还没有这个分支，首次推送会创建。</p>
      )}
      {state?.ahead > 0 && state?.behind > 0 && (
        <p className="error">
          本机与远端都有新版本，不能直接覆盖。请先在版本管理中保存当前内容，再由仓库维护者合并冲突；工作台不会强制覆盖任意一侧。
        </p>
      )}
      {!state && query.loading && <p role="status">正在读取同步状态…</p>}
      {query.error && <Button onClick={query.refresh}>重试读取状态</Button>}
      {!!state?.dirty && (
        <p>
          有尚未保存的文件。点击“保存并推送”会先保存当前作品版本，再上传到远端；只保存到服务器可在版本管理中操作。
        </p>
      )}
      {state?.behind > 0 && !state?.ahead && !state?.dirty && (
        <p>远端有更新，可以拉取；当前没有未保存修改。</p>
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
export { Versions } from "./versions";
export function Details({ work, notify, onSave }) {
  const [run, busy] = useAction(notify);
  return (
    <Form
      busy={busy}
      onSubmit={(a) =>
        run(async () => {
          await api("works_update", { id: work.id, ...a });
          onSave();
          notify("资料已保存");
        })
      }
    >
      <Field label="作品名称">
        <input
          name="title"
          required
          defaultValue={work.title}
          maxLength="150"
        />
      </Field>
      <Field label="简介">
        <textarea
          name="description"
          rows="4"
          defaultValue={work.description}
          maxLength={4000}
        />
      </Field>
      <Field label="分类">
        <input name="category" defaultValue={work.category} maxLength={80} />
      </Field>
      <Field label="制作状态">
        <select name="status" defaultValue={work.status}>
          <option value="draft">制作中</option>
          <option value="review">待审片</option>
          <option value="finished">已完成</option>
        </select>
      </Field>
      <p>所属仓库：{work.repository?.name}</p>
    </Form>
  );
}
export { Voice } from "./voice";
export { Exports } from "./exports";

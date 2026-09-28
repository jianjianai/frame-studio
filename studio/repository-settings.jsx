import { useState } from "react";
import { api, useQuery, useAction, Button, Field, Form, ErrorNote } from "./ui";
import { BranchSync } from "./work-panels";
export function RepositorySettings({ repo, notify, onSaved }) {
  const accounts = useQuery("github_accounts"),
    [account, setAccount] = useState(repo.account || ""),
    [run, busy] = useAction(notify);
  return (
    <>
      <p>每个作品独占一个分支；此处管理账号、远端地址及共享素材分支。</p>
      <Form
        busy={busy}
        onSubmit={(a) =>
          run(async () => {
            if (account)
              await api("repositories_account", { repo: repo.id, account });
            if (a.url && a.url !== repo.url)
              await api("repositories_remote", { repo: repo.id, url: a.url });
            onSaved?.();
            notify("仓库设置已保存");
          })
        }
      >
        <Field label="GitHub 账号">
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">选择账号</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.login}
              </option>
            ))}
          </select>
        </Field>
        <Field label="GitHub 仓库地址">
          <input
            name="url"
            type="url"
            defaultValue={repo.url}
            placeholder="https://github.com/账号/作品仓库.git"
          />
        </Field>
      </Form>
      <ErrorNote error={accounts.error} />
      <Button
        disabled={busy || !repo.url}
        onClick={() =>
          run(async () => {
            await api("repositories_refresh", { repo: repo.id });
            onSaved?.();
            notify("已读取远端作品分支");
          })
        }
      >
        发现远端作品
      </Button>
      <h3>素材库同步</h3>
      <BranchSync repo={repo.id} notify={notify} />
    </>
  );
}

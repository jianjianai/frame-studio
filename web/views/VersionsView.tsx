import { useEffect, useState } from "react";
import { RefreshCw, Save, Undo2, ArrowUp, ArrowDown, CloudUpload, History, FileDiff, RotateCcw } from "lucide-react";
import { api, timeAgo, workPath, experiencePath, materialsPath, useServerEvent, type ApiError } from "../lib/api";
import { useAction, useConfirm, useContextMenu } from "../lib/ui";
import type { Version, WorkStatus } from "../lib/types";
import { useWorkbench } from "../workbench/store";
import { RepoDialog } from "../components/RepoDialog";
import { ViewHeader } from "./ViewHeader";
import { RemoteBar } from "../workbench/RemoteBar";
import { reviewsPath } from "../lib/reviews";

const statusLabel: Record<string, string> = { M: "修改", A: "新增", D: "删除", "?": "新增", R: "重命名", U: "冲突" };

export function VersionsView() {
  const { work } = useWorkbench();
  const [refresh, setRefresh] = useState(0);
  return (
    <div className="view">
      <ViewHeader title="版本与同步">
        <button
          className="icon-btn"
          title="刷新"
          // A manual refresh also compares with GitHub (the bar above the editor shows the result).
          onClick={() =>
            Promise.all([
              api(`${workPath(work.repo, work.id)}/sync`, { method: "POST" }),
              api(`${workPath(work.repo, work.id)}/remote/check`, { method: "POST" }),
            ]).then(
              () => setRefresh(Date.now()),
              () => setRefresh(Date.now()),
            )
          }
        >
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      <VersionsPanel source="work" refresh={refresh} />
    </div>
  );
}

/**
 * Save versions, unsaved changes, history and GitHub sync of the work or of one of the
 * repository's shared branches: experience, materials, reviews (same API on another branch).
 */
export function VersionsPanel({ source, refresh = 0 }: { source: "work" | "experience" | "materials" | "reviews"; refresh?: number }) {
  const { work, reload: reloadWork, openDiff, readOnly } = useWorkbench();
  // Experience and material libraries share the work's version UI on their own branches.
  const experience = source !== "work";
  // A published work keeps its history viewable and syncs, but takes no new versions.
  const locked = !experience && readOnly;
  const scope = source === "work" ? work.id : `${source}-${work.repo}`;
  const reload = experience ? async () => {} : reloadWork;
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [history, setHistory] = useState<Version[]>([]);
  const [message, setMessage] = useState("");
  const [publish, setPublish] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const [openMenu, menu] = useContextMenu();
  const base =
    source === "experience"
      ? experiencePath(work.repo)
      : source === "materials"
        ? materialsPath(work.repo)
        : source === "reviews"
          ? reviewsPath(work.repo)
          : workPath(work.repo, work.id);
  const name = { work: "作品", experience: "经验库", materials: "素材库", reviews: "复盘资料" }[source];
  const prefix = experience ? "" : `projects/${work.slug}/`;
  const load = async () => {
    const [nextStatus, nextHistory] = await Promise.all([api<WorkStatus>(`${base}/status`), api<Version[]>(`${base}/history?limit=100`)]);
    setStatus(nextStatus);
    setHistory(nextHistory);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, refresh]);
  useServerEvent((event) => {
    if ((event.type === "work-files" || event.type === "work-versions") && event.work === scope) void load();
    if (source === "experience" && event.type === "experience-files" && event.repo === work.repo) void load();
    if (source === "materials" && event.type === "materials" && event.repo === work.repo) void load();
    if (source === "reviews" && event.type === "reviews" && event.repo === work.repo) void load();
  });

  const commit = () =>
    run(async () => {
      const result = await api<{ commit: string | null }>(`${base}/commit`, { body: { message: message.trim() || "手动保存" } });
      setMessage("");
      await load();
      return result;
    }, "已保存版本");
  // Like VS Code: a click previews the changes in a tab, a double-click keeps the tab.
  const showDiff = (title: string, query: string, preview = true) => openDiff(title, query, { preview, source });
  const revert = async (version: Version) => {
    if (
      !(await confirm(`把${name}恢复成「${version.message}」时的样子？\n当前内容会先自动保存，恢复本身也会成为一个新版本，随时可以再恢复回来。`, {
        confirm: "恢复",
      }))
    )
      return;
    await run(async () => {
      await api(`${base}/revert`, { body: { commit: version.commit } });
      await load();
      await reload();
    }, "已恢复");
  };
  const discard = async (file?: string) => {
    if (
      !(await confirm(file ? `放弃对 ${file.replace(prefix, "")} 的修改？` : "放弃所有未保存的修改，回到上一个版本？", { confirm: "放弃修改", danger: true }))
    )
      return;
    await run(async () => {
      await api(`${base}/discard`, { body: { files: file ? [file] : [] } });
      await load();
    });
  };
  const [diverged, setDiverged] = useState(false);
  const sync = (action: "push" | "pull") =>
    run(
      async () => {
        try {
          await api(`${base}/${action}`, { method: "POST" });
        } catch (error) {
          if (action === "pull" && (error as ApiError).details && ((error as ApiError).details as { diverged?: boolean }).diverged) setDiverged(true);
          throw error;
        }
        await load();
        if (action === "pull") await reload();
      },
      action === "push" ? "已推送到 GitHub" : "已从 GitHub 拉取",
    );
  const resolve = (strategy: "merge" | "remote") =>
    run(
      async () => {
        await api(`${base}/resolve`, { body: { strategy } });
        setDiverged(false);
        await load();
        await reload();
      },
      strategy === "merge" ? "已合并" : "已采用 GitHub 的版本，本地版本已备份",
    );

  return (
    <>
      {/* The work's own warning sits above the editor; the shared libraries warn here. */}
      {source !== "work" && <RemoteBar base={`${base}/remote`} repo={work.repo} scope={`${source}-${work.repo}`} what={name} onSettled={() => void load()} />}
      {busy && <div className="view-progress" />}
      <section className="view-section">
        {!locked && (
          <textarea
            className="textarea"
            rows={2}
            placeholder="这个版本改了什么（Ctrl+Enter 保存）"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && (event.ctrlKey || event.metaKey) && commit()}
          />
        )}
        <div className="row">
          {locked ? (
            <span className="grow faint small-text">作品已发布，不再保存新版本。</span>
          ) : (
            <button className="btn primary grow" disabled={!status?.files.length} onClick={commit}>
              <Save size={14} /> 保存版本
            </button>
          )}
          {status?.remote ? (
            <>
              <button className="btn" title="推送到 GitHub" onClick={() => sync("push")}>
                <ArrowUp size={14} /> {status.ahead || ""}
              </button>
              <button className="btn" title="从 GitHub 拉取" onClick={() => sync("pull")}>
                <ArrowDown size={14} /> {status.behind || ""}
              </button>
            </>
          ) : (
            <button className="btn" title="发布到 GitHub" onClick={() => setPublish(true)}>
              <CloudUpload size={14} />
            </button>
          )}
        </div>
        {diverged && (
          <div className="diverged">
            <p>本地和 GitHub 上都有新的修改：</p>
            <div className="row wrap">
              <button className="btn small" onClick={() => resolve("merge")}>
                合并双方
              </button>
              <button className="btn small" onClick={() => resolve("remote")}>
                采用 GitHub 的版本
              </button>
            </div>
          </div>
        )}
      </section>
      <section className="view-section">
        <h3>
          未保存的修改 <span className="badge">{status?.files.length ?? 0}</span>
          <span className="grow" />
          {!!status?.files.length && !locked && (
            <button className="icon-btn" title="全部放弃" onClick={() => discard()}>
              <Undo2 size={14} />
            </button>
          )}
        </h3>
        {status?.files.map((file) => (
          <div
            key={file.path}
            className="change-row"
            title="单击查看改动，双击保持打开"
            onClick={() => showDiff(`${file.path.split("/").pop()}（未保存）`, `file=${encodeURIComponent(file.path)}`)}
            onDoubleClick={() => showDiff(`${file.path.split("/").pop()}（未保存）`, `file=${encodeURIComponent(file.path)}`, false)}
          >
            <span className={`change-status s-${file.status === "?" ? "A" : file.status}`}>{file.status === "?" ? "A" : file.status}</span>
            <span className="ellipsis grow" title={statusLabel[file.status] || file.status}>
              {file.path.replace(prefix, "")}
            </span>
            {!locked && (
              <button
                className="icon-btn"
                title="放弃修改"
                onClick={(event) => {
                  event.stopPropagation();
                  void discard(file.path);
                }}
              >
                <Undo2 size={13} />
              </button>
            )}
          </div>
        ))}
      </section>
      <section className="view-section">
        <h3>
          <History size={14} /> 历史
        </h3>
        {history.map((version, index) => (
          <div
            key={version.commit}
            className="version-row"
            onClick={() => showDiff(`${version.short} ${version.message}`, `commit=${version.commit}`)}
            onDoubleClick={() => showDiff(`${version.short} ${version.message}`, `commit=${version.commit}`, false)}
            onContextMenu={(event) =>
              openMenu(event, [
                {
                  label: "查看改动",
                  icon: <FileDiff size={14} />,
                  onClick: () => showDiff(`${version.short} ${version.message}`, `commit=${version.commit}`, false),
                },
                { label: "恢复到这个版本", icon: <RotateCcw size={14} />, onClick: () => revert(version), disabled: index === 0 || locked },
              ])
            }
          >
            <span className="version-dot" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" title={version.message}>
                {version.message}
              </div>
              <div className="faint small-text">
                {timeAgo(version.date)} · {version.short}
                {version.stat
                  ? ` · ${version.stat
                      .replace(/ files? changed/, " 个文件")
                      .replace(/insertions?\(\+\)/, "+")
                      .replace(/deletions?\(-\)/, "-")}`
                  : ""}
              </div>
            </div>
            {index > 0 && !locked && (
              <button
                className="icon-btn"
                title="恢复到这个版本"
                onClick={(event) => {
                  event.stopPropagation();
                  void revert(version);
                }}
              >
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        ))}
      </section>
      {publish && <RepoDialog mode="publish" onClose={() => setPublish(false)} onDone={load} />}
      {menu}
    </>
  );
}

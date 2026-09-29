import { useEffect, useRef, useState } from "react";
import {
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Undo2,
  Search,
  CheckCheck,
  FileCode2,
  History,
  Copy,
  X,
  Check,
  CircleAlert,
  BookmarkPlus,
  Play,
} from "lucide-react";
import { api, useQuery, useAction, Button, Modal, ErrorNote, date } from "./ui";
import { VersionReview } from "./versions";
import { SourceDiff } from "./source-diff";
import "./source-control.css";

const statuses = {
  M: "已修改",
  A: "新增",
  D: "已删除",
  R: "重命名",
  C: "复制",
  T: "类型变化",
  U: "冲突",
};
const labels = {
  stage: "暂存",
  unstage: "取消暂存",
  discard: "撤销未暂存更改",
  commit: "提交",
  checkpoint: "创建命名版本",
  fetch: "刷新远端",
  pull: "拉取",
  push: "推送",
  sync: "同步",
};
function displayPath(work, file) {
  const relative = file.replace(`projects/${work.project}/`, ""),
    slash = relative.lastIndexOf("/");
  return {
    name: relative.slice(slash + 1),
    folder:
      slash < 0
        ? file.startsWith("projects/")
          ? ""
          : "分支文件"
        : relative.slice(0, slash),
    relative,
  };
}
function readDraft(id) {
  try {
    return sessionStorage.getItem("frame.scm.commit:" + id) || "";
  } catch {
    return "";
  }
}
function FileGroup({
  title,
  area,
  files,
  work,
  selection,
  onSelect,
  onAction,
  disabled,
  bulkDisabled,
  history = false,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const operation = area === "staged" ? "unstage" : "stage";
  return (
    <section className="scm-file-group" aria-label={title}>
      <header className="scm-group-heading">
        <button
          className="scm-group-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <strong>{title}</strong>
          <span className="scm-count">{files.length}</span>
        </button>
        {!history && area !== "conflict" && (
          <Button
            icon={operation === "stage" ? Plus : Minus}
            className="scm-icon"
            aria-label={
              operation === "stage"
                ? "暂存列表中的所有更改"
                : "取消列表中所有文件的暂存"
            }
            title={
              operation === "stage" ? "暂存列表中的所有更改" : "全部取消暂存"
            }
            disabled={
              disabled ||
              bulkDisabled ||
              !files.length ||
              files.some((file) => file.unsafe)
            }
            onClick={() => onAction(operation, files)}
          />
        )}
      </header>
      {!collapsed && (
        <div className="scm-file-list">
          {files.map((file) => {
            const parts = displayPath(work, file.path),
              selected =
                selection?.path === file.path &&
                (selection?.area === area || area === "conflict");
            const status = file.conflict
              ? "U"
              : area === "staged"
                ? file.index || file.status
                : file.untracked
                  ? "A"
                  : file.working?.replace(".", "") || file.status;
            return (
              <div
                className={`scm-file-row ${selected ? "selected" : ""}`}
                key={file.path}
                data-status={status}
              >
                <button
                  className="scm-file-select"
                  aria-label={`查看${title}：${parts.relative}`}
                  aria-pressed={selected}
                  title={
                    file.unsafe ||
                    (file.originalPath
                      ? `${file.originalPath} → ${file.path}`
                      : file.path)
                  }
                  disabled={!!file.unsafe}
                  onClick={() =>
                    onSelect(file, area === "conflict" ? "working" : area)
                  }
                >
                  <FileCode2 size={15} aria-hidden="true" />
                  <span className="scm-file-name">
                    <strong>{parts.name}</strong>
                    <small>
                      {file.originalPath
                        ? `从 ${displayPath(work, file.originalPath).relative}`
                        : parts.folder}
                    </small>
                  </span>
                  <span
                    className="scm-file-status"
                    title={file.unsafe || statuses[status] || status}
                  >
                    {file.unsafe ? "!" : status}
                  </span>
                </button>
                {!history && !file.conflict && (
                  <div className="scm-file-actions">
                    <Button
                      className="scm-icon"
                      icon={area === "staged" ? Minus : Plus}
                      aria-label={`${area === "staged" ? "取消暂存" : "暂存"} ${parts.relative}`}
                      title={area === "staged" ? "取消暂存" : "暂存更改"}
                      disabled={disabled || !!file.unsafe}
                      onClick={() =>
                        onAction(area === "staged" ? "unstage" : "stage", [
                          file,
                        ])
                      }
                    />
                    {area === "working" && (
                      <Button
                        className="scm-icon"
                        icon={Undo2}
                        aria-label={`撤销 ${parts.relative} 的未暂存更改`}
                        title="撤销未暂存更改（需要确认）"
                        disabled={disabled || !!file.unsafe}
                        onClick={() => onAction("discard", [file])}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!files.length && <p className="scm-group-empty">没有{title}</p>}
        </div>
      )}
    </section>
  );
}
export function SourceControl({
  work,
  notify,
  onChange,
  visible = true,
  currentPreview,
  position,
  onPause,
}) {
  const query = useQuery(
    visible ? "works_scm_status" : null,
    { id: work.id },
    1,
  );
  const state = query.data;
  const [tab, setTab] = useState("changes"),
    [filter, setFilter] = useState(""),
    [draft, setDraft] = useState(() => readDraft(work.id));
  const [selection, setSelection] = useState(null),
    [selectedCommit, setSelectedCommit] = useState(null),
    [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(false),
    [discard, setDiscard] = useState(null),
    [restore, setRestore] = useState(null),
    [review, setReview] = useState(null),
    [bookmark, setBookmark] = useState(false),
    [versionName, setVersionName] = useState("");
  const [error, setError] = useState(""),
    [operation, setOperation] = useState(""),
    [activity, setActivity] = useState([]),
    [run, busy] = useAction(notify);
  const diffQuery = useQuery(
    visible && selection ? "works_scm_diff" : null,
    selection ? { id: work.id, ...selection } : {},
  );
  const history = useQuery(
    visible && tab === "history" ? "works_versions" : null,
    { id: work.id, limit: 50, offset },
  );
  const detail = useQuery(
    visible && tab === "history" && selectedCommit?.kind === "git"
      ? "works_scm_commit"
      : null,
    { id: work.id, version: selectedCommit?.id },
  );
  const lastRevision = useRef(null);
  const diffAnchor = useRef(null),
    reviewedSelection = useRef(null);
  useEffect(() => {
    const key = selection && JSON.stringify(selection);
    if (!key) {
      reviewedSelection.current = null;
      return;
    }
    if (
      reviewedSelection.current === key ||
      diffQuery.loading ||
      !diffQuery.data ||
      diffQuery.data.path !== selection.path ||
      diffQuery.data.area !== selection.area
    )
      return;
    reviewedSelection.current = key;
    const frame = requestAnimationFrame(() =>
      diffAnchor.current?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [selection, diffQuery.data, diffQuery.loading]);
  useEffect(() => {
    try {
      sessionStorage.setItem("frame.scm.commit:" + work.id, draft);
    } catch {}
  }, [draft, work.id]);
  useEffect(() => {
    if (!visible) return;
    const refresh = () => {
      if (!document.hidden) query.refresh();
    };
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 15000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [visible, work.id]);
  useEffect(() => {
    if (!state?.revision || state.revision === lastRevision.current) return;
    lastRevision.current = state.revision;
    if (selection && selection.area !== "commit") {
      const file = state.files.find((entry) => entry.path === selection.path);
      if (!file) {
        setSelection(null);
        setExpanded(false);
      } else if (
        !file.conflict &&
        selection.area === "working" &&
        !file.untracked &&
        file.working === "."
      )
        setSelection({ path: file.path, area: "staged" });
      else if (
        !file.conflict &&
        selection.area === "staged" &&
        (file.untracked || file.index === ".")
      )
        setSelection({ path: file.path, area: "working" });
      else diffQuery.refresh();
    }
    if (tab === "history") history.refresh();
  }, [state?.revision]);
  const refreshAll = () => {
    query.refresh();
    history.refresh();
    detail.refresh();
    diffQuery.refresh();
    onChange?.();
  };
  const execute = (name, fn) =>
    run(async () => {
      setError("");
      setOperation(name);
      try {
        const result = await fn();
        setActivity((old) =>
          [{ name, ok: true, at: new Date().toISOString() }, ...old].slice(
            0,
            8,
          ),
        );
        notify(`${name}完成`);
        return result;
      } catch (failure) {
        setError(failure.message);
        setActivity((old) =>
          [{ name, ok: false, at: new Date().toISOString() }, ...old].slice(
            0,
            8,
          ),
        );
        throw failure;
      } finally {
        setOperation("");
        refreshAll();
      }
    });
  const change = (action, files = [], extra = {}) =>
    execute(labels[action], async () => {
      const result = await api("works_scm_change", {
        id: work.id,
        action,
        paths: files.map((file) => file.path),
        expectedRevision: state.revision,
        ...extra,
      });
      if (action === "commit" || action === "checkpoint") {
        setSelectedCommit({
          id: result.head,
          name: action === "commit" ? draft.trim() : versionName.trim(),
          kind: "git",
        });
        setSelection(null);
        setOffset(0);
        setTab("history");
        if (action === "commit") setDraft("");
        else {
          setBookmark(false);
          setVersionName("");
        }
      }
      return result;
    });
  const actOnFiles = (action, files) => {
    if (action === "discard") {
      setDiscard({ file: files[0], revision: state.revision });
      return;
    }
    void change(action, files);
  };
  const sync = (action) =>
    execute(labels[action], async () => {
      const result = await api("works_scm_sync", {
        id: work.id,
        action,
        expectedRevision: state.revision,
      });
      if (result.head !== state.head) onChange?.({ reloadWork: true });
      return result;
    });
  const choose = (file, area) => {
    setSelection({
      path: file.path,
      area,
      ...(area === "commit" ? { version: selectedCommit.id } : {}),
    });
    setExpanded(false);
  };
  const disabled =
    busy ||
    !!state?.blocked ||
    !state?.revision ||
    !!state?.conflicts ||
    query.loading;
  const files = (state?.files || []).filter((file) =>
    file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  const conflicts = files.filter((file) => file.conflict);
  const staged = files.filter(
    (file) => !file.conflict && !file.untracked && file.index !== ".",
  );
  const working = files.filter(
    (file) => !file.conflict && (file.untracked || file.working !== "."),
  );
  const remote = state?.sync;
  const diverged = !!(remote?.ahead && remote?.behind);
  const staleDiff =
    !!selection &&
    selection.area !== "commit" &&
    diffQuery.data?.revision !== state?.revision;
  const currentSelection = state?.files.find(
    (file) => file.path === selection?.path,
  );
  const diffView = (wide = false) => (
    <>
      <div className="scm-file-heading">
        <FileCode2 size={16} />
        <span>
          <strong>{displayPath(work, selection.path).name}</strong>
          <small>{selection.path}</small>
        </span>
        {!wide && (
          <Button
            className="scm-icon"
            icon={X}
            aria-label="关闭文件差异"
            onClick={() => {
              setSelection(null);
              diffAnchor.current?.closest(".scm-body")?.scrollTo({ top: 0 });
            }}
          />
        )}
      </div>
      {selection.area !== "commit" &&
        currentSelection &&
        !currentSelection.conflict && (
          <div className="scm-diff-actions">
            <span>
              {selection.area === "staged"
                ? "本次提交将包含这些更改"
                : "这些更改尚未加入提交"}
            </span>
            <Button
              disabled={disabled || staleDiff || diffQuery.loading}
              icon={selection.area === "staged" ? Minus : Plus}
              onClick={() =>
                actOnFiles(selection.area === "staged" ? "unstage" : "stage", [
                  currentSelection,
                ])
              }
            >
              {selection.area === "staged" ? "取消暂存此文件" : "暂存此文件"}
            </Button>
          </div>
        )}
      <ErrorNote error={diffQuery.error} />
      {diffQuery.error && (
        <Button
          onClick={() => {
            diffQuery.refresh();
            query.refresh();
          }}
        >
          重新读取差异
        </Button>
      )}
      {(diffQuery.loading || staleDiff) && !diffQuery.error && (
        <p className="scm-loading" role="status">
          {diffQuery.data
            ? "文件已变化，正在重新读取差异…"
            : "正在读取文件差异…"}
        </p>
      )}
      {diffQuery.data && !staleDiff && (
        <SourceDiff
          key={`${selection.path}:${selection.area}:${selection.version || ""}:${diffQuery.data.revision}`}
          value={diffQuery.data}
          expanded={wide}
          onExpand={() => setExpanded(true)}
          notify={notify}
        />
      )}
    </>
  );
  return (
    <section className="scm-panel" aria-label="作品源代码管理" aria-busy={busy}>
      <div className="scm-repository">
        <div className="scm-branch">
          <GitBranch size={16} />
          <strong title={state?.branch || work.branch}>
            {state?.branch || work.branch || "检查分支中"}
          </strong>
          <Button
            className="scm-icon"
            icon={RefreshCw}
            aria-label="刷新源代码管理"
            title="刷新文件状态，不访问远端"
            disabled={busy || query.loading}
            onClick={refreshAll}
          />
        </div>
        <div className="scm-sync-summary">
          <span title={remote?.remote || "尚未关联远端"}>
            {remote?.remote ? "origin" : "服务器本地"}
          </span>
          <span title="待推送提交">
            <ArrowUp size={12} />
            {remote?.ahead ?? "—"}
          </span>
          <span title="待拉取提交">
            <ArrowDown size={12} />
            {remote?.behind ?? "—"}
          </span>
          <small>
            {remote?.remote
              ? remote.checked
                ? `检查于 ${date(remote.checked)}`
                : "远端状态待检查"
              : "提交无需连接 GitHub"}
          </small>
        </div>
        <div className="scm-sync-bar">
          <Button
            icon={ArrowDownUp}
            className="scm-sync-primary"
            disabled={
              disabled ||
              !remote?.remote ||
              diverged ||
              (remote?.behind > 0 && (state?.total > 0 || state?.outside > 0))
            }
            title="先拉取，再推送；不自动提交未暂存文件"
            onClick={() => sync("sync")}
          >
            {remote?.remote && !remote.remoteExists
              ? "发布分支"
              : remote?.behind && !remote.ahead
                ? `拉取 ${remote.behind} 个提交`
                : "同步更改"}
          </Button>
          <details className="scm-sync-menu">
            <summary aria-label="更多同步操作">
              <ChevronDown size={16} />
            </summary>
            <div>
              {[
                ["fetch", "检查远端更新"],
                ["pull", "仅拉取（快进）"],
                ["push", "仅推送已提交版本"],
              ].map(([action, label]) => (
                <button
                  key={action}
                  disabled={
                    busy || !remote?.remote || (action !== "fetch" && disabled)
                  }
                  onClick={(event) => {
                    event.currentTarget.closest("details").open = false;
                    sync(action);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </details>
        </div>
        {remote?.remote &&
          !state?.total &&
          !remote.ahead &&
          !remote.behind &&
          remote.checked &&
          !remote.error && (
            <p className="scm-up-to-date">
              <CheckCheck size={13} />
              已与远端一致
            </p>
          )}
      </div>
      <div
        className="scm-tabs"
        role="tablist"
        aria-label="源代码管理视图"
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "changes"
                : event.key === "End"
                  ? "history"
                  : tab === "changes"
                    ? "history"
                    : "changes";
            setTab(next);
            event.currentTarget.querySelector(`[data-tab="${next}"]`)?.focus();
            setSelection(null);
          }
        }}
      >
        {[
          ["changes", "变更", state?.total],
          ["history", "历史", null],
        ].map(([key, name, count]) => (
          <button
            role="tab"
            id={`scm-tab-${key}`}
            aria-controls={`scm-panel-${key}`}
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            data-tab={key}
            key={key}
            onClick={() => {
              setTab(key);
              setSelection(null);
            }}
          >
            {key === "history" ? (
              <History size={14} />
            ) : (
              <GitCommitHorizontal size={14} />
            )}
            {name}
            {count != null && <span className="scm-count">{count}</span>}
          </button>
        ))}
      </div>
      <div className="scm-body">
        <ErrorNote error={error || query.error || remote?.error} />
        {query.error && (
          <Button onClick={query.refresh}>重试读取源代码管理</Button>
        )}
        {state?.blocked && (
          <p className="scm-notice warning">
            <CircleAlert size={15} />
            {state.blocked}。可以继续查看差异与历史。
          </p>
        )}
        {diverged && (
          <p className="scm-notice warning">
            本地和远端均有独立提交，已停止自动同步。请先使用本地 Git
            合并；工作台不会强制覆盖。
          </p>
        )}
        {!!state?.outside && (
          <p className="scm-notice warning">
            检测到 {state.outside}{" "}
            项作品范围外变更，未加入此列表。含范围外文件的提交会被阻止。
          </p>
        )}
        {state?.truncated && (
          <p className="scm-notice">
            仅显示前 500 / {state.total} 个变更；批量操作已禁用，请使用本地 Git
            整理大型变更。
          </p>
        )}
        {query.loading && !state && (
          <p className="scm-loading" role="status">
            正在读取工作区和暂存区…
          </p>
        )}
        {operation && (
          <p className="scm-operation" role="status">
            <RefreshCw size={14} />
            正在{operation}，请勿重复操作…
          </p>
        )}
        {tab === "changes" ? (
          <div
            role="tabpanel"
            id="scm-panel-changes"
            aria-labelledby="scm-tab-changes"
          >
            <form
              className="scm-commit-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!disabled && state.staged && draft.trim())
                  void change("commit", [], { message: draft.trim() });
              }}
            >
              <label htmlFor="scm-commit-message">提交说明</label>
              <textarea
                id="scm-commit-message"
                value={draft}
                maxLength={1000}
                rows={3}
                placeholder="说明这次修改了什么…"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    event.currentTarget.form.requestSubmit();
                  }
                }}
              />
              <div className="scm-commit-footer">
                <small>{draft.length}/1000 · Ctrl / ⌘ + Enter</small>
                <Button
                  className="primary"
                  type="submit"
                  icon={Check}
                  disabled={disabled || !state?.staged || !draft.trim()}
                >
                  提交已暂存{state?.staged ? ` (${state.staged})` : ""}
                </Button>
              </div>
              <p className="scm-hint">
                只提交暂存区，不自动推送。先查看文件差异，再用 + 选择本次提交。
              </p>
            </form>
            <label className="scm-search">
              <Search size={15} />
              <input
                aria-label="筛选变更文件"
                placeholder="筛选文件名或路径"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter && (
                <Button
                  icon={X}
                  className="scm-icon"
                  aria-label="清除文件筛选"
                  onClick={() => setFilter("")}
                />
              )}
            </label>
            <div className="scm-file-groups">
              {!!conflicts.length && (
                <FileGroup
                  title="合并冲突"
                  area="conflict"
                  files={conflicts}
                  work={work}
                  selection={selection}
                  onSelect={choose}
                  disabled
                />
              )}
              <FileGroup
                title="已暂存更改"
                area="staged"
                files={staged}
                work={work}
                selection={selection}
                onSelect={choose}
                onAction={actOnFiles}
                disabled={disabled}
                bulkDisabled={state?.truncated}
              />
              <FileGroup
                title="更改"
                area="working"
                files={working}
                work={work}
                selection={selection}
                onSelect={choose}
                onAction={actOnFiles}
                disabled={disabled}
                bulkDisabled={state?.truncated}
              />
            </div>
            {state && !state.total && (
              <div className="scm-clean">
                <CheckCheck size={26} />
                <strong>工作区干净</strong>
                <p>
                  所有修改都已提交。可在历史中审阅版本
                  {remote?.ahead
                    ? `，还有 ${remote.ahead} 个提交待推送。`
                    : "。"}
                </p>
              </div>
            )}
            {!!filter && !files.length && (
              <p className="scm-hint">
                没有匹配的文件。清除筛选可查看所有变更。
              </p>
            )}
          </div>
        ) : (
          <div
            role="tabpanel"
            id="scm-panel-history"
            aria-labelledby="scm-tab-history"
            className="scm-history"
          >
            <header className="scm-history-heading">
              <span>提交历史 · 每页 50 条</span>
              <Button
                icon={BookmarkPlus}
                disabled={disabled || state?.total > 0 || state?.outside > 0}
                title={
                  state?.total
                    ? "先提交文件更改，再创建命名版本"
                    : "为当前已提交状态新增命名记录"
                }
                onClick={() => setBookmark(true)}
              >
                命名版本
              </Button>
            </header>
            <ErrorNote error={history.error || detail.error} />
            {history.error && (
              <Button onClick={history.refresh}>重试加载历史</Button>
            )}
            {history.loading && !history.data && (
              <p className="scm-loading" role="status">
                正在读取提交历史…
              </p>
            )}
            {!history.loading && !history.error && !history.data?.length && (
              <p className="scm-hint">
                尚无历史提交。从“变更”中暂存文件后创建首个提交。
              </p>
            )}
            <div className="scm-history-list">
              {history.data?.map((version) => (
                <article
                  key={version.id}
                  className={`scm-history-row ${selectedCommit?.id === version.id ? "selected" : ""}`}
                >
                  <button
                    className="scm-commit-select"
                    aria-label={`查看提交 ${version.name}`}
                    aria-pressed={selectedCommit?.id === version.id}
                    onClick={() => {
                      setSelectedCommit(version);
                      setSelection(null);
                    }}
                  >
                    <GitCommitHorizontal size={16} />
                    <span>
                      <strong>{version.name}</strong>
                      <small>
                        <code>
                          {version.kind === "git"
                            ? version.id.slice(0, 8)
                            : "本地快照"}
                        </code>{" "}
                        · {date(version.created)}{" "}
                        {version.id === state?.head && <b>HEAD</b>}
                      </small>
                    </span>
                  </button>
                  <div className="scm-history-actions">
                    <Button
                      icon={Play}
                      className="scm-icon"
                      aria-label={`预览与比较 ${version.name}`}
                      title="视频预览与比较"
                      disabled={version.kind !== "git"}
                      onClick={() => setReview(version)}
                    />
                    <Button
                      icon={Undo2}
                      className="scm-icon"
                      aria-label={`恢复版本 ${version.name}`}
                      title={
                        state?.staged
                          ? "请先提交暂存区，再恢复历史版本"
                          : "恢复此版本（先保存当前内容）"
                      }
                      disabled={disabled || state?.staged > 0}
                      onClick={() =>
                        setRestore({ version, revision: state.revision })
                      }
                    />
                  </div>
                </article>
              ))}
            </div>
            <div className="scm-pagination">
              <Button
                disabled={!offset || history.loading}
                onClick={() => {
                  setOffset(Math.max(0, offset - 50));
                  setSelection(null);
                  setSelectedCommit(null);
                }}
              >
                上一页
              </Button>
              <small>第 {Math.floor(offset / 50) + 1} 页</small>
              <Button
                disabled={
                  history.loading ||
                  (history.data?.filter((item) => item.kind === "git").length ||
                    0) < 50
                }
                onClick={() => {
                  setOffset(offset + 50);
                  setSelection(null);
                  setSelectedCommit(null);
                }}
              >
                下一页
              </Button>
            </div>
            {selectedCommit?.kind === "snapshot" && (
              <p className="scm-notice">
                早期本地快照不包含 Git 文件差异，但仍可以恢复。
              </p>
            )}
            {selectedCommit?.kind === "git" && (
              <section className="scm-commit-detail">
                <h3>{selectedCommit.name}</h3>
                <p className="scm-commit-meta">
                  {detail.data?.author} · {date(detail.data?.created)}
                  <Button
                    className="scm-icon"
                    icon={Copy}
                    aria-label="复制提交哈希"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(selectedCommit.id);
                        notify("已复制提交哈希");
                      } catch {
                        notify("无法复制，请从历史中选中哈希复制", "error");
                      }
                    }}
                  />
                </p>
                <code className="scm-full-hash">{selectedCommit.id}</code>
                <p className="scm-hint">
                  以下比较此提交与{detail.data?.parent ? "父提交" : "空版本"}
                  ，不含当前未提交修改。
                </p>
                {detail.loading && !detail.data && (
                  <p role="status">正在读取提交文件…</p>
                )}
                {detail.data && (
                  <>
                    <FileGroup
                      title="提交中的文件"
                      area="commit"
                      files={detail.data.files}
                      history
                      work={work}
                      selection={selection}
                      onSelect={choose}
                    />
                    {!detail.data.total && (
                      <p className="scm-hint">
                        此版本没有文件差异，可能是一条命名记录。
                      </p>
                    )}
                    {detail.data.truncated && (
                      <p className="scm-notice">
                        仅展示前 500 / {detail.data.total} 个提交文件。
                      </p>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        )}
        {selection && (
          <div className="scm-diff-detail" ref={diffAnchor}>
            {diffView()}
          </div>
        )}
        {!!activity.length && (
          <details className="scm-activity">
            <summary>
              最近操作 · {activity[0].name}
              {activity[0].ok ? "完成" : "失败"}
            </summary>
            {activity.map((item, index) => (
              <p key={index}>
                {item.ok ? <Check size={12} /> : <CircleAlert size={12} />}
                <span>
                  {item.name}
                  {item.ok ? "完成" : "失败"}
                </span>
                <small>{date(item.at)}</small>
              </p>
            ))}
          </details>
        )}
        {!remote?.remote && state && (
          <p className="scm-offline-note">
            此作品的提交与历史保存在服务器。可在作品库的“仓库设置”中关联
            GitHub，随后发布此作品分支。
          </p>
        )}
      </div>
      {expanded && selection && (
        <Modal title="文件差异审阅" wide onClose={() => setExpanded(false)}>
          <div className="scm-expanded">{diffView(true)}</div>
        </Modal>
      )}
      {discard && (
        <Modal title="撤销未暂存更改" onClose={() => !busy && setDiscard(null)}>
          <div className="scm-confirm">
            <p>
              <strong>{displayPath(work, discard.file.path).relative}</strong>
            </p>
            <p>
              {discard.file.untracked
                ? "此文件尚未被 Git 跟踪，确认后将永久删除，无法从版本历史恢复。"
                : "将恢复为暂存区中的内容。已暂存更改会保留，但此文件未暂存的修改将丢失。"}
            </p>
            <div className="row">
              <Button disabled={busy} onClick={() => setDiscard(null)}>
                取消
              </Button>
              <Button
                className="danger"
                disabled={busy}
                onClick={() =>
                  execute(labels.discard, async () => {
                    await api("works_scm_change", {
                      id: work.id,
                      action: "discard",
                      paths: [discard.file.path],
                      expectedRevision: discard.revision,
                      confirm: true,
                    });
                    setDiscard(null);
                  })
                }
              >
                确认撤销此文件
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {restore && (
        <Modal title="恢复作品版本" onClose={() => !busy && setRestore(null)}>
          <div className="scm-confirm">
            <p>
              恢复到“<strong>{restore.version.name}</strong>”？
            </p>
            <p>
              当前文件会先自动保存，随后追加恢复记录；不会删除已有历史或强制推送远端。恢复后可更新视频预览。
            </p>
            <div className="row">
              <Button disabled={busy} onClick={() => setRestore(null)}>
                取消
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  execute("恢复作品版本", async () => {
                    await api("works_restore", {
                      id: work.id,
                      version: restore.version.id,
                      expectedRevision: restore.revision,
                    });
                    setRestore(null);
                    setSelection(null);
                    onChange?.({ reloadWork: true });
                  })
                }
              >
                保存当前内容并恢复
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {review && (
        <Modal title="版本预览与比较" wide onClose={() => setReview(null)}>
          <VersionReview
            key={review.id}
            work={work}
            version={review}
            currentPreview={currentPreview}
            position={position}
            onPause={onPause}
            notify={notify}
          />
        </Modal>
      )}
      {bookmark && (
        <Modal title="创建命名版本" onClose={() => !busy && setBookmark(false)}>
          <form
            className="scm-confirm"
            onSubmit={(event) => {
              event.preventDefault();
              void change("checkpoint", [], { message: versionName.trim() });
            }}
          >
            <label htmlFor="scm-version-name">版本名称</label>
            <input
              id="scm-version-name"
              value={versionName}
              onChange={(event) => setVersionName(event.target.value)}
              maxLength={150}
              required
              autoFocus
              placeholder="例如：已确认的开场"
            />
            <p>为当前已提交状态添加命名记录，不自动暂存文件，不推送远端。</p>
            <Button
              className="primary"
              type="submit"
              disabled={disabled || !versionName.trim()}
            >
              创建命名版本
            </Button>
          </form>
        </Modal>
      )}
    </section>
  );
}

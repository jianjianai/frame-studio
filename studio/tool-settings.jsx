import { useEffect, useRef, useState } from "react";
import {
  Terminal,
  RefreshCw,
  Download,
  Check,
  ArrowUpRight,
  LoaderCircle,
  History,
  AlertCircle,
  ChevronRight,
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
  date,
  states,
} from "./ui";
import "./tool-settings.css";

const names = { codex: "Codex", claude: "Claude Code" };
const updating = (task) =>
  ["queued", "running", "cancelling", "publishing"].includes(task?.state);
const failed = (task) => ["failed", "publish_failed"].includes(task?.state);
const versionOf = (tool) =>
  tool.installedVersion || tool.version?.trim() || "未安装";
const labelOf = (tool) =>
  !tool.available
    ? "需要安装"
    : tool.release?.status === "error"
      ? "检查失败"
      : tool.updateAvailable
        ? "有新版本"
        : tool.updateAvailable === false
          ? "已是最新"
          : "待检查";

function VersionDialog({ tool, busy, onInstall, onClose }) {
  const [version, setVersion] = useState(tool.release?.latestVersion || "");
  const choices = [
    ...new Set(
      [tool.release?.latestVersion, ...(tool.installedVersions || [])].filter(
        Boolean,
      ),
    ),
  ];
  return (
    <Modal title={names[tool.tool] + " · 指定版本"} onClose={onClose}>
      <p className="tool-dialog-intro">
        当前版本 <code>{versionOf(tool)}</code>
        。输入完整版本号安装，也可切换到以前的版本。
      </p>
      <Form
        submit="安装此版本"
        busy={busy}
        onSubmit={async () => {
          await onInstall(tool, version.trim());
          onClose();
        }}
      >
        <Field label="目标版本">
          <input
            name="version"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            list="tool-version-options"
            autoFocus
            required
            maxLength={80}
            autoComplete="off"
            placeholder="例如 1.2.3"
          />
          <datalist id="tool-version-options">
            {choices.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </Field>
        <p className="tool-field-help">
          支持完整版本号和预发布版本；可带 v
          前缀。版本不存在时会保留输入，方便修改后重试。
        </p>
        {!!tool.installedVersions?.length && (
          <div className="tool-version-shortcuts">
            <span>已安装</span>
            {tool.installedVersions.slice(0, 8).map((value) => (
              <Button
                type="button"
                key={value}
                aria-label={"选择已安装版本 " + value}
                onClick={() => setVersion(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        )}
        <div className="tool-dialog-note">
          <Check size={16} />
          安装验证通过后才切换。正在运行的创作继续使用原版本。
        </div>
      </Form>
    </Modal>
  );
}

function UpdateDetails({ task, tool, onClose }) {
  const query = useQuery("task_get", { id: task.id }, 1);
  const current = query.data?.task || task;
  const logs = (query.data?.events || [])
    .map((event) => event.data?.text || "")
    .filter(Boolean)
    .join("\n")
    .slice(-12000);
  return (
    <Modal title={names[tool] + " 更新详情"} onClose={onClose} wide>
      <ErrorNote error={query.error} />
      <div className="tool-log-heading">
        <strong>{current.input?.version || "—"}</strong>
        <span>{states[current.state] || current.state}</span>
      </div>
      {current.progress?.stage && <p role="status">{current.progress.stage}</p>}
      <ErrorNote error={current.error} />
      {query.loading && !query.data ? (
        <Loading />
      ) : (
        <pre className="tool-update-log">{logs || "暂时没有安装日志。"}</pre>
      )}
      {query.data?.hasMore && (
        <p className="tool-field-help">
          此处显示部分日志，完整记录可在任务管理中查看。
        </p>
      )}
    </Modal>
  );
}

export function ToolSettings({ notify }) {
  const tools = useQuery("tools_info", {}, 1);
  const [run, busy] = useAction(notify);
  const [checking, setChecking] = useState(false),
    [installing, setInstalling] = useState("");
  const [versionTool, setVersionTool] = useState(null),
    [details, setDetails] = useState(null);
  const [acknowledged, setAcknowledged] = useState(null);
  const pending = useRef(false);
  const rows = tools.data || [],
    tasks = rows.flatMap((tool) => tool.updates || []);
  const acknowledgedTask =
    tasks.find((task) => task.id === acknowledged?.id) || acknowledged;
  const active =
    tasks.find(updating) ||
    (updating(acknowledgedTask) ? acknowledgedTask : null);
  const installingNow = !!installing || !!active;

  // Re-entering the page and every 15 minutes refresh the server's bounded release cache.
  useEffect(() => {
    const interval = setInterval(() => tools.refresh(), 15 * 60_000);
    const focus = () => tools.refresh();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, []);
  useEffect(() => {
    if (!acknowledged) return;
    const current = tasks.find((task) => task.id === acknowledged.id);
    if (!current || updating(current)) return;
    if (current.state === "succeeded")
      notify(
        names[current.input.provider] + " 已更新到 " + current.input.version,
      );
    else if (failed(current))
      notify(
        names[current.input.provider] + " 更新失败，当前版本已保留。",
        "error",
      );
    setAcknowledged(null);
  }, [tools.data, acknowledged]);

  const check = () =>
    run(async () => {
      setChecking(true);
      try {
        const result = await api("tools_check_updates");
        tools.refresh();
        const errors = result.filter(
          (tool) => tool.release?.status === "error",
        );
        notify(
          errors.length
            ? errors.map((tool) => names[tool.tool]).join("、") +
                " 检查失败，请查看工具中的原因。"
            : "已检查最新版本",
          errors.length ? "error" : undefined,
        );
      } finally {
        setChecking(false);
      }
    });
  const install = async (tool, version) => {
    if (pending.current || installingNow)
      throw Error("已有工具更新正在进行，请等待完成。");
    pending.current = true;
    setInstalling(tool.tool);
    try {
      const task = await api("tools_update", { provider: tool.tool, version });
      setAcknowledged(task);
      tools.refresh();
      notify(
        names[tool.tool] +
          " " +
          (task.input?.version || version) +
          " 更新已排队，可离开此页面。",
      );
    } finally {
      pending.current = false;
      setInstalling("");
    }
  };
  const installedCount = rows.filter((tool) => tool.available).length;
  const updateCount = rows.filter(
    (tool) => tool.updateAvailable && tool.release?.status === "ready",
  ).length;

  return (
    <section className="tool-settings" aria-label="创作工具管理">
      <div className="settings-section-heading tool-settings-heading">
        <div>
          <span className="tool-eyebrow">执行环境</span>
          <h2>创作工具</h2>
          <p>保持 AI 创作工具就绪，模型与登录账号在「AI 模型」中管理。</p>
        </div>
        <Button
          icon={checking ? LoaderCircle : RefreshCw}
          onClick={check}
          disabled={checking || busy || tools.loading}
          aria-label="检查创作工具更新"
          className={checking ? "tool-check checking" : "tool-check"}
        >
          {checking ? "正在检查…" : "检查更新"}
        </Button>
      </div>
      <ErrorNote error={tools.error} />
      {tools.loading && !tools.data && <Loading />}
      {!!rows.length && (
        <>
          <div className="tool-overview">
            <span>
              <Check size={14} />
              {installedCount} / {rows.length} 个工具就绪
            </span>
            <span>
              {updateCount ? updateCount + " 个可用更新" : "版本状态见下方"}
            </span>
            <span className="tool-auto-check">自动检查 · 每 15 分钟</span>
          </div>
          {active && (
            <div className="tool-running-notice" role="status">
              <LoaderCircle size={16} className="spin" />
              <span>
                {names[active.input.provider]} {active.input.version}{" "}
                {active.progress?.stage ||
                  (active.state === "queued" ? "等待安装" : "正在更新")}
                。完成后会自动刷新版本。
              </span>
            </div>
          )}
          <div className="tool-cards">
            {rows.map((tool) => {
              const release = tool.release || {},
                latest = tool.updates?.[0];
              const running =
                tool.updates?.find(updating) ||
                (acknowledgedTask?.input?.provider === tool.tool &&
                updating(acknowledgedTask)
                  ? acknowledgedTask
                  : null);
              const hasError = release.status === "error";
              const upToDate =
                tool.available && tool.updateAvailable === false && !hasError;
              const badge = running ? "更新中" : labelOf(tool);
              return (
                <article
                  className="tool-card"
                  key={tool.tool}
                  aria-label={names[tool.tool] + " 工具"}
                >
                  <header>
                    <div className={"tool-mark " + tool.tool}>
                      <Terminal size={22} />
                    </div>
                    <div className="tool-card-title">
                      <h3>{names[tool.tool]}</h3>
                      <p>
                        {tool.tool === "codex"
                          ? "OpenAI 的代码创作工具"
                          : "Anthropic 的代码创作工具"}
                      </p>
                    </div>
                    <span
                      className={
                        "tool-status " +
                        (running
                          ? "running"
                          : hasError || !tool.available
                            ? "warning"
                            : tool.updateAvailable
                              ? "update"
                              : "ready")
                      }
                    >
                      {badge}
                    </span>
                  </header>
                  <dl className="tool-version-grid">
                    <div>
                      <dt>当前版本</dt>
                      <dd>
                        <code>{versionOf(tool)}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {hasError && release.latestVersion
                          ? "上次发现的版本"
                          : "最新版本"}
                      </dt>
                      <dd>
                        <code>{release.latestVersion || "—"}</code>
                      </dd>
                    </div>
                  </dl>
                  <div className="tool-release-meta">
                    <span>
                      {release.checkedAt
                        ? "上次检查 " + date(release.checkedAt)
                        : "尚未成功检查"}
                    </span>
                    {tool.releasesUrl && (
                      <a
                        href={tool.releasesUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        版本说明 <ArrowUpRight size={13} />
                      </a>
                    )}
                  </div>
                  {hasError && (
                    <div className="tool-inline-warning" role="alert">
                      <AlertCircle size={16} />
                      <span>{release.error}</span>
                    </div>
                  )}
                  {!tool.available && (
                    <p className="tool-field-help">
                      未找到可用 CLI。
                      {tool.localMode
                        ? "请先在这台电脑上安装工具。"
                        : "点击安装最新版本即可准备创作环境。"}
                    </p>
                  )}
                  {tool.localMode ? (
                    <div className="tool-local-note">
                      由这台电脑管理 · 使用本机已安装并登录的
                      CLI，通过官方安装方式更新。
                    </div>
                  ) : (
                    <div className="tool-card-actions">
                      <Button
                        className="primary"
                        icon={
                          running || installing === tool.tool
                            ? LoaderCircle
                            : upToDate
                              ? Check
                              : Download
                        }
                        disabled={busy || installingNow || upToDate}
                        onClick={() => run(() => install(tool, "latest"))}
                      >
                        {running || installing === tool.tool
                          ? "正在更新…"
                          : upToDate
                            ? "已是最新"
                            : !tool.available
                              ? "安装最新版本"
                              : release.latestVersion && !hasError
                                ? "更新到最新"
                                : "检查并更新"}
                      </Button>
                      <Button
                        disabled={busy || installingNow}
                        onClick={() => setVersionTool(tool)}
                      >
                        指定版本 <ChevronRight size={14} />
                      </Button>
                    </div>
                  )}
                  {running && (
                    <div className="tool-install-progress" role="status">
                      <div className="tool-progress-line" />
                      <p>
                        {running.progress?.stage ||
                          (running.state === "queued"
                            ? "已加入更新队列"
                            : "正在准备安装")}
                      </p>
                    </div>
                  )}
                  {failed(latest) && !running && (
                    <div className="tool-update-failure">
                      <strong>上次更新未完成</strong>
                      <p>{latest.error || "更新失败，当前版本已保留。"}</p>
                      {!tool.localMode && (
                        <Button
                          disabled={busy || installingNow}
                          onClick={() =>
                            run(() => install(tool, latest.input.version))
                          }
                        >
                          重试更新
                        </Button>
                      )}
                    </div>
                  )}
                  {!!tool.updates?.length && (
                    <details className="tool-update-history">
                      <summary>
                        <History size={14} />
                        更新记录 <span>{tool.updates.length}</span>
                      </summary>
                      <ol>
                        {tool.updates.map((task) => (
                          <li key={task.id}>
                            <div>
                              <code>{task.input?.version || "—"}</code>
                              <span>{date(task.created)}</span>
                            </div>
                            <span
                              className={
                                failed(task) ? "tool-history-error" : ""
                              }
                            >
                              {states[task.state] || task.state}
                            </span>
                            <Button
                              onClick={() =>
                                setDetails({ tool: tool.tool, task })
                              }
                              aria-label={
                                "查看 " +
                                names[tool.tool] +
                                " " +
                                task.input?.version +
                                " 更新详情"
                              }
                            >
                              详情
                            </Button>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          <div className="tool-update-policy">
            <Check size={16} />
            <div>
              <strong>更新完成，继续创作</strong>
              <p>
                新版本验证成功后对后续任务生效；更新失败保留当前版本。更新在后台执行，离开设置页也会继续。
              </p>
            </div>
          </div>
        </>
      )}
      {versionTool && (
        <VersionDialog
          tool={versionTool}
          busy={busy || installingNow}
          onInstall={install}
          onClose={() => setVersionTool(null)}
        />
      )}
      {details && (
        <UpdateDetails {...details} onClose={() => setDetails(null)} />
      )}
    </section>
  );
}

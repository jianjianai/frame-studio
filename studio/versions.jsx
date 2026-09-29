import { useEffect, useRef, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import {
  api,
  request,
  useQuery,
  useAction,
  Button,
  ErrorNote,
  Loading,
  states,
  active,
  cancellable,
} from "./ui";
import { reviewTime } from "./review-text";

export function VersionReview({
  work,
  version,
  currentPreview,
  position,
  onPause,
  notify,
}) {
  const comparison = useQuery(
    version.kind === "git" ? "works_version_compare" : null,
    { id: work.id, version: version.id },
  );
  const [task, setTask] = useState(null),
    [link, setLink] = useState(null),
    [run, busy] = useAction(notify);
  const historical = useRef(null),
    current = useRef(null);
  const query = useQuery(task ? "task_get" : null, { id: task?.id }, 1);
  const row = query.data?.task || task;
  const [time, setTime] = useState(Number(position?.time || 0));
  useEffect(() => {
    onPause?.();
  }, []);
  useEffect(() => {
    if (!row || row.state !== "succeeded" || link) return;
    let cancelled = false;
    request(`/api/tasks/${row.id}/preview`, { method: "POST" })
      .then((value) => {
        if (!cancelled) setLink(value);
      })
      .catch((error) => notify(error.message, "error"));
    return () => {
      cancelled = true;
    };
  }, [row?.id, row?.state]);
  const seek = (ref, seconds) => {
    ref.current?.contentWindow?.postMessage(
      { type: "frame-player-command", command: "seek", time: seconds },
      "*",
    );
  };
  const configure = (ref) =>
    ref.current?.contentWindow?.postMessage(
      {
        type: "frame-player-command",
        command: "configure-view",
        preferences: {
          timelineVisible: false,
          quality: "draft",
          videoRatio: 68,
        },
      },
      "*",
    );
  useEffect(() => {
    const ready = (event) => {
      const ref =
        event.source === current.current?.contentWindow
          ? current
          : event.source === historical.current?.contentWindow
            ? historical
            : null;
      if (!ref) return;
      if (event.data?.type === "frame-player-ready") configure(ref);
      if (event.data?.type === "frame-preview-loading" && !event.data.message)
        seek(ref, time);
    };
    window.addEventListener("message", ready);
    return () => window.removeEventListener("message", ready);
  }, [time]);
  if (version.kind !== "git")
    return (
      <p>
        这是早期本地快照，未记录 Git
        差异。原快照仍可恢复，恢复前会自动保存当前作品。
      </p>
    );
  return (
    <section className="version-review">
      <div className="section-head">
        <div>
          <h3>预览与比较 · {version.name}</h3>
          <p>仅查看，不改变当前作品。两边可定位到同一时间分别审片。</p>
        </div>
        <Button icon={RefreshCw} onClick={comparison.refresh}>
          刷新差异
        </Button>
      </div>
      <ErrorNote error={comparison.error || query.error} />
      {!task && (
        <Button
          icon={Play}
          disabled={busy}
          onClick={() =>
            run(async () =>
              setTask(
                await api("works_version_preview", {
                  id: work.id,
                  version: version.id,
                }),
              ),
            )
          }
        >
          生成所选版本预览
        </Button>
      )}
      {row && !link && (
        <div className="version-progress" role="status">
          <span>{states[row.state] || "正在准备"}</span>
          {active(row) && <progress aria-label="历史预览构建进度" />}
          <ErrorNote error={row.error} />
          {cancellable(row) ? (
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("task_cancel", { id: row.id });
                  query.refresh();
                })
              }
            >
              停止历史预览构建
            </Button>
          ) : (
            !active(row) &&
            row.state !== "publish_failed" &&
            row.state !== "succeeded" && (
              <Button
                onClick={() => {
                  setTask(null);
                  setLink(null);
                }}
              >
                重新准备
              </Button>
            )
          )}
          {row.state === "publish_failed" && (
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api("task_retry_publish", { id: row.id });
                  query.refresh();
                })
              }
            >
              重试保存预览
            </Button>
          )}
          {row.state === "succeeded" && (
            <Button
              onClick={() =>
                run(async () => {
                  setLink(
                    await request(`/api/tasks/${row.id}/preview`, {
                      method: "POST",
                    }),
                  );
                })
              }
            >
              重新获取预览链接
            </Button>
          )}
        </div>
      )}
      {link && (
        <>
          <div className="version-seek row">
            <label>
              比较位置（秒）{" "}
              <input
                type="number"
                aria-label="版本比较时间"
                min={0}
                max={position?.duration || 3600}
                step={0.01}
                value={time}
                onChange={(event) => setTime(Number(event.target.value))}
              />
            </label>
            <Button
              onClick={() => {
                seek(current, time);
                seek(historical, time);
              }}
            >
              两边定位到 {reviewTime(time)}
            </Button>
          </div>
          <div className="version-players">
            <section>
              <strong>当前预览</strong>
              {currentPreview ? (
                <iframe
                  ref={current}
                  title="当前版本比较播放器"
                  sandbox="allow-scripts allow-downloads"
                  allow="autoplay; fullscreen"
                  src={currentPreview}
                  onLoad={() => configure(current)}
                />
              ) : (
                <p>当前作品暂无有效预览。</p>
              )}
            </section>
            <section>
              <strong>所选历史版本 · {version.id.slice(0, 8)}</strong>
              <iframe
                ref={historical}
                title="历史版本比较播放器"
                sandbox="allow-scripts allow-downloads"
                allow="autoplay; fullscreen"
                src={link.url}
                onLoad={() => configure(historical)}
              />
            </section>
          </div>
          <p className="quiet">
            左侧为最近成功构建的预览；文件差异包含当前未提交内容。未构建的修改不会出现在左侧画面。
          </p>
        </>
      )}
      {comparison.loading && !comparison.data ? (
        <Loading />
      ) : (
        comparison.data && (
          <details className="version-changes" open>
            <summary>
              {comparison.data.total
                ? `${comparison.data.total} 个文件有变化`
                : "与当前作品文件一致"}
            </summary>
            <p>{comparison.data.note}</p>
            <ul>
              {comparison.data.changes.map((change, i) => (
                <li key={i}>
                  <span className="badge">
                    {{
                      A: "当前新增",
                      D: "当前删除",
                      M: "内容变化",
                      T: "类型变化",
                    }[change.status] || change.status}
                  </span>
                  <code>{change.path}</code>
                </li>
              ))}
            </ul>
            {comparison.data.truncated && <p>仅展示前 500 个文件。</p>}
          </details>
        )
      )}
    </section>
  );
}

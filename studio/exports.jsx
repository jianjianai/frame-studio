import { useState } from "react";
import {
  Download,
  ExternalLink,
  Trash2,
  Square,
  Image,
  FileText,
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
  Empty,
  bytes,
  date,
} from "./ui";
import { reviewTime } from "./review-text";

export const exportState = (task) =>
  task.cleaned
    ? "已清理"
    : {
        queued: "等待导出",
        running: "正在导出",
        cancelling: "正在停止",
        cancelled: "已停止",
        failed: "导出失败",
        succeeded: "导出完成",
        publishing: "正在保存文件",
        publish_failed: "文件保存需处理",
      }[task.state] || "状态未知，请刷新";
const isRunning = (state) =>
  ["queued", "running", "cancelling", "publishing"].includes(state);
function Progress({ value, label }) {
  const total = Number(value?.total),
    completed = Number(value?.completed);
  const measured = total > 0 && Number.isFinite(completed);
  return (
    <div className="export-progress">
      <progress
        aria-label={label}
        max={measured ? total : undefined}
        value={measured ? Math.max(0, Math.min(completed, total)) : undefined}
      />
      <small>
        {value?.stage ||
          {
            preparing: "准备编码",
            rendering: "逐帧渲染",
            finalizing: "封装文件",
          }[value?.phase] ||
          "等待服务器进度"}
        {measured
          ? ` · ${Math.round((completed / total) * 100)}% (${completed}/${total})`
          : ""}
      </small>
    </div>
  );
}
export function Exports({
  work,
  notify,
  position = {},
  previewReady,
  browserJob,
  onBrowserExport,
  onBrowserCancel,
  onBrowserDownload,
  onSnapshot,
  onSubtitles,
}) {
  const query = useQuery("works_exports", { id: work.id }, 1),
    [run, busy] = useAction(notify);
  const [release, setRelease] = useState(null),
    [remove, setRemove] = useState(null);
  const [format, setFormat] = useState("mp4"),
    [width, setWidth] = useState(1920),
    [fps, setFps] = useState(position.fps || 30);
  const [range, setRange] = useState("whole"),
    [start, setStart] = useState(position.selection?.start || 0),
    [end, setEnd] = useState(position.selection?.end || position.duration || 1),
    [subtitles, setSubtitles] = useState(true);
  const browserBusy = isRunning(browserJob?.state),
    rangeValid =
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start &&
      end <= (position.duration || 3600);
  const settings = {
    width,
    fps,
    subtitles,
    ...(range === "custom" ? { start, end } : {}),
  };
  return (
    <>
      <p>
        统一选择画面参数，再选择导出位置。导出使用作品原始音轨设置；预览中的临时调音不会影响成片。
      </p>
      <Form
        protect={false}
        busy={busy}
        disabled={
          (range === "custom" && !rangeValid) ||
          (format === "webm" && (!previewReady || browserBusy))
        }
        submit={format === "mp4" ? "开始后台导出 MP4" : "开始本机导出 WebM"}
        onSubmit={() =>
          run(async () => {
            if (range === "custom" && !rangeValid)
              throw new Error("请设置有效的导出起止时间");
            if (format === "webm") onBrowserExport(settings);
            else {
              await api("works_task", {
                id: work.id,
                kind: "render",
                input: settings,
              });
              query.refresh();
              notify("导出已加入后台队列，可关闭本标签页");
            }
          })
        }
      >
        <div className="export-settings-grid">
          <Field label="格式与执行位置">
            <select
              aria-label="导出格式与位置"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="mp4">MP4 · 后台服务器</option>
              <option value="webm">WebM · 本机浏览器</option>
            </select>
          </Field>
          <Field label="分辨率">
            <select
              aria-label="导出分辨率"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            >
              {[640, 1280, 1920, 3840].map((n) => (
                <option key={n} value={n}>
                  {n} × {(n * 9) / 16}
                </option>
              ))}
            </select>
          </Field>
          <Field label="帧率">
            <select
              aria-label="导出帧率"
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
            >
              {[...new Set([12, 24, 25, 30, 60, position.fps || 30])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option value={n} key={n}>
                    {n} fps{n === position.fps ? " · 作品帧率" : ""}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="导出范围">
            <select
              aria-label="导出范围"
              value={range}
              onChange={(e) => setRange(e.target.value)}
            >
              <option value="whole">
                全片
                {position.duration ? " · " + reviewTime(position.duration) : ""}
              </option>
              <option value="custom">指定选段</option>
            </select>
          </Field>
        </div>
        {range === "custom" && (
          <div className="row export-range">
            <Field label="起点（秒）">
              <input
                aria-label="导出起点"
                type="number"
                min={0}
                max={position.duration || 3600}
                step={0.001}
                value={start}
                onChange={(e) => setStart(Number(e.target.value))}
                required
              />
            </Field>
            <Field label="终点（秒）">
              <input
                aria-label="导出终点"
                type="number"
                min={0}
                max={position.duration || 3600}
                step={0.001}
                value={end}
                onChange={(e) => setEnd(Number(e.target.value))}
                required
              />
            </Field>
            <Button
              type="button"
              disabled={!(position.selection?.end > position.selection?.start)}
              onClick={() => {
                setStart(position.selection.start);
                setEnd(position.selection.end);
              }}
            >
              采用时间轴选段
            </Button>
            {!rangeValid && (
              <ErrorNote error="终点应大于起点，且不能超过影片时长。" />
            )}
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={subtitles}
            onChange={(e) => setSubtitles(e.target.checked)}
          />
          将中文字幕绘入视频
        </label>
        <p className="export-explanation">
          {format === "mp4"
            ? "后台导出按任务执行时的作品源码生成，关闭浏览器仍会继续；保留期限见下方文件记录。"
            : "本机导出使用当前已加载预览的作品版本。可以关闭此弹窗，但请勿关闭或刷新作品标签页。大文件建议后台导出。"}
        </p>
        {format === "webm" && !previewReady && (
          <p role="status">请等待播放器加载完成后再使用本机导出。</p>
        )}
      </Form>
      <div className="row secondary-downloads">
        <Button
          icon={Image}
          disabled={!previewReady || browserBusy}
          onClick={onSnapshot}
        >
          下载当前帧 PNG
        </Button>
        <Button icon={FileText} disabled={!previewReady} onClick={onSubtitles}>
          下载字幕 SRT
        </Button>
      </div>
      {browserJob && (
        <section className="export-item local-export" aria-label="本机导出状态">
          <div className="section-head">
            <strong>本机 WebM</strong>
            <span>
              {browserJob.state === "succeeded"
                ? "已生成并请求下载"
                : exportState(browserJob)}
            </span>
          </div>
          {browserBusy && (
            <Progress value={browserJob.progress} label="本机导出进度" />
          )}
          <ErrorNote error={browserJob.error} />
          {browserBusy && (
            <Button icon={Square} onClick={onBrowserCancel}>
              停止本机导出
            </Button>
          )}
          {browserJob.state === "succeeded" && (
            <>
              <p>
                {browserJob.filename} · {bytes(browserJob.bytes)}
                。本机文件不受服务器到期清理影响。
              </p>
              <Button icon={Download} onClick={onBrowserDownload}>
                再次下载 WebM
              </Button>
            </>
          )}
        </section>
      )}
      <h3 className="export-history-heading">后台导出记录</h3>
      <ErrorNote error={query.error} />
      {query.error && <Button onClick={query.refresh}>刷新导出状态</Button>}
      {query.loading && !query.data ? (
        <Loading />
      ) : !query.error && !query.data?.length ? (
        <Empty>尚无后台导出记录。</Empty>
      ) : (
        query.data?.map((task) => (
          <section className="export-item" key={task.id}>
            <div className="section-head">
              <strong>{date(task.created)}</strong>
              <span className={"badge " + task.state}>{exportState(task)}</span>
            </div>
            <p className="quiet">
              {task.input?.width ? task.input.width + "px" : "作品默认尺寸"} ·{" "}
              {task.input?.fps ? task.input.fps + " fps" : "作品帧率"}
              {task.input?.end
                ? " · " +
                  reviewTime(task.input.start) +
                  "—" +
                  reviewTime(task.input.end)
                : " · 全片"}
            </p>
            {!task.cleaned && isRunning(task.state) && (
              <Progress value={task.progress} label="后台导出进度" />
            )}
            <ErrorNote error={task.error} />
            {!["succeeded", "failed", "cancelled"].includes(task.state) &&
              !task.cleaned && (
                <Button
                  icon={Square}
                  disabled={busy || task.state === "cancelling"}
                  onClick={() =>
                    run(async () => {
                      await api("task_cancel", { id: task.id });
                      query.refresh();
                    })
                  }
                >
                  {task.state === "cancelling" ? "正在停止…" : "停止导出"}
                </Button>
              )}
            {!task.cleaned &&
              task.result?.artifacts
                ?.filter((a) => /\.(mp4|webm)$/i.test(a.path))
                .map((artifact) => (
                  <div className="settings-row" key={artifact.path}>
                    <div>
                      <strong>{artifact.name}</strong>
                      <p>
                        {bytes(artifact.bytes)} ·{" "}
                        {task.expires
                          ? date(task.expires) + " 后可能清理"
                          : "保留期限待确认"}
                      </p>
                    </div>
                    <div className="row">
                      <a
                        className="button"
                        href={`/api/tasks/${task.id}/file/${artifact.path}`}
                        download
                      >
                        下载
                      </a>
                      <Button
                        icon={ExternalLink}
                        disabled={!work.repository?.url}
                        title={
                          !work.repository?.url
                            ? "当前为本地仓库，连接 GitHub 后可发布"
                            : "发布到当前作品仓库"
                        }
                        onClick={() =>
                          setRelease({ task: task.id, artifact: artifact.path })
                        }
                      >
                        发布视频
                      </Button>
                    </div>
                  </div>
                ))}
            {task.result?.releases?.map((release) => (
              <a
                key={release.url}
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看 Release · {release.tag}
              </a>
            ))}
            {!task.cleaned &&
              ["succeeded", "failed", "cancelled"].includes(task.state) && (
                <Button
                  icon={Trash2}
                  disabled={busy}
                  onClick={() => setRemove(task)}
                >
                  清理临时文件
                </Button>
              )}
          </section>
        ))
      )}
      {remove && (
        <Modal title="清理导出文件" onClose={() => setRemove(null)}>
          <p>
            删除服务器上的这次导出文件。已下载的本机文件、作品源码和版本不受影响；重新获得文件需要再次导出。
          </p>
          <Form
            protect={false}
            busy={busy}
            submit="确认清理"
            onSubmit={() =>
              run(async () => {
                const result = await api("exports_delete", { id: remove.id });
                if (!result.removed)
                  throw new Error("文件正在使用，请稍后再试");
                setRemove(null);
                query.refresh();
                notify("导出临时文件已清理");
              })
            }
          />
        </Modal>
      )}
      {release && (
        <Modal title="发布到 GitHub Releases" onClose={() => setRelease(null)}>
          <p>
            视频将发布到 {work.repository?.name}。请确认仓库可见性与视频内容。
          </p>
          <Form
            busy={busy}
            submit="发布视频"
            onSubmit={(a) =>
              run(async () => {
                const result = await api("exports_release", {
                  ...release,
                  ...a,
                });
                setRelease(null);
                query.refresh();
                notify("发布完成：" + result.url);
              })
            }
          >
            <Field label="发布标签">
              <input
                name="tag"
                required
                defaultValue={"film-" + new Date().toISOString().slice(0, 10)}
              />
            </Field>
            <Field label="标题">
              <input name="title" required defaultValue={work.title} />
            </Field>
            <Field label="说明">
              <textarea name="notes" rows={3} />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}

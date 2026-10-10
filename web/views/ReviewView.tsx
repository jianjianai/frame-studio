import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FilePlus,
  FileSpreadsheet,
  FileText,
  File as FileIcon,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
  BarChart3,
} from "lucide-react";
import { api, del, formatBytes, formatTime, useServerEvent } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePersistent, usePrompt, useToast } from "../lib/ui";
import { useObservable, useWorkbench } from "../workbench/store";
import { navigate } from "../App";
import {
  ageLabel,
  ageShort,
  definitionOf,
  formatDateTime,
  formatMetric,
  formatPercent,
  postSlot,
  retentionAt,
  reviewsPath,
  seriesColor,
  type Post,
  type ReviewDetail,
  type Snapshot,
  type Stretch,
} from "../lib/reviews";
import { ChartLegend, LineChart } from "../reviews/LineChart";
import { PostDialog, SnapshotDialog } from "../reviews/ReviewDialogs";
import { VersionsPanel } from "./VersionsView";
import { ViewHeader } from "./ViewHeader";
import "../reviews/reviews.css";

const REVIEW_PROMPT =
  "请复盘这个作品发布后的表现：先用 review_read 看现有的数据，把还没录入的原始文件读出来录入（看不清或拿不准的先问我）；用 reviews_compare 和同类作品在同一发布天数比较；观众留存流失明显的地方用 preview_frames 看那几秒的画面，找出原因；把结论写进复盘文档 复盘.md（先写结论，再写做得好的、问题和原因、下次怎么做）。最后列出值得写进经验库的经验，问我要不要写入。";
const ENTER_PROMPT = (file: string) =>
  `请读取复盘原始文件 ${file}，把里面的数据用 review_write 录入（source 写这个文件；发布记录还没有的先问我发到了哪个平台、什么时候发的）。看不清或拿不准的数字先问我，不要猜。`;

/** Tiles of the newest numbers, in this order when present; a rate goes under its count. */
const TILES: [string, string?][] = [
  ["views", "clickRate"],
  ["likes", "likeRate"],
  ["completionRate"],
  ["avgWatchTime", "watchRatio"],
  ["retention3s"],
  ["comments", "commentRate"],
  ["shares", "shareRate"],
  ["favorites", "favoriteRate"],
  ["followers", "followRate"],
  ["impressions"],
];

/**
 * The work's review: where it was posted, its numbers over time, where viewers leave
 * (the retention curve follows the work's timeline: click it to see that moment), the
 * original files from the platforms and the review documents. Every change is saved as
 * a version at once; a published work takes them too.
 */
export function ReviewView() {
  const { work, stage, openReview, askAi } = useWorkbench();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [metric, setMetric] = usePersistent("review-metric", "views");
  const [dialog, setDialog] = useState<null | { kind: "post"; post?: Post } | { kind: "snapshot"; post: Post; snapshot?: Snapshot }>(null);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = reviewsPath(work.repo);
  const workBase = `${base}/works/${encodeURIComponent(work.id)}`;
  const load = () => api<ReviewDetail>(workBase).then(setDetail, (error: Error) => toast(error.message, "error"));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workBase]);
  useServerEvent(
    (event) => {
      if (event.type === "reviews" && event.repo === work.repo && (!event.work || event.work === work.id)) void load();
      if (event.type === "work-versions" && event.work === `reviews-${work.repo}`) void load();
    },
    [work.repo, work.id],
  );

  const review = detail?.review;
  const definitions = detail?.definitions ?? null;
  const posts = review?.posts ?? [];
  const post = posts.find((item) => item.id === selected) ?? posts[posts.length - 1] ?? null;
  const duration = post?.duration ?? work.meta?.duration ?? 0;
  const latestRetention = useMemo(() => {
    const list = (review?.snapshots ?? []).filter((snapshot) => snapshot.post === post?.id && snapshot.retention?.length);
    return list.length ? list[list.length - 1].retention! : null;
  }, [review, post?.id]);
  const analysis = post ? detail?.analyses[post.id] : undefined;
  const numbers = post ? detail?.summary[post.id] : undefined;

  const apply = async (operations: Record<string, unknown>[], success?: string) => {
    const result = await run(async () => {
      const next = await api<ReviewDetail & { results: { status: string; message?: string }[] }>(workBase, { body: { operations } });
      setDetail(next);
      const failed = next.results.filter((item) => item.status !== "ok");
      if (failed.length) throw new Error(failed.map((item) => item.message).join("；"));
      return next;
    }, success);
    return Boolean(result);
  };
  const upload = (files: File[]) =>
    run(
      async () => {
        for (const file of files)
          await api(`${workBase}/upload?name=${encodeURIComponent(file.name)}`, { raw: file, contentType: file.type || "application/octet-stream" });
        await load();
      },
      files.length > 1 ? `已上传 ${files.length} 个文件` : "已上传",
    );
  const pickFiles = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".xlsx,.xlsm,.xls,.csv,.tsv,.pdf,image/*";
    input.onchange = () => void upload([...(input.files ?? [])]);
    input.click();
  };
  const newDocument = () =>
    run(async () => {
      const taken = new Set(documents.map((doc) => doc.path));
      const suggested = taken.has("复盘.md") ? `复盘-${new Date().toISOString().slice(0, 10)}.md` : "复盘.md";
      const name = (await prompt("新复盘文档", suggested))?.trim();
      if (!name) return;
      const file = /\.(md|txt)$/i.test(name) ? name : `${name}.md`;
      const title = `${work.meta?.title ?? ""} ${file
        .replace(/\.(md|txt)$/i, "")
        .split("/")
        .pop()}`.trim();
      await api(`${base}/file`, { method: "PUT", body: { path: `${work.id}/${file}`, content: `# ${title}\n\n`, expectedHash: null } });
      await load();
      openReview(`${work.id}/${file}`);
    });
  const removeFile = (path: string) =>
    run(async () => {
      if (!(await confirm(`删除 ${path}？删除也会保存为一个版本，可以在「版本」里恢复。`, { confirm: "删除", danger: true }))) return;
      await del(`${workBase}/file?path=${encodeURIComponent(path)}`);
      await load();
    });
  const removePost = (item: Post) =>
    run(async () => {
      if (!(await confirm(`删除 ${item.platform} 的发布记录和它的所有数据？可以在「版本」里恢复。`, { confirm: "删除", danger: true }))) return;
      await apply([{ op: "remove_post", id: item.id }]);
    });
  const removeSnapshot = (item: Snapshot) =>
    run(async () => {
      if (!(await confirm("删除这次的数据？可以在「版本」里恢复。", { confirm: "删除", danger: true }))) return;
      await apply([{ op: "remove_snapshot", post: item.post, at: item.at }]);
    });

  // Every post's numbers over the days after posting, for the chosen metric.
  const metricKeys = useMemo(() => {
    const present = new Set(Object.values(detail?.history ?? {}).flatMap((list) => list.flatMap((entry) => Object.keys(entry.metrics))));
    const known = definitions ? [...definitions.metrics, ...definitions.derived].map((item) => item.key) : [];
    return [...known.filter((key) => present.has(key)), ...[...present].filter((key) => !known.includes(key))];
  }, [detail?.history, definitions]);
  const shownMetric = metricKeys.includes(metric) ? metric : (metricKeys[0] ?? "views");
  const growth = posts
    .map((item) => ({
      id: item.id,
      label: `${item.platform}${posts.filter((other) => other.platform === item.platform).length > 1 ? ` ${item.id}` : ""}`,
      color: seriesColor(postSlot(item)),
      dots: true,
      points: (detail?.history[item.id] ?? [])
        .filter((entry) => Number.isFinite(entry.metrics[shownMetric]))
        .map((entry) => [entry.age, entry.metrics[shownMetric]] as [number, number]),
    }))
    .filter((item) => item.points.length);
  const maxAge = Math.max(1, ...growth.flatMap((item) => item.points.map(([age]) => age)));

  const files = detail?.files ?? [];
  const documents = detail?.documents ?? [];
  const snapshots = (review?.snapshots ?? []).filter((snapshot) => snapshot.post === post?.id);
  const fileIcon = (kind: string) => (kind === "table" ? <FileSpreadsheet size={14} /> : kind === "image" ? <ImageIcon size={14} /> : <FileIcon size={14} />);

  return (
    <div
      className={`view ${dragging ? "drop-active" : ""}`}
      onDragOver={(event) => [...event.dataTransfer.types].includes("Files") && (event.preventDefault(), setDragging(true))}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length) void upload([...event.dataTransfer.files]);
      }}
    >
      <ViewHeader title="复盘">
        <button className="icon-btn" title="记录一次发布" onClick={() => setDialog({ kind: "post" })} disabled={!detail}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" title="上传原始文件（平台后台导出的表格、截图）" onClick={pickFiles}>
          <Upload size={15} />
        </button>
        <button className="icon-btn" title="和其他作品对比" onClick={() => navigate(`/reviews?focus=${encodeURIComponent(`${work.repo}/${work.id}`)}`)}>
          <BarChart3 size={15} />
        </button>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      {busy && <div className="view-progress" />}
      {!detail ? (
        <div className="empty">正在读取…</div>
      ) : !posts.length ? (
        <div className="review-empty">
          <span>
            作品发到平台以后，在这里记下发布平台和时间，再录入数据：上传平台后台导出的表格或截图，可以让 AI
            读出来录入，也可以手动填写。之后可以和其他作品在同一发布天数比较。
          </span>
          <button className="btn primary" onClick={() => setDialog({ kind: "post" })}>
            <Plus size={14} /> 记录一次发布
          </button>
          <button className="btn" onClick={pickFiles}>
            <Upload size={14} /> 上传原始文件
          </button>
        </div>
      ) : (
        <section className="view-section">
          <div className="review-posts" role="tablist" aria-label="发布记录">
            {posts.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={item.id === post?.id}
                className={`review-post-chip ${item.id === post?.id ? "active" : ""}`}
                title={`${item.platform} · ${formatDateTime(item.postedAt)}`}
                onClick={() => setSelected(item.id)}
              >
                <span className="chart-key" style={{ background: seriesColor(postSlot(item)) }} />
                {item.platform}
                <span className="faint">{formatDateTime(item.postedAt).slice(5, 10)}</span>
              </button>
            ))}
          </div>
          {post && (
            <>
              <div className="review-post-head">
                <div className="grow">
                  {post.url ? (
                    <a href={post.url} target="_blank" rel="noreferrer" title={post.url}>
                      {post.title ?? work.meta?.title} <ExternalLink size={11} />
                    </a>
                  ) : (
                    <strong>{post.title ?? work.meta?.title}</strong>
                  )}
                  <div className="faint small-text">
                    {post.account ? `${post.account} · ` : ""}
                    {formatDateTime(post.postedAt)} 发布 · 已发布 {ageLabel((Date.now() - Date.parse(post.postedAt)) / 86400000).replace("发布后 ", "")}
                  </div>
                  {(post.export || post.notes) && (
                    <div className="faint small-text ellipsis" title={[post.export, post.notes].filter(Boolean).join("\n")}>
                      {[post.export && `视频：${post.export}`, post.notes].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <button
                  className="icon-btn"
                  aria-label="发布记录操作"
                  onClick={(event) =>
                    openMenu(event, [
                      { label: "修改发布记录", icon: <Pencil size={14} />, onClick: () => setDialog({ kind: "post", post }) },
                      "separator",
                      { label: "删除发布记录", icon: <Trash2 size={14} />, danger: true, onClick: () => removePost(post) },
                    ])
                  }
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
              {numbers ? (
                <>
                  <div className="review-stats">
                    {[
                      ...TILES.filter(([key]) => Number.isFinite(numbers.metrics[key])),
                      ...Object.keys(numbers.metrics)
                        .filter((key) => !definitions || ![...definitions.metrics, ...definitions.derived].some((item) => item.key === key))
                        .map((key): [string, string?] => [key]),
                    ].map(([key, rate]) => {
                      // A number the newest record lacks comes from an earlier one: say which day.
                      const older = Math.abs((numbers.ages[key] ?? numbers.age) - numbers.age) > 0.01 ? ageShort(numbers.ages[key]) : "";
                      const note = [
                        rate &&
                          Number.isFinite(numbers.metrics[rate]) &&
                          `${definitionOf(definitions, rate).label} ${formatMetric(definitions, rate, numbers.metrics[rate])}`,
                        older,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <div key={key} className="review-stat">
                          <div className="review-stat-label ellipsis">{definitionOf(definitions, key).label}</div>
                          <div className="review-stat-value">{formatMetric(definitions, key, numbers.metrics[key], true)}</div>
                          {note && <div className="review-stat-note">{note}</div>}
                        </div>
                      );
                    })}
                  </div>
                  <div className="faint small-text">{ageLabel(numbers.age)}的数据</div>
                </>
              ) : (
                <p className="view-hint">还没有这次发布的数据。</p>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn small grow" onClick={() => setDialog({ kind: "snapshot", post })}>
                  <Plus size={13} /> 录入数据
                </button>
                <button className="btn small grow" title="AI 读原始文件、对比同类作品、看流失处的画面，写复盘文档" onClick={() => askAi(REVIEW_PROMPT)}>
                  <Sparkles size={13} /> 让 AI 复盘
                </button>
              </div>

              {growth.length > 0 && (
                <>
                  <div className="review-chart-head">
                    增长
                    <select className="select" value={shownMetric} onChange={(event) => setMetric(event.target.value)} aria-label="指标">
                      {metricKeys.map((key) => (
                        <option key={key} value={key}>
                          {definitionOf(definitions, key).label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <LineChart
                    label={`各平台${definitionOf(definitions, shownMetric).label}随发布天数的变化`}
                    height={140}
                    series={growth}
                    x={{ domain: [0, Math.ceil(maxAge)], format: (value) => `${+value.toFixed(1)} 天` }}
                    y={{ format: (value) => formatMetric(definitions, shownMetric, value, true) }}
                  />
                  <ChartLegend series={growth} />
                </>
              )}

              {latestRetention && duration > 0 && (
                <RetentionPanel
                  points={latestRetention}
                  duration={duration}
                  stage={stage}
                  beats={work.meta?.beats ?? []}
                  drops={analysis?.drops ?? []}
                  rises={analysis?.rises ?? []}
                  opening={analysis?.opening}
                  color={seriesColor(postSlot(post))}
                />
              )}

              {snapshots.length > 0 && (
                <>
                  <h3 className="review-chart-head clickable" onClick={() => setShowSnapshots(!showSnapshots)}>
                    {showSnapshots ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 数据记录 <span className="badge">{snapshots.length}</span>
                  </h3>
                  {showSnapshots &&
                    snapshots.map((snapshot) => (
                      <div
                        key={snapshot.at}
                        className="review-row"
                        title={`${formatDateTime(snapshot.at)}${snapshot.source ? `\n来源：${snapshot.source}` : ""}`}
                        onClick={() => setDialog({ kind: "snapshot", post, snapshot })}
                      >
                        <span className="grow ellipsis">
                          {ageLabel((Date.parse(snapshot.at) - Date.parse(post.postedAt)) / 86400000)}
                          <span className="faint">
                            {" · "}
                            {Number.isFinite(snapshot.metrics.views)
                              ? `播放 ${formatMetric(definitions, "views", snapshot.metrics.views, true)}`
                              : `${Object.keys(snapshot.metrics).length} 项`}
                            {snapshot.retention?.length ? " · 留存" : ""}
                            {snapshot.source && snapshot.source !== "手动录入" ? ` · ${snapshot.source.replace(/^raw\//, "")}` : ""}
                          </span>
                        </span>
                        <button
                          className="icon-btn tiny"
                          title="删除这次的数据"
                          onClick={(event) => {
                            event.stopPropagation();
                            void removeSnapshot(snapshot);
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                </>
              )}
            </>
          )}
        </section>
      )}

      {detail && (
        <section className="view-section">
          <h3>
            原始文件 <span className="badge">{files.length}</span>
            <span className="grow" />
            <button className="icon-btn tiny" title="上传原始文件" onClick={pickFiles}>
              <Upload size={13} />
            </button>
          </h3>
          {!files.length && <p className="view-hint">平台后台导出的表格（xlsx、csv）或截图，拖到这里上传。原样保存，AI 可以读出数字录入。</p>}
          {files.map((file) => (
            <div
              key={file.path}
              className="review-row"
              title={`${file.path}（${formatBytes(file.size)}）`}
              onClick={() => openReview(`${work.id}/${file.path}`, { preview: true })}
              onDoubleClick={() => openReview(`${work.id}/${file.path}`)}
              onContextMenu={(event) =>
                openMenu(event, [
                  { label: "打开", icon: <FileText size={14} />, onClick: () => openReview(`${work.id}/${file.path}`) },
                  { label: "让 AI 录入这个文件", icon: <Sparkles size={14} />, onClick: () => askAi(ENTER_PROMPT(file.path)) },
                  {
                    label: "下载",
                    icon: <Download size={14} />,
                    onClick: () => window.open(`${workBase}/raw?path=${encodeURIComponent(file.path)}`, "_blank"),
                  },
                  "separator",
                  { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => removeFile(file.path) },
                ])
              }
            >
              {fileIcon(file.kind)}
              <span className="grow ellipsis">{file.path.replace(/^raw\//, "")}</span>
              {file.used ? <span className="badge ok">已录入</span> : <span className="badge">未录入</span>}
              {!file.used && (
                <button
                  className="icon-btn tiny"
                  title="让 AI 录入这个文件"
                  onClick={(event) => {
                    event.stopPropagation();
                    askAi(ENTER_PROMPT(file.path));
                  }}
                >
                  <Sparkles size={12} />
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {detail && (
        <section className="view-section">
          <h3>
            复盘文档 <span className="badge">{documents.length}</span>
            <span className="grow" />
            <button className="icon-btn tiny" title="新建复盘文档" onClick={newDocument}>
              <FilePlus size={13} />
            </button>
          </h3>
          {!documents.length && <p className="view-hint">复盘的结论写在这里。可以让 AI 复盘后写入，也可以自己新建。</p>}
          {documents.map((doc) => (
            <div
              key={doc.path}
              className="review-row"
              title={doc.path}
              onClick={() => openReview(`${work.id}/${doc.path}`, { preview: true })}
              onDoubleClick={() => openReview(`${work.id}/${doc.path}`)}
              onContextMenu={(event) =>
                openMenu(event, [
                  { label: "打开", icon: <FileText size={14} />, onClick: () => openReview(`${work.id}/${doc.path}`) },
                  "separator",
                  { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => removeFile(doc.path) },
                ])
              }
            >
              <FileText size={14} />
              <span className="grow ellipsis">{doc.title || doc.path}</span>
              {doc.title && <span className="faint small-text">{doc.path}</span>}
            </div>
          ))}
        </section>
      )}

      {detail && (
        <section className="view-section">
          <h3 className="clickable" onClick={() => setShowVersions(!showVersions)}>
            {showVersions ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 版本
            <span className="faint small-text">（每次修改自动保存）</span>
          </h3>
        </section>
      )}
      {showVersions && <VersionsPanel source="reviews" />}

      {dialog?.kind === "post" && definitions && (
        <PostDialog
          work={work}
          post={dialog.post}
          definitions={definitions}
          onSave={(operation) => apply([operation], dialog.post ? "已保存" : "已记录")}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "snapshot" && definitions && (
        <SnapshotDialog
          post={dialog.post}
          snapshot={dialog.snapshot}
          files={files}
          definitions={definitions}
          onSave={(operations) => apply(operations, "已保存")}
          onClose={() => setDialog(null)}
        />
      )}
      {menu}
    </div>
  );
}

/**
 * The retention curve on the work's own time: shots as hairlines, the stretches where
 * viewers leave shaded, the playhead on it; a click (or drag) moves the preview there.
 */
function RetentionPanel({
  points,
  duration,
  stage,
  beats,
  drops,
  rises,
  opening,
  color,
}: {
  points: [number, number][];
  duration: number;
  stage: ReturnType<typeof useWorkbench>["stage"];
  beats: { at: number; title: string }[];
  drops: Stretch[];
  rises: Stretch[];
  opening?: { seconds: number; kept: number; lost: number };
  color: string;
}) {
  const playback = useObservable(stage.playback);
  const shotAt = (time: number) =>
    [...beats]
      .sort((a, b) => a.at - b.at)
      .filter((beat) => beat.at <= time + 1e-6)
      .pop();
  const seek = (time: number) => {
    stage.pause();
    void stage.seek(time);
  };
  const stretch = (item: Stretch, kind: "drop" | "rise") => (
    <button key={`${kind}-${item.start}`} className={`review-stretch ${kind}`} onClick={() => seek(item.start)} title="在预览中查看这一段">
      {kind === "drop" ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
      <span className="grow">
        {formatTime(item.start, false)}–{formatTime(item.end, false)} {kind === "drop" ? "流失" : "回升"} {formatPercent(Math.abs(item.to - item.from))}
        {item.shot && <span className="faint"> · 镜头「{item.shot.title}」</span>}
        {item.subtitle && <span className="faint"> · “{item.subtitle}”</span>}
      </span>
    </button>
  );
  return (
    <>
      <div className="review-chart-head">
        观众留存
        <span className="faint" style={{ fontWeight: "normal" }}>
          点击曲线跳到那一刻
        </span>
      </div>
      <LineChart
        label="观众留存曲线：横轴是视频的秒数，纵轴是还在看的比例"
        height={150}
        snap="continuous"
        series={[{ id: "retention", label: "还在看", color, points, area: true }]}
        x={{ domain: [0, duration], format: (value) => formatTime(value, false) }}
        y={{ domain: [0, Math.max(1, ...points.map(([, share]) => share))], format: (value) => `${Math.round(value * 100)}%` }}
        markers={beats.map((beat) => ({ at: beat.at, label: beat.title }))}
        bands={drops.map((item) => ({ start: item.start, end: item.end }))}
        cursor={playback.time}
        onPick={seek}
        describe={(time) => {
          const shot = shotAt(time);
          return shot ? `镜头「${shot.title}」` : null;
        }}
      />
      <div className="faint small-text" style={{ margin: "4px 0" }}>
        {opening && `开头 ${opening.seconds} 秒流失 ${formatPercent(opening.lost)} · `}
        半程还剩 {formatPercent(retentionAt(points, duration / 2))} · 结尾 {formatPercent(retentionAt(points, duration))}
      </div>
      {drops.map((item) => stretch(item, "drop"))}
      {rises.map((item) => stretch(item, "rise"))}
    </>
  );
}

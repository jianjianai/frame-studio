import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  FilePlus,
  FileSpreadsheet,
  FileText,
  Flag,
  Image as ImageIcon,
  Import,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
} from "lucide-react";
import { api, del, formatBytes, formatTime, useServerEvent, type ApiError } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePersistent, usePrompt, useToast } from "../lib/ui";
import { useObservable, useWorkbench } from "../workbench/store";
import { navigate } from "../App";
import {
  BENCHMARK_COLOR,
  LOWER_IS_BETTER,
  ageLabel,
  ageShort,
  cumulative,
  definitionOf,
  formatCount,
  formatDateTime,
  formatMetric,
  formatPercent,
  isBenchmarked,
  postSlot,
  reviewsPath,
  seriesColor,
  today,
  type Definitions,
  type FlowAnalysis,
  type ImportPreview,
  type Post,
  type PostSummary,
  type RetentionAnalysis,
  type ReviewDetail,
  type Series,
  type Snapshot,
  type Stretch,
} from "../lib/reviews";
import { ChartLegend, LineChart } from "../reviews/LineChart";
import { ImportDialog, PostDialog, SnapshotDialog } from "../reviews/ReviewDialogs";
import { VersionsPanel } from "./VersionsView";
import { ViewHeader } from "./ViewHeader";
import "../reviews/reviews.css";

const REVIEW_PROMPT =
  "请复盘这个作品发布后的表现：先用 review_read 看现有的数据，有还没导入的平台导出文件就用 review_import 导入，其他原始文件读出来录入（看不清或拿不准的先问我）；用 reviews_compare 和同类作品在同一发布天数比较（同一首歌的作品加 lyrics: true）；流失率是同类几倍最高的几秒、倍数高的分段，用 preview_frames 看那几秒的画面，需要时用 review_read 的 seconds 看逐秒的数字，先对照前后两三秒再下结论。复盘文档 复盘.md 已经有的先读：在原来的基础上更新结论，这次新的发现注明是发布后第几天的数据，不要删掉之前的分析；还没有就新写（先写结论，再写做得好的、问题和原因、下次怎么做）。最后列出值得写进经验库的经验，问我要不要写入。";
const ENTER_PROMPT = (file: string) =>
  `请读取复盘原始文件 ${file}，把里面的数据录入（平台后台的导出用 review_import，其他的用 review_write，source 写这个文件；发布记录还没有的先问我发到了哪个平台、什么时候发的）。看不清或拿不准的数字先问我，不要猜。`;

/** Tiles of the newest numbers, in this order when present; a rate goes under its count. */
const TILES: [string, string?][] = [
  ["views", "fanViewShare"],
  ["likes", "likeRate"],
  ["comments", "commentRate"],
  ["shares", "shareRate"],
  ["favorites", "favoriteRate"],
  ["bounce2s"],
  ["retention5s"],
  ["retentionEnd"],
  ["avgWatchTime", "watchRatio"],
  ["completionRate"],
  ["followers", "followsPerThousand"],
  ["unfollows", "unfollowRate"],
  ["dislikes", "dislikeRate"],
  ["danmaku"],
  ["impressions", "clickRate"],
];

const labelsOf = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([kind, label]) => `${kind}「${label}」`)
    .join(" ");

/** A part of the view that folds away, remembered per kind. */
function Section({
  id,
  title,
  extra,
  children,
  open: initial = true,
}: {
  id: string;
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = usePersistent(`review-section-${id}`, initial);
  return (
    <>
      <div className="review-chart-head clickable" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="grow">{title}</span>
        {open && extra && <span onClick={(event) => event.stopPropagation()}>{extra}</span>}
      </div>
      {open && children}
    </>
  );
}

/**
 * The work's review: where it was posted and the numbers since (with similar videos' values
 * next to them), how the views came in by the hour, where viewers leave compared with similar
 * videos (on the work's own timeline: a click shows that moment in the preview), the
 * original files from the platforms (one click imports a creator center's export) and the
 * review documents. Every change is saved as a version at once; a published work takes them too.
 */
export function ReviewView() {
  const { work, stage, openReview, askAi } = useWorkbench();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    null | { kind: "post"; post?: Post } | { kind: "snapshot"; post: Post; snapshot?: Snapshot } | { kind: "import"; preview: ImportPreview; files: string[] }
  >(null);
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
  const numbers = post ? detail?.summary[post.id] : undefined;
  const analysis = post ? detail?.analyses[post.id] : undefined;
  const hourly = review?.series.find((series) => series.post === post?.id && series.key === "views" && series.step === 3600) ?? null;
  const retentionCurves = useMemo(() => {
    const list = (review?.snapshots ?? []).filter((snapshot) => snapshot.post === post?.id);
    const newest = (key: "retention" | "retentionBenchmark") => [...list].reverse().find((snapshot) => snapshot[key]?.length)?.[key] ?? null;
    return { mine: newest("retention"), theirs: newest("retentionBenchmark") };
  }, [review, post?.id]);

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
  /** Look at what a set of uploaded files would import; ask before importing it. */
  const offerImport = async (files: string[], quiet = false) => {
    try {
      const { preview } = await api<{ preview: ImportPreview }>(`${workBase}/import`, { body: { files, dryRun: true } });
      setDialog({ kind: "import", preview, files });
    } catch (error) {
      if (!quiet) toast((error as ApiError).message, "error");
    }
  };
  const upload = (files: File[]) =>
    run(
      async () => {
        // An upload's files stay together: one folder per day, like one export from the creator center.
        const folder = today();
        const saved: string[] = [];
        const known: string[] = [];
        for (const file of files) {
          const result = await api<{ path: string; duplicate?: boolean }>(`${workBase}/upload?name=${encodeURIComponent(file.name)}&folder=${folder}`, {
            raw: file,
            contentType: file.type || "application/octet-stream",
          });
          saved.push(result.path);
          if (result.duplicate) known.push(`${file.name}（和 ${result.path.replace(/^raw\//, "")} 相同）`);
        }
        if (known.length) toast(`已经有这些文件，没有重复保存：${known.join("、")}`, "info");
        await load();
        const tables = saved.filter((path) => /\.(xlsx|xlsm|csv|tsv)$/i.test(path));
        if (tables.length) await offerImport(tables, true);
        return saved;
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
  const runImport = (files: string[], options: { post?: string; postedAt?: string; at?: string }) =>
    run(async () => {
      const next = await api<ReviewDetail>(`${workBase}/import`, { body: { files, ...options } });
      setDetail(next);
      if (options.post) setSelected(options.post);
      return next;
    }, "已导入").then(Boolean);
  const documents = detail?.documents ?? [];
  const newDocument = () =>
    run(async () => {
      const taken = new Set(documents.map((doc) => doc.path));
      const suggested = taken.has("复盘.md") ? `复盘-${today()}.md` : "复盘.md";
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
  const addMoment = () =>
    run(async () => {
      const at = +stage.playback.get().time.toFixed(2);
      const label = (await prompt(`把 ${formatTime(at)} 记为关键时刻（例如 反转、兑现）`, review?.moments.length ? "" : "反转"))?.trim();
      if (label) await apply([{ op: "moment", label, at }], "已记下");
    });

  const files = detail?.files ?? [];
  const folders = useMemo(() => {
    const groups = new Map<string, typeof files>();
    for (const file of files) {
      const folder = file.path.split("/").slice(0, -1).join("/");
      groups.set(folder, [...(groups.get(folder) ?? []), file]);
    }
    return [...groups].sort((a, b) => b[0].localeCompare(a[0]));
  }, [files]);
  const snapshots = (review?.snapshots ?? []).filter((snapshot) => snapshot.post === post?.id);
  const fileIcon = (kind: string) => (kind === "table" ? <FileSpreadsheet size={14} /> : kind === "image" ? <ImageIcon size={14} /> : <FileIcon size={14} />);
  const seek = (time: number) => {
    stage.pause();
    void stage.seek(time);
  };

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
        <button className="icon-btn" title="上传平台后台导出的数据或截图（抖音创作者中心的导出会直接导入）" onClick={pickFiles}>
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
            作品发到平台以后，把创作者中心导出的数据表格拖到这里：抖音的作品数据导出会自动认出并导入（指标、逐秒留存和同类作品、每小时播放和涨粉、流量来源、评论）。也可以手动记录发布和数据。之后可以和其他作品在同一发布天数比较。
          </span>
          <button className="btn primary" onClick={pickFiles}>
            <Upload size={14} /> 上传后台数据
          </button>
          <button className="btn" onClick={() => setDialog({ kind: "post" })}>
            <Plus size={14} /> 手动记录一次发布
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
                <div className="grow" style={{ minWidth: 0 }}>
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
                  {post.pinnedComment && (
                    <div className="review-pinned small-text" title={post.pinnedComment}>
                      置顶评论：{post.pinnedComment}
                    </div>
                  )}
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
                      { label: "修改发布记录和目标", icon: <Pencil size={14} />, onClick: () => setDialog({ kind: "post", post }) },
                      { label: "手动录入数据", icon: <Plus size={14} />, onClick: () => setDialog({ kind: "snapshot", post }) },
                      "separator",
                      { label: "删除发布记录", icon: <Trash2 size={14} />, danger: true, onClick: () => removePost(post) },
                    ])
                  }
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
              {numbers ? (
                <Tiles numbers={numbers} definitions={definitions} goals={post.goals} />
              ) : (
                <p className="view-hint">还没有这次发布的数据。上传平台后台导出的表格，或手动录入。</p>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn small grow" onClick={pickFiles} title="抖音创作者中心的作品数据导出会直接导入">
                  <Upload size={13} /> 上传后台数据
                </button>
                <button className="btn small grow" title="AI 导入原始文件、对比同类作品、看流失处的画面，写复盘文档" onClick={() => askAi(REVIEW_PROMPT)}>
                  <Sparkles size={13} /> 让 AI 复盘
                </button>
              </div>

              {analysis?.flow && hourly && <FlowPanel flow={analysis.flow} views={hourly} color={seriesColor(postSlot(post))} />}
              {detail && <GrowthPanel detail={detail} post={post} definitions={definitions} />}
              {retentionCurves.mine && duration > 0 && analysis?.retention && (
                <RetentionPanel
                  mine={retentionCurves.mine}
                  theirs={retentionCurves.theirs}
                  analysis={analysis.retention}
                  duration={duration}
                  stage={stage}
                  markers={review?.moments.length ? review.moments : (work.meta?.beats ?? []).map((beat) => ({ at: beat.at, label: beat.title }))}
                  color={seriesColor(postSlot(post))}
                  seek={seek}
                />
              )}
              {analysis?.retention?.perSecond && <ChurnPanel analysis={analysis.retention} duration={duration} stage={stage} seek={seek} />}
              {analysis?.retention && Object.keys(analysis.retention.segments).length > 0 && <SegmentsPanel analysis={analysis.retention} seek={seek} />}

              <Section id="moments" title={`关键时刻${review?.moments.length ? `（${review.moments.length}）` : ""}`} open={false}>
                {review?.moments.map((moment) => {
                  const kept = analysis?.retention?.moments.find((item) => item.label === moment.label);
                  return (
                    <div key={moment.label} className="review-row" onClick={() => seek(moment.at)} title="在预览中查看">
                      <Flag size={13} />
                      <span className="grow ellipsis">
                        {moment.label} · {formatTime(moment.at, false)}
                        {kept && (
                          <span className="faint">
                            {" "}
                            · 还在 {formatPercent(kept.kept)}
                            {kept.keptBenchmark != null && `（同类 ${formatPercent(kept.keptBenchmark)}）`}
                          </span>
                        )}
                      </span>
                      <button
                        className="icon-btn tiny"
                        title="删除"
                        onClick={(event) => {
                          event.stopPropagation();
                          void apply([{ op: "remove_moment", label: moment.label }]);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  );
                })}
                <p className="view-hint">反转、兑现这样的时刻：对比时多一列“那一刻还剩多少人”。在预览里停到那一秒再添加。</p>
                <button className="btn small" onClick={addMoment}>
                  <Flag size={13} /> 把播放头所在的时刻记为关键时刻
                </button>
              </Section>

              {numbers?.sources?.length ? (
                <Section id="sources" title="流量来源">
                  {numbers.sources.map((source) => (
                    <div
                      key={source.name}
                      className="review-source"
                      title={source.vsAccount != null ? `账号近 7 天平均 ${formatPercent(source.share - source.vsAccount)}` : undefined}
                    >
                      <span className="review-source-name">{source.name}</span>
                      <span className="review-source-bar">
                        <span style={{ width: `${Math.max(1, source.share * 100)}%` }} />
                      </span>
                      <span className="review-source-value">
                        {formatPercent(source.share)}
                        {source.vsAccount != null && <span className="faint">（均 {formatPercent(source.share - source.vsAccount)}）</span>}
                      </span>
                    </div>
                  ))}
                  <p className="view-hint">括号里是账号近 7 天的平均。</p>
                </Section>
              ) : null}

              {numbers?.comments?.top.length ? (
                <Section id="comments" title={`评论（一级 ${numbers.comments.threads ?? "?"} 条、回复 ${numbers.comments.replies ?? "?"} 条）`} open={false}>
                  {numbers.comments.top.slice(0, 8).map((comment, index) => (
                    <div key={index} className="review-comment">
                      <span className="grow">{comment.text}</span>
                      <span className="faint small-text">
                        {comment.likes} 赞{comment.replies ? ` · ${comment.replies} 回复` : ""}
                      </span>
                    </div>
                  ))}
                </Section>
              ) : null}

              {snapshots.length > 0 && (
                <Section id="snapshots" title={`数据记录（${snapshots.length}）`} open={false}>
                  {snapshots.map((snapshot) => (
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
                          {snapshot.source && snapshot.source !== "手动录入" ? ` · ${snapshot.source.split("、").length} 个文件` : ""}
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
                </Section>
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
          {!files.length && (
            <p className="view-hint">
              创作者中心导出的表格（xlsx、csv）或截图，拖到这里上传。原样保存；抖音的作品数据导出直接导入，其他的可以让 AI 读出来录入。
            </p>
          )}
          {folders.map(([folder, list]) => {
            const waiting = list.filter((file) => file.kind === "table" && !file.used).map((file) => file.path);
            return (
              <div key={folder} className="review-folder">
                {folder !== "raw" && (
                  <div className="review-folder-head">
                    <span className="grow faint small-text">{folder.replace(/^raw\/?/, "")}</span>
                    {waiting.length > 0 && (
                      <button className="btn small ghost" title="导入这一批文件" onClick={() => offerImport(waiting)}>
                        <Import size={13} /> 导入
                      </button>
                    )}
                  </div>
                )}
                {list.map((file) => (
                  <div
                    key={file.path}
                    className="review-row"
                    title={`${file.path}（${formatBytes(file.size)}）`}
                    onClick={() => openReview(`${work.id}/${file.path}`, { preview: true })}
                    onDoubleClick={() => openReview(`${work.id}/${file.path}`)}
                    onContextMenu={(event) =>
                      openMenu(event, [
                        { label: "打开", icon: <FileText size={14} />, onClick: () => openReview(`${work.id}/${file.path}`) },
                        ...(file.kind === "table"
                          ? [{ label: "导入（平台后台的导出）", icon: <Import size={14} />, onClick: () => offerImport([file.path]) }]
                          : []),
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
                    <span className="grow ellipsis">{file.path.split("/").pop()}</span>
                    {file.used ? <span className="badge ok">已录入</span> : <span className="badge">未录入</span>}
                  </div>
                ))}
              </div>
            );
          })}
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
      {dialog?.kind === "import" && (
        <ImportDialog preview={dialog.preview} posts={posts} onImport={(options) => runImport(dialog.files, options)} onClose={() => setDialog(null)} />
      )}
      {menu}
    </div>
  );
}

/** The newest numbers: similar videos' value, the rate, the goal and the day under each when there is one. */
function Tiles({ numbers, definitions, goals }: { numbers: PostSummary; definitions: Definitions | null; goals?: Record<string, number> }) {
  const known = new Set([...(definitions?.metrics ?? []), ...(definitions?.derived ?? [])].map((item) => item.key));
  const keys: [string, string?][] = [
    ...TILES.filter(([key]) => Number.isFinite(numbers.metrics[key])),
    ...Object.keys(numbers.metrics)
      .filter((key) => !known.has(key) && !key.startsWith("moment:"))
      .map((key): [string, string?] => [key]),
  ];
  return (
    <>
      <div className="review-stats">
        {keys.map(([key, rate]) => {
          // A number the newest record lacks comes from an earlier one: say which day.
          const older = Math.abs((numbers.ages[key] ?? numbers.age) - numbers.age) > 0.01 ? ageShort(numbers.ages[key]) : "";
          const goal = goals?.[key];
          const reached = goal != null && (LOWER_IS_BETTER.has(key) ? numbers.metrics[key] <= goal : numbers.metrics[key] >= goal);
          const notes = [
            isBenchmarked(key) && Number.isFinite(numbers.benchmark[key]) && `同类 ${formatMetric(definitions, key, numbers.benchmark[key])}`,
            rate &&
              Number.isFinite(numbers.metrics[rate]) &&
              `${definitionOf(definitions, rate).label} ${formatMetric(definitions, rate, numbers.metrics[rate])}`,
            goal != null &&
              (definitionOf(definitions, key).kind === "count" && !LOWER_IS_BETTER.has(key)
                ? `目标 ${formatCount(goal, true)} · ${formatPercent(numbers.metrics[key] / goal)}`
                : `目标 ${formatMetric(definitions, key, goal)}${reached ? " · 达成" : ""}`),
            older,
          ].filter(Boolean);
          return (
            <div key={key} className="review-stat">
              <div className="review-stat-label ellipsis">{definitionOf(definitions, key).label}</div>
              <div className="review-stat-value">{formatMetric(definitions, key, numbers.metrics[key], true)}</div>
              {notes.length > 0 && <div className="review-stat-note">{notes.join(" · ")}</div>}
            </div>
          );
        })}
      </div>
      <div className="faint small-text">{ageLabel(numbers.age)}的数据</div>
    </>
  );
}

/** Views by the hour on the calendar (the waves), with the first 24/48/72 hours and the channels. */
function FlowPanel({ flow, views, color }: { flow: FlowAnalysis; views: Series; color: string }) {
  const start = Date.parse(views.start);
  const at = (index: number) => new Date(start + Math.floor(index) * 3600000);
  const points = views.values.map((value, index) => [index + 0.5, value] as [number, number]);
  // Ticks at each midnight in the viewer's time zone.
  const ticks: number[] = [];
  for (let index = 0; index <= views.values.length; index++) if (at(index).getHours() === 0) ticks.push(index);
  const format = (index: number) => {
    const time = at(index);
    return ticks.includes(index)
      ? `${time.getMonth() + 1}-${time.getDate()}`
      : `${time.getMonth() + 1}-${time.getDate()} ${String(time.getHours()).padStart(2, "0")}:00`;
  };
  return (
    <Section id="flow" title="每小时播放">
      <LineChart
        label="每小时新增播放"
        height={130}
        series={[{ id: "views", label: "播放", color, points, bars: true }]}
        x={{ domain: [0, views.values.length], format, ticks }}
        y={{ format: (value) => formatCount(value, true) }}
      />
      <div className="faint small-text review-flow-note">
        {flow.firstHours.map((item) => `${item.hours === 24 ? "首 24 小时" : `${item.hours} 小时`} ${formatCount(item.views, true)}`).join(" · ")}
        {flow.channels.length > 0 && ` · ${flow.channels.map((channel) => `${channel.name} ${formatPercent(channel.share)}`).join(" · ")}`}
      </div>
      {flow.waves.map((wave) => (
        <div key={wave.start} className="small-text review-wave">
          <TrendingUp size={12} /> {formatDateTime(wave.start).slice(5)}–{formatDateTime(wave.end).slice(11)} 共 {formatCount(wave.views, true)}
          <span className="faint">
            （最高 {formatDateTime(wave.peak.at).slice(11)} {formatCount(wave.peak.views, true)}）
          </span>
        </div>
      ))}
    </Section>
  );
}

/** A metric of every post over the days after posting: hourly data where there is some, else the snapshots. */
function GrowthPanel({ detail, post, definitions }: { detail: ReviewDetail; post: Post; definitions: Definitions | null }) {
  const [metric, setMetric] = usePersistent("review-metric", "views");
  const posts = detail.review.posts;
  const keys = useMemo(() => {
    const present = new Set(Object.values(detail.history).flatMap((list) => list.flatMap((entry) => Object.keys(entry.metrics))));
    const known = definitions ? [...definitions.metrics, ...definitions.derived].map((item) => item.key) : [];
    return [...known.filter((key) => present.has(key)), ...[...present].filter((key) => !known.includes(key))];
  }, [detail.history, definitions]);
  const shown = keys.includes(metric) ? metric : (keys[0] ?? "views");
  const series = posts
    .map((item) => {
      const hourly = detail.review.series.find((entry) => entry.post === item.id && entry.key === shown && entry.step === 3600);
      return {
        id: item.id,
        label: `${item.platform}${posts.filter((other) => other.platform === item.platform).length > 1 ? ` ${item.id}` : ""}`,
        color: seriesColor(postSlot(item)),
        dots: !hourly,
        points: hourly
          ? cumulative(hourly, item.postedAt)
          : (detail.history[item.id] ?? [])
              .filter((entry) => Number.isFinite(entry.metrics[shown]))
              .map((entry) => [entry.age, entry.metrics[shown]] as [number, number]),
      };
    })
    .filter((item) => item.points.length > 1 || (item.points.length === 1 && item.id === post.id));
  if (!series.length) return null;
  const maxAge = Math.max(1, ...series.flatMap((item) => item.points.map(([age]) => age)));
  return (
    <Section
      id="growth"
      title="累计增长"
      extra={
        <select className="select" value={shown} onChange={(event) => setMetric(event.target.value)} aria-label="指标">
          {keys.map((key) => (
            <option key={key} value={key}>
              {definitionOf(definitions, key).label}
            </option>
          ))}
        </select>
      }
    >
      <LineChart
        label={`各平台${definitionOf(definitions, shown).label}随发布天数的变化`}
        height={140}
        series={series}
        x={{
          domain: [0, Math.max(1, Math.ceil(maxAge * 2) / 2)],
          format: (value) => (value < 2 ? `${Math.round(value * 24)} 小时` : `${+value.toFixed(1)} 天`),
        }}
        y={{ format: (value) => formatMetric(definitions, shown, value, true) }}
      />
      <ChartLegend series={series} />
    </Section>
  );
}

/**
 * The retention curve on the work's own time, next to similar videos': moments (or shots) as
 * hairlines, the playhead on it; a click (or drag) moves the preview there.
 */
function RetentionPanel({
  mine,
  theirs,
  analysis,
  duration,
  stage,
  markers,
  color,
  seek,
}: {
  mine: [number, number][];
  theirs: [number, number][] | null;
  analysis: RetentionAnalysis;
  duration: number;
  stage: ReturnType<typeof useWorkbench>["stage"];
  markers: { at: number; label: string }[];
  color: string;
  seek: (time: number) => void;
}) {
  const playback = useObservable(stage.playback);
  const series = [
    { id: "mine", label: "这个作品", color, points: mine, area: true },
    ...(theirs ? [{ id: "theirs", label: "同类作品", color: BENCHMARK_COLOR, points: theirs }] : []),
  ];
  const stretch = (item: Stretch, kind: "drop" | "rise") => (
    <button key={`${kind}-${item.start}`} className={`review-stretch ${kind}`} onClick={() => seek(item.start)} title="在预览中查看这一段">
      {kind === "drop" ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
      <span className="grow">
        {formatTime(item.start, false)}–{formatTime(item.end, false)} {kind === "drop" ? "流失" : "回升"} {formatPercent(Math.abs(item.to - item.from))}
        <span className="faint"> {labelsOf(item.labels)}</span>
      </span>
    </button>
  );
  return (
    <Section id="retention" title="观众留存" extra={<span className="faint small-text">点曲线跳到那一刻</span>}>
      <LineChart
        label="观众留存曲线：横轴是视频的秒数，纵轴是还在看的比例"
        height={150}
        snap="continuous"
        series={series}
        x={{ domain: [0, duration], format: (value) => formatTime(value, false) }}
        y={{ domain: [0, Math.max(1, ...mine.map(([, share]) => share))], format: (value) => `${Math.round(value * 100)}%` }}
        markers={markers}
        bands={(analysis.peaks ?? []).map((peak) => ({ start: peak.t, end: peak.t + 1 }))}
        cursor={playback.time}
        onPick={seek}
      />
      <ChartLegend series={series} />
      <div className="faint small-text" style={{ margin: "4px 0" }}>
        开头 {analysis.opening.seconds} 秒还在 {formatPercent(analysis.opening.kept)}
        {analysis.opening.keptBenchmark != null && `（同类 ${formatPercent(analysis.opening.keptBenchmark)}）`} · 半程 {formatPercent(analysis.half)} · 结尾{" "}
        {formatPercent(analysis.end)}
        {analysis.keptVsBenchmark != null && `，是同类的 ${analysis.keptVsBenchmark} 倍`}
      </div>
      {analysis.drops?.map((item) => stretch(item, "drop"))}
      {analysis.rises?.map((item) => stretch(item, "rise"))}
    </Section>
  );
}

/** Leaving compared with similar videos: each second's churn rate divided by theirs (above 1: more leave here), the worst seconds with their neighbours. */
function ChurnPanel({
  analysis,
  duration,
  stage,
  seek,
}: {
  analysis: RetentionAnalysis;
  duration: number;
  stage: ReturnType<typeof useWorkbench>["stage"];
  seek: (time: number) => void;
}) {
  const playback = useObservable(stage.playback);
  const points = (analysis.perSecond ?? []).filter((item) => item.multiplier != null).map((item) => [item.t + 0.5, item.multiplier!] as [number, number]);
  const highest = Math.max(2, ...points.map(([, value]) => value));
  const around = (values: (number | null)[]) => values.map((value) => (value == null ? "—" : `×${value}`)).join(" ");
  return (
    <Section id="churn" title="流失率 ÷ 同类" extra={<span className="faint small-text">高于 1：这一秒比同类掉得多</span>}>
      <LineChart
        label="每一秒的流失率是同类作品的几倍"
        height={130}
        snap="continuous"
        series={[{ id: "multiplier", label: "倍数", color: "var(--series-2)", points }]}
        x={{ domain: [0, duration], format: (value) => `${Math.floor(value)}–${Math.floor(value) + 1} 秒` }}
        y={{ domain: [0, Math.ceil(highest)], format: (value) => `×${+value.toFixed(1)}`, reference: { value: 1, label: "同类" } }}
        cursor={playback.time}
        onPick={(value) => seek(Math.floor(value))}
      />
      {(analysis.peaks ?? []).map((peak) => (
        <button key={peak.t} className="review-stretch drop" onClick={() => seek(peak.t)} title="在预览中查看这一秒；括号里是前两秒和后两秒的倍数">
          <TrendingDown size={13} />
          <span className="grow">
            {peak.t}–{peak.t + 1} 秒 ×{peak.multiplier}
            <span className="faint">
              {" "}
              （{around(peak.around.slice(0, 2))} | {around(peak.around.slice(2))}）{labelsOf(peak.labels)}
            </span>
          </span>
        </button>
      ))}
    </Section>
  );
}

/** Each segment's multiplier (or share lost) and what keeping people there like similar videos would add at the end. */
function SegmentsPanel({ analysis, seek }: { analysis: RetentionAnalysis; seek: (time: number) => void }) {
  const kinds = Object.keys(analysis.segments);
  const [kind, setKind] = usePersistent("review-segment-kind", kinds[0]);
  const shown = kinds.includes(kind) ? kind : kinds[0];
  return (
    <Section
      id="segments"
      title="分段"
      extra={
        kinds.length > 1 ? (
          <div className="segmented">
            {kinds.map((item) => (
              <button key={item} className={item === shown ? "active" : ""} onClick={() => setKind(item)}>
                {item}
              </button>
            ))}
          </div>
        ) : (
          <span className="faint small-text">{shown}</span>
        )
      }
    >
      {analysis.segments[shown].map((segment) => (
        <button
          key={`${segment.start}-${segment.label}`}
          className="review-segment"
          onClick={() => seek(segment.start)}
          title={`${segment.label}\n在预览中查看`}
        >
          <span className="review-segment-time">
            {formatTime(segment.start, false)}–{formatTime(segment.end, false)}
          </span>
          <span className="grow ellipsis">{segment.label}</span>
          {segment.multiplier != null ? (
            <span className={`review-segment-value ${segment.multiplier >= 1.5 ? "high" : ""}`}>
              ×{segment.multiplier}
              {segment.gain != null && segment.gain >= 0.01 && <span className="faint"> +{formatPercent(segment.gain)}</span>}
            </span>
          ) : (
            <span className="review-segment-value">−{formatPercent(segment.lost)}</span>
          )}
        </button>
      ))}
      {analysis.hasBenchmark && <p className="view-hint">×：这一段走掉的比例是同类的几倍；+：这一段按同类的流失率走，结尾能多留的人。</p>}
    </Section>
  );
}

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Home, RefreshCw } from "lucide-react";
import { api, useServerEvent } from "../lib/api";
import { usePersistent, useToast } from "../lib/ui";
import type { Repo } from "../lib/types";
import { navigate } from "../App";
import { CHECKPOINT_LABELS, definitionOf, formatMetric, SERIES_COUNT, seriesColor, type CompareRow, type Definitions } from "../lib/reviews";
import { ChartLegend, LineChart, type ChartSeries } from "./LineChart";
import "../pages/pages.css";
import "./reviews.css";

const rowKey = (row: CompareRow) => `${row.repo}/${row.work}/${row.post}`;
const median = (values: number[]) => {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};

/** Open a work on its review view. */
function openReview(row: CompareRow) {
  try {
    localStorage.setItem("frame:view", JSON.stringify("reviews"));
  } catch {}
  navigate(`/work/${encodeURIComponent(row.repo)}/${encodeURIComponent(row.work)}`);
}

/**
 * Every posted work side by side, each post at the same age after posting (totals keep
 * growing, so numbers of different ages do not compare): a table of the numbers and rates
 * with the medians, and charts of the chosen posts' growth and retention over the video.
 */
export function ComparePage() {
  const focus = new URLSearchParams(location.search).get("focus") ?? "";
  const toast = useToast();
  const [checkpoint, setCheckpoint] = usePersistent("compare-checkpoint", "7d");
  const [platform, setPlatform] = useState("");
  const [repo, setRepo] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = usePersistent<{ key: string; desc: boolean }>("compare-sort", { key: "views", desc: true });
  const [growthMetric, setGrowthMetric] = usePersistent("compare-growth", "views");
  const [data, setData] = useState<{ rows: CompareRow[]; definitions: Definitions } | null>(null);
  const [loading, setLoading] = useState(true);
  const [repos, setRepos] = useState<Repo[]>([]);
  // Charted posts keep their color slot while chosen (a removed one never repaints the others).
  const [chosen, setChosen] = useState<{ key: string; slot: number }[] | null>(null);

  const load = () => {
    setLoading(true);
    return api<{ rows: CompareRow[]; definitions: Definitions }>(`/api/reviews/compare?checkpoint=${encodeURIComponent(checkpoint)}&curves=1`).then(
      (next) => (setData(next), setLoading(false)),
      (error: Error) => (toast(error.message, "error"), setLoading(false)),
    );
  };
  useEffect(() => {
    document.title = "复盘对比 · FRAME Studio";
    void api<Repo[]>("/api/repos").then(setRepos, () => {});
  }, []);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpoint]);
  useServerEvent((event) => {
    if (event.type === "reviews") void load();
  });

  const definitions = data?.definitions ?? null;
  const all = data?.rows ?? [];
  const platforms = [...new Set(all.map((row) => row.platform))];
  const tags = [...new Set(all.flatMap((row) => row.tags))];
  const rows = all.filter((row) => (!platform || row.platform === platform) && (!repo || row.repo === repo) && (!tag || row.tags.includes(tag)));
  const columns = definitions?.columns ?? [];
  const value = (row: CompareRow, key: string) => (key === "duration" ? row.duration : key === "postedAt" ? Date.parse(row.postedAt) : row.metrics[key]);
  // Posts with numbers at the checkpoint first, in the chosen order; the others after them, newest first.
  const order = (a: CompareRow, b: CompareRow) => {
    if (sort.key === "title") return (sort.desc ? -1 : 1) * a.title.localeCompare(b.title, "zh");
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    const fa = Number.isFinite(va);
    const fb = Number.isFinite(vb);
    if (fa !== fb) return fa ? -1 : 1;
    return fa ? (sort.desc ? vb - va : va - vb) : 0;
  };
  const sorted = [
    ...rows.filter((row) => row.age !== null).sort(order),
    ...rows.filter((row) => row.age === null).sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt)),
  ];

  // First look: the focused work's posts and the leading ones, up to four.
  useEffect(() => {
    if (chosen !== null || !data) return;
    const focused = sorted.filter((row) => focus && `${row.repo}/${row.work}` === focus);
    const leading = sorted.filter((row) => row.age !== null && !focused.includes(row));
    setChosen([...focused, ...leading].slice(0, 3).map((row, slot) => ({ key: rowKey(row), slot })));
  }, [data, sorted, chosen, focus]);
  const slotOf = (row: CompareRow) => chosen?.find((item) => item.key === rowKey(row))?.slot;
  const toggle = (row: CompareRow) =>
    setChosen((current) => {
      const list = current ?? [];
      if (list.some((item) => item.key === rowKey(row))) return list.filter((item) => item.key !== rowKey(row));
      if (list.length >= SERIES_COUNT) {
        toast(`图表里最多放 ${SERIES_COUNT} 条，先取消一条`, "info");
        return list;
      }
      const slot = [...Array(SERIES_COUNT).keys()].find((free) => !list.some((item) => item.slot === free)) ?? 0;
      return [...list, { key: rowKey(row), slot }];
    });
  const charted = sorted.filter((row) => slotOf(row) !== undefined);
  const name = (row: CompareRow) => `${row.title} · ${row.platform}`;
  const growth: ChartSeries[] = charted
    .map((row) => ({
      id: rowKey(row),
      label: name(row),
      color: seriesColor(slotOf(row)!),
      dots: true,
      points: (row.history ?? [])
        .filter((entry) => Number.isFinite(entry.metrics[growthMetric]))
        .map((entry) => [entry.age, entry.metrics[growthMetric]] as [number, number]),
    }))
    .filter((item) => item.points.length);
  const retention: ChartSeries[] = charted
    .filter((row) => row.curve?.length)
    .map((row) => ({ id: rowKey(row), label: name(row), color: seriesColor(slotOf(row)!), points: row.curve! }));
  const growthKeys = [...new Set(all.flatMap((row) => (row.history ?? []).flatMap((entry) => Object.keys(entry.metrics))))];
  const maxAge = Math.max(1, ...growth.flatMap((item) => item.points.map(([age]) => age)));
  const medians = Object.fromEntries(columns.map((key) => [key, median(sorted.filter((row) => row.age !== null).map((row) => row.metrics[key]))]));
  const header = (key: string, label: string, text = false) => (
    <th
      key={key}
      className={`${sort.key === key ? "sorted" : ""} ${text ? "text" : ""}`}
      onClick={() => setSort((current) => ({ key, desc: current.key === key ? !current.desc : true }))}
      aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      {label}
      {sort.key === key && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
    </th>
  );
  const days = checkpoint === "latest" ? null : Number(checkpoint.replace("d", ""));

  return (
    <div className="welcome">
      <header className="welcome-top">
        <div className="brand">
          <button className="icon-btn" title="返回首页" onClick={() => navigate("/")}>
            <Home size={16} />
          </button>
          <span>复盘对比</span>
        </div>
        <button className="icon-btn" title="刷新" onClick={load}>
          <RefreshCw size={16} />
        </button>
      </header>
      <div className="compare-page">
        <main className="compare-main">
          <p className="muted" style={{ margin: 0 }}>
            每条发布记录一行，都取发布后同一天数的数据：总数会一直增长，不同天数的数字不能直接比。比例（点赞率、完播率、3 秒留存……）更能说明内容本身。
          </p>
          <div className="compare-filters">
            <div className="segmented" role="group" aria-label="发布后天数">
              {(definitions?.checkpoints ?? Object.keys(CHECKPOINT_LABELS)).map((key) => (
                <button key={key} className={checkpoint === key ? "active" : ""} onClick={() => setCheckpoint(key)}>
                  {CHECKPOINT_LABELS[key] ?? key}
                </button>
              ))}
            </div>
            <select className="select" value={platform} onChange={(event) => setPlatform(event.target.value)} aria-label="平台">
              <option value="">全部平台</option>
              {platforms.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            {tags.length > 0 && (
              <select className="select" value={tag} onChange={(event) => setTag(event.target.value)} aria-label="标签">
                <option value="">全部标签</option>
                {tags.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            )}
            {repos.length > 1 && (
              <select className="select" value={repo} onChange={(event) => setRepo(event.target.value)} aria-label="作品库">
                <option value="">全部作品库</option>
                {repos.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {!data ? (
            <div className="empty">正在读取…</div>
          ) : !all.length ? (
            <div className="empty">还没有复盘数据。在作品的「复盘」里记下发到了哪个平台、录入数据以后，所有作品会在这里放在一起比较。</div>
          ) : (
            <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity 0.15s" }}>
              <div className="compare-charts">
                <section className="compare-card">
                  <h3>
                    增长
                    <select className="select" value={growthMetric} onChange={(event) => setGrowthMetric(event.target.value)} aria-label="指标">
                      {growthKeys.map((key) => (
                        <option key={key} value={key}>
                          {definitionOf(definitions, key).label}
                        </option>
                      ))}
                    </select>
                  </h3>
                  {growth.length ? (
                    <>
                      <LineChart
                        label={`所选发布记录的${definitionOf(definitions, growthMetric).label}随发布天数的变化`}
                        height={200}
                        series={growth}
                        x={{ domain: [0, Math.ceil(maxAge)], format: (age) => `${+age.toFixed(1)} 天` }}
                        y={{ format: (number) => formatMetric(definitions, growthMetric, number, true) }}
                      />
                      <ChartLegend series={growth} />
                    </>
                  ) : (
                    <div className="empty small-text">在下面的表格里勾选作品，比较它们的增长</div>
                  )}
                </section>
                <section className="compare-card">
                  <h3>观众留存（按视频进度对齐）</h3>
                  {retention.length ? (
                    <>
                      <LineChart
                        label="所选发布记录的观众留存，横轴是视频进度"
                        height={200}
                        snap="continuous"
                        series={retention}
                        x={{ domain: [0, 1], format: (share) => `${Math.round(share * 100)}%`, ticks: [0, 0.25, 0.5, 0.75, 1] }}
                        y={{
                          domain: [0, Math.max(1, ...retention.flatMap((item) => item.points.map(([, share]) => share)))],
                          format: (share) => `${Math.round(share * 100)}%`,
                        }}
                      />
                      <ChartLegend series={retention} />
                    </>
                  ) : (
                    <div className="empty small-text">勾选的发布记录还没有留存曲线</div>
                  )}
                </section>
              </div>

              <div className="compare-table-wrap">
                <table className="compare-table">
                  <thead>
                    <tr>
                      {header("title", "作品", true)}
                      {header("postedAt", "发布", true)}
                      {header("duration", "时长")}
                      {columns.map((key) => header(key, definitionOf(definitions, key).label))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((row) => {
                      const slot = slotOf(row);
                      return (
                        <tr key={rowKey(row)} className={`${focus === `${row.repo}/${row.work}` ? "current" : ""} ${row.age === null ? "no-data" : ""}`}>
                          <td>
                            <div className="compare-work">
                              <input type="checkbox" checked={slot !== undefined} onChange={() => toggle(row)} aria-label={`在图表中显示 ${name(row)}`} />
                              <span className="chart-key" style={{ background: slot !== undefined ? seriesColor(slot) : "transparent" }} />
                              <span className="grow ellipsis">
                                <button title={row.missing ? "作品已删除或在回收站" : "打开作品的复盘"} disabled={row.missing} onClick={() => openReview(row)}>
                                  {row.title}
                                </button>
                                {row.missing && <span className="badge"> 已删除</span>}
                                <div className="faint small-text ellipsis">
                                  {row.platform}
                                  {row.postTitle && row.postTitle !== row.title ? ` · ${row.postTitle}` : ""}
                                  {row.shape ? ` · ${row.shape}` : ""}
                                </div>
                              </span>
                            </div>
                          </td>
                          <td className="text">
                            {row.postedAt.slice(0, 10)}
                            <div className="faint small-text">
                              {row.age === null
                                ? row.snapshots.length
                                  ? `${days ? `第 ${days} 天` : ""}没有数据（有第 ${row.snapshots.join("、")} 天的）`
                                  : "还没有数据"
                                : `第 ${+row.age.toFixed(1)} 天的数据`}
                            </div>
                          </td>
                          <td>{row.duration ? `${+row.duration.toFixed(1)} 秒` : "—"}</td>
                          {columns.map((key) => (
                            <td key={key}>{formatMetric(definitions, key, row.metrics[key], true)}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                  {sorted.filter((row) => row.age !== null).length > 1 && (
                    <tfoot>
                      <tr>
                        <td>中位数</td>
                        <td className="text" />
                        <td />
                        {columns.map((key) => (
                          <td key={key}>{formatMetric(definitions, key, medians[key], true)}</td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <p className="compare-hint">
                勾选最多 {SERIES_COUNT} 条放进图表。点作品名打开它的复盘。
                {days !== null &&
                  ` 第 ${days} 天取第 ${+(days - Math.max(0.5, days * 0.2)).toFixed(1)}–${+(days + Math.max(0.5, days * 0.2)).toFixed(1)} 天之间最接近的一次记录。`}
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

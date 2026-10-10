import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, workPath } from "../lib/api";
import { Dialog } from "../lib/ui";
import type { WorkInfo } from "../lib/types";
import {
  definitionOf,
  formatDateTime,
  fromLocalInput,
  parseRetention,
  retentionText,
  toLocalInput,
  type Definitions,
  type ImportPreview,
  type Post,
  type RawFile,
  type Snapshot,
} from "../lib/reviews";

interface ExportFile {
  name: string;
  duration?: number;
  createdAt: string;
}

/** A number as people type or paste it: "12,034", "1.2万", "3.5亿". */
export function parseNumber(text: string): number | null {
  const clean = text.replace(/[,\s，]/g, "");
  if (!clean) return null;
  const match = /^(-?\d+(?:\.\d+)?)(万|亿|w|k)?$/i.exec(clean);
  if (!match) return null;
  const unit = { 万: 1e4, 亿: 1e8, w: 1e4, k: 1e3 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  return +(Number(match[1]) * unit).toPrecision(12);
}

/** How a metric is typed: percentages for ratios, seconds for durations. */
const toInput = (kind: string, value: number | undefined) => (value == null ? "" : kind === "ratio" ? String(+(value * 100).toPrecision(10)) : String(value));
const fromInput = (kind: string, text: string) => {
  const value = parseNumber(text.replace(/%$/, ""));
  return value == null ? null : kind === "ratio" ? +(value / 100).toPrecision(12) : value;
};

/** Add or change a post: where and when the video went out, which export it was, what it should reach. */
export function PostDialog({
  work,
  post,
  definitions,
  onSave,
  onClose,
}: {
  work: WorkInfo;
  post?: Post;
  definitions: Definitions;
  onSave: (operation: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [platform, setPlatform] = useState(post?.platform ?? "");
  const [postedAt, setPostedAt] = useState(toLocalInput(post?.postedAt ?? new Date().toISOString()));
  const [url, setUrl] = useState(post?.url ?? "");
  const [title, setTitle] = useState(post?.title ?? "");
  const [pinned, setPinned] = useState(post?.pinnedComment ?? "");
  const [account, setAccount] = useState(post?.account ?? "");
  const [exported, setExported] = useState(post?.export ?? "");
  const [notes, setNotes] = useState(post?.notes ?? "");
  const [goals, setGoals] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(post?.goals ?? {}).map(([key, value]) => ({ key, value: toInput(definitionOf(definitions, key).kind, value) })),
  );
  const [exports, setExports] = useState<ExportFile[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api<ExportFile[]>(`${workPath(work.repo, work.id)}/exports`).then(
      (list) => setExports(list.filter((file) => /\.(mp4|webm)$/i.test(file.name))),
      () => {},
    );
  }, [work.repo, work.id]);
  const goalOptions = [...definitions.metrics, ...definitions.derived].filter((item) => !["retention3s", "retentionHalf"].includes(item.key));
  const goalValues = Object.fromEntries(
    goals.map((goal) => [goal.key, fromInput(definitionOf(definitions, goal.key).kind, goal.value)]).filter(([, value]) => value != null),
  ) as Record<string, number>;
  const valid = platform.trim() && postedAt && goals.every((goal) => !goal.value.trim() || fromInput("count", goal.value) != null);
  const save = async () => {
    if (!valid) return;
    setSaving(true);
    // Editing sends cleared fields as "", which removes them.
    const fields = {
      platform: platform.trim(),
      postedAt: fromLocalInput(postedAt),
      url: url.trim(),
      title: title.trim(),
      pinnedComment: pinned.trim(),
      account: account.trim(),
      notes: notes.trim(),
    };
    const operation = post
      ? { op: "post", id: post.id, ...fields, goals: goalValues, ...(exported !== (post.export ?? "") ? { export: exported } : {}) }
      : {
          op: "post",
          ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value)),
          ...(Object.keys(goalValues).length ? { goals: goalValues } : {}),
          ...(exported ? { export: exported } : {}),
        };
    const ok = await onSave(operation);
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      title={post ? "修改发布记录" : "记录一次发布"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!valid || saving} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="metric-grid">
        <label className="field">
          <span>平台</span>
          <input
            className="input"
            list="review-platforms"
            autoFocus={!post}
            value={platform}
            placeholder="例如 抖音"
            onChange={(event) => setPlatform(event.target.value)}
          />
          <datalist id="review-platforms">
            {definitions.platforms.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>发布时间</span>
          <input className="input" type="datetime-local" value={postedAt} onChange={(event) => setPostedAt(event.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>发布时的标题和话题（不填用作品标题）</span>
        <input className="input" value={title} placeholder={work.meta?.title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="field">
        <span>置顶评论（可选）</span>
        <textarea className="textarea" rows={2} value={pinned} onChange={(event) => setPinned(event.target.value)} />
      </label>
      <div className="metric-grid">
        <label className="field">
          <span>链接</span>
          <input className="input" value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} />
        </label>
        <label className="field">
          <span>账号（可选）</span>
          <input className="input" value={account} onChange={(event) => setAccount(event.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>发布的视频（记下当时的作品版本和时长）</span>
        <select className="select" value={exported} onChange={(event) => setExported(event.target.value)}>
          <option value="">不指定（用作品现在的版本）</option>
          {exports.map((file) => (
            <option key={file.name} value={file.name}>
              {file.name}
              {file.duration ? `（${+file.duration.toFixed(1)} 秒）` : ""}
            </option>
          ))}
          {exported && !exports.some((file) => file.name === exported) && <option value={exported}>{exported}（已删除）</option>}
        </select>
      </label>
      <div className="field">
        <span>目标（可选，例如播放 100万、点赞率 5%）</span>
        {goals.map((goal, index) => {
          const kind = definitionOf(definitions, goal.key).kind;
          return (
            <div key={index} className="row">
              <select
                className="select"
                value={goal.key}
                onChange={(event) => setGoals((list) => list.map((entry, at) => (at === index ? { ...entry, key: event.target.value } : entry)))}
              >
                {goalOptions.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="input-suffix grow">
                <input
                  className="input"
                  inputMode="decimal"
                  value={goal.value}
                  placeholder={kind === "count" ? "例如 100万" : ""}
                  onChange={(event) => setGoals((list) => list.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)))}
                />
                {kind !== "count" && kind !== "number" && <em>{kind === "ratio" ? "%" : "秒"}</em>}
              </span>
              <button className="icon-btn" title="删除" onClick={() => setGoals((list) => list.filter((_, at) => at !== index))}>
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        <div>
          <button
            className="btn small ghost"
            onClick={() => setGoals((list) => [...list, { key: list.some((item) => item.key === "views") ? "likeRate" : "views", value: "" }])}
          >
            <Plus size={13} /> 添加目标
          </button>
        </div>
      </div>
      <label className="field">
        <span>备注（封面、投流……）</span>
        <textarea className="textarea" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
    </Dialog>
  );
}

/** Enter (or correct) the numbers of a post at one moment, by hand. */
export function SnapshotDialog({
  post,
  snapshot,
  files,
  definitions,
  onSave,
  onClose,
}: {
  post: Post;
  snapshot?: Snapshot;
  files: RawFile[];
  definitions: Definitions;
  onSave: (operations: Record<string, unknown>[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const standard = definitions.metrics;
  const [at, setAt] = useState(() => toLocalInput(snapshot?.at ?? new Date(Math.max(Date.parse(post.postedAt), Date.now())).toISOString()));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(standard.map((item) => [item.key, toInput(item.kind, snapshot?.metrics[item.key])])),
  );
  const [extra, setExtra] = useState<{ name: string; value: string }[]>(() =>
    Object.entries(snapshot?.metrics ?? {})
      .filter(([key]) => !standard.some((item) => item.key === key))
      .map(([name, value]) => ({ name, value: toInput(definitionOf(definitions, name).kind, value) })),
  );
  const [retention, setRetention] = useState(retentionText(snapshot?.retention));
  const [similar, setSimilar] = useState(retentionText(snapshot?.retentionBenchmark));
  const [source, setSource] = useState(snapshot?.source ?? "手动录入");
  const [saving, setSaving] = useState(false);
  const curve = useMemo(() => parseRetention(retention), [retention]);
  const benchmark = useMemo(() => parseRetention(similar), [similar]);
  const metrics = useMemo(() => {
    const out: Record<string, number> = {};
    for (const item of standard) {
      const value = fromInput(item.kind, values[item.key] ?? "");
      if (value != null) out[item.key] = value;
    }
    for (const item of extra) {
      const value = fromInput(definitionOf(definitions, item.name.trim()).kind, item.value);
      if (item.name.trim() && value != null) out[item.name.trim()] = value;
    }
    return out;
  }, [values, extra, standard, definitions]);
  const typedWrong = [...standard.map((item) => values[item.key] ?? ""), ...extra.map((item) => item.value)].some(
    (text) => text.trim() && fromInput("count", text) == null,
  );
  const valid = at && (Object.keys(metrics).length || curve.length) && !typedWrong;
  const quick = [1, 2, 3, 7, 14, 30];
  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const moment = fromLocalInput(at);
    const operation = {
      op: "snapshot",
      post: post.id,
      at: moment,
      source: source || "手动录入",
      metrics,
      ...(curve.length ? { retention: curve } : {}),
      ...(benchmark.length ? { retentionBenchmark: benchmark } : {}),
      ...(snapshot?.sources ? { sources: snapshot.sources } : {}),
      ...(snapshot?.comments ? { comments: snapshot.comments } : {}),
      ...(snapshot?.benchmark ? { benchmark: snapshot.benchmark } : {}),
      replace: Boolean(snapshot),
    };
    // A corrected moment replaces the old snapshot.
    const moved = snapshot && Date.parse(snapshot.at) !== Date.parse(moment);
    const ok = await onSave(moved ? [{ op: "remove_snapshot", post: post.id, at: snapshot.at }, operation] : [operation]);
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Dialog
      title={`${snapshot ? "修改" : "录入"}数据 · ${post.platform}`}
      onClose={onClose}
      width={640}
      footer={
        <>
          <span className="faint small-text grow">数字是截至统计时间的累计值；比例填百分数。平台导出的表格可以直接上传导入</span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!valid || saving} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <label className="field">
        <span>统计时间</span>
        <input className="input" type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
      </label>
      <div className="quick-times">
        {quick.map((days) => (
          <button
            key={days}
            className="btn small ghost"
            onClick={() => setAt(toLocalInput(new Date(Date.parse(post.postedAt) + days * 86400000).toISOString()))}
          >
            发布后 {days} 天
          </button>
        ))}
      </div>
      <div className="metric-grid">
        {standard.map((item) => (
          <label key={item.key} className="field">
            <span>{item.label}</span>
            <span className="input-suffix">
              <input
                className="input"
                inputMode="decimal"
                value={values[item.key] ?? ""}
                placeholder={item.key === "views" ? "例如 12034 或 1.2万" : ""}
                onChange={(event) => setValues((current) => ({ ...current, [item.key]: event.target.value }))}
              />
              {item.kind !== "count" && item.kind !== "number" && <em>{item.kind === "ratio" ? "%" : "秒"}</em>}
            </span>
          </label>
        ))}
      </div>
      <div className="field">
        <span>平台特有的指标（例如 投币；名称带“率”的按百分数填）</span>
        {extra.map((item, index) => (
          <div key={index} className="row">
            <input
              className="input"
              value={item.name}
              placeholder="名称"
              onChange={(event) => setExtra((list) => list.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry)))}
            />
            <input
              className="input"
              inputMode="decimal"
              value={item.value}
              placeholder="数值"
              onChange={(event) => setExtra((list) => list.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)))}
            />
            <button className="icon-btn" title="删除" onClick={() => setExtra((list) => list.filter((_, at) => at !== index))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div>
          <button className="btn small ghost" onClick={() => setExtra((list) => [...list, { name: "", value: "" }])}>
            <Plus size={13} /> 添加指标
          </button>
        </div>
      </div>
      <div className="metric-grid">
        <label className="field">
          <span>观众留存（可选）：每行“第几秒 还在看的百分比”{curve.length ? `，已识别 ${curve.length} 点` : ""}</span>
          <textarea
            className="textarea mono"
            rows={4}
            value={retention}
            placeholder={"0 100\n3 62\n8 45"}
            onChange={(event) => setRetention(event.target.value)}
          />
        </label>
        <label className="field">
          <span>同类作品的留存（可选）{benchmark.length ? `，已识别 ${benchmark.length} 点` : ""}</span>
          <textarea className="textarea mono" rows={4} value={similar} placeholder={"0 100\n3 63\n8 48"} onChange={(event) => setSimilar(event.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>数据来源</span>
        <select className="select" value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="手动录入">手动录入</option>
          {files.map((file) => (
            <option key={file.path} value={file.path}>
              {file.path}
            </option>
          ))}
          {source !== "手动录入" && !files.some((file) => file.path === source) && <option value={source}>{source}</option>}
        </select>
      </label>
      {typedWrong && <p className="danger-text small-text">有填写不是数字的格子</p>}
    </Dialog>
  );
}

/**
 * Bring a platform's exports in: which files were recognized and as what, into which post
 * (or a new one, posted when the data begins), counted up to when.
 */
export function ImportDialog({
  preview,
  posts,
  onImport,
  onClose,
}: {
  preview: ImportPreview;
  posts: Post[];
  onImport: (options: { post?: string; postedAt?: string; at?: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const same = posts.filter((post) => post.platform === preview.platform);
  const [target, setTarget] = useState(preview.post ?? (same.length ? same[0].id : "new"));
  const [postedAt, setPostedAt] = useState(toLocalInput(preview.postedAt));
  const [at, setAt] = useState(toLocalInput(preview.at));
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    // The inputs show minutes: times left as they were go to the server as it read them (to the second).
    const times = {
      ...(at !== toLocalInput(preview.at) ? { at: fromLocalInput(at) } : {}),
      ...(target === "new" && postedAt !== toLocalInput(preview.postedAt) ? { postedAt: fromLocalInput(postedAt) } : {}),
    };
    const ok = await onImport(target === "new" ? times : { post: target, ...times });
    setBusy(false);
    if (ok) onClose();
  };
  const parts = [
    `${preview.metrics.length} 项指标`,
    preview.retention && `逐秒留存${preview.benchmark ? "（含同类作品）" : ""}`,
    preview.series.some((key) => key.startsWith("views")) && "每小时播放",
    preview.series.some((key) => key.startsWith("followers")) && "每小时涨粉",
    preview.sources && `流量来源 ${preview.sources} 项`,
    preview.comments && `评论 ${preview.comments.threads} 条一级、${preview.comments.replies} 条回复`,
  ].filter(Boolean);
  return (
    <Dialog
      title={`导入${preview.platform}后台数据`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={run}>
            导入
          </button>
        </>
      }
    >
      <p className="small-text">认出了：{parts.join("、")}。</p>
      {preview.unchanged && <p className="small-text">这些文件之前已经导入过，再导入不会有变化。</p>}
      {!preview.unchanged && preview.replaces && <p className="small-text">这条发布记录在这个时间已经有数据，导入会替换它。</p>}
      <div className="import-files">
        {preview.recognized.map((item) => (
          <div key={item.path} className="small-text">
            <span className="mono">{item.path.replace(/^raw\//, "")}</span>
            <span className="faint"> · {item.parts.join("、")}</span>
          </div>
        ))}
        {preview.duplicates.map((item) => (
          <div key={item.path} className="small-text faint">
            <span className="mono">{item.path.replace(/^raw\//, "")}</span> · 和 {item.of.replace(/^raw\//, "")} 内容相同，只读一次
          </div>
        ))}
        {preview.unrecognized.map((path) => (
          <div key={path} className="small-text faint">
            <span className="mono">{path.replace(/^raw\//, "")}</span> · 没认出（留作原始文件）
          </div>
        ))}
      </div>
      <label className="field">
        <span>导入到</span>
        <select className="select" value={target} onChange={(event) => setTarget(event.target.value)}>
          {same.map((post) => (
            <option key={post.id} value={post.id}>
              {post.platform} · {formatDateTime(post.postedAt)} 发布（{post.id}）
            </option>
          ))}
          <option value="new">新建{preview.platform}发布记录</option>
        </select>
      </label>
      <div className="metric-grid">
        {target === "new" && (
          <label className="field">
            <span>发布时间（数据从这个小时开始，填准确的分钟）</span>
            <input className="input" type="datetime-local" value={postedAt} onChange={(event) => setPostedAt(event.target.value)} />
          </label>
        )}
        <label className="field">
          <span>数据统计到（每小时数据的最后一个小时，可改成导出的时间）</span>
          <input className="input" type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}

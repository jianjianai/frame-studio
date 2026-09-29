import { useMemo, useState } from "react";
import { FileCode2, FilePlus2, FileX2, ChevronRight, Files, GitCompareArrows, WrapText } from "lucide-react";
import { Modal } from "../ui";
import { AgentCopy } from "./AgentMarkdown";

const names = { add: "新增", write: "写入", delete: "删除", rename: "重命名", update: "修改", modify: "修改" };
export function diffStats(file) {
  if (file.binary) return null;
  if (Number.isFinite(file.added) && Number.isFinite(file.removed)) return { added: file.added, removed: file.removed };
  if (!file.diff) return null;
  return { added: file.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: file.diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length };
}
export function AgentFileList({ files = [], onOpen, compact = false }) {
  return <div className={"agent-file-list " + (compact ? "compact" : "")}>
    {files.map((file, index) => { const stats = diffStats(file), Icon = file.kind === "add" ? FilePlus2 : file.kind === "delete" ? FileX2 : FileCode2;
      return <button type="button" key={file.path + ":" + index} className="agent-file-row" onClick={() => onOpen(file)} title={file.path} aria-label={"查看文件差异 " + file.path}>
        <Icon size={14} /><span className="agent-file-name"><strong>{file.path.split("/").at(-1)}</strong>{!compact && <small>{file.path}</small>}</span>
        <span className="agent-file-kind">{names[file.kind] || "修改"}</span>{stats && <span className="agent-diff-stats"><ins>+{stats.added}</ins><del>−{stats.removed}</del></span>}<ChevronRight size={12} />
      </button>;
    })}
  </div>;
}
function DiffLines({ file, wrap }) {
  const [limit, setLimit] = useState(400);
  const rows = useMemo(() => {
    let old = null, current = null;
    return String(file.diff || "").split("\n").map((line, index) => {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) { old = Number(match[1]); current = Number(match[2]); return { index, text: line, kind: "hunk" }; }
      if (old === null || line.startsWith("\\ No newline") || line.startsWith("diff --git ")) return { index, text: line, kind: "meta" };
      if (line.startsWith("+")) return { index, text: line, kind: "add", current: current++ };
      if (line.startsWith("-")) return { index, text: line, kind: "remove", old: old++ };
      if (line.startsWith(" ")) return { index, text: line, kind: "context", old: old++, current: current++ };
      return { index, text: line, kind: "meta" };
    });
  }, [file.diff]);
  if (!file.diff || file.binary) return <div className="agent-diff-empty"><FileCode2 size={22} /><p>{file.note || (file.binary ? "二进制文件或链接：不提供文本差异。" : file.truncated ? "文件较大，未将全文放入对话。请在作品文件管理中查看。" : "此步骤记录了文件路径，但提供商未返回文本差异。下方的本轮文件清单会显示工作副本的实际变更。")}</p></div>;
  return <><div className={"agent-diff-lines " + (wrap ? "wrap" : "")} role="region" aria-label="只读逐行差异" tabIndex={0}>
    {rows.slice(0, limit).map((row) => <div key={row.index} className={"agent-diff-line " + row.kind}><span aria-hidden="true">{row.old ?? ""}</span><span aria-hidden="true">{row.current ?? ""}</span><code>{row.text || " "}</code></div>)}
  </div>{rows.length > limit && <button type="button" className="agent-more-lines" onClick={() => setLimit((n) => n + 600)}>再显示 {Math.min(600, rows.length - limit)} 行 · 共 {rows.length} 行</button>}
  {file.truncated && <p className="agent-detail-note">差异已截断；这里只展示已捕获的部分，不代表文件全部内容。</p>}</>;
}
export function AgentDiffViewer({ files, initial, onClose, notify, task, scope = "turn" }) {
  const [selected, setSelected] = useState(initial.path), [wrap, setWrap] = useState(false);
  const file = files.find((item) => item.path === selected) || initial;
  return <Modal title="本轮文件变更" wide onClose={onClose}><div className="agent-diff-review">
    <div className="agent-diff-heading"><div><strong>{file.path}</strong><small>只读审查 · {scope === "step" ? "此步骤记录的差异，不代表本轮最终净变更" : task?.state === "succeeded" ? "已保存的本轮结果" : "当前隔离工作副本，不代表已应用到作品"}</small></div><div className="row"><button type="button" aria-pressed={wrap} title="切换自动换行" onClick={() => setWrap(!wrap)}><WrapText size={15} /></button><AgentCopy text={file.diff || file.path} label="复制差异" notify={notify} /></div></div>
    {files.length > 1 && <nav className="agent-diff-tabs" aria-label="选择变更文件">{files.map((entry) => <button type="button" key={entry.path} aria-pressed={entry.path === file.path} title={entry.path} onClick={() => setSelected(entry.path)}><FileCode2 size={13} />{entry.path.split("/").at(-1)}</button>)}</nav>}
    <DiffLines key={file.path} file={file} wrap={wrap} />
  </div></Modal>;
}
export function AgentChangeSummary({ files, truncated, task, onOpen }) {
  const [open, setOpen] = useState(false);
  if (!files.length) return null;
  const stats = files.map(diffStats).filter(Boolean), added = stats.reduce((n, s) => n + s.added, 0), removed = stats.reduce((n, s) => n + s.removed, 0);
  return <section className="agent-change-summary"><button type="button" className="agent-summary-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Files size={14} /><strong>{files.length} 个文件变更</strong><span className="agent-diff-stats"><ins>+{added}</ins><del>−{removed}</del></span><ChevronRight size={13} className={open ? "is-open" : ""} /></button>
    {open && <><AgentFileList files={files} onOpen={onOpen} /><p className="agent-detail-note">{task.state === "succeeded" ? "本轮已验证并保存" : "工作副本中的实际变更；任务成功前不覆盖正式作品"}{truncated ? " · 大文件或超出上限的内容未完整收录" : ""}</p></>}
  </section>;
}

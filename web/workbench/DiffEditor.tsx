import { useEffect, useMemo, useState } from "react";
import { FileCode2, WrapText } from "lucide-react";
import { api, workPath, experiencePath, materialsPath, useServerEvent } from "../lib/api";
import { reviewsPath } from "../lib/reviews";
import { usePersistent } from "../lib/ui";
import { useWorkbench } from "./store";
import { parseDiff, type DiffLine } from "./diff";

/**
 * A diff shown as an editor tab. `query` is the /diff query: `file=<path>` (uncommitted
 * changes of a file), empty (all uncommitted changes) or `commit=<sha>` (one version).
 * Uncommitted diffs follow the files as they change. `source` picks the work or one of the
 * repository's shared branches (experience, materials, reviews).
 */
export function DiffEditor({ query, source = "work" }: { query: string; source?: "work" | "experience" | "materials" | "reviews" }) {
  const { work, openFile, openExperience, openReview } = useWorkbench();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Long lines (prose, JSON) wrap by default, so a change is seen without scrolling sideways.
  const [wrap, setWrap] = usePersistent("diffWrap", true);
  const experience = source === "experience";
  const base = experience
    ? experiencePath(work.repo)
    : source === "materials"
      ? materialsPath(work.repo)
      : source === "reviews"
        ? reviewsPath(work.repo)
        : workPath(work.repo, work.id);
  const scope = source === "work" ? work.id : `${source}-${work.repo}`;
  const live = !query.startsWith("commit=");
  const load = () =>
    api<{ diff: string }>(`${base}/diff?${query}`).then(
      (result) => (setText(result.diff), setError("")),
      (failure) => setError((failure as Error).message),
    );
  useEffect(() => {
    setText(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, query]);
  useServerEvent((event) => {
    if (!live) return;
    if ((event.type === "work-files" || event.type === "work-versions") && event.work === scope) void load();
    if (experience && event.type === "experience-files" && event.repo === work.repo) void load();
  });
  const files = useMemo(() => parseDiff(text ?? ""), [text]);
  const prefix = source === "work" ? `projects/${work.slug}/` : "";
  // Material library files are media: their changes show here, they do not open as text.
  const open = (path: string) => (experience ? openExperience(path) : source === "reviews" ? openReview(path) : source === "work" ? openFile(path) : undefined);

  if (error) return <div className="empty">{error}</div>;
  if (text === null) return <div className="empty">正在读取改动…</div>;
  if (!files.length) return <div className="empty">{live ? "没有未保存的修改" : "这个版本没有改动"}</div>;
  return (
    <>
      <div className="editor-toolbar">
        <span className="faint small-text grow">
          {files.length} 个文件 · <span className="diff-count add">+{files.reduce((sum, file) => sum + file.added, 0)}</span>{" "}
          <span className="diff-count del">−{files.reduce((sum, file) => sum + file.removed, 0)}</span>
        </span>
        <label className="prop-check small-text" title="长行自动换行，不用左右滚动">
          <input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.target.checked)} />
          <WrapText size={13} /> 自动换行
        </label>
      </div>
      <div className={`diff-editor ${wrap ? "wrap" : ""}`}>
        {files.map((file) => (
          <section key={file.path} className="diff-file">
            <header>
              <FileCode2 size={14} />
              <span className="ellipsis grow mono">{file.path.replace(prefix, "")}</span>
              <span className="diff-count add">+{file.added}</span>
              <span className="diff-count del">−{file.removed}</span>
              {live && file.path.startsWith(prefix) && (
                <button className="btn small" onClick={() => open(file.path.slice(prefix.length))}>
                  打开文件
                </button>
              )}
            </header>
            <div className="diff-lines">
              {file.lines.map((line, index) =>
                line.kind === "hunk" ? (
                  <div key={index} className="diff-line hunk">
                    <span className="diff-gutter" />
                    <span className="diff-gutter" />
                    <span className="diff-text">{line.text}</span>
                  </div>
                ) : (
                  <div key={index} className={`diff-line ${line.kind}`}>
                    <span className="diff-gutter">{line.old ?? ""}</span>
                    <span className="diff-gutter">{line.new ?? ""}</span>
                    <span className="diff-text">
                      <span className="diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                      <LineText line={line} />
                    </span>
                  </div>
                ),
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

/** A line's text with the characters that changed (against the line it replaced) highlighted. */
function LineText({ line }: { line: DiffLine }) {
  if (!line.marks?.length) return <>{line.text || " "}</>;
  const parts = [];
  let at = 0;
  for (const [start, end] of line.marks) {
    parts.push(line.text.slice(at, start), <mark key={start} className="diff-mark">{line.text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(line.text.slice(at));
  return <>{parts}</>;
}

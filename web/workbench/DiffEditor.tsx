import { useEffect, useMemo, useState } from "react";
import { FileCode2 } from "lucide-react";
import { api, workPath, experiencePath, useServerEvent } from "../lib/api";
import { useWorkbench } from "./store";
import { parseDiff } from "./diff";

/**
 * A diff shown as an editor tab. `query` is the /diff query: `file=<path>` (uncommitted
 * changes of a file), empty (all uncommitted changes) or `commit=<sha>` (one version).
 * Uncommitted diffs follow the files as they change. `source` picks the work or the
 * repository's experience libraries.
 */
export function DiffEditor({ query, source = "work" }: { query: string; source?: "work" | "experience" }) {
  const { work, openFile, openExperience } = useWorkbench();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const experience = source === "experience";
  const base = experience ? experiencePath(work.repo) : workPath(work.repo, work.id);
  const scope = experience ? `experience-${work.repo}` : work.id;
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
  const prefix = experience ? "" : `projects/${work.slug}/`;
  const open = (path: string) => (experience ? openExperience(path) : openFile(path));

  if (error) return <div className="empty">{error}</div>;
  if (text === null) return <div className="empty">正在读取改动…</div>;
  if (!files.length) return <div className="empty">{live ? "没有未保存的修改" : "这个版本没有改动"}</div>;
  return (
    <div className="diff-editor">
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
                    {line.text || " "}
                  </span>
                </div>
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

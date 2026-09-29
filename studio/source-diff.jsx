import { useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Columns2,
  Rows3,
  WrapText,
  Maximize2,
  Copy,
  FileDiff,
} from "lucide-react";
import { Button, bytes } from "./ui";
import { readPreference, writePreference } from "../src/ui/view-preferences";
import { parsePatch, splitRows } from "./source-diff-model.js";

const sideNames = {
  working: ["暂存区", "工作区"],
  staged: ["上次提交", "暂存区"],
  commit: ["父提交", "所选提交"],
};
const kindNames = {
  missing: "不存在",
  text: "文本",
  binary: "二进制文件",
  large: "大文件",
  lfs: "Git LFS 素材",
  unsupported: "不支持的文件类型",
};
function SideInfo({ title, side }) {
  return (
    <div className="scm-side-info">
      <strong>{title}</strong>
      <span>{kindNames[side?.kind] || "未知"}</span>
      {side?.kind !== "missing" && <small>{bytes(side?.bytes)}</small>}
      {side?.oid && <code title={side.oid}>{side.oid.slice(0, 12)}</code>}
    </div>
  );
}
export function SourceDiff({ value, expanded = false, onExpand, notify }) {
  const [mode, setMode] = useState(() =>
    readPreference("frame.scm.diff-mode", expanded ? "split" : "unified"),
  );
  const [wrap, setWrap] = useState(() =>
    readPreference("frame.scm.diff-wrap", false),
  );
  const [hunk, setHunk] = useState(0);
  const root = useRef(null);
  const parsed = useMemo(() => parsePatch(value.patch || ""), [value.patch]);
  const labels = sideNames[value.area] || sideNames.working;
  const move = (direction) => {
    const index = Math.max(
      0,
      Math.min(parsed.hunks.length - 1, hunk + direction),
    );
    setHunk(index);
    root.current
      ?.querySelector(`[data-hunk="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  if (value.conflict)
    return (
      <section className="scm-conflict-view">
        <p className="scm-notice warning">
          此文件存在合并冲突。以下为只读三方内容；请在本地 Git
          解决后刷新，不会自动覆盖任意一侧。
        </p>
        {[
          ["合并基线", value.base],
          ["本地版本（ours）", value.ours],
          ["传入版本（theirs）", value.theirs],
        ].map(([name, side]) => (
          <details key={name} open>
            <summary>{name}</summary>
            {side?.kind === "text" ? (
              <pre>{side.text.slice(0, 60000)}</pre>
            ) : (
              <SideInfo title={name} side={side} />
            )}
            {side?.text?.length > 60000 && (
              <p className="scm-hint">
                仅显示前 60,000 字符，请使用本地 Git 查看完整冲突。
              </p>
            )}
          </details>
        ))}
      </section>
    );
  const text =
    !value.binaryDiff &&
    [value.before?.kind, value.after?.kind].every((kind) =>
      ["text", "missing"].includes(kind),
    );
  return (
    <section
      className={`scm-diff ${wrap ? "wrap" : ""}`}
      ref={root}
      aria-label="文件差异"
    >
      <header className="scm-diff-toolbar">
        <span className="scm-diff-counts">
          <b className="added">+{parsed.added}</b>
          <b className="removed">−{parsed.removed}</b>
        </span>
        <div className="scm-icon-actions">
          {text && (
            <>
              <Button
                icon={mode === "split" ? Columns2 : Rows3}
                aria-label={
                  mode === "split" ? "切换为行内差异" : "切换为并排差异"
                }
                title={
                  mode === "split"
                    ? "并排视图 · 点击切换行内"
                    : "行内视图 · 点击切换并排"
                }
                onClick={() => {
                  const next = mode === "split" ? "unified" : "split";
                  setMode(next);
                  writePreference("frame.scm.diff-mode", next);
                }}
              />
              <Button
                icon={WrapText}
                aria-label="差异自动换行"
                aria-pressed={wrap}
                title="自动换行"
                onClick={() => {
                  setWrap(!wrap);
                  writePreference("frame.scm.diff-wrap", !wrap);
                }}
              />
              <Button
                icon={ArrowUp}
                aria-label="上一处差异"
                disabled={!parsed.hunks.length || hunk === 0}
                onClick={() => move(-1)}
              />
              <Button
                icon={ArrowDown}
                aria-label="下一处差异"
                disabled={hunk >= parsed.hunks.length - 1}
                onClick={() => move(1)}
              />
              <Button
                icon={Copy}
                aria-label="复制差异补丁"
                title="复制 unified diff"
                disabled={!value.patch}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(value.patch);
                    notify?.("已复制差异补丁");
                  } catch {
                    notify?.("浏览器不允许复制，请选中文本后复制", "error");
                  }
                }}
              />
            </>
          )}
          {!expanded && (
            <Button
              icon={Maximize2}
              aria-label="展开文件差异"
              title="大窗口审阅，不改变播放器布局"
              onClick={onExpand}
            />
          )}
        </div>
      </header>
      <div className="scm-diff-labels">
        <span>{labels[0]}</span>
        <span>{labels[1]}</span>
      </div>
      {!text || value.limited ? (
        <div className="scm-binary">
          <FileDiff size={30} aria-hidden="true" />
          <p>
            {value.limited ? "差异超过在线展示上限" : "此文件不提供文本行差异"}
          </p>
          <div>
            <SideInfo title={labels[0]} side={value.before} />
            <SideInfo title={labels[1]} side={value.after} />
          </div>
          <small>
            二进制与 LFS 素材显示类型、大小和对象信息；大文本单侧上限 192
            KiB。可正常暂存与提交。
          </small>
        </div>
      ) : !parsed.hunks.length ? (
        <div className="scm-diff-empty">
          没有文本行变化。可能只改变了文件名、权限，或新增了空文件。
        </div>
      ) : (
        <div
          className="scm-diff-scroll"
          tabIndex={0}
          aria-label="可滚动的差异内容"
        >
          <table
            className={`scm-diff-table ${mode === "split" ? "split" : "unified"}`}
            aria-label={mode === "split" ? "并排文件差异" : "行内文件差异"}
          >
            <colgroup>
              <col className="number-column" />
              {mode === "split" ? (
                <>
                  <col />
                  <col className="number-column" />
                  <col />
                </>
              ) : (
                <>
                  <col className="number-column" />
                  <col />
                </>
              )}
            </colgroup>
            <tbody>
              {parsed.hunks.map((section, index) => (
                <Hunk
                  key={index}
                  section={section}
                  index={index}
                  split={mode === "split"}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {parsed.truncated && (
        <p className="scm-notice">
          为保持滚动流畅，仅展示前 4,000
          行差异。复制补丁可获取接口返回的完整内容。
        </p>
      )}
      {!!parsed.hunks.length && (
        <footer className="scm-diff-footer">
          {parsed.hunks.length} 处差异 · 只读审阅，不修改文件
        </footer>
      )}
    </section>
  );
}
function Hunk({ section, index, split }) {
  return (
    <>
      <tr className="scm-hunk" data-hunk={index}>
        <td colSpan={split ? 4 : 3}>{section.header}</td>
      </tr>
      {split
        ? splitRows(section.lines).map((row, i) =>
            row.meta ? (
              <tr key={i} className="scm-diff-meta">
                <td colSpan={4}>{row.meta}</td>
              </tr>
            ) : (
              <tr key={i}>
                <td className={`line-number ${row.left?.kind || "gap"}`}>
                  {row.left?.oldLine}
                </td>
                <td className={`line-code ${row.left?.kind || "gap"}`}>
                  <code>{row.left?.text ?? ""}</code>
                </td>
                <td className={`line-number ${row.right?.kind || "gap"}`}>
                  {row.right?.newLine}
                </td>
                <td className={`line-code ${row.right?.kind || "gap"}`}>
                  <code>{row.right?.text ?? ""}</code>
                </td>
              </tr>
            ),
          )
        : section.lines.map((line, i) =>
            line.kind === "meta" ? (
              <tr key={i} className="scm-diff-meta">
                <td colSpan={3}>{line.text}</td>
              </tr>
            ) : (
              <tr key={i} className={line.kind}>
                <td className="line-number">{line.oldLine}</td>
                <td className="line-number">{line.newLine}</td>
                <td className="line-code">
                  <span className="scm-line-sign" aria-hidden="true">
                    {line.kind === "add"
                      ? "+"
                      : line.kind === "remove"
                        ? "−"
                        : " "}
                  </span>
                  <code>{line.text || " "}</code>
                </td>
              </tr>
            ),
          )}
    </>
  );
}

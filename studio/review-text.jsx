import { Fragment } from "react";

export const reviewTime = (value) => {
  const time = Math.max(0, Number(value) || 0);
  return (
    String(Math.floor(time / 60)).padStart(2, "0") +
    ":" +
    (time % 60).toFixed(2).padStart(5, "0")
  );
};
const safeLink = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
function Inline({ text, onRecall }) {
  const pattern =
    /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\b(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\b|\b(\d+(?:\.\d+)?)\s*[–—~至]\s*(\d+(?:\.\d+)?)\s*秒/g;
  const parts = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    const key = match.index;
    if (match[1]) parts.push(<strong key={key}>{match[1]}</strong>);
    else if (match[2]) parts.push(<code key={key}>{match[2]}</code>);
    else if (match[3]) {
      const href = safeLink(match[4]);
      parts.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {match[3]}
          </a>
        ) : (
          match[0]
        ),
      );
    } else {
      const context = match[5]
        ? { time: Number(match[5]) * 60 + Number(match[6]) }
        : {
            time: Number(match[7]),
            start: Number(match[7]),
            end: Number(match[8]),
          };
      const valid =
        context.time <= 3600 &&
        (!context.end || (context.end > context.start && context.end <= 3600));
      parts.push(
        onRecall && valid ? (
          <button
            type="button"
            className="inline-time"
            key={key}
            onClick={() => onRecall(context)}
          >
            {match[0]}
          </button>
        ) : (
          match[0]
        ),
      );
    }
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  );
}
/** Small Markdown view: raw HTML is React-escaped; no remote images or HTML injection. */
export function ReviewText({ text = "", onRecall }) {
  const lines = String(text).replaceAll("\r\n", "\n").split("\n"),
    blocks = [];
  let i = 0;
  while (i < lines.length) {
    const key = i,
      line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*`{3}/.test(line)) {
      const language = line.replace(/^\s*`{3}/, "").trim(),
        code = [];
      i++;
      while (i < lines.length && !/^\s*`{3}/.test(lines[i]))
        code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key} aria-label={language ? language + " 代码" : "代码"}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      blocks.push(
        <h4 key={key}>
          <Inline text={heading[1]} onRecall={onRecall} />
        </h4>,
      );
      i++;
      continue;
    }
    const list = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = !list[1],
        items = [];
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
        if (!item || !item[1] !== ordered) break;
        items.push(
          <li key={i}>
            <Inline text={item[2]} onRecall={onRecall} />
          </li>,
        );
        i++;
      }
      blocks.push(
        ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push(
        <blockquote key={key}>
          <Inline text={line.replace(/^>\s?/, "")} onRecall={onRecall} />
        </blockquote>,
      );
      i++;
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(?:\s*`{3}|#{1,6}\s|\s*(?:[-*+]|\d+[.)])\s|>)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    blocks.push(
      <p key={key}>
        <Inline text={paragraph.join("\n")} onRecall={onRecall} />
      </p>,
    );
  }
  return <div className="review-text">{blocks}</div>;
}

export function ReviewContext({ context, onRecall, onRemove }) {
  if (!context) return null;
  const range =
    Number.isFinite(context.start) &&
    Number.isFinite(context.end) &&
    context.end > context.start;
  return (
    <div className="review-context">
      {(range || Number.isFinite(context.time)) && (
        <span className="context-chip">
          <button
            type="button"
            onClick={() => onRecall?.(context)}
            title="跳转到引用位置"
          >
            {range
              ? "选段 " +
                reviewTime(context.start) +
                "—" +
                reviewTime(context.end)
              : "时间 " + reviewTime(context.time)}
            {context.sourceCommit && <small className="reference-version">版本 {context.sourceCommit.slice(0, 7)}</small>}
            {context.liveSessionId && context.sourceRevision && <small className="reference-version">{context.draftTask ? "AI 草稿" : "实时版本"} {context.sourceRevision.slice(0, 7)}</small>}
          </button>
          {onRemove && (
            <button type="button" aria-label="移除时间引用" onClick={onRemove}>
              ×
            </button>
          )}
        </span>
      )}
      {(context.assets || []).map((id, index) => (
        <span
          className="context-chip asset-reference"
          key={id}
          title={context.assetNames?.[id] || id}
        >
          {context.assetNames?.[id] || "参考素材 " + (index + 1)}
        </span>
      ))}
    </div>
  );
}

import { Children, createContext, useContext, useEffect, useRef, useState, isValidElement, cloneElement, memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

const Actions = createContext({});
export function AgentCopy({ text, label = "复制", className = "", notify }) {
  const [copied, setCopied] = useState(false), timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className={"agent-copy " + className} aria-label={label} title={copied ? "已复制" : label} onClick={async () => {
    try { await navigator.clipboard.writeText(text || ""); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); }
    catch { notify?.("复制失败，请选择文字复制", "error"); }
  }}>{copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? "已复制" : label}</span></button>;
}
function plain(children) { return Children.toArray(children).map((child) => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement(child) ? plain(child.props.children) : "").join(""); }
function CodeBlock({ children }) {
  const { notify } = useContext(Actions), [expanded, setExpanded] = useState(false), ref = useRef(null);
  const code = Children.toArray(children).find(isValidElement), source = plain(code?.props.children ?? children).replace(/\n$/, "");
  const language = code?.props.className?.match(/language-([^\s]+)/)?.[1] || "text";
  const long = source.split("\n").length > 16;
  return <section className={"agent-code-block " + (expanded ? "expanded" : "")}>
    <header><span>{language}</span><AgentCopy text={source} label="复制代码" notify={notify} /></header>
    <pre ref={ref} tabIndex={0} aria-label={language + " 代码"}>{children}</pre>
    {long && <button type="button" className="agent-code-expand" onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{expanded ? "收起代码" : "展开完整代码"}</button>}
  </section>;
}
const timePattern = /\b(\d{1,2}):(\d{2}(?:\.\d{1,3})?)(?:\s*[—–~至-]\s*(\d{1,2}):(\d{2}(?:\.\d{1,3})?))?\b|\b(\d+(?:\.\d+)?)\s*[—–~至]\s*(\d+(?:\.\d+)?)\s*秒/g;
function TimeText({ children }) {
  const { onRecall } = useContext(Actions);
  if (!onRecall) return children;
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts = []; let at = 0;
    for (const match of child.matchAll(timePattern)) {
      const start = match[1] ? Number(match[1]) * 60 + Number(match[2]) : Number(match[5]);
      const end = match[3] ? Number(match[3]) * 60 + Number(match[4]) : match[6] ? Number(match[6]) : undefined;
      if (start > 3600 || (end !== undefined && (end <= start || end > 3600))) continue;
      parts.push(child.slice(at, match.index), <button type="button" className="inline-time" key={match.index} onClick={() => onRecall({ time: start, ...(end !== undefined ? { start, end } : {}) })}>{match[0]}</button>);
      at = match.index + match[0].length;
    }
    if (!at) return child; parts.push(child.slice(at)); return parts;
  });
}
function Link({ href, children, title }) {
  const { onFile } = useContext(Actions);
  if (!href) return <span>{children}</span>;
  if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer" title={title || href}>{children}</a>;
  if (href.startsWith("#")) return <span>{children}</span>;
  const location = href.replace(/^\/workspace\//, "").split(/[?#]/)[0];
  if (onFile) return <button type="button" className="agent-file-link" onClick={() => onFile(location)} title="查看本轮记录的文件变更">{children}</button>;
  return <code>{children}</code>;
}
const components = {
  pre: CodeBlock,
  p: ({ children }) => <p><TimeText>{children}</TimeText></p>,
  li: ({ children, className }) => <li className={className}><TimeText>{children}</TimeText></li>,
  h1: ({ children }) => <h3>{children}</h3>, h2: ({ children }) => <h4>{children}</h4>, h3: ({ children }) => <h4>{children}</h4>,
  a: Link,
  img: ({ src, alt }) => /^https?:\/\//i.test(src || "") ? <a href={src} target="_blank" rel="noopener noreferrer" className="agent-image-link"><ExternalLink size={12} />{alt || "查看引用图片"}</a> : <span>{alt || "图片引用"}</span>,
  table: ({ children }) => <div className="agent-table-scroll" tabIndex={0}><table>{children}</table></div>,
};
const remarkPlugins = [remarkGfm], rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];
export const AgentMarkdown = memo(function AgentMarkdown({ text = "", onRecall, onFile, notify, streaming = false }) {
  return <Actions.Provider value={{ onRecall, onFile, notify }}><div className={"agent-markdown review-text " + (streaming ? "is-streaming" : "")}><Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{String(text)}</Markdown></div></Actions.Provider>;
});

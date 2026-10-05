import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useWorkbench } from "../workbench/store";

const TIME = /(\d{1,2}:\d{2}(?:\.\d{1,3})?)/g;

/** Markdown with clickable time codes ("0:12.5" seeks the player) and file links. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const { stage, openFile } = useWorkbench();
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: false }]]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
            const text = String(children);
            const file = !className && /^[\w./-]+\.(ts|tsx|js|json|md|svg|png|jpg|wav|mp3)(:\d+)?$/.test(text) ? text : null;
            if (file) {
              const [path, line] = file.split(":");
              return (
                <code className="file-link" onClick={() => openFile(path.replace(/^projects\/[^/]+\//, ""), { line: line ? Number(line) : undefined })}>
                  {text}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          p: ({ children }) => <p>{linkTimes(children, (seconds) => stage.seek(seconds))}</p>,
          li: ({ children }) => <li>{linkTimes(children, (seconds) => stage.seek(seconds))}</li>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function linkTimes(children: React.ReactNode, seek: (seconds: number) => void): React.ReactNode {
  if (typeof children === "string") {
    const parts = children.split(TIME);
    if (parts.length === 1) return children;
    return parts.map((part, index) => {
      if (index % 2 === 0) return part;
      const [m, s] = part.split(":");
      const seconds = Number(m) * 60 + Number(s);
      return (
        <button key={index} className="time-link" title="跳到这个时间" onClick={() => seek(seconds)}>
          {part}
        </button>
      );
    });
  }
  if (Array.isArray(children)) return children.map((child, index) => <span key={index}>{linkTimes(child, seek)}</span>);
  return children;
}

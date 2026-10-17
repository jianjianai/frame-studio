import { useEffect, useRef, useState } from "react";

/** SVG-Edit's host page (src/svg-editor, served by server/svg-editor.mjs). */
const FRAME = "/svg-editor/frame.html";

interface FrameMessage {
  svgEditor: true;
  type: "ready" | "loaded" | "error" | "change" | "save" | "selection";
  text?: string | null;
  message?: string;
  items?: string[];
}

/**
 * An SVG drawn and edited in SVG-Edit (paths node by node, shapes, text, gradients, layers…).
 * It runs in a sandboxed frame, an origin of its own: what an SVG may carry never acts as the
 * studio. The frame gets `value` and sends back the text after each change; the tab keeps it
 * like the code editor's, and saves it (Ctrl+S in the frame asks for that too).
 */
export function SvgEditor({
  value,
  onChange,
  onSave,
  onSelection,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** What is selected: `#id` for the file's ids, else `<tag>`. */
  onSelection?: (items: string[]) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"opening" | "ready" | { error: string }>("opening");
  const callbacks = useRef({ onChange, onSave, onSelection });
  callbacks.current = { onChange, onSave, onSelection };
  const latest = useRef(value);
  latest.current = value;
  /** The text the frame opened, and the last one it sent: the tab's text is one of them unless it came from elsewhere. */
  const opened = useRef<string | null>(null);
  const sent = useRef<string | null>(null);
  const ready = useRef(false);

  const open = (text: string) => {
    opened.current = sent.current = text;
    frame.current?.contentWindow?.postMessage({ type: "load", text }, "*");
  };
  useEffect(() => {
    const receive = (event: MessageEvent<FrameMessage>) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.svgEditor) return;
      const message = event.data;
      if (message.type === "ready") {
        ready.current = true;
        open(latest.current);
      } else if (message.type === "loaded") setState("ready");
      else if (message.type === "error") setState({ error: message.message ?? "SVG 编辑器出错了" });
      else if (message.type === "change") {
        // null: every change undone, the text as it was opened.
        const text = message.text ?? opened.current ?? "";
        sent.current = text;
        callbacks.current.onChange(text);
      } else if (message.type === "save") callbacks.current.onSave();
      else if (message.type === "selection") callbacks.current.onSelection?.(message.items ?? []);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      callbacks.current.onSelection?.([]);
    };
  }, []);
  // A text from elsewhere (the code view, the file changed on disk and loaded again): the frame opens it.
  useEffect(() => {
    if (ready.current && value !== sent.current && value !== opened.current) open(value);
  }, [value]);

  return (
    <div className="svg-editor">
      <iframe ref={frame} src={FRAME} sandbox="allow-scripts" title="SVG 编辑器" />
      {state !== "ready" && <div className="svg-editor-state">{state === "opening" ? "正在打开 SVG 编辑器…" : state.error}</div>}
    </div>
  );
}

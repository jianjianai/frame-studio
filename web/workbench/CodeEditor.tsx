import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const language = (path: string) => {
  if (/\.json$/i.test(path)) return json();
  if (/\.md$/i.test(path)) return markdown();
  if (/\.(ts|tsx|js|mjs|jsx)$/i.test(path)) return javascript({ typescript: /\.tsx?$/i.test(path), jsx: /x$/i.test(path) });
  return [];
};

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syntax-function)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
  { tag: [tags.propertyName], color: "var(--syntax-property)" },
  { tag: [tags.heading], color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--bg-hover) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
  ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--fg)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-elev)", border: "1px solid var(--border-strong)" },
  ".cm-searchMatch": { backgroundColor: "rgb(227 169 72 / 0.3)" },
});

/** Light code editing for people; AI does most of the writing. Ctrl+S saves. */
export function CodeEditor({
  path,
  value,
  line,
  onChange,
  onSave,
  readOnly = false,
}: {
  path: string;
  value: string;
  line?: number;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const languageSlot = useRef(new Compartment());
  const lockSlot = useRef(new Compartment());
  const locked = (on: boolean) => [EditorState.readOnly.of(on), EditorView.editable.of(!on)];

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          languageSlot.current.of(language(path)),
          lockSlot.current.of(locked(readOnly)),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => editor.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    view.current?.dispatch({ effects: lockSlot.current.reconfigure(locked(readOnly)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // External content (reloaded from disk) replaces the document.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !line) return;
    const target = editor.state.doc.line(Math.min(Math.max(1, line), editor.state.doc.lines));
    editor.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    editor.focus();
  }, [line]);

  return <div className="code-editor" ref={host} />;
}

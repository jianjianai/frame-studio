import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { X, MonitorPlay, FileCode2, FileImage, FileAudio, FileVideo, File as FileIcon, Circle } from "lucide-react";
import { api, workPath, useServerEvent } from "../lib/api";
import { Sash, usePersistent, useToast, useConfirm } from "../lib/ui";
import { useWorkbench } from "./store";
import { PreviewPane } from "./PreviewPane";
import { CodeEditor } from "./CodeEditor";

export interface EditorHandle {
  openFile(path: string, options?: { line?: number }): void;
}
interface Tab {
  path: string;
  kind: "text" | "image" | "audio" | "video" | "file";
  content?: string;
  saved?: string;
  hash?: string | null;
  external?: boolean;
  line?: number;
}

const kindOf = (path: string): Tab["kind"] =>
  /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(path)
    ? "image"
    : /\.(wav|mp3|m4a|ogg|opus|flac|aac|weba)$/i.test(path)
      ? "audio"
      : /\.(mp4|webm|mov|m4v)$/i.test(path)
        ? "video"
        : /\.(ts|tsx|js|mjs|jsx|json|md|txt|css|html|glsl|frag|vert|srt|vtt|csv|ya?ml|toml)$/i.test(path)
          ? "text"
          : "file";

export const fileIcon = (path: string, size = 14) => {
  const kind = kindOf(path);
  return kind === "image" ? (
    <FileImage size={size} />
  ) : kind === "audio" ? (
    <FileAudio size={size} />
  ) : kind === "video" ? (
    <FileVideo size={size} />
  ) : kind === "text" ? (
    <FileCode2 size={size} />
  ) : (
    <FileIcon size={size} />
  );
};

/** Preview on the left; opened files in a second group on the right ("open to the side"). */
export function EditorArea({ ref }: { ref?: Ref<EditorHandle> }) {
  const { work } = useWorkbench();
  const toast = useToast();
  const confirm = useConfirm();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [split, setSplit] = usePersistent("editor-split", 0.5);
  const container = useRef<HTMLDivElement>(null);
  const base = workPath(work.repo, work.id);

  const load = useCallback(
    async (path: string) => {
      const file = await api<{ content: string; hash: string }>(`${base}/file?path=${encodeURIComponent(path)}`);
      return { content: file.content, saved: file.content, hash: file.hash };
    },
    [base],
  );

  const openFile = useCallback(
    async (path: string, options: { line?: number } = {}) => {
      setActive(path);
      if (tabs.some((tab) => tab.path === path)) {
        if (options.line) setTabs((list) => list.map((tab) => (tab.path === path ? { ...tab, line: options.line } : tab)));
        return;
      }
      const kind = kindOf(path);
      const tab: Tab = { path, kind, line: options.line };
      setTabs((list) => [...list, tab]);
      if (kind === "text") {
        try {
          const loaded = await load(path);
          setTabs((list) => list.map((item) => (item.path === path ? { ...item, ...loaded } : item)));
        } catch (error) {
          toast((error as Error).message, "error");
          setTabs((list) => list.filter((item) => item.path !== path));
        }
      }
    },
    [tabs, load, toast],
  );
  useImperativeHandle(ref, () => ({ openFile: (path, options) => void openFile(path, options) }), [openFile]);

  // Files changed by AI or other tools: refresh clean tabs, flag dirty ones.
  useServerEvent(
    (event) => {
      if (event.type !== "work-files" || event.work !== work.id) return;
      const changed = new Set((event.files as string[]).map((file) => file.replace(/^projects\/[^/]+\//, "")));
      for (const tab of tabs) {
        if (tab.kind !== "text" || !changed.has(tab.path)) continue;
        void load(tab.path).then(
          (loaded) =>
            setTabs((list) =>
              list.map((item) => {
                if (item.path !== tab.path || loaded.hash === item.hash) return item;
                return item.content === item.saved ? { ...item, ...loaded, external: false } : { ...item, external: true };
              }),
            ),
          () => {},
        );
      }
    },
    [tabs, work.id],
  );

  const save = async (path: string) => {
    const tab = tabs.find((item) => item.path === path);
    if (!tab || tab.content === undefined) return;
    try {
      const result = await api<{ hash: string }>(`${base}/file`, {
        method: "PUT",
        body: { path, content: tab.content, expectedHash: tab.external ? undefined : tab.hash },
      });
      setTabs((list) => list.map((item) => (item.path === path ? { ...item, saved: tab.content, hash: result.hash, external: false } : item)));
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const close = async (path: string) => {
    const tab = tabs.find((item) => item.path === path);
    if (tab && tab.content !== tab.saved && !(await confirm(`${path} 有未保存的修改，确定关闭？`, { confirm: "不保存并关闭", danger: true }))) return;
    const index = tabs.findIndex((item) => item.path === path);
    const next = tabs.filter((item) => item.path !== path);
    setTabs(next);
    if (active === path) setActive(next[Math.min(index, next.length - 1)]?.path ?? null);
  };
  const current = tabs.find((tab) => tab.path === active) ?? null;

  return (
    <div className="editor-area" ref={container}>
      <div className="editor-group" style={{ flex: tabs.length ? `${split} 1 0` : "1 1 0" }}>
        <div className="editor-tabs">
          <div className="editor-tab active">
            <MonitorPlay size={14} /> 预览
          </div>
        </div>
        <PreviewPane />
      </div>
      {tabs.length > 0 && (
        <>
          <Sash
            direction="vertical"
            onDrag={(delta) => {
              const width = container.current?.clientWidth || 1;
              setSplit((value) => Math.max(0.2, Math.min(0.8, value + delta / width)));
            }}
          />
          <div className="editor-group" style={{ flex: `${1 - split} 1 0` }}>
            <div className="editor-tabs">
              {tabs.map((tab) => (
                <div
                  key={tab.path}
                  className={`editor-tab ${tab.path === active ? "active" : ""}`}
                  title={tab.path}
                  onClick={() => setActive(tab.path)}
                  onMouseDown={(event) => event.button === 1 && (event.preventDefault(), void close(tab.path))}
                >
                  {fileIcon(tab.path)}
                  <span className="ellipsis">{tab.path.split("/").pop()}</span>
                  <button
                    className="tab-close"
                    aria-label="关闭"
                    onClick={(event) => {
                      event.stopPropagation();
                      void close(tab.path);
                    }}
                  >
                    {tab.content !== tab.saved ? <Circle size={9} fill="currentColor" /> : <X size={13} />}
                  </button>
                </div>
              ))}
            </div>
            {current && (
              <div className="editor-content">
                {current.external && (
                  <div className="editor-banner">
                    这个文件已被 AI 或其他程序修改。
                    <button
                      className="btn small"
                      onClick={() =>
                        load(current.path).then((loaded) =>
                          setTabs((list) => list.map((item) => (item.path === current.path ? { ...item, ...loaded, external: false } : item))),
                        )
                      }
                    >
                      载入新版本（丢弃我的修改）
                    </button>
                    <button className="btn small" onClick={() => save(current.path)}>
                      用我的版本覆盖
                    </button>
                  </div>
                )}
                {current.kind === "text" ? (
                  current.content === undefined ? (
                    <div className="empty">正在读取…</div>
                  ) : (
                    <CodeEditor
                      key={current.path}
                      path={current.path}
                      value={current.content}
                      line={current.line}
                      onChange={(content) => setTabs((list) => list.map((item) => (item.path === current.path ? { ...item, content } : item)))}
                      onSave={() => save(current.path)}
                    />
                  )
                ) : (
                  <MediaViewer path={current.path} kind={current.kind} />
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MediaViewer({ path, kind }: { path: string; kind: Tab["kind"] }) {
  const { work } = useWorkbench();
  const [version, setVersion] = useState(0);
  useEffect(() => setVersion(Date.now()), [path]);
  const url = `${workPath(work.repo, work.id)}/raw?path=${encodeURIComponent(path)}&v=${version}`;
  return (
    <div className="media-viewer">
      {kind === "image" && <img src={url} alt={path} />}
      {kind === "audio" && <audio src={url} controls />}
      {kind === "video" && <video src={url} controls />}
      {kind === "file" && <div className="empty">无法在这里预览这种文件</div>}
      <div className="faint mono">{path}</div>
    </div>
  );
}

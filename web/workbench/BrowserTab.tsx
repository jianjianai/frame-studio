import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, FolderInput, Globe, Keyboard, KeyRound, Laptop, Loader2, LogOut, MoreVertical, Plus, RotateCw, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { browserPath, focusRemote, loginDone, onWantedTab, takeWantedTab, useBrowserState, type BrowserTabInfo } from "../lib/browser";
import { coarsePointer } from "../lib/touch";
import { Dialog, useConfirm, useContextMenu, useToast } from "../lib/ui";
import { useTabVisible, useWorkbench } from "./store";

type Viewport = { width: number; height: number };
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "Fn", "OS", "Dead"]);
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/** The page drawn at its CSS size, smaller when another viewer made it larger than this stage. */
function canvasSize(view: Viewport | null, stage: Viewport | null) {
  if (!view || !stage) return { visibility: "hidden" as const };
  const scale = Math.min(1, stage.width / view.width, stage.height / view.height);
  return { width: Math.floor(view.width * scale), height: Math.floor(view.height * scale) };
}

/**
 * The studio's logged-in browser (server/browser.mjs) in an editor tab: the server streams the
 * page it shows as pictures and this tab sends the mouse, touch, keys and typed text back. The
 * user logs in to sites here (the AI never sees passwords); the AI's tabs are here too, so what
 * it does can be watched. Text goes through a hidden text field, so input methods (pinyin) and
 * phone keyboards work.
 */
export function BrowserTab() {
  const { work } = useWorkbench();
  const visible = useTabVisible();
  const toast = useToast();
  const confirm = useConfirm();
  const [openMenu, menu] = useContextMenu();
  // Each repository has its own browser: its logins are for its works only.
  const repo = work.repo;
  const { tabs, downloads, computers, remoteTabs } = useBrowserState(repo);
  const [pairing, setPairing] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [stageSize, setStageSize] = useState<Viewport | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const measured = useRef<Viewport | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const touch = coarsePointer();

  const send = useCallback((message: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  // Frames are drawn as they come; one decoding at a time, the newest waiting (older ones are dropped).
  const pending = useRef<Blob | null>(null);
  const decoding = useRef(false);
  const draw = useCallback(async () => {
    if (decoding.current) return;
    decoding.current = true;
    try {
      while (pending.current) {
        const blob = pending.current;
        pending.current = null;
        const bitmap = await createImageBitmap(blob).catch(() => null);
        const element = canvas.current;
        if (!bitmap || !element) continue;
        if (element.width !== bitmap.width || element.height !== bitmap.height) {
          element.width = bitmap.width;
          element.height = bitmap.height;
        }
        element.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      }
    } finally {
      decoding.current = false;
    }
  }, []);

  // The connection: opened once the stage has a size, reopened after it drops.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const { width, height } = measured.current!;
      const tab = takeWantedTab() ?? currentRef.current;
      const query = new URLSearchParams({ repo, width: String(width), height: String(height), dpr: String(devicePixelRatio || 1), ...(tab ? { tab } : {}), ...(visibleRef.current ? {} : { paused: "1" }) });
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/browser/view?${query}`);
      ws.binaryType = "blob";
      socket.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          pending.current = event.data;
          void draw();
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "view") {
          // The viewport message that follows is for this tab.
          currentRef.current = message.tab;
          setCurrent(message.tab);
        }
        else if (message.type === "viewport" && message.tab === currentRef.current) setViewport({ width: message.width, height: message.height });
        else if (message.type === "focus" && message.editable && touch) keys.current?.focus({ preventScroll: true });
        else if (message.type === "error") toast(message.message, "error");
      };
      ws.onclose = () => {
        setConnected(false);
        if (socket.current === ws) socket.current = null;
        if (!closed) retry = setTimeout(open, 1500);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
    };
  }, [ready, draw, toast, touch, repo]);

  // The stage's size is the page's (sent a moment after it settles).
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const width = Math.floor(element.clientWidth);
      const height = Math.floor(element.clientHeight);
      if (width < 50 || height < 50) return;
      const first = !measured.current;
      measured.current = { width, height };
      setStageSize({ width, height });
      if (first) setReady(true);
      clearTimeout(timer);
      timer = setTimeout(() => send({ type: "size", width, height, dpr: devicePixelRatio || 1 }), 150);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [send]);

  // Out of sight, no frames.
  useEffect(() => send({ type: visible ? "resume" : "pause" }), [visible, send, connected]);
  // A login the AI asked for while this tab is open.
  useEffect(() => onWantedTab((tab) => (takeWantedTab(), send({ type: "show", tab }))), [send]);

  const tab: BrowserTabInfo | undefined = tabs.find((item) => item.id === current);
  useEffect(() => setAddress(null), [current, tab?.url]);

  /** The page's CSS pixel under a pointer. */
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    const view = viewportRef.current ?? measured.current!;
    return { x: ((event.clientX - rect.left) / rect.width) * view.width, y: ((event.clientY - rect.top) / rect.height) * view.height };
  };
  const placeKeys = (event: { clientX: number; clientY: number }) => {
    // The hidden field sits where the user clicked: an input method's candidates show there.
    const rect = stage.current!.getBoundingClientRect();
    if (keys.current) {
      keys.current.style.left = `${event.clientX - rect.left}px`;
      keys.current.style.top = `${event.clientY - rect.top}px`;
    }
  };

  // Mouse: as it is (clicks counted here: pointer events carry no click count). Touch: a tap clicks, a drag scrolls.
  const drag = useRef<{ x: number; y: number; at: number; scrolled: boolean; last: { x: number; y: number } } | null>(null);
  const moveFrame = useRef<number | null>(null);
  const lastMove = useRef<{ x: number; y: number } | null>(null);
  const lastDown = useRef({ at: 0, x: 0, y: 0, clicks: 0 });
  const button = (event: React.PointerEvent) => ["left", "middle", "right"][event.button] ?? "left";
  const onPointerDown = (event: React.PointerEvent) => {
    if (!canvas.current) return;
    placeKeys(event);
    if (event.pointerType === "mouse") {
      event.currentTarget.setPointerCapture(event.pointerId);
      const previous = lastDown.current;
      const again = Date.now() - previous.at < 500 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 5;
      lastDown.current = { at: Date.now(), x: event.clientX, y: event.clientY, clicks: again ? Math.min(3, previous.clicks + 1) : 1 };
      send({ type: "mouse", action: "down", ...point(event), button: button(event), clicks: lastDown.current.clicks });
    } else {
      // No mouse events made up from the touch afterwards.
      event.preventDefault();
      drag.current = { x: event.clientX, y: event.clientY, at: Date.now(), scrolled: false, last: { x: event.clientX, y: event.clientY } };
    }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") {
      lastMove.current = point(event);
      moveFrame.current ??= requestAnimationFrame(() => {
        moveFrame.current = null;
        if (lastMove.current) send({ type: "mouse", action: "move", ...lastMove.current });
      });
      return;
    }
    const state = drag.current;
    if (!state) return;
    if (!state.scrolled && Math.hypot(event.clientX - state.x, event.clientY - state.y) > 8) state.scrolled = true;
    if (!state.scrolled) return;
    const dx = state.last.x - event.clientX;
    const dy = state.last.y - event.clientY;
    state.last = { x: event.clientX, y: event.clientY };
    const view = viewportRef.current ?? measured.current!;
    const rect = canvas.current!.getBoundingClientRect();
    send({ type: "wheel", ...point(event), dx: (dx / rect.width) * view.width, dy: (dy / rect.height) * view.height });
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") {
      send({ type: "mouse", action: "up", ...point(event), button: button(event), clicks: lastDown.current.clicks || 1 });
      return;
    }
    const state = drag.current;
    drag.current = null;
    if (!state || state.scrolled || Date.now() - state.at > 700) return;
    const at = point(event);
    send({ type: "mouse", action: "down", ...at, button: "left", clicks: 1 });
    send({ type: "mouse", action: "up", ...at, button: "left", clicks: 1 });
  };
  // The wheel scrolls the page, not the studio (a passive React listener could not stop that).
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      send({ type: "wheel", ...point(event), dx: event.deltaX * scale, dy: event.deltaY * scale });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, ready]);

  // Typing: keys that are not text go as keys; text (also from input methods and phone keyboards) as text.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (native.isComposing || event.key === "Process" || event.key === "Unidentified" || native.keyCode === 229) return;
    if (MODIFIER_KEYS.has(event.key)) return;
    const command = event.ctrlKey || event.metaKey;
    // Paste arrives as a paste event, with the text.
    if (command && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    event.stopPropagation();
    const modifiers = [event.ctrlKey && "Control", event.altKey && "Alt", event.metaKey && "Meta", event.shiftKey && event.key.length > 1 && "Shift"].filter(Boolean);
    send({ type: "key", key: event.key, modifiers });
  };
  useEffect(() => {
    const element = keys.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      if (event.inputType === "insertText" && event.data) send({ type: "text", text: event.data });
      else if (event.inputType === "deleteContentBackward") send({ type: "key", key: "Backspace" });
      else if (event.inputType === "deleteContentForward") send({ type: "key", key: "Delete" });
      else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") send({ type: "key", key: "Enter" });
      else return;
      event.preventDefault();
    };
    const compositionEnd = (event: CompositionEvent) => {
      if (event.data) send({ type: "text", text: event.data });
      element.value = "";
    };
    const paste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      event.preventDefault();
      if (text) send({ type: "text", text });
    };
    element.addEventListener("beforeinput", beforeInput);
    element.addEventListener("compositionend", compositionEnd);
    element.addEventListener("paste", paste);
    return () => {
      element.removeEventListener("beforeinput", beforeInput);
      element.removeEventListener("compositionend", compositionEnd);
      element.removeEventListener("paste", paste);
    };
  }, [send]);

  const go = (text: string) => {
    if (!text.trim()) return;
    send(current ? { type: "go", url: text.trim() } : { type: "new", url: text.trim() });
    setAddress(null);
    if (!touch) keys.current?.focus({ preventScroll: true });
  };
  const signOut = async () => {
    if (!tab) return;
    const host = hostOf(tab.url);
    if (!(await confirm(`退出 ${host}：清除这个网站在这个作品库的浏览器里的登录信息（cookie 和网站存的数据）。之后这个作品库的 AI 也不能再以你的身份访问它。`, { confirm: "退出", danger: true }))) return;
    try {
      const result = await api<{ site: string }>(`${browserPath(repo)}/tabs/${encodeURIComponent(tab.id)}/sign-out`, { method: "POST" });
      toast(`已退出 ${result.site}`, "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const clearAll = async () => {
    if (!(await confirm(`清除这个作品库（${repo === "local" ? "本地" : repo}）的浏览器里所有网站的登录信息、浏览记录和缓存，并关掉所有标签页（包括 AI 正在用的）。其他作品库的不受影响。不能撤销。`, { confirm: "全部清除", danger: true }))) return;
    try {
      await api(`${browserPath(repo)}/clear`, { method: "POST" });
      toast("已清除全部登录信息", "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const importDownload = async (id: string) => {
    try {
      const result = await api<{ path: string }>(`${browserPath(repo)}/downloads/${id}/import`, { body: { work: work.id } });
      toast(`已放进作品：${result.path}`, "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const recent = downloads.filter((item) => Date.now() - item.at < 60 * 60 * 1000).slice(0, 4);

  return (
    <div className="browser-tab">
      <div className="browser-tabs" role="tablist">
        {tabs.map((item) => (
          <div
            key={item.id}
            role="tab"
            aria-selected={item.id === current}
            className={`browser-tabs-item ${item.id === current ? "active" : ""}`}
            title={`${item.title || item.url}${item.owner === "ai" ? "（AI 的标签页）" : ""}`}
            onClick={() => send({ type: "show", tab: item.id })}
          >
            {item.loading ? <Loader2 size={12} className="spin" /> : item.owner === "ai" ? <Sparkles size={12} className={item.ai ? "accent-text" : "faint"} /> : <Globe size={12} className="faint" />}
            {item.login && <KeyRound size={12} className="warn-text" />}
            <span className="ellipsis">{item.title || hostOf(item.url) || "新标签页"}</span>
            <button
              className="icon-btn tiny"
              title="关闭"
              onClick={(event) => {
                event.stopPropagation();
                send({ type: "close", tab: item.id });
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn" title="新标签页" onClick={() => send({ type: "new" })}>
          <Plus size={14} />
        </button>
        <span className="grow" />
        <span className="browser-repo faint" title="每个作品库有自己的浏览器：这里登录的网站只有这个作品库的作品和 AI 能用">
          {repo === "local" ? "本地" : repo} 的浏览器
        </span>
      </div>
      <div className="browser-bar">
        <button className="icon-btn" title="后退" disabled={!tab} onClick={() => send({ type: "back" })}>
          <ArrowLeft size={15} />
        </button>
        <button className="icon-btn" title="前进" disabled={!tab} onClick={() => send({ type: "forward" })}>
          <ArrowRight size={15} />
        </button>
        <button className="icon-btn" title="刷新" disabled={!tab} onClick={() => send({ type: "reload" })}>
          <RotateCw size={14} />
        </button>
        <input
          className="input browser-address"
          value={address ?? (tab?.url === "about:blank" ? "" : (tab?.url ?? ""))}
          placeholder="输入网址或搜索"
          spellCheck={false}
          autoCapitalize="off"
          enterKeyHint="go"
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.target.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") go(event.currentTarget.value);
            else if (event.key === "Escape") setAddress(null);
          }}
        />
        {touch && (
          <button className={`icon-btn ${typing ? "active" : ""}`} title="键盘：在网页里打字" onClick={() => keys.current?.focus({ preventScroll: true })}>
            <Keyboard size={15} />
          </button>
        )}
        <button
          className="icon-btn"
          title="更多"
          onClick={(event) =>
            openMenu(event, [
              { label: tab ? `退出 ${hostOf(tab.url) || "这个网站"}` : "退出这个网站", icon: <LogOut size={14} />, onClick: signOut, disabled: !tab || !/^https?:/.test(tab.url) },
              "separator",
              { label: "清除全部登录信息…", icon: <Trash2 size={14} />, onClick: clearAll, danger: true },
            ])
          }
        >
          <MoreVertical size={15} />
        </button>
      </div>
      <ComputerStrip repo={repo} computers={computers} remoteTabs={remoteTabs} onManage={() => setPairing(true)} />
      {tab?.login && (
        <div className="browser-note warn">
          <KeyRound size={14} />
          <span className="grow">
            AI 请你登录 <strong>{tab.login.host}</strong>：{tab.login.reason}。在下面的网页里登录（扫码、输入密码、通过验证都在这里，不要发到聊天里）。
          </span>
          <button
            className="btn small primary"
            onClick={() =>
              loginDone(repo, tab.id).then(
                (result) => toast(result.notified ? "已告诉 AI" : "好的", "ok"),
                (error) => toast((error as Error).message, "error"),
              )
            }
          >
            登录好了
          </button>
        </div>
      )}
      {tab?.ai && !tab.login && (
        <div className="browser-note">
          <Sparkles size={14} className="accent-text" /> AI 正在用这个标签页
        </div>
      )}
      <div className={`browser-stage ${typing ? "typing" : ""}`} ref={stage}>
        <canvas
          ref={canvas}
          className="browser-canvas"
          style={canvasSize(viewport ?? stageSize, stageSize)}
          onMouseDown={(event) => {
            // The page gets the keys after a click on it.
            event.preventDefault();
            if (!touch) keys.current?.focus({ preventScroll: true });
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          onContextMenu={(event) => event.preventDefault()}
        />
        <textarea
          ref={keys}
          className="browser-keys"
          aria-label="在网页里打字"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
        />
        {!connected && (
          <div className="browser-overlay">
            <Loader2 size={16} className="spin" /> 正在连接浏览器…
          </div>
        )}
        {connected && !current && (
          <div className="browser-overlay">
            <span>浏览器没有打开的网页</span>
            <button className="btn small" onClick={() => send({ type: "new" })}>
              <Plus size={13} /> 新标签页
            </button>
          </div>
        )}
      </div>
      {recent.length > 0 && (
        <div className="browser-downloads">
          {recent.map((item) => (
            <div key={item.id} className="browser-download">
              {item.state === "downloading" ? <Loader2 size={13} className="spin" /> : <Download size={13} className={item.state === "failed" ? "danger-text" : "faint"} />}
              <span className="ellipsis grow" title={item.url}>
                {item.name}
                <span className="faint">{item.state === "done" ? ` · ${size(item.size)}` : item.state === "failed" ? ` · 失败：${item.error ?? ""}` : " · 下载中"}</span>
              </span>
              {item.state === "done" && (
                <>
                  <a className="btn small" href={`${browserPath(repo)}/downloads/${item.id}`} download={item.name}>
                    <Download size={12} /> 存到本机
                  </a>
                  <button className="btn small" onClick={() => importDownload(item.id)} title="放进这个作品的 public/imports/">
                    <FolderInput size={12} /> 放进作品
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {menu}
      {pairing && <ComputersDialog repo={repo} onClose={() => setPairing(false)} />}
    </div>
  );
}

/**
 * The browsers on the user's computer linked to this repository (the FRAME 连接器 extension):
 * whether one is online, the AI's tabs there and logins it asked for.
 */
function ComputerStrip({ repo, computers, remoteTabs, onManage }: { repo: string; computers: { online: boolean; name: string }[]; remoteTabs: BrowserTabInfo[]; onManage: () => void }) {
  const toast = useToast();
  const online = computers.find((item) => item.online);
  const logins = remoteTabs.filter((item) => item.login);
  return (
    <>
      <div className="browser-note computer">
        <Laptop size={14} className={online ? "ok-text" : "faint"} />
        <span className="grow ellipsis">
          {online
            ? `电脑上的浏览器已连接：${online.name}。AI 优先用它（你已经登录的网站），${remoteTabs.length ? `现在能用 ${remoteTabs.length} 个标签页` : "还没有打开标签页"}`
            : computers.length
              ? "电脑上的浏览器没有连着：AI 先用下面这个服务器上的浏览器"
              : "还可以让 AI 用你电脑上的 Edge 或 Chrome（你已经登录的网站）"}
        </span>
        <button className="btn small" onClick={onManage}>
          {computers.length ? "管理" : "连接电脑上的浏览器"}
        </button>
      </div>
      {logins.map((item) => (
        <div key={item.id} className="browser-note warn">
          <KeyRound size={14} />
          <span className="grow">
            AI 请你在电脑上的浏览器里登录 <strong>{item.login!.host}</strong>：{item.login!.reason}
          </span>
          <button className="btn small" onClick={() => void focusRemote(repo, item.id).catch((error) => toast((error as Error).message, "error"))}>
            在电脑上打开
          </button>
          <button
            className="btn small primary"
            onClick={() =>
              loginDone(repo, item.id).then(
                (result) => toast(result.notified ? "已告诉 AI" : "好的", "ok"),
                (error) => toast((error as Error).message, "error"),
              )
            }
          >
            登录好了
          </button>
        </div>
      ))}
    </>
  );
}

/** Link a browser on this computer (pairing code, how to install the extension) and see or unlink the linked ones. */
function ComputersDialog({ repo, onClose }: { repo: string; onClose: () => void }) {
  const { computers, remoteTabs } = useBrowserState(repo);
  const toast = useToast();
  const confirm = useConfirm();
  const [code, setCode] = useState<{ code: string; expires: string; server: string } | null>(null);
  const name = repo === "local" ? "本地" : repo;
  const create = async () => {
    try {
      setCode(await api(`${browserPath(repo)}/pair`, { method: "POST" }));
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  // A pairing that came through: the code is used up.
  const count = computers.length;
  const first = useRef(count);
  useEffect(() => {
    if (code && count > first.current) {
      setCode(null);
      toast("已连接", "ok");
    }
    first.current = count;
  }, [count, code, toast]);
  return (
    <Dialog title="电脑上的浏览器" onClose={onClose} width={560}>
      <div className="computers">
        <p className="muted small-text">
          装上 FRAME 连接器扩展后，作品库「{name}」的 AI 可以用你在那个浏览器里已经登录的网站：只在它自己开的标签页（单独的窗口和「FRAME AI」标签组）和你在扩展里交给它的页面里浏览和下载，你的登录信息不会传到服务器。同一个浏览器连接几个作品库时，它们共用这些登录。
        </p>
        {computers.map((item) => (
          <div key={item.id} className="computer-row">
            <Laptop size={15} className={item.online ? "ok-text" : "faint"} />
            <span className="grow">
              {item.name}
              <span className="faint small-text">
                {" · "}
                {item.online ? "在线" : item.lastSeen ? `上次在线 ${new Date(item.lastSeen).toLocaleString()}` : "离线"}
              </span>
            </span>
            <button
              className="btn small danger"
              onClick={async () => {
                if (!(await confirm(`断开 ${item.name} 和作品库「${name}」的连接：这个作品库的 AI 不能再用它。`, { confirm: "断开", danger: true }))) return;
                api(`${browserPath(repo)}/computers/${item.id}`, { method: "DELETE" }).catch((error) => toast((error as Error).message, "error"));
              }}
            >
              断开
            </button>
          </div>
        ))}
        {remoteTabs.length > 0 && (
          <div className="computer-tabs">
            <div className="faint small-text">AI 在电脑上能用的标签页</div>
            {remoteTabs.map((item) => (
              <div key={item.id} className="computer-row">
                {item.owner === "ai" ? <Sparkles size={13} className="accent-text" /> : <Globe size={13} className="faint" />}
                <span className="grow ellipsis" title={item.url}>
                  {item.title || item.url}
                </span>
                <button className="btn small" onClick={() => void focusRemote(repo, item.id).catch((error) => toast((error as Error).message, "error"))}>
                  在电脑上打开
                </button>
              </div>
            ))}
          </div>
        )}
        <ol className="pair-steps">
          <li>
            下载扩展：
            <a className="btn small" href="/api/browser-extension.zip" download>
              <Download size={12} /> frame-connector.zip
            </a>
            ，解压到一个文件夹（例如「全部解压缩」得到的 frame-connector），里面直接就是 manifest.json。
          </li>
          <li>
            Edge 打开 <code>edge://extensions</code>（Chrome 是 <code>chrome://extensions</code>），打开「开发人员模式」，点「加载解压缩的扩展」，选直接包含 manifest.json 的那个文件夹。建议给 AI 单独建一个浏览器用户资料，只在那里登录要给它用的网站。
          </li>
          <li>
            点工具栏上的 FRAME 连接器图标，填 FRAME 地址和配对码：
            {code ? (
              <div className="pair-code">
                <div>
                  地址 <code>{code.server}</code>
                </div>
                <div>
                  配对码 <strong className="mono">{code.code}</strong>
                  <span className="faint small-text">（{new Date(code.expires).toLocaleTimeString()} 前有效，用一次）</span>
                </div>
              </div>
            ) : (
              <button className="btn small primary" onClick={create}>
                生成配对码
              </button>
            )}
          </li>
        </ol>
      </div>
    </Dialog>
  );
}

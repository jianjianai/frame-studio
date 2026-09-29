import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, LoaderCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { socketCall, subscribe } from "./realtime";
export async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(!options.body || options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const result = await response
    .json()
    .catch(() => ({ error: "服务器返回了无法读取的响应" }));
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("frame-auth-required"));
    const error = new Error(result.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}
export const api = socketCall;
export const date = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export const bytes = (value) =>
  Number(value) > 1048576
    ? (Number(value) / 1048576).toFixed(1) + " MB"
    : Math.ceil(Number(value) / 1024) + " KB";
export const go = (path) => {
  location.hash = "/" + path;
};
export const active = (task) =>
  ["queued", "running", "cancelling"].includes(task.state);
export const states = {
  queued: "等待开始",
  running: "正在制作",
  cancelling: "正在停止",
  cancelled: "已停止",
  failed: "需要处理",
  succeeded: "已完成",
};
export const kinds = {
  agent: "AI 创作",
  build: "准备预览",
  render: "导出视频",
  validate: "检查作品",
  frame: "截图",
  storyboard: "分镜预览",
};
export function useQuery(name, args = {}, interval = 0) {
  const key = JSON.stringify(args),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, refresh] = useState(0);
  useEffect(() => {
    let cancelled = false,
      timer;
    if (!name) {
      setData(null);
      setLoading(false);
      setError("");
      return;
    }
    if (interval) {
      setLoading(true);
      return subscribe(name, JSON.parse(key), ({ result, error }) => {
        if (error) setError(error);
        else {
          setData(result);
          setError("");
        }
        setLoading(false);
      });
    }
    const load = async () => {
      try {
        const value = await api(name, JSON.parse(key));
        if (!cancelled) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    setLoading(true);
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, key, interval, revision]);
  return { data, error, loading, refresh: () => refresh((n) => n + 1) };
}
const ACTION_FAILURE = Symbol("action-failure");
export function useAction(notify = () => {}) {
  const [busy, setBusy] = useState(false), pending = useRef(false);
  const run = async (fn) => {
    if (pending.current) return { [ACTION_FAILURE]: true, message: "上一项操作尚未完成，请稍候。" };
    pending.current = true;
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      const message = e?.message || "操作失败，请重试";
      notify(message, "error");
      return { [ACTION_FAILURE]: true, message };
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return [run, busy];
}
export function Button({ icon: Icon, children, ref, ...props }) {
  return (
    <button ref={ref} {...props}>
      {Icon && <Icon size={17} />} {children}
    </button>
  );
}
export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Empty({ children, action }) {
  return <div className="empty"><div>{children}</div>{action && <div className="empty-action">{action}</div>}</div>;
}
export function ErrorNote({ error }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} /> 正在加载…
    </div>
  );
}
export function Pagination({ page, setPage, total, size = 30 }) {
  return total > size ? (
    <div className="pagination">
      <span>
        共 {total} 个 · 第 {page + 1} 页
      </span>
      <Button
        icon={ChevronLeft}
        aria-label="上一页"
        disabled={!page}
        onClick={() => setPage(page - 1)}
      />
      <Button
        icon={ChevronRight}
        aria-label="下一页"
        disabled={(page + 1) * size >= total}
        onClick={() => setPage(page + 1)}
      />
    </div>
  ) : null;
}
// Track actual opening order, not z-index or DOM order, including nested dialogs.
const modalLayers = [];
const topModal = () => modalLayers.findLast((el) => el.isConnected && el.open);
const announceLayer = () => window.dispatchEvent(new Event("frame-modal-layer"));
export function Notification({ notice, onClose }) {
  const [target, setTarget] = useState(null);
  useEffect(() => {
    const update = () => setTarget(topModal()?.querySelector("[data-modal-notices]") || null);
    update(); window.addEventListener("frame-modal-layer", update);
    return () => window.removeEventListener("frame-modal-layer", update);
  }, []);
  if (!notice) return null;
  const content = <div className={"toast " + notice.type + (target ? " inside-modal" : "")} role={notice.type === "error" ? "alert" : "status"}>
    <span>{notice.text}</span><Button type="button" icon={X} aria-label="关闭通知" onClick={onClose} />
  </div>;
  return target ? createPortal(content, target) : content;
}

export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null), outside = useRef(false), focusBeforeClose = useRef(null);
  const [closing, setClosing] = useState("");
  const requestClose = () => {
    const el = ref.current;
    focusBeforeClose.current = document.activeElement;
    if (el.querySelector('form[data-pending="true"]')) { setClosing("busy"); return; }
    if (el.querySelector('form[data-dirty="true"]')) { setClosing("dirty"); return; }
    onClose();
  };
  useEffect(() => {
    const before = document.activeElement, el = ref.current;
    if (!el.open) el.showModal();
    modalLayers.push(el); announceLayer();
    return () => {
      const index = modalLayers.indexOf(el); if (index >= 0) modalLayers.splice(index, 1);
      el.close(); announceLayer();
      if (before?.isConnected) before.focus?.();
    };
  }, []);
  const isOutside = (event) => {
    if (event.target !== event.currentTarget) return false;
    const r = event.currentTarget.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };
  return <dialog ref={ref} aria-label={title} className={"modal " + (wide ? "wide" : "")}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); requestClose(); }}
    onPointerDown={(event) => { outside.current = isOutside(event); }}
    onPointerUp={(event) => { if (outside.current && isOutside(event)) requestClose(); outside.current = false; }}>
    <header><h2>{title}</h2><Button type="button" icon={X} aria-label="关闭弹窗" onClick={requestClose} /></header>
    <div className="modal-notices" data-modal-notices />
    {closing && <section className="discard-warning" role="alert" aria-label="关闭前确认">
      <strong>{closing === "busy" ? "操作仍在进行" : "有尚未保存的修改"}</strong>
      <p>{closing === "busy" ? "请等待本次操作返回结果，避免重复提交。" : "关闭将放弃本次输入。已保存的作品内容不会改变。"}</p>
      <div className="row"><Button type="button" autoFocus onClick={() => { setClosing(""); focusBeforeClose.current?.focus?.(); }}>继续编辑</Button>
        {closing === "dirty" && <Button type="button" className="danger-text" onClick={onClose}>放弃修改并关闭</Button>}</div>
    </section>}
    <div className="modal-content">{children}</div>
  </dialog>;
}

// Compare values in memory only. Passwords and file bytes are never persisted.
const formSnapshot = (form) => JSON.stringify([...form.querySelectorAll("input,textarea,select")].map((el) => [
  el.name || el.getAttribute("aria-label") || "", el.type,
  el.type === "checkbox" || el.type === "radio" ? [el.checked, el.value] : el.type === "file" ? [...(el.files || [])].map(f => [f.name, f.size, f.lastModified]) : el.value,
]));
export function Form({ children, onSubmit, busy = false, disabled = false, submit = "保存", protect = true }) {
  const ref = useRef(null), baseline = useRef(null), dirtyRef = useRef(false), pendingRef = useRef(false), mounted = useRef(true);
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const markDirty = () => { if (baseline.current === null) return; const changed = formSnapshot(ref.current) !== baseline.current; dirtyRef.current = changed; setDirty(changed); };
  useEffect(() => {
    mounted.current = true; baseline.current = formSnapshot(ref.current);
    const unload = (event) => { if (protect && (dirtyRef.current || pendingRef.current)) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => { mounted.current = false; window.removeEventListener("beforeunload", unload); };
  }, [protect]);
  return <form ref={ref} data-dirty={protect && dirty} data-pending={pending || busy} aria-busy={pending || busy}
    onInputCapture={markDirty} onChangeCapture={markDirty}
    onSubmit={async (event) => {
      event.preventDefault();
      if (pendingRef.current || busy || disabled) return;
      const form = event.currentTarget, submitted = formSnapshot(form);
      const values = Object.fromEntries(new FormData(form));
      pendingRef.current = true; setPending(true); setError("");
      try {
        const result = await onSubmit(values);
        if (result?.[ACTION_FAILURE]) throw new Error(result.message);
        if (mounted.current) { baseline.current = submitted; markDirty(); }
      } catch (e) {
        if (mounted.current) setError(e?.message || "未能保存，输入已保留，请重试。");
      } finally {
        pendingRef.current = false;
        if (mounted.current) setPending(false);
      }
    }}>
    {children}
    <ErrorNote error={error} />
    <div className="form-actions">
      {protect && dirty && <small role="status">尚未保存</small>}
      <Button type="submit" className="primary" disabled={busy || pending || disabled}>{busy || pending ? "处理中…" : submit}</Button>
    </div>
  </form>;
}

export function useDebouncedValue(value, delay = 220) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setCurrent(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return current;
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => { const media = window.matchMedia(query); const change = () => setMatches(media.matches); change(); media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, [query]);
  return matches;
}

import { useEffect, useRef, useState } from "react";
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
export function useAction(notify = () => {}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      notify(e.message, "error");
      return null;
    } finally {
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
export function Empty({ children }) {
  return <div className="empty">{children}</div>;
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
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    const el = ref.current;
    el.showModal();
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      el.close();
      before?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={"modal " + (wide ? "wide" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2>{title}</h2>
        <Button icon={X} aria-label="关闭弹窗" onClick={onClose} />
      </header>
      <div className="modal-content">{children}</div>
    </dialog>
  );
}
export function Form({ children, onSubmit, busy, submit = "保存" }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(Object.fromEntries(new FormData(e.currentTarget)));
      }}
    >
      {children}
      <div className="form-actions">
        <Button className="primary" disabled={busy}>
          {busy ? "处理中…" : submit}
        </Button>
      </div>
    </form>
  );
}

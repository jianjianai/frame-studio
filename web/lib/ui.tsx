import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle2, AlertTriangle, Info } from "lucide-react";
import "./ui.css";

// ---- toasts --------------------------------------------------------------
type Toast = { id: number; kind: "info" | "ok" | "error"; text: string };
const ToastContext = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), kind === "error" ? 8000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.kind === "ok" ? <CheckCircle2 size={16} /> : toast.kind === "error" ? <AlertTriangle size={16} /> : <Info size={16} />}
            <span>{toast.text}</span>
            <button className="icon-btn" aria-label="关闭" onClick={() => setToasts((list) => list.filter((item) => item.id !== toast.id))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Wrap an async action: shows its error as a toast and returns a busy flag. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await action();
        if (success) toast(success, "ok");
        return result;
      } catch (error) {
        toast((error as Error).message, "error");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return [run, busy] as const;
}

// ---- modal dialog ----------------------------------------------------------
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 480,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width }}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Simple confirmation dialog driven by a promise. */
type ConfirmState = { text: ReactNode; confirm: string; danger?: boolean; resolve: (ok: boolean) => void } | null;
const ConfirmContext = createContext<(text: ReactNode, options?: { confirm?: string; danger?: boolean }) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState>(null);
  const ask = useCallback(
    (text: ReactNode, options: { confirm?: string; danger?: boolean } = {}) =>
      new Promise<boolean>((resolve) => setState({ text, confirm: options.confirm || "确定", danger: options.danger, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {state && (
        <Dialog
          title="请确认"
          onClose={() => close(false)}
          width={420}
          footer={
            <>
              <button className="btn" onClick={() => close(false)}>
                取消
              </button>
              <button className={`btn primary ${state.danger ? "danger-fill" : ""}`} autoFocus onClick={() => close(true)}>
                {state.confirm}
              </button>
            </>
          }
        >
          <div className="confirm-text">{state.text}</div>
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}

/** Text input dialog driven by a promise; resolves to null when cancelled. */
type PromptState = { title: string; value: string; placeholder?: string; resolve: (value: string | null) => void } | null;
const PromptContext = createContext<(title: string, value?: string, placeholder?: string) => Promise<string | null>>(async () => null);
export const usePrompt = () => useContext(PromptContext);
export function PromptProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PromptState>(null);
  const [value, setValue] = useState("");
  const ask = useCallback(
    (title: string, initial = "", placeholder?: string) =>
      new Promise<string | null>((resolve) => {
        setValue(initial);
        setState({ title, value: initial, placeholder, resolve });
      }),
    [],
  );
  const close = (result: string | null) => {
    state?.resolve(result);
    setState(null);
  };
  return (
    <PromptContext.Provider value={ask}>
      {children}
      {state && (
        <Dialog
          title={state.title}
          onClose={() => close(null)}
          width={420}
          footer={
            <>
              <button className="btn" onClick={() => close(null)}>
                取消
              </button>
              <button className="btn primary" disabled={!value.trim()} onClick={() => close(value.trim())}>
                确定
              </button>
            </>
          }
        >
          <input
            className="input"
            autoFocus
            value={value}
            placeholder={state.placeholder}
            onFocus={(event) => event.target.select()}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && value.trim() && close(value.trim())}
          />
        </Dialog>
      )}
    </PromptContext.Provider>
  );
}

// ---- context menu ----------------------------------------------------------------
export type MenuItem = { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean } | "separator";
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = useCallback((event: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => {
    event.preventDefault?.();
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, []);
  const element = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return [open, element] as const;
}
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  useEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPosition({ x: Math.min(x, innerWidth - rect.width - 4), y: Math.min(y, innerHeight - rect.height - 4) });
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", close);
    };
  }, [x, y, onClose]);
  return createPortal(
    <div ref={ref} className="context-menu" style={{ left: position.x, top: position.y }} onMouseDown={(event) => event.stopPropagation()}>
      {items.map((item, index) =>
        item === "separator" ? (
          <div key={index} className="menu-separator" />
        ) : (
          <button
            key={index}
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span className="menu-icon">{item.icon}</span>
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ---- persisted state -------------------------------------------------------------
export function usePersistent<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem("frame:" + key);
      return stored ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("frame:" + key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}

/** Drag handle that resizes a neighbouring pane. */
export function Sash({
  direction,
  onDrag,
  onDoubleClick,
}: {
  direction: "vertical" | "horizontal";
  onDrag: (delta: number) => void;
  onDoubleClick?: () => void;
}) {
  const start = (event: React.PointerEvent) => {
    event.preventDefault();
    let last = direction === "vertical" ? event.clientX : event.clientY;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    target.classList.add("dragging");
    document.body.classList.add(direction === "vertical" ? "resizing-x" : "resizing-y");
    const move = (moveEvent: PointerEvent) => {
      const now = direction === "vertical" ? moveEvent.clientX : moveEvent.clientY;
      onDrag(now - last);
      last = now;
    };
    const up = () => {
      target.classList.remove("dragging");
      document.body.classList.remove("resizing-x", "resizing-y");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return <div className={`sash ${direction}`} onPointerDown={start} onDoubleClick={onDoubleClick} role="separator" />;
}

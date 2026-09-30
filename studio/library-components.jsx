import { useEffect, useId, useRef, useState } from "react";
import { Film, MoreHorizontal } from "lucide-react";

export const productionLabels = {
  draft: "制作中",
  review: "待审片",
  finished: "已完成",
};

export function readLibraryView() {
  try {
    return localStorage.getItem("frame.library-view") === "list"
      ? "list"
      : "grid";
  } catch {
    return "grid";
  }
}
export function saveLibraryView(view) {
  try {
    localStorage.setItem("frame.library-view", view);
  } catch {
    /* Browsing still works without storage. */
  }
}
export function durationLabel(value) {
  if (!Number.isFinite(Number(value)) || value == null || value <= 0) return "";
  const seconds = Math.ceil(Number(value));
  const parts = [Math.floor(seconds / 60), seconds % 60];
  if (seconds >= 3600)
    parts.splice(
      0,
      1,
      Math.floor(seconds / 3600),
      Math.floor(seconds / 60) % 60,
    );
  return parts
    .map((part, index) =>
      index ? String(part).padStart(2, "0") : String(part),
    )
    .join(":");
}

export function WorkCover({ work }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [work.cover]);
  const tone = [...work.id].reduce((n, char) => n + char.charCodeAt(0), 0) % 4;
  const duration = durationLabel(work.duration);
  return (
    <div className={"work-cover library-cover tone-" + tone}>
      {work.cover && !failed ? (
        <img
          src={work.cover}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="library-cover-placeholder">
          <Film size={30} strokeWidth={1.4} />
          <span>尚无预览封面</span>
        </div>
      )}
      {duration && <span className="library-duration">{duration}</span>}
    </div>
  );
}

/** One menu at a time, with dismissal and keyboard navigation. */
export function LibraryMenu({ label, items, disabled = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null),
    trigger = useRef(null),
    menuId = useId();
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(
      new CustomEvent("frame-library-menu", { detail: menuId }),
    );
    ref.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = (event) => {
      if (!ref.current?.contains(event.target)) close();
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    const other = (event) => {
      if (event.detail !== menuId) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("frame-library-menu", other);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("frame-library-menu", other);
    };
  }, [open, menuId]);
  return (
    <div
      className="library-card-menu"
      ref={ref}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="library-menu-trigger"
        aria-label={label}
        title="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={19} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="library-menu-popup"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const buttons = [
              ...event.currentTarget.querySelectorAll(
                '[role="menuitem"]:not(:disabled)',
              ),
            ];
            const index = buttons.indexOf(document.activeElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }}
        >
          {items.map(({ label: itemLabel, icon: Icon, action, danger }) => (
            <button
              key={itemLabel}
              type="button"
              role="menuitem"
              className={danger ? "danger-text" : ""}
              onClick={() => {
                close(true);
                action();
              }}
            >
              <Icon size={16} />
              {itemLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LibrarySkeleton({ view = "grid" }) {
  return (
    <div role="status" className={"library-skeleton " + view}>
      <span className="library-sr-only">正在加载作品…</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden="true">
          <i />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

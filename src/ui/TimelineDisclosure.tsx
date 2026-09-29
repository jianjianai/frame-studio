import { useEffect, useRef, type ReactNode } from "react";

/** A disclosure in the browser top layer cannot be clipped by a short/scrolled timeline. */
export function TimelineDisclosure({
  className,
  label,
  summary,
  children,
}: {
  className: string;
  label: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target))
        return;
      if (disclosure.current) disclosure.current.open = false;
      if (popup.current?.matches(":popover-open")) popup.current.hidePopover();
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, []);
  return (
    <details
      ref={disclosure}
      className={className}
      onToggle={(event) => {
        if (event.target !== event.currentTarget || !popup.current) return;
        const panel = popup.current;
        if (!event.currentTarget.open) {
          if (panel.matches(":popover-open")) panel.hidePopover();
          return;
        }
        panel.showPopover();
        const anchor = event.currentTarget
          .querySelector("summary")!
          .getBoundingClientRect();
        const rect = panel.getBoundingClientRect();
        const above = anchor.top - rect.height - 8;
        const top =
          above >= 8
            ? above
            : Math.min(innerHeight - rect.height - 8, anchor.bottom + 8);
        panel.style.top = `${Math.max(8, top)}px`;
        panel.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - rect.width - 8))}px`;
      }}
    >
      <summary aria-label={label} title={label}>
        {summary}
      </summary>
      <div
        ref={popup}
        popover="auto"
        className="timeline-popover"
        onToggle={(event) => {
          if (
            event.target === event.currentTarget &&
            !event.currentTarget.matches(":popover-open") &&
            disclosure.current
          )
            disclosure.current.open = false;
        }}
      >
        <div className="timeline-popover-heading">
          <strong>{label}</strong>
          <button
            aria-label={`关闭${label}`}
            onClick={() => {
              if (disclosure.current) disclosure.current.open = false;
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </details>
  );
}

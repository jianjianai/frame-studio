import { useEffect, useRef } from "react";
import { PanelRightClose } from "lucide-react";
import { Button } from "./ui";

export const toolNames = {
  ai: "AI 创作对话",
  composition: "合成与片段",
  audio:"音频工作台",
  materials: "素材",
  voice: "配音",
  tasks: "后台任务",
  sync: "源代码管理",
};

/** Keep tool children mounted; only one occupies the shared work area at a time. */
export function WorkDock({ tool, compact, onClose, children }) {
  const dock = useRef(null);
  useEffect(() => {
    const root = dock.current;
    root
      ?.querySelectorAll("[hidden] audio, [hidden] video")
      .forEach((media) => media.pause());
    if (tool && compact) {
      const pane = root?.querySelector(`[data-dock-pane="${tool}"]`);
      const first =
        pane?.querySelector("textarea:not(:disabled)") ||
        pane?.querySelector("input:not(:disabled)") ||
        pane?.querySelector("button:not(:disabled)");
      (first || root)?.focus();
    }
  }, [tool, compact]);
  return (
    <aside
      id="work-dock"
      ref={dock}
      className="work-dock"
      hidden={!tool}
      role={compact ? "dialog" : "complementary"}
      aria-modal={compact && tool ? true : undefined}
      aria-label={toolNames[tool] || "作品工作面板"}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Nested native dialogs own their keyboard and dirty-form confirmation.
        if (event.defaultPrevented || event.target.closest("dialog[open]"))
          return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Tab" && compact) {
          const items = [
            ...dock.current.querySelectorAll(
              'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
            ),
          ].filter(
            (el) => el.getClientRects().length && !el.closest("[inert]"),
          );
          const first = items[0],
            last = items.at(-1);
          if (!first) {
            event.preventDefault();
            dock.current.focus();
          } else if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === dock.current)
          ) {
            event.preventDefault();
            last.focus();
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              document.activeElement === dock.current)
          ) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      {tool !== "ai" && (
        <header className="work-dock-heading">
          <h2>{toolNames[tool]}</h2>
          <Button
            icon={PanelRightClose}
            aria-label={`关闭${toolNames[tool] || "工作面板"}`}
            title="收起面板，保留当前内容"
            onClick={onClose}
          />
        </header>
      )}
      {children}
    </aside>
  );
}

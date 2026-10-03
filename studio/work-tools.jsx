import { useEffect, useRef, useState } from "react";
import {
  Film,
  Layers,
  Music2,
  HardDrive,
  MessageSquare,
  Image,
  Mic,
  ListTodo,
  GitPullRequest,
  Download,
  GitBranch,
  Info,
  ChevronDown,
  PanelsTopLeft,
  AlertCircle,
} from "lucide-react";

const tools = [
  ["ai", MessageSquare, "AI"],
  ["composition", Layers, "合成"],
  ["audio", Music2, "音频"],
  ["materials", Image, "素材"],
  ["preview-media", HardDrive, "素材模式"],
  ["voice", Mic, "配音"],
];

/** A work-local toolbar, not library navigation. Menus contain only secondary actions. */
export function WorkTools({
  work,
  tool,
  onTool,
  onModal,
  compact,
  running,
  sync,
  syncError,
  browserBusy,
  inert,
  toolbarRef,
}) {
  const [menu, setMenu] = useState("");
  const [focused, setFocused] = useState("work");
  const popup = useRef(null);
  const menuTrigger = useRef(null);
  const keys = compact
    ? ["work", "tools", "ai", "exports"]
    : [
        "work",
        "ai",
        "composition",
        "audio",
        "materials",
        "preview-media",
        "voice",
        "tasks",
        "sync",
        "exports",
      ];
  const focusKey = keys.includes(focused) ? focused : "work";
  const syncLabel =
    syncError || sync?.error
      ? "远端检查失败，请查看详情"
      : sync?.dirty
        ? `有 ${sync.dirty} 个未提交文件`
        : sync?.behind
          ? "有远端更新"
          : sync?.ahead
            ? `待同步 ${sync.ahead} 个版本`
            : sync
              ? sync.remote
                ? "已同步"
                : "保存在服务器"
              : "正在检查同步状态";
  const attention = !!(
    syncError ||
    sync?.error ||
    sync?.dirty ||
    sync?.behind ||
    sync?.ahead
  );
  const failed = !!(syncError || sync?.error);
  const closeMenu = (restore = false) => {
    setMenu("");
    if (restore) menuTrigger.current?.focus();
  };
  useEffect(() => {
    setMenu("");
  }, [compact]);
  useEffect(() => {
    if (!menu) return;
    popup.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = (event) => {
      if (
        !popup.current?.contains(event.target) &&
        !menuTrigger.current?.contains(event.target)
      )
        setMenu("");
    };
    // Pointer events in the sandboxed player do not bubble into this document.
    const blurred = () => setMenu("");
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", blurred);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", blurred);
    };
  }, [menu]);
  const openMenu = (name, event) => {
    menuTrigger.current = event.currentTarget;
    setMenu((previous) => (previous === name ? "" : name));
  };
  const select = (key, modal = false) => {
    const trigger = menuTrigger.current;
    trigger?.focus();
    setMenu("");
    if (modal) onModal(key);
    else onTool(key, trigger);
  };
  const button = (key, Icon, text, props = {}) => (
    <button
      key={key}
      type="button"
      data-tool-key={key}
      className="work-tool"
      tabIndex={key === focusKey ? 0 : -1}
      aria-controls="work-dock"
      aria-expanded={tool === key}
      title={text}
      onClick={(event) => onTool(key, event.currentTarget)}
      {...props}
    >
      <Icon size={19} aria-hidden="true" />
      <span className="work-tool-label">{text}</span>
      {key === "tasks" && running > 0 && (
        <span className="tool-badge" aria-hidden="true">
          {running > 99 ? "99+" : running}
        </span>
      )}
      {key === "tools" && (running > 0 || attention) && (
        <span className="tool-badge" aria-hidden="true">
          {failed ? "!" : running > 0 ? (running > 99 ? "99+" : running) : "!"}
        </span>
      )}
      {key === "sync" && attention && (
        <span className="tool-badge" aria-hidden="true">
          {failed
            ? "!"
            : sync?.dirty
              ? sync.dirty > 99
                ? "99+"
                : sync.dirty
              : "↑↓"}
        </span>
      )}
    </button>
  );
  return (
    <header
      className="creation-toolbar"
      inert={inert || undefined}
      ref={toolbarRef}
    >
      <div
        className="creation-actions"
        role="toolbar"
        aria-label="当前作品工具"
        aria-orientation={compact ? "horizontal" : "vertical"}
        onFocus={(event) => {
          const key = event.target.dataset.toolKey;
          if (key) setFocused(key);
        }}
        onKeyDown={(event) => {
          if (!event.target.matches("[data-tool-key]")) return;
          const prev = compact ? "ArrowLeft" : "ArrowUp";
          const next = compact ? "ArrowRight" : "ArrowDown";
          if (![prev, next, "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index = keys.indexOf(event.target.dataset.toolKey);
          const key =
            event.key === "Home"
              ? keys[0]
              : event.key === "End"
                ? keys.at(-1)
                : keys[
                    (index + (event.key === prev ? -1 : 1) + keys.length) %
                      keys.length
                  ];
          toolbarRef.current
            ?.querySelector(`[data-tool-key="${key}"]`)
            ?.focus();
        }}
      >
        <div className="work-menu-anchor identity-anchor">
          {button("work", Film, compact ? work.title : "作品", {
            className: "work-tool work-menu-trigger",
            "aria-label": "作品菜单",
            "aria-controls": "work-secondary-menu",
            "aria-haspopup": "menu",
            "aria-expanded": menu === "work",
            title: work.title,
            onClick: (event) => openMenu("work", event),
          })}
          {compact && (
            <ChevronDown
              className="identity-chevron"
              size={12}
              aria-hidden="true"
            />
          )}
        </div>
        {compact &&
          button("tools", PanelsTopLeft, "工具", {
            "aria-label": "作品工具菜单",
            "aria-controls": "work-secondary-menu",
            "aria-haspopup": "menu",
            "aria-expanded": menu === "tools",
            onClick: (event) => openMenu("tools", event),
            className: "work-tool compact-tools-trigger",
            "aria-description": `${running} 项任务进行中；${syncLabel}`,
          })}
        <div className="work-tool-group creative-tools">
          {tools
            .filter(([key]) => !compact || key === "ai")
            .map(([key, Icon, label]) =>
              button(key, Icon, label, {
                "aria-label":
                  key === "ai"
                    ? tool === "ai"
                      ? "关闭 AI 对话"
                      : "打开 AI 对话"
                    : label,
                title: key === "ai" ? "AI 对话（收起不会停止创作）" : label,
              }),
            )}
        </div>
        {!compact && (
          <div className="work-tool-group status-tools">
            {button("tasks", ListTodo, "任务", {
              "aria-label": "后台任务",
              title: running ? `${running} 项任务进行中` : "后台任务",
            })}
            {button("sync", failed ? AlertCircle : GitBranch, "版本", {
              "aria-label": "源代码管理",
              "aria-description": syncLabel,
              title: `源代码管理 · ${syncLabel}（Ctrl / ⌘ + Shift + G）`,
              className: `work-tool sync-tool ${failed ? "sync-failed" : attention ? "sync-pending" : ""}`,
            })}
          </div>
        )}
        {button("exports", Download, "导出", {
          className: "work-tool export-tool",
          "aria-controls": undefined,
          "aria-expanded": undefined,
          "aria-haspopup": "dialog",
          "aria-label": "导出",
          title: browserBusy ? "正在本机导出，查看进度" : "导出作品",
          onClick: () => onModal("exports"),
        })}
      </div>
      {menu && (
        <div
          id="work-secondary-menu"
          className={`work-secondary-menu ${menu === "tools" ? "tools-menu" : ""}`}
          role="menu"
          aria-label={menu === "work" ? "作品操作" : "作品工具"}
          ref={popup}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeMenu(true);
            } else if (event.key === "Tab") closeMenu(true);
            else if (
              ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              const items = [
                ...popup.current.querySelectorAll('[role="menuitem"]'),
              ];
              const index = items.indexOf(document.activeElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowUp" ? -1 : 1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }
          }}
        >
          {menu === "work" ? (
            <>
              <div className="work-menu-caption">
                <strong title={work.title}>{work.title}</strong>
                <small>{work.repository?.name}</small>
              </div>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => select("details", true)}
              >
                <Info size={17} />
                作品资料
              </button>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => select("sync")}
              >
                <GitBranch size={17} />
                源代码管理
              </button>
            </>
          ) : (
            <>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => select("preview-media")}
              >
                <HardDrive size={17} />
                素材模式
              </button>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => select("materials")}
              >
                <Image size={17} />
                素材
              </button>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => select("voice")}
              >
                <Mic size={17} />
                配音
              </button>
              <div role="separator" />
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => select("tasks")}
              >
                <ListTodo size={17} />
                后台任务 {running > 0 ? `· ${running}` : ""}
              </button>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => select("sync")}
              >
                <GitPullRequest size={17} />
                <span>
                  源代码管理<small>{syncLabel}</small>
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </header>
  );
}

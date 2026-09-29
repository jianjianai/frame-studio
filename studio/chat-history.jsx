import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, MessageSquare, Check } from "lucide-react";

export function ChatHistory({ chats = [], selected, onChange, disabled }) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const root = useRef(null),
    input = useRef(null),
    button = useRef(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="chat-history"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="chat-title"
        aria-label="对话历史"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={selected?.title || "新对话"}
        disabled={disabled}
        onClick={() => {
          setSearch("");
          setOpen(!open);
        }}
      >
        <MessageSquare size={15} />
        <span>{selected?.title || "新对话"}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          className="chat-history-menu"
          role="dialog"
          aria-label="选择创作对话"
        >
          <label className="settings-search">
            <Search size={14} />
            <input
              ref={input}
              aria-label="搜索对话"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索当前作品的对话"
            />
          </label>
          <div className="chat-history-list">
            {chats
              .filter((chat) =>
                chat.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((chat) => (
                <button
                  type="button"
                  key={chat.id}
                  aria-current={selected?.id === chat.id ? "true" : undefined}
                  onClick={() => {
                    onChange(chat.id);
                    setOpen(false);
                    button.current?.focus();
                  }}
                >
                  <span>{chat.title}</span>
                  {selected?.id === chat.id && <Check size={14} />}
                </button>
              ))}
            {!chats.length && (
              <p className="settings-help">发送第一条要求后自动保存对话</p>
            )}
            {!!chats.length &&
              !chats.some((chat) =>
                chat.title.toLowerCase().includes(search.toLowerCase()),
              ) && <p className="settings-help">没有匹配的对话</p>}
          </div>
        </div>
      )}
    </div>
  );
}

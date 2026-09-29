import { useEffect, useRef, useState } from "react";
import { Search, ChevronDown, ChevronUp, X } from "lucide-react";
export function useAgentSearch(messages, follow, setFollowing) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [count, setCount] = useState(0), [index, setIndex] = useState(-1);
  const input = useRef(null), matches = useRef([]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    const root = messages.current;
    if (!open || !root) return;
    let timer;
    const measure = () => {
      clearTimeout(timer); timer = setTimeout(() => {
        matches.current = [...root.querySelectorAll('[data-agent-match="true"]')];
        setCount(matches.current.length);
      }, 80);
    };
    measure(); const observer = new MutationObserver(measure); observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [open, query, messages]);
  const close = () => { setOpen(false); setQuery(""); setCount(0); setIndex(-1); };
  const next = (step = 1) => {
    const all = matches.current; if (!all.length) return;
    follow.current = false; setFollowing(false);
    const at = (index + step + all.length) % all.length;
    all[at].scrollIntoView({ block: "center", behavior: "instant" }); setIndex(at);
  };
  return { open, query, count, index, input, next, close, toggle: () => open ? close() : setOpen(true),
    change: (value) => { follow.current = false; setFollowing(false); setQuery(value); setIndex(-1); },
    onKeyDown: (event) => {
      if (event.target.closest("dialog[open]")) return false;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); setOpen(true); input.current?.focus(); input.current?.select(); return true; }
      if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return true; }
      return false;
    },
  };
}
export function AgentChatSearch({ controller: c }) {
  if (!c.open) return null;
  return <><div className="agent-chat-search"><Search size={14} /><input ref={c.input} value={c.query} onChange={(e) => c.change(e.target.value)} aria-label="搜索已加载对话" placeholder="搜索文字、工具、命令或文件…" onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); c.next(e.shiftKey ? -1 : 1); } }} /><small role="status">{c.query ? c.count ? `${c.index < 0 ? "–" : c.index + 1}/${c.count}` : "无匹配" : ""}</small><button type="button" aria-label="上一个匹配" disabled={!c.count} onClick={() => c.next(-1)}><ChevronUp size={14} /></button><button type="button" aria-label="下一个匹配" disabled={!c.count} onClick={() => c.next(1)}><ChevronDown size={14} /></button><button type="button" aria-label="关闭对话搜索" onClick={c.close}><X size={14} /></button></div><p className="agent-chat-search-hint">搜索当前已加载的内容；更早记录可在上方加载。</p></>;
}

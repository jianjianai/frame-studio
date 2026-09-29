import { useEffect, useRef, useState } from "react";
import { api } from "../ui";
const key = "frame.agent-navigation";
const uuid = /^[a-f0-9-]{36}$/i;
export function readAgentTarget() {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    return value && uuid.test(value.work) && uuid.test(value.task) && (!value.chat || uuid.test(value.chat)) ? value : null;
  } catch { return null; }
}
export function navigateToAgent(notification) {
  const target = { work: notification.work, chat: notification.chat, task: notification.task, question: notification.question || null, nonce: crypto.randomUUID() };
  try { sessionStorage.setItem(key, JSON.stringify(target)); } catch {}
  window.location.hash = "/work/" + target.work;
  window.dispatchEvent(new CustomEvent("frame-agent-navigate", { detail: target }));
}
export function useAgentTarget({ work, chat, chats, visible, turns, switchChat, setOlder, follow, setFollowing, messages, notify }) {
  const [target, setTarget] = useState(readAgentTarget);
  const current = useRef({}); current.current = { switchChat, setOlder, setFollowing, notify };
  const requested = useRef(null), done = useRef(null);
  useEffect(() => {
    const read = (event) => setTarget(event.detail || readAgentTarget());
    window.addEventListener("frame-agent-navigate", read);
    return () => window.removeEventListener("frame-agent-navigate", read);
  }, []);
  useEffect(() => {
    if (!visible || !target || target.work !== work.id || !chats || done.current === target.nonce) return;
    const context = current.current;
    if (!chats.some((c) => c.id === target.chat)) { context.notify("通知对应的对话已不可用", "error"); done.current = target.nonce; return; }
    if (chat !== target.chat) { context.switchChat(target.chat); return; }
    follow.current = false; context.setFollowing(false);
    if (!turns.some((t) => t.id === target.task)) {
      if (requested.current === target.nonce) return;
      requested.current = target.nonce;
      api("agent_turn_read", { work: work.id, task: target.task }).then((row) => {
        if (readAgentTarget()?.nonce === target.nonce) context.setOlder((old) => [...old, row]);
      }).catch((error) => context.notify(error.message, "error"));
      return;
    }
    const root = messages.current;
    if (!root) return;
    let timer;
    const show = () => {
      const el = document.getElementById(target.question ? "agent-question-" + target.question : "agent-turn-" + target.task);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.classList.add("agent-target-highlight");
      done.current = target.nonce;
      try { if (readAgentTarget()?.nonce === target.nonce) sessionStorage.removeItem(key); } catch {}
      observer.disconnect();
      timer = setTimeout(() => el.classList.remove("agent-target-highlight"), 2000);
    };
    const observer = new MutationObserver(show); observer.observe(root, { childList: true, subtree: true });
    show();
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [visible, target, chat, chats, turns, work.id, messages, follow]);
}

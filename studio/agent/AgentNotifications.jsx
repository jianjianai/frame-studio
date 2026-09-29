import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Bell, BellRing, CircleHelp, CircleAlert, Check, CheckCheck, ExternalLink, X, Settings2 } from "lucide-react";
import { api, useQuery, Modal, ErrorNote, Loading, date } from "../ui";
import { navigateToAgent } from "./agent-navigation";
import "./agent-notifications.css";

const Context = createContext(null), preferenceKey = "frame.agent-notifications.v1";
const labels = { question: "等待你的回答", completed: "创作已完成", failed: "创作需要处理" };
const icons = { question: CircleHelp, completed: Check, failed: CircleAlert };
function readPreferences() {
  try { const value = JSON.parse(localStorage.getItem(preferenceKey) || "{}"); return { inApp: value.inApp !== false, desktop: value.desktop === true }; }
  catch { return { inApp: true, desktop: false }; }
}
async function showDesktopOnce(row, onClick) {
  const perform = () => {
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem("frame.agent-desktop-seen") || "[]"); if (!Array.isArray(seen)) seen = []; } catch {}
    if (seen.includes(String(row.id))) return;
    try { localStorage.setItem("frame.agent-desktop-seen", JSON.stringify([...seen, String(row.id)].slice(-200))); } catch {}
    const notification = new Notification(labels[row.kind] || "FRAME", {
      body: row.work_title, tag: "frame-agent-" + row.task + "-" + row.kind,
      silent: true, requireInteraction: row.kind === "question",
    });
    notification.onclick = () => { window.focus(); onClick(row); notification.close(); };
    if (row.kind !== "question") window.setTimeout(() => notification.close(), 15000);
  };
  if (navigator.locks) await navigator.locks.request("frame-agent-desktop", perform);
  else perform();
}
export function useAgentNotifications() { return useContext(Context); }
export function AgentNotificationBell({ className = "", label = false, ...props }) {
  const context = useAgentNotifications();
  if (!context) return null;
  return <button type="button" className={"agent-notification-bell " + className} aria-label="Agent 通知" title={context.unread ? `${context.unread} 条未读 Agent 通知` : "Agent 通知"} aria-haspopup="dialog" onClick={() => context.setOpen(true)} {...props}>
    <Bell size={17} />{label && <span className="work-tool-label">通知</span>}{context.unread > 0 && <span className="agent-notification-count">{context.unread > 99 ? "99+" : context.unread}</span>}
  </button>;
}
export function AgentNotificationProvider({ children }) {
  const query = useQuery("agent_notifications", { limit: 30 }, 1);
  const [open, setOpen] = useState(false), [toast, setToast] = useState(null), [preferences, setPreferences] = useState(readPreferences), [error, setError] = useState("");
  const known = useRef(null), timer = useRef(null), latestAction = useRef(null);
  const visit = async (row) => {
    setOpen(false); setToast(null);
    try { await api("agent_notifications_read", { ids: [String(row.id)] }); }
    catch (err) { setError(err.message); }
    navigateToAgent(row);
  };
  latestAction.current = visit;
  useEffect(() => {
    const sync = () => setPreferences(readPreferences());
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("storage", sync); clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    const rows = query.data?.items;
    if (!rows) return;
    if (known.current === null) { known.current = new Set(rows.map((row) => String(row.id))); return; }
    const fresh = rows.filter((row) => !known.current.has(String(row.id)) && !row.read_at);
    rows.forEach((row) => known.current.add(String(row.id)));
    if (known.current.size > 1000) known.current = new Set(rows.map((row) => String(row.id)));
    if (!fresh.length) return;
    const row = fresh.find((item) => item.kind === "question") || fresh[0];
    const current = document.getElementById("agent-turn-" + row.task), rect = current?.getBoundingClientRect();
    const alreadyVisible = document.hasFocus() && !document.hidden && rect && rect.bottom > 0 && rect.top < innerHeight && current.getClientRects().length > 0 && !current.closest("[hidden]");
    if (preferences.inApp && !alreadyVisible && !document.querySelector("dialog[open]")) {
      setToast(row); clearTimeout(timer.current);
      timer.current = setTimeout(() => setToast(null), row.kind === "question" ? 18000 : 10000);
    }
    if (preferences.desktop && "Notification" in window && Notification.permission === "granted" && (!document.hasFocus() || document.hidden))
      void showDesktopOnce(row, (item) => latestAction.current(item)).catch(() => {});
  }, [query.data, preferences]);
  const savePreferences = (next) => { setPreferences(next); try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { setError("浏览器无法保存通知偏好"); } };
  return <Context.Provider value={{ unread: query.data?.unread || 0, open, setOpen }}>
    {children}
    {toast && <aside className={"agent-toast " + toast.kind} role="status"><span className="agent-toast-icon">{toast.kind === "question" ? <CircleHelp size={18} /> : toast.kind === "failed" ? <CircleAlert size={18} /> : <Check size={18} />}</span><div><strong>{labels[toast.kind]}</strong><span>{toast.work_title}</span></div><button type="button" onClick={() => void visit(toast)}>{toast.kind === "question" ? "去回答" : "查看"}</button><button type="button" className="agent-toast-close" aria-label="收起 Agent 提醒" onClick={() => setToast(null)}><X size={13} /></button></aside>}
    {open && <AgentNotificationCenter query={query} visit={visit} preferences={preferences} savePreferences={savePreferences} error={error} setError={setError} onClose={() => setOpen(false)} />}
  </Context.Provider>;
}
function AgentNotificationCenter({ query, visit, preferences, savePreferences, error, setError, onClose }) {
  const [older, setOlder] = useState([]), [next, setNext] = useState(undefined), [loading, setLoading] = useState(false), [settings, setSettings] = useState(false), [unreadOnly, setUnreadOnly] = useState(false);
  const rows = [...new Map([...(query.data?.items || []), ...older].map((row) => [String(row.id), row])).values()].sort((a, b) => Number(b.id) - Number(a.id));
  const cursor = next === undefined ? query.data?.next : next;
  const markRead = async (ids) => { if (!ids.length) return; setLoading(true); try { await api("agent_notifications_read", { ids }); setOlder((old) => old.map((row) => ids.includes(String(row.id)) ? { ...row, read_at: new Date().toISOString() } : row)); } catch (err) { setError(err.message); } finally { setLoading(false); } };
  return <Modal title="Agent 通知" onClose={onClose}><div className="agent-notification-center">
    <div className="agent-notification-toolbar"><div className="row"><button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>全部</button><button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>未读 {query.data?.unread || 0}</button></div><div className="row"><button type="button" title="将已加载的通知全部标为已读" aria-label="已加载通知全部已读" disabled={loading || !rows.some((r) => !r.read_at)} onClick={() => void markRead(rows.filter((r) => !r.read_at).map((r) => String(r.id)).slice(0, 100))}><CheckCheck size={16} /></button><button type="button" aria-label="通知设置" aria-expanded={settings} onClick={() => setSettings(!settings)}><Settings2 size={16} /></button></div></div>
    {settings && <section className="agent-notification-settings" aria-label="Agent 通知设置"><label><input type="checkbox" checked={preferences.inApp} onChange={(e) => savePreferences({ ...preferences, inApp: e.target.checked })} />网页内显示重要提醒</label><label><input type="checkbox" checked={preferences.desktop} onChange={async (e) => {
      if (!e.target.checked) { savePreferences({ ...preferences, desktop: false }); return; }
      if (!("Notification" in window)) { setError("当前浏览器不支持桌面通知"); return; }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setError("桌面通知未获授权，可在浏览器网站设置中开启；网页通知仍然可用。 "); return; }
      setError(""); savePreferences({ ...preferences, desktop: true });
    }} />窗口失焦时发送桌面通知</label><p>只提醒待回答、完成和失败，不通知每个工具调用。默认无声音；关闭浏览器期间的事件在重新打开后保留于通知中心，不提供离线推送。</p></section>}
    <ErrorNote error={error || query.error} />
    {query.loading && !query.data && <Loading />}
    <div className="agent-notification-list">{rows.filter((row) => !unreadOnly || !row.read_at).map((row) => { const Icon = icons[row.kind] || Bell; return <article key={row.id} className={(row.read_at ? "" : "unread ") + row.kind}>
      <button type="button" className="agent-notification-open" onClick={() => void visit(row)}><Icon size={17} /><span><strong>{labels[row.kind]}{!row.read_at && <i aria-label="未读" />}</strong><span>{row.work_title}</span><small>{(row.prompt || "").slice(0, 120)}</small><time>{date(row.created)}</time></span><ExternalLink size={13} /></button>
      {!row.read_at && <button type="button" className="agent-notification-mark" aria-label={"标为已读 " + row.work_title} onClick={() => void markRead([String(row.id)])}><Check size={13} /></button>}
    </article>; })}</div>
    {!query.loading && !rows.some((row) => !unreadOnly || !row.read_at) && <p className="agent-notification-empty">{unreadOnly ? "没有未读通知" : "暂无通知。AI 完成、失败或需要你的意见时会出现在这里。"}</p>}
    {cursor && <button type="button" className="agent-notifications-more" disabled={loading} onClick={async () => { setLoading(true); try { const value = await api("agent_notifications", { limit: 30, before: cursor }); setOlder((old) => [...old, ...value.items]); setNext(value.next); } catch (err) { setError(err.message); } finally { setLoading(false); } }}>{loading ? "加载中…" : "加载更早通知"}</button>}
  </div></Modal>;
}

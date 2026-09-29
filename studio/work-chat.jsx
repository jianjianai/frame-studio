import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Square,
  Plus,
  MessageSquare,
  PanelRightClose,
  Sparkles,
  Copy,
} from "lucide-react";
import { subscribe } from "./realtime";
import {
  api,
  useQuery,
  useAction,
  Button,
  ErrorNote,
  Loading,
  active,
  states,
  date,
} from "./ui";
import { ReviewText, ReviewContext, reviewTime } from "./review-text";

function useEvents(tasks, chat) {
  const cache = useRef({}),
    [events, setEvents] = useState({}),
    [error, setError] = useState("");
  const signature = tasks
    .filter((t) => t.chat === chat)
    .map((t) => t.id + ":" + t.state)
    .join(",");
  useEffect(() => {
    let cancelled = false;
    const stops = tasks
      .filter((t) => t.chat === chat)
      .map((task) => {
        const entry = (cache.current[task.id] ||= { after: 0, rows: [] });
        return subscribe(
          "task_get",
          { id: task.id, after: entry.after },
          ({ result, error }) => {
            if (cancelled) return;
            if (error) {
              setError(error);
              return;
            }
            const rows = new Map(entry.rows.map((row) => [row.id, row]));
            for (const row of result.events || []) rows.set(row.id, row);
            entry.rows = [...rows.values()];
            entry.after = Number(entry.rows.at(-1)?.id || 0);
            setEvents(
              Object.fromEntries(
                Object.entries(cache.current).map(([id, v]) => [
                  id,
                  [...v.rows],
                ]),
              ),
            );
            setError("");
          },
        );
      });
    const connection = (event) =>
      setError(
        event.detail === "connected"
          ? ""
          : "连接暂时中断，正在重新连接；服务器上的创作会继续。",
      );
    window.addEventListener("frame-connection", connection);
    return () => {
      cancelled = true;
      stops.forEach((stop) => stop());
      window.removeEventListener("frame-connection", connection);
    };
  }, [chat, signature]);
  return { events, error };
}
function Turn({ task, events, onRetry, onStop, onRecall, notify }) {
  const messages = new Map(),
    activities = new Map();
  let delta = "";
  for (const row of events || []) {
    const e = row.data;
    if (row.kind === "message") {
      messages.set(e.id || row.id, e.text);
      delta = "";
    } else if (row.kind === "summary" && e.text) {
      if (![...messages.values()].includes(e.text))
        messages.set("summary", e.text);
      delta = "";
    } else if (row.kind === "delta") delta += e.text;
    else if (row.kind === "activity") {
      const previous = activities.get(e.id);
      activities.set(e.id || row.id, {
        ...previous,
        ...e,
        text: e.tool === "result" && previous ? previous.text : e.text,
      });
    }
  }
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="chat-turn">
      <div className="human-message">
        {task.input.prompt}
        <ReviewContext context={task.input.context} onRecall={onRecall} />
      </div>
      <div className="assistant-message">
        <div className="assistant-label">
          <Sparkles size={14} />
          <strong>{states[task.state] || "状态更新中"}</strong>
          <span>{date(task.created)}</span>
        </div>
        {[...messages].map(([id, text]) => (
          <div className="message-text" key={id}>
            <ReviewText text={text} onRecall={onRecall} />
          </div>
        ))}
        {delta && (
          <div className="message-text streaming">
            <ReviewText text={delta} onRecall={onRecall} />
          </div>
        )}
        {activities.size > 0 && (
          <details className="activity-list">
            <summary>
              {active(task) ? "查看正在进行的工作" : "查看制作过程"} ·{" "}
              {activities.size} 项
            </summary>
            {[...activities].slice(expanded ? 0 : -30).map(([id, activity]) => (
              <div key={id}>
                <span>
                  {activity.phase === "done" ? "✓" : "·"} {activity.text}
                </span>
                {activity.output && <pre>{activity.output}</pre>}
              </div>
            ))}
            {activities.size > 30 && (
              <button type="button" onClick={() => setExpanded(!expanded)}>
                {expanded ? "只显示最近 30 项" : "展开更早的过程"}
              </button>
            )}
          </details>
        )}
        {!messages.size && !delta && active(task) && (
          <p className="quiet">
            {task.state === "queued"
              ? "已排队，前一项工作结束后自动开始。"
              : "AI 正在制作作品…"}
          </p>
        )}
        <ErrorNote error={task.error} />
        <div className="row turn-actions">
          {!!messages.size && (
            <Button
              icon={Copy}
              aria-label="复制 AI 回复"
              onClick={() =>
                navigator.clipboard
                  .writeText([...messages.values()].join("\n\n"))
                  .then(
                    () => notify("回复已复制"),
                    () => notify("复制失败，请选择文字复制", "error"),
                  )
              }
            >
              复制回复
            </Button>
          )}
          {task.state === "failed" && (
            <Button
              onClick={() =>
                onRetry(task.input.prompt, task.input.context || {})
              }
            >
              保留原引用重试
            </Button>
          )}
          {active(task) && (
            <Button icon={Square} onClick={() => onStop(task.id)}>
              停止本次创作
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
const draftRead = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
};
const draftWrite = (key, value) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
export function WorkChat({
  work,
  tasks,
  reload,
  notify,
  position,
  selectedAssets,
  onClearAssets,
  onRemoveAsset,
  onRecall,
  onClose,
  suggestion,
  visible = true,
  compact = false,
}) {
  const chats = useQuery("works_chats", { id: work.id }),
    connections = useQuery("connections_list");
  const draftKey = (chat) =>
    "frame.chat-draft:" + work.id + ":" + (chat || "new");
  const [chat, setChat] = useState(""),
    [connection, setConnection] = useState("");
  const [prompt, setPrompt] = useState(
    () => draftRead(draftKey("")).prompt || "",
  );
  const [review, setReview] = useState(
    () => draftRead(draftKey("")).review || null,
  );
  const [run, busy] = useAction(notify),
    [older, setOlder] = useState([]),
    [more, setMore] = useState(true),
    [following, setFollowing] = useState(true);
  const initialized = useRef(false),
    requestKey = useRef(null),
    messages = useRef(null),
    follow = useRef(true),
    section = useRef(null),
    composer = useRef(null),
    historyAnchor = useRef(null);
  useEffect(() => {
    if (!suggestion) return;
    setPrompt((previous) =>
      previous.trim() ? previous + "\n\n" + suggestion.text : suggestion.text,
    );
    if (suggestion.review) setReview(suggestion.review);
    composer.current?.focus();
  }, [suggestion?.id]);
  const currentTurns = useQuery(
    chat ? "works_chat_turns" : null,
    { id: work.id, chat, limit: 30 },
    1500,
  );
  const switchChat = (next) => {
    draftWrite(draftKey(chat), { prompt, review });
    const draft = draftRead(draftKey(next));
    setChat(next);
    setPrompt(draft.prompt || "");
    setReview(draft.review || null);
    setOlder([]);
    setMore(true);
    follow.current = true;
    setFollowing(true);
    draftWrite("frame.active-chat:" + work.id, { id: next });
  };
  useEffect(() => {
    if (initialized.current || !chats.data) return;
    initialized.current = true;
    const remembered = draftRead("frame.active-chat:" + work.id).id;
    const id = chats.data.some((c) => c.id === remembered)
      ? remembered
      : chats.data[0]?.id || "";
    switchChat(id);
  }, [chats.data]);
  useEffect(() => {
    if (!connection && connections.data?.length)
      setConnection(connections.data.find((c) => c.configured)?.id || "");
  }, [connection, connections.data]);
  useEffect(() => {
    const refresh = () => connections.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    draftWrite(draftKey(chat), { prompt, review });
    requestKey.current = null;
  }, [
    prompt,
    review,
    chat,
    work.id,
    selectedAssets.map((a) => a.id).join(","),
  ]);
  const conversationTasks = [
    ...new Map(
      [...older, ...(currentTurns.data || []), ...tasks]
        .filter((t) => t.chat === chat)
        .map((t) => [t.id, t]),
    ).values(),
  ].sort(
    (a, b) =>
      new Date(a.created) - new Date(b.created) || a.id.localeCompare(b.id),
  );
  const stream = useEvents(conversationTasks, chat),
    selected = chats.data?.find((c) => c.id === chat),
    chosen = selected?.connection || connection;
  const chosenConnection = connections.data?.find((c) => c.id === chosen),
    canSend = !!chosenConnection?.configured;
  useEffect(() => {
    const el = messages.current;
    if (!el) return;
    if (historyAnchor.current) {
      el.scrollTop =
        el.scrollHeight -
        historyAnchor.current.height +
        historyAnchor.current.top;
      historyAnchor.current = null;
    } else if (visible && follow.current) el.scrollTop = el.scrollHeight;
  }, [stream.events, tasks, currentTurns.data, older, visible, chat]);
  useEffect(() => {
    if (visible && compact) composer.current?.focus();
  }, [visible, compact]);
  const send = async (text = prompt, originalContext) => {
    if (!text.trim() || busy || !canSend) return;
    const context = originalContext || {
      ...(review || {}),
      ...(selectedAssets.length
        ? { assets: selectedAssets.map((a) => a.id) }
        : {}),
    };
    const { assetNames, ...requestContext } = context;
    const key = originalContext
      ? crypto.randomUUID()
      : (requestKey.current ||= crypto.randomUUID());
    const oldDraft = draftKey(chat);
    await run(async () => {
      let id = chat;
      if (!id) {
        const c = await api("works_chat_create", {
          id: work.id,
          connection: chosen,
          title: text.slice(0, 60),
        });
        id = c.id;
        setChat(id);
        chats.refresh();
        draftWrite("frame.active-chat:" + work.id, { id });
      }
      await api("works_chat_send", {
        id: work.id,
        chat: id,
        prompt: text,
        requestKey: key,
        context: requestContext,
      });
      requestKey.current = null;
      if (!originalContext) {
        setPrompt("");
        setReview(null);
        onClearAssets();
        draftWrite(oldDraft, {});
        draftWrite(draftKey(id), {});
      }
      reload();
      follow.current = true;
      setFollowing(true);
    });
  };
  const validRange =
    Number.isFinite(position.selection?.start) &&
    position.selection.end > position.selection.start;
  return (
    <section
      ref={section}
      id="work-chat"
      className="creation-chat"
      hidden={!visible}
      aria-label="AI 创作对话"
      role={compact ? "dialog" : undefined}
      aria-modal={compact && visible ? true : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && compact) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Tab" && compact) {
          const focusable = [
            ...section.current.querySelectorAll(
              "button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary",
            ),
          ].filter((el) => el.getClientRects().length);
          const first = focusable[0],
            last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="chat-header">
        <div className="row">
          <MessageSquare size={18} />
          <h2>AI 创作</h2>
        </div>
        <Button
          icon={Plus}
          aria-label="新对话"
          disabled={busy}
          onClick={() => {
            switchChat("");
            composer.current?.focus();
          }}
        >
          新对话
        </Button>
        <Button
          icon={PanelRightClose}
          aria-label="关闭 AI 对话"
          title="关闭 AI 对话（不会停止创作）"
          onClick={onClose}
        />
      </header>
      <div className="chat-selectors">
        <select
          aria-label="创作对话"
          value={chat}
          disabled={busy}
          onChange={(e) => switchChat(e.target.value)}
        >
          <option value="">新的创作对话</option>
          {chats.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <select
          aria-label="模型连接"
          title={
            chat
              ? "此对话绑定当前模型连接；新对话可选择其他连接"
              : "选择创作模型连接"
          }
          value={chosen}
          disabled={!!chat || busy}
          onChange={(e) => setConnection(e.target.value)}
        >
          <option value="">选择模型连接</option>
          {connections.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.configured ? "" : " · 未连接"}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={chats.error || connections.error} />
      {stream.error && (
        <p className="reconnecting" role="status">
          {stream.error}
        </p>
      )}
      <div
        className="chat-messages"
        ref={messages}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          setFollowing(follow.current);
        }}
      >
        <ErrorNote error={currentTurns.error} />
        {currentTurns.error && (
          <Button onClick={currentTurns.refresh}>重试加载对话</Button>
        )}
        {more && conversationTasks.length >= 30 && (
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const page = await api("works_chat_turns", {
                  id: work.id,
                  chat,
                  limit: 30,
                  before: conversationTasks[0].id,
                });
                follow.current = false;
                historyAnchor.current = {
                  height: messages.current.scrollHeight,
                  top: messages.current.scrollTop,
                };
                setOlder((previous) => [...page, ...previous]);
                setMore(page.length === 30);
              })
            }
          >
            加载更早的对话
          </Button>
        )}
        {!conversationTasks.length &&
        (chats.loading || currentTurns.loading) ? (
          <Loading />
        ) : (
          !conversationTasks.length &&
          !chats.error &&
          !currentTurns.error && (
            <div className="chat-intro">
              <Sparkles size={25} />
              <h3>从一个想法开始</h3>
              <p>描述想法，或引用一个时间、选段和素材，让 AI 精确修改。</p>
              <div className="suggestions">
                {[
                  "先帮我设计这个作品的分镜与风格",
                  "制作一段简洁、有节奏的开场动画",
                ].map((text) => (
                  <button key={text} onClick={() => setPrompt(text)}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )
        )}
        {conversationTasks.map((t) => (
          <Turn
            key={t.id}
            task={t}
            events={stream.events[t.id]}
            onRetry={send}
            onStop={(id) =>
              run(async () => {
                await api("task_cancel", { id });
                reload();
              })
            }
            onRecall={onRecall}
            notify={notify}
          />
        ))}
      </div>
      {!following && (
        <button
          className="follow-latest"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            messages.current.scrollTop = messages.current.scrollHeight;
          }}
        >
          回到最新回复 ↓
        </button>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <ReviewContext
          context={review}
          onRecall={onRecall}
          onRemove={() => setReview(null)}
        />
        {selectedAssets.length > 0 && (
          <div className="selected-assets">
            {selectedAssets.map((a) => (
              <span className="selected-asset" key={a.id} title={a.name}>
                {a.name}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={"移除引用 " + a.name}
                  onClick={() => onRemoveAsset(a.id)}
                >
                  ×
                </button>
              </span>
            ))}
            <small>仅引用素材；移除引用不会删除资源。</small>
          </div>
        )}
        <textarea
          ref={composer}
          aria-label="创作要求"
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述想法，或告诉 AI 这一段怎样调整…"
          rows={4}
          required
          maxLength={40000}
          onKeyDown={(e) => {
            if (
              (e.ctrlKey || e.metaKey) &&
              e.key === "Enter" &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-options">
          <div className="context-tools">
            <Button
              type="button"
              disabled={busy || !position.duration}
              title={"引用 " + reviewTime(position.time)}
              onClick={() => setReview({ time: Number(position.time || 0) })}
            >
              引用当前时间
            </Button>
            <Button
              type="button"
              disabled={busy || !validRange}
              title={
                validRange
                  ? reviewTime(position.selection.start) +
                    "—" +
                    reviewTime(position.selection.end)
                  : "先在时间轴设置入点和出点"
              }
              onClick={() =>
                setReview({
                  time: position.selection.start,
                  start: position.selection.start,
                  end: position.selection.end,
                })
              }
            >
              引用选段
            </Button>
          </div>
          <Button
            type="submit"
            className="primary"
            icon={ArrowUp}
            disabled={busy || !prompt.trim() || !canSend}
          >
            {busy ? "发送中" : "发送"}
          </Button>
        </div>
        {!canSend && !connections.loading && (
          <p className="connection-hint">
            此对话没有可用的模型连接。
            <a href="#/settings" target="_blank" rel="noopener">
              连接模型 ↗
            </a>
            {chat && "，或新建对话选择其他连接。"}
          </p>
        )}
        <small>草稿自动保留 · 关闭对话不停止创作 · Ctrl / ⌘ + Enter 发送</small>
      </form>
    </section>
  );
}

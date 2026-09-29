import { subscribe } from "./realtime";

import { loadTaskEvents } from "./task-events";
import { canClearDraft, canReuseSubmission } from "./chat-draft";
import { useEffect, useRef, useState } from "react";

import { ArrowUp, Square, Plus, MessageSquare, X, Sparkles } from "lucide-react";
import { api, request, useQuery, useAction, Button, ErrorNote, active, cancellable, states, date } from "./ui";

function useEvents(tasks, chat) {
  const cache = useRef({}),
    [events, setEvents] = useState({}),
    [error, setError] = useState(""),
    [connectionError, setConnectionError] = useState(""),
    [reconnected, setReconnected] = useState(0);
  const signature = tasks.filter((t) => t.chat === chat).map((t) => t.id + ":" + t.state).join(",");
  useEffect(() => {
    setError("");
    const stop = loadTaskEvents({
      tasks: tasks.filter((task) => task.chat === chat), cache: cache.current,
      call: api, subscribe, onChange: setEvents, onError: setError,
    });
    const connection = (e) => {
      if (e.detail === "connected") {
        setConnectionError("");
        setReconnected((value) => value + 1);
      } else setConnectionError("连接暂时中断，正在重新连接；服务器上的创作会继续。");
    };
    window.addEventListener("frame-connection", connection);
    return () => { stop(); window.removeEventListener("frame-connection", connection); };
  }, [chat, signature, reconnected]);
  return { events, error: connectionError || error };
}
function Turn({ task, events, onRetry, onStop, onRetryPublication }) {
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
  return (
    <article className="chat-turn">
      <div className="human-message">
        {task.input.prompt}
        {task.input.context?.time !== undefined && (
          <small>审片位置 {task.input.context.time.toFixed(2)} 秒</small>
        )}
      </div>
      <div className="assistant-message">
        <div className="assistant-label">
          <Sparkles size={14} />
          <strong>{states[task.state]}</strong>
          <span>{date(task.created)}</span>
        </div>
        {[...messages].map(([id, text]) => (
          <div className="message-text" key={id}>
            {text}
          </div>
        ))}
        {delta && <div className="message-text streaming">{delta}</div>}
        {activities.size > 0 && (
          <details className="activity-list">
            <summary>
              {active(task) ? "查看正在进行的工作" : "查看制作过程"} ·{" "}
              {activities.size} 项
            </summary>
            {[...activities].slice(-30).map(([id, e]) => (
              <div key={id}>
                <span>
                  {e.phase === "done" ? "✓" : "·"} {e.text}
                </span>
                {e.output && <pre>{e.output}</pre>}
              </div>
            ))}
          </details>
        )}
        {!messages.size && !delta && active(task) && (
          <p className="quiet">
            {task.state === "queued"
              ? "已排队，前一项工作结束后自动开始。"
              : "AI 正在制作作品…"}
          </p>
        )}
        {task.error && (
          <p role="alert" className="error">
            {task.error}
          </p>
        )}
        <div className="row">
          {task.state === "failed" && (
            <Button onClick={() => onRetry(task.input.prompt)}>
              保留上下文重试
            </Button>
          )}
          {task.state === "publish_failed" && (
            <Button onClick={() => onRetryPublication(task.id)}>重试保存结果（不重跑 AI）</Button>
          )}
          {cancellable(task) && (
            <Button icon={Square} onClick={() => onStop(task.id)}>
              停止本次创作
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
export function WorkChat({
  work,
  tasks,
  reload,
  notify,
  position,
  selectedAssets,
  onClearAssets,
}) {
  const chats = useQuery("works_chats", { id: work.id }),
    connections = useQuery("connections_list"),
    [chat, setChat] = useState(""),
    [connection, setConnection] = useState(""),
    [prompt, setPrompt] = useState(
      () => sessionStorage.getItem("draft:" + work.id) || "",
    ),
    [usePosition, setUsePosition] = useState(false),
    [run, busy] = useAction(notify);
  const initialized = useRef(false),
    requestKey = useRef(null),
    draftRevision = useRef(0),
    chatRevision = useRef(0),
    promptRef = useRef(prompt),
    sending = useRef(false),
    messages = useRef(null),
    follow = useRef(true);
  promptRef.current = prompt;
  const editPrompt = (value) => { draftRevision.current++; promptRef.current = value; setPrompt(value); };
  const chooseChat = (value) => { initialized.current = true; chatRevision.current++; setChat(value); };
  const currentTurns = useQuery(
    chat ? "works_chat_turns" : null,
    { id: work.id, chat, limit: 30 },
    1500,
  );
  const [older, setOlder] = useState([]),
    [more, setMore] = useState(true);
  useEffect(() => {
    setOlder([]);
    setMore(true);
  }, [chat]);
  useEffect(() => {
    if (!initialized.current && chats.data) {
      setChat(chats.data[0]?.id || "");
      initialized.current = true;
    }
  }, [chats.data]);
  useEffect(() => {
    if (!connection && connections.data?.length)
      setConnection(
        connections.data.find((c) => c.configured)?.id ||
          connections.data[0].id,
      );
  }, [connections.data, connection]);
  useEffect(() => {
    sessionStorage.setItem("draft:" + work.id, prompt);
  }, [prompt, work.id]);
  const conversationTasks = [
    ...new Map(
      [...older, ...(currentTurns.data || []), ...tasks]
        .filter((t) => t.chat === chat)
        .map((t) => [t.id, t]),
    ).values(),
  ].sort((a, b) => new Date(b.created) - new Date(a.created));
  const stream = useEvents(conversationTasks, chat),
    turns = conversationTasks.toReversed(),
    selected = chats.data?.find((c) => c.id === chat),
    chosen = selected?.connection || connection;
  useEffect(() => {
    if (follow.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [stream.events, tasks]);
  const send = async (text = prompt) => {
    if (sending.current || !text.trim() || !chosen) return;
    sending.current = true;
    initialized.current = true;
    const sent = { text, version: draftRevision.current, conversation: chatRevision.current };
    const assetIds = selectedAssets.map((asset) => asset.id);
    const intent = {
      id: work.id, chat, connection: chosen, prompt: text,
      context: {
        ...(usePosition ? { time: position.time || 0 } : {}),
        ...(usePosition && position.selection?.start !== undefined && position.selection?.end > position.selection.start
          ? { start: position.selection.start, end: position.selection.end } : {}),
        ...(assetIds.length ? { assets: assetIds } : {}),
      },
    };
    const previous = requestKey.current;
    const snapshot = { ...sent, work: work.id, chat, connection: chosen, usePosition, assetIds };
    // A retry after a lost acknowledgement must retain the original review time
    // and request key, even when the player has advanced in the meantime.
    const submission = previous && canReuseSubmission({ ...previous.snapshot, chat: previous.chat }, snapshot)
      ? previous : { key: crypto.randomUUID(), intent, chat, snapshot };
    requestKey.current = submission;
    try {
      await run(async () => {
        const frozen = submission.intent;
        if (!submission.chat) {
          const created = await api("works_chat_create", {
            id: frozen.id, connection: frozen.connection, title: frozen.prompt.slice(0, 60),
          });
          submission.chat = created.id;
          if (chatRevision.current === sent.conversation) setChat(created.id);
          chats.refresh();
        }
        await api("works_chat_send", {
          id: frozen.id, chat: submission.chat, prompt: frozen.prompt,
          requestKey: submission.key, context: frozen.context,
        });
        if (requestKey.current === submission) requestKey.current = null;
        if (canClearDraft(sent, { text: promptRef.current, version: draftRevision.current, conversation: chatRevision.current }))
          editPrompt("");
        if (chatRevision.current === sent.conversation) {
          onClearAssets(assetIds);
          follow.current = true;
        }
        reload();
      });
    } finally { sending.current = false; }
  };
  const stop = (id) =>
    run(async () => {
      await api("task_cancel", { id });
      reload();
    });
  return (
    <section className="creation-chat">
      <header className="chat-header">
        <div className="row">
          <MessageSquare size={18} />
          <h2>AI 创作</h2>
        </div>
        <Button
          icon={Plus}
          aria-label="新对话"
          onClick={() => {
            chooseChat("");
            editPrompt("");
          }}
        >
          新对话
        </Button>
      </header>
      <div className="chat-selectors">
        <select
          aria-label="创作对话"
          value={chat}
          onChange={(e) => chooseChat(e.target.value)}
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
          value={chosen}
          disabled={!!chat}
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
          const t = e.currentTarget;
          follow.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
        }}
      >
        <ErrorNote error={currentTurns.error} />
        {more && conversationTasks.length >= 30 && (
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const page = await api("works_chat_turns", {
                  id: work.id,
                  chat,
                  limit: 30,
                  before: turns[0].id,
                });
                follow.current = false;
                setOlder((previous) => [...previous, ...page]);
                setMore(page.length === 30);
              })
            }
          >
            加载更早的对话
          </Button>
        )}
        {!turns.length && (
          <div className="chat-intro">
            <Sparkles size={27} />
            <h3>从一个想法开始</h3>
            <p>告诉 AI 想表达什么。画面、分镜、声音与节奏，可以边看边调整。</p>
            <div className="suggestions">
              {[
                "先帮我设计这个作品的分镜与风格",
                "制作一段简洁、有节奏的开场动画",
              ].map((s) => (
                <button key={s} onClick={() => editPrompt(s)}>
                  {s}
                </button>
              ))}
            </div>
            {!connections.data?.some((c) => c.configured) && (
              <a href="#/settings">连接创作模型 →</a>
            )}
          </div>
        )}
        {turns.map((t) => (
          <Turn
            key={t.id}
            task={t}
            events={stream.events[t.id]}
            onRetry={send}
            onStop={stop}
            onRetryPublication={(id) => run(async () => { await api("task_retry_publish", { id }); reload(); })}
          />
        ))}
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {selectedAssets.length > 0 && (
          <div className="selected-assets">
            {selectedAssets.map((a) => (
              <span key={a.id}>{a.name}</span>
            ))}
            <Button
              icon={X}
              aria-label="清除素材引用"
              type="button"
              onClick={() => onClearAssets()}
            />
          </div>
        )}
        <textarea
          aria-label="创作要求"
          value={prompt}
          onChange={(e) => editPrompt(e.target.value)}
          placeholder="描述想法，或告诉 AI 这一段怎样调整…"
          rows="4"
          required
          maxLength="40000"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (prompt.trim() && !busy) void send();
            }
          }}
        />
        <div className="composer-options">
          <label className="check">
            <input
              type="checkbox"
              checked={usePosition}
              onChange={(e) => setUsePosition(e.target.checked)}
            />
            附带当前画面 {Number(position.time || 0).toFixed(2)}s
          </label>
          <Button
            className="primary"
            icon={ArrowUp}
            disabled={busy || !prompt.trim() || !chosen}
          >
            {busy ? "发送中" : "发送"}
          </Button>
        </div>
        <small>关闭浏览器后继续制作 · Ctrl / ⌘ + Enter 发送</small>
      </form>
    </section>
  );
}


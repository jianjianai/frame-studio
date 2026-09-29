import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Search,
  CircleHelp,
  Square,
  Plus,
  MessageSquare,
  PanelRightClose,
  Sparkles,
  Copy,
  Settings2,
  Paperclip,
  Clock3,
  Scissors,
  Maximize2,
  Minimize2,
  Play,
  Pencil,
  LoaderCircle,
} from "lucide-react";
import { AgentTurn as Turn } from "./agent/AgentTurn";
import { AgentChatSearch, useAgentSearch } from "./agent/AgentSearch";
import { useAgentTarget, navigateToAgent } from "./agent/agent-navigation";
import "./agent/agent-thread.css";
import { ModelPicker } from "./model-picker";
import { WorkResult } from "./work-result";
import { TaskDiagnostics } from "./task-diagnostics";
import { positionReference } from "./preview-session";
import { ChatHistory } from "./chat-history";
import { useAiPreferences } from "./ai-preferences";
import {
  providerModels,
  providerAvailable,
} from "../src/contracts/ai-models.mjs";
import "./ai-workbench.css";
import { loadTaskEvents } from "./task-events";
import { subscribe } from "./realtime";
import {
  api,
  request,
  Modal,
  useQuery,
  useAction,
  Button,
  ErrorNote,
  Loading,
  active,
  cancellable,
  states,
  date,
} from "./ui";
import { ReviewText, ReviewContext, reviewTime } from "./review-text";

function useEvents(tasks, chat) {
  const cache = useRef({}),
    [events, setEvents] = useState({}),
    [error, setError] = useState(""),
    [connectionError, setConnectionError] = useState(""),
    [reconnected, setReconnected] = useState(0);
  const signature = tasks
    .filter((t) => t.chat === chat)
    .map((t) => t.id + ":" + t.state)
    .join(",");
  useEffect(() => {
    setError("");
    const stop = loadTaskEvents({
      tasks: tasks.filter((task) => task.chat === chat),
      cache: cache.current,
      call: api,
      subscribe,
      onChange: setEvents,
      onError: setError,
    });
    const connection = (e) => {
      if (e.detail === "connected") {
        setConnectionError("");
        setReconnected((value) => value + 1);
      } else
        setConnectionError(
          "连接暂时中断，正在重新连接；服务器上的创作会继续。",
        );
    };
    window.addEventListener("frame-connection", connection);
    return () => {
      stop();
      window.removeEventListener("frame-connection", connection);
    };
  }, [chat, signature, reconnected]);
  return { events, error: connectionError || error };
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
  previewReference = {},
  onClearAssets,
  onRemoveAsset,
  onRecall,
  onClose,
  onAddAssets,
  onPausePreview,
  suggestion,
  visible = true,
  compact = false,
  embedded = false,
}) {
  const chats = useQuery("works_chats", { id: work.id }),
    connections = useQuery("connections_list", {}, 1);
  const queueQuery = useQuery(visible && tasks.some(task => task.state === "queued") ? "works_queue_status" : null, { id: work.id }, 1);
  const [preferences] = useAiPreferences();
  const [modelChoice, setModelChoice] = useState(null),
    [expandedComposer, setExpandedComposer] = useState(false),
    [resultPreview, setResultPreview] = useState(null);
  const draftKey = (chat) =>
    "frame.chat-draft:" + work.id + ":" + (chat || "new");
  const [chat, setChat] = useState(""),
    [connection, setConnection] = useState("");
  const [prompt, updatePrompt] = useState(
    () => draftRead(draftKey("")).prompt || "",
  );
  const [review, updateReview] = useState(
    () => draftRead(draftKey("")).review || null,
  );
  const [run, busy] = useAction(notify),
    [older, setOlder] = useState([]),
    [focusedTurns, setFocusedTurns] = useState([]),
    [more, setMore] = useState(true),
    [following, setFollowing] = useState(true);
  const initialized = useRef(false),
    requestKey = useRef(null),
    messages = useRef(null),
    follow = useRef(true),
    section = useRef(null),
    composer = useRef(null),
    historyAnchor = useRef(null);
  const draftRevision = useRef(0),
    conversationRevision = useRef(0),
    sending = useRef(false);
  const search = useAgentSearch(messages, follow, setFollowing);
  const currentDraft = useRef({ prompt, review });
  currentDraft.current = { prompt, review };
  const setPrompt = (value) => {
    draftRevision.current++;
    updatePrompt(value);
  };
  const setReview = (value) => {
    draftRevision.current++;
    updateReview(value);
  };
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
  const switchChat = (next, preserveDraft = false) => {
    initialized.current = true;
    conversationRevision.current++;
    draftWrite(draftKey(chat), { prompt, review, modelChoice });
    const draft = preserveDraft ? { prompt, review, modelChoice } : draftRead(draftKey(next));
    if (!next)
      setConnection(
        preferences.defaultSelection?.connection ||
          connections.data?.find(providerAvailable)?.id ||
          "",
      );
    setChat(next);
    setModelChoice(draft.modelChoice || null);
    setPrompt(draft.prompt || "");
    setReview(draft.review || null);
    setOlder([]);
    setFocusedTurns([]);
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
    // A user may type before the initial conversation subscription arrives.
    switchChat(id, draftRevision.current > 0);
  }, [chats.data]);
  useEffect(() => {
    if (!connection && connections.data?.length)
      setConnection(
        preferences.defaultSelection?.connection ||
          connections.data.find(providerAvailable)?.id ||
          "",
      );
  }, [connection, connections.data, preferences.defaultSelection]);
  useEffect(() => {
    const refresh = () => connections.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    draftWrite(draftKey(chat), { prompt, review, modelChoice });
  }, [
    prompt,
    review,
    chat,
    work.id,
    modelChoice,
    selectedAssets.map((a) => a.id).join(","),
  ]);
  const conversationTasks = [
    ...new Map(
      [...focusedTurns, ...older, ...(currentTurns.data || []), ...tasks]
        .filter((t) => t.chat === chat)
        .map((t) => [t.id, t]),
    ).values(),
  ].sort(
    (a, b) =>
      new Date(a.created) - new Date(b.created) || a.id.localeCompare(b.id),
  );
  const stream = useEvents(conversationTasks, chat),
    selected = chats.data?.find((c) => c.id === chat),
    chosen = modelChoice?.connection || selected?.connection || connection;
  const chosenConnection = connections.data?.find((c) => c.id === chosen);
  const model =
    modelChoice?.model ??
    (selected?.connection
      ? conversationTasks.findLast(
          (task) => typeof task.input?.model === "string",
        )?.input.model
      : preferences.defaultSelection?.connection === chosen
        ? preferences.defaultSelection.model
        : undefined) ??
    chosenConnection?.model ??
    "";
  const canSend =
    providerAvailable(chosenConnection) &&
    providerModels(chosenConnection).some(
      (entry) => entry.id === model && entry.enabled !== false,
    );
  useAgentTarget({ work, chat, chats: chats.data, refreshChats: chats.refresh, visible, turns: conversationTasks, switchChat, setOlder: setFocusedTurns, follow, setFollowing, messages, notify });
  const changesProvider =
    !!chat && !!selected?.connection && chosen !== selected.connection;
  const activeTasks = tasks.filter(
    (task) => task.kind === "agent" && active(task),
  );
  const runningTask = activeTasks.find((task) => task.state !== "queued");
  const queuedCount = activeTasks.filter(
    (task) => task.state === "queued",
  ).length;
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = expandedComposer ? "100%" : "auto";
    if (!expandedComposer)
      el.style.height = Math.min(220, Math.max(66, el.scrollHeight)) + "px";
  }, [prompt, expandedComposer]);
  const showResult = (task) => { onPausePreview?.(); setResultPreview({ task }); };
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
  const send = async (text = prompt, originalContext, originalModel) => {
    const sendConnection = originalContext
      ? selected?.connection || chosen
      : chosen;
    const sendModel = originalContext
      ? (originalModel ??
        connections.data?.find((entry) => entry.id === sendConnection)?.model ??
        "")
      : model;
    if (!text.trim() || sending.current) return;
    if (
      !providerAvailable(
        connections.data?.find((entry) => entry.id === sendConnection),
      )
    ) {
      notify("请先选择可用的模型提供商", "error");
      return;
    }
    sending.current = true;
    initialized.current = true;
    const revision = draftRevision.current,
      conversation = conversationRevision.current;
    const context = originalContext || {
      ...(review || {}),
      ...(selectedAssets.length
        ? { assets: selectedAssets.map((a) => a.id) }
        : {}),
    };
    const { assetNames, ...requestContext } = context;
    const signature = JSON.stringify({
      text,
      context: requestContext,
      chosen: sendConnection,
      model: sendModel,
      revision,
      conversation,
    });
    const previous = requestKey.current;
    const submission =
      previous?.signature === signature
        ? previous
        : {
            signature,
            key: crypto.randomUUID(),
            chat: !originalContext && changesProvider ? "" : chat,
            intent: {
              id: work.id,
              connection: sendConnection,
              model: sendModel,
              prompt: text,
              context: requestContext,
            },
          };
    requestKey.current = submission;
    const oldDraft = draftKey(chat);
    try {
      await run(async () => {
        const frozen = submission.intent;
        if (!submission.chat) {
          const c = await api("works_chat_create", {
            id: frozen.id,
            connection: frozen.connection,
            title: frozen.prompt.slice(0, 60),
          });
          submission.chat = c.id;
          if (conversationRevision.current === conversation) {
            setChat(c.id);
            draftWrite("frame.active-chat:" + work.id, { id: c.id });
          }
          chats.refresh();
        }
        await api("works_chat_send", {
          id: frozen.id,
          chat: submission.chat,
          prompt: frozen.prompt,
          model: frozen.model,
          requestKey: submission.key,
          context: frozen.context,
        });
        if (requestKey.current === submission) requestKey.current = null;
        if (!originalContext && conversationRevision.current === conversation) {
          if (
            draftRevision.current === revision &&
            currentDraft.current.prompt === text
          ) {
            setPrompt("");
            setReview(null);
            draftWrite(oldDraft, {});
            draftWrite(draftKey(submission.chat), {});
          }
          onClearAssets(frozen.context.assets || []);
        }
        reload();
        follow.current = true;
        setFollowing(true);
      });
    } finally {
      sending.current = false;
    }
  };
  const validRange =
    Number.isFinite(position.selection?.start) &&
    position.selection.end > position.selection.start;
  return (
    <section
      ref={section}
      id="work-chat"
      className={`creation-chat ai-chat agent-chat ${expandedComposer ? "composer-expanded" : ""}`}
      style={{ "--ai-font-size": preferences.fontSize + "px" }}
      hidden={!visible}
      aria-label="AI 创作对话"
      role={compact && !embedded ? "dialog" : undefined}
      aria-modal={compact && visible && !embedded ? true : undefined}
      onKeyDown={(event) => {
        if (search.onKeyDown(event)) return;
        if (event.defaultPrevented || event.target.closest("dialog[open]"))
          return;
        if (event.key === "Escape" && expandedComposer) {
          event.preventDefault();
          event.stopPropagation();
          setExpandedComposer(false);
          composer.current?.focus();
          return;
        }
        if (embedded) return;
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
        <ChatHistory
          chats={chats.data || []}
          selected={selected}
          disabled={busy}
          onChange={switchChat}
        />
        <Button type="button" icon={Search} aria-label="搜索对话内容" title="搜索已加载对话（Ctrl / ⌘ + F）" onClick={search.toggle} />
        <Button
          icon={Plus}
          aria-label="新对话"
          title="新对话"
          disabled={busy}
          onClick={() => {
            switchChat("");
            composer.current?.focus();
          }}
        />
        <a
          className="chat-settings"
          href="#/settings/ai"
          target="_blank"
          rel="noopener"
          aria-label="AI 设置"
          title="提供商与模型设置"
        >
          <Settings2 size={16} />
        </a>
        <Button
          icon={PanelRightClose}
          aria-label="关闭 AI 对话"
          title="关闭 AI 对话（不会停止创作）"
          onClick={onClose}
        />
      </header>
      <AgentChatSearch controller={search} />
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
                  before: [...older, ...(currentTurns.data || [])].sort((a, b) => new Date(a.created) - new Date(b.created) || a.id.localeCompare(b.id))[0]?.id,
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
              <h3>
                {position.duration ? "继续打磨这个作品" : "从一个想法开始"}
              </h3>
              <p>
                {position.duration
                  ? "选择一个片段，或直接描述想调整的画面、节奏与声音。"
                  : "描述主题和想要的效果，让 AI 开始制作。"}
              </p>
              <div className="suggestions">
                {(position.duration
                  ? [
                      "检查整片节奏，改善拖沓的衔接",
                      "优化动画运动曲线与声音反馈",
                    ]
                  : [
                      "先帮我设计这个作品的分镜与风格",
                      "制作一段简洁、有节奏的开场动画",
                    ]
                ).map((text) => (
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
            work={work}
            search={search.query}
            queue={queueQuery.data?.items.find(item => item.id === t.id)}
            events={stream.events[t.id]}
            onRetry={send}
            onStop={(id) =>
              run(async () => {
                await api("task_cancel", { id });
                reload();
              })
            }
            onRetryPublication={(id) =>
              run(async () => {
                await api("task_retry_publish", { id });
                reload();
              })
            }
            onRecall={onRecall}
            onResult={showResult}
            onEdit={(task) => {
              setPrompt((previous) =>
                previous.trim()
                  ? previous + "\n\n" + task.input.prompt
                  : task.input.prompt,
              );
              setReview(task.input.context || null);
              composer.current?.focus();
            }}
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
      {activeTasks.length > 0 && (
        <div className="chat-run-status" role="status">
          {runningTask?.interaction ? <CircleHelp size={13} /> : <LoaderCircle size={13} className={runningTask ? "spin" : ""} />}
          <span>
            {(runningTask?.interaction ? "等待回答；新要求会进入队列" : runningTask?.progress?.stage) ||
              (runningTask ? states[runningTask.state] : "等待开始")}
            {queuedCount > 0 ? ` · ${queuedCount} 项排队` : ""}
          </span>
          {runningTask?.interaction && <button type="button" onClick={() => navigateToAgent({ work: work.id, chat: runningTask.chat, task: runningTask.id, question: runningTask.interaction.id })}>回答</button>}
          {runningTask && cancellable(runningTask) && (
            <Button
              aria-label="停止当前任务"
              disabled={busy || runningTask.state === "cancelling"}
              onClick={() =>
                run(async () => {
                  await api("task_cancel", { id: runningTask.id });
                  reload();
                })
              }
            >
              停止
            </Button>
          )}
        </div>
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
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述想法，或告诉 AI 这一段怎样调整…"
          rows={2}
          required
          maxLength={40000}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              (e.ctrlKey ||
                e.metaKey ||
                preferences.sendShortcut === "enter") &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-context-actions">
          <Button
            type="button"
            icon={Paperclip}
            aria-label="引用素材"
            title="从素材库添加引用"
            disabled={busy || !onAddAssets}
            onClick={onAddAssets}
          />
          <Button
            type="button"
            icon={Clock3}
            aria-label="引用当前时间"
            title={"引用 " + reviewTime(position.time)}
            disabled={busy || !position.duration}
            onClick={() => setReview(positionReference(position, previewReference))}
          >
            当前时间
          </Button>
          <Button
            type="button"
            icon={Scissors}
            aria-label="引用选段"
            title={
              validRange
                ? reviewTime(position.selection.start) +
                  "—" +
                  reviewTime(position.selection.end)
                : "先在时间轴选择片段"
            }
            disabled={busy || !validRange}
            onClick={() =>
              setReview({ time: position.selection.start, ...positionReference(position, previewReference, true) })
            }
          >
            选段
          </Button>
          <Button
            type="button"
            icon={expandedComposer ? Minimize2 : Maximize2}
            aria-label={expandedComposer ? "收起输入框" : "展开输入框"}
            title={expandedComposer ? "收起输入框" : "展开输入框"}
            onClick={() => setExpandedComposer(!expandedComposer)}
          />
        </div>
        <div className="composer-options">
          <span
            className="composer-mode"
            title="在当前作品内直接修改；运行中的新要求将排队执行"
          >
            创作
          </span>
          <ModelPicker
            connections={connections.data || []}
            loading={connections.loading && !connections.data}
            selection={{ connection: chosen, model }}
            disabled={busy}
            onChange={(value) => {
              draftRevision.current++;
              setModelChoice(value);
            }}
          />
          <Button
            type="submit"
            className="primary composer-send"
            icon={ArrowUp}
            aria-label={
              busy ? "发送中" : activeTasks.length ? "排队发送" : "发送"
            }
            title={
              busy
                ? "发送中"
                : activeTasks.length
                  ? "当前任务完成后执行，不会即时补充到正在运行的任务"
                  : "发送创作要求"
            }
            disabled={busy || !prompt.trim() || !canSend}
          >
            {busy ? "发送中" : activeTasks.length ? "排队发送" : "发送"}
          </Button>
        </div>
        {changesProvider && (
          <p className="provider-switch-note">
            发送后将使用「{chosenConnection?.name}
            」新建对话。原对话保留，不转移其他提供商的会话。
          </p>
        )}
        {!canSend && !connections.loading && (
          <p className="connection-hint">
            所选模型暂不可用，请重新选择或配置提供商。
            <a href="#/settings/ai" target="_blank" rel="noopener">
              连接模型 ↗
            </a>
            {chat && "，或新建对话选择其他连接。"}
          </p>
        )}
        <small className="composer-shortcut">
          {preferences.sendShortcut === "enter"
            ? "Enter 发送 · Shift + Enter 换行"
            : "Ctrl / ⌘ + Enter 发送"}{" "}
          · 草稿自动保留
        </small>
      </form>
      {resultPreview && (
        <Modal title="本轮修改与审片" wide onClose={() => setResultPreview(null)}>
          <WorkResult work={work} task={resultPreview.task} notify={notify} onChanged={reload} onContinue={({text, review}) => {
            setPrompt(previous => previous.trim() ? previous + "\n\n" + text : text);
            setReview(review); setResultPreview(null); composer.current?.focus();
          }} />
        </Modal>
      )}
    </section>
  );
}

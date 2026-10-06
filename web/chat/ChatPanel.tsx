import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import {
  Plus,
  History,
  X,
  Send,
  Square,
  Camera,
  Clock,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Trash2,
  Pencil,
  Film,
  Layers,
  FileText,
  AlertCircle,
  Paperclip,
  Check,
  LogIn,
  CornerDownRight,
  BookOpen,
  Image as ImageIcon,
  Minimize2,
  BookMarked,
  Folder,
  MessageSquareText,
  Settings2,
  BookmarkPlus,
  GitBranch,
  ChevronLeft,
} from "lucide-react";
import { api, del, patch, formatTime, timeAgo, useServerEvent } from "../lib/api";
import { useContextMenu, usePersistent, usePrompt, useToast } from "../lib/ui";
import { useWorkbench, type ChatAttachment } from "../workbench/store";
import { reduceTranscript, groupTurns, type Entry } from "./reduce";
import { TurnBlocks } from "./Transcript";
import { uploadBlobs } from "../views/upload";
import { readImage } from "./images";
import { insertPrompt, newPromptId, usePrompts, type PromptNode } from "../lib/prompts";
import "./chat.css";

export interface ChatHandle {
  attach(attachment: ChatAttachment, prompt?: string): void;
  /** Put text into the input box (after what is there), e.g. from the prompt library. */
  insert(text: string): void;
  send(prompt: string, attachments?: ChatAttachment[]): void;
  focus(): void;
}
interface ConfigOption {
  id: string;
  name: string;
  type?: string;
  category?: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}
interface SessionMeta {
  id: string;
  work: string;
  repo: string;
  profile: string;
  profileName: string;
  agent: string;
  model: string;
  title: string;
  status: "idle" | "running" | "waiting";
  createdAt: string;
  updatedAt: string;
  /** A branch holds the first `keep` turns of conversation `from`. */
  branch?: { from: string; title: string; keep: number } | null;
  queue: { id: string; text: string }[];
  configOptions?: ConfigOption[];
  commands?: { name: string; description: string; hint?: string }[];
  /** Context window occupancy, from the agent's last usage report. */
  usage?: { used?: number; size?: number } | null;
}
interface Profile {
  id: string;
  name: string;
  agent: "claude" | "codex";
  kind: "account" | "anthropic" | "openai";
  models?: string[];
  defaultModel?: string;
}

const SUGGESTIONS = ["检查作品，发现问题就修复", "做一段 3 秒的开场标题动画", "给作品配一段轻快的背景音乐", "让现在这个画面的配色更有电影感"];

export function ChatPanel({ ref, onClose }: { ref?: Ref<ChatHandle>; onClose: () => void }) {
  const { work, stage, openSettings, viewNow, showView, readOnly } = useWorkbench();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [current, setCurrent] = usePersistent<string | null>(`chat:${work.repo}/${work.id}`, null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [defaultModes, setDefaultModes] = useState<Record<string, string>>({});
  const [profileId, setProfileId] = usePersistent<string>("ai-profile", "");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [accounts, setAccounts] = useState<Record<string, boolean | undefined>>({});
  const [sending, setSending] = useState(false);
  const [branching, setBranching] = useState(false);
  // Shown until the server echoes the message (session start can take a few seconds).
  const [pending, setPending] = useState<{ text: string; attachments: ChatAttachment[] } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const historyList = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [openMenu, menu] = useContextMenu();
  const prompt = usePrompt();
  const [dropping, setDropping] = useState(false);
  /** Dropped files become work assets (public/uploads/) referenced in the message. */
  const dropFiles = async (files: File[]) => {
    if (!files.length) return;
    try {
      const uploaded = await uploadBlobs(work, files, "public/uploads");
      setAttachments((list) => [...list, ...uploaded.map((item) => ({ type: "asset" as const, url: item.url, path: item.path }))]);
      toast(`已上传 ${uploaded.length} 个素材`, "ok");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  const session = sessions.find((item) => item.id === current) ?? null;
  const profile = profiles.find((item) => item.id === (session?.profile ?? profileId)) ?? profiles[0];
  // Picker choices of a conversation not started yet live in localStorage: re-render when they change.
  const [, setPrefsVersion] = useState(0);
  const notePref = (key: string, value: string) => {
    writePref(profile?.id, key, value);
    setPrefsVersion((version) => version + 1);
  };
  // What a profile offers (model, mode, effort), from the server's last session of it: the
  // pickers of a new conversation, also in a browser that never showed that AI before.
  const [profileOptions, setProfileOptions] = useState<Record<string, ConfigOption[]>>({});
  useEffect(() => {
    if (session || !profile || profileOptions[profile.id]) return;
    void api<ConfigOption[]>(`/api/ai/profiles/${encodeURIComponent(profile.id)}/options`).then(
      (options) => setProfileOptions((map) => ({ ...map, [profile.id]: options })),
      () => {},
    );
  }, [session, profile, profileOptions]);
  const newChatOptions = profile ? (profileOptions[profile.id]?.length ? profileOptions[profile.id] : cachedOptions(profile.id)) : [];
  /** The server's answer to a session change is authoritative (also when live updates are slow). */
  const applyMeta = (meta: SessionMeta) => setSessions((list) => list.map((item) => (item.id === meta.id ? meta : item)));

  const loadSessions = useCallback(() => api<SessionMeta[]>(`/api/ai/sessions?work=${encodeURIComponent(work.id)}`).then(setSessions), [work.id]);
  useEffect(() => {
    void loadSessions();
    void api<{ profiles: Profile[]; defaultProfile: string; defaultModes: Record<string, string> }>("/api/ai/profiles").then((data) => {
      setProfiles(data.profiles);
      setDefaultModes(data.defaultModes ?? {});
      setProfileId((value) => (data.profiles.some((item) => item.id === value) ? value : data.defaultProfile));
    });
    for (const agent of ["claude", "codex"])
      void api<{ loggedIn: boolean }>(`/api/ai/accounts/${agent}`).then(
        (status) => setAccounts((map) => ({ ...map, [agent]: status.loggedIn })),
        () => {},
      );
  }, [loadSessions, setProfileId]);
  useEffect(() => {
    if (!current) return setEntries([]);
    api<{ transcript: Entry[] }>(`/api/ai/sessions/${current}`).then(
      (data) => setEntries(data.transcript),
      () => setCurrent(null),
    );
  }, [current, setCurrent]);

  useServerEvent(
    (event) => {
      if (event.type === "ai-session") {
        const meta = event.session as SessionMeta;
        if (meta.work !== work.id) return;
        setSessions((list) => [meta, ...list.filter((item) => item.id !== meta.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      } else if (event.type === "ai-event" && event.session === current) {
        setEntries((list) => [...list, event.entry as Entry]);
        if ((event.entry as Entry).kind === "user") setPending(null);
      } else if (event.type === "ai-session-removed") setSessions((list) => list.filter((item) => item.id !== event.session));
      else if (event.type === "settings" && event.key === "ai")
        void api<{ profiles: Profile[]; defaultModes: Record<string, string> }>("/api/ai/profiles").then((data) => {
          setProfiles(data.profiles);
          setDefaultModes(data.defaultModes ?? {});
        });
      else if (event.type === "ai-login") setAccounts((map) => ({ ...map, [event.agent as string]: (event.status as { loggedIn: boolean }).loggedIn }));
    },
    [current, work.id],
  );

  // The history list closes like a dropdown: on a click elsewhere or Escape.
  useEffect(() => {
    if (!showHistory) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!historyList.current?.contains(target) && !target.closest("[data-history-toggle]")) setShowHistory(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setShowHistory(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [showHistory]);

  // The input grows with its text, also when text is put in by code.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = Math.min(220, element.scrollHeight) + "px";
  }, [text]);
  const insertText = (value: string) => {
    setText((current) => (current.trim() ? current.replace(/\s*$/, "\n") + value : value));
    setTimeout(() => {
      const element = input.current;
      element?.focus();
      element?.setSelectionRange(element.value.length, element.value.length);
    }, 0);
  };

  const blocks = useMemo(() => reduceTranscript(entries), [entries]);
  const turns = useMemo(() => groupTurns(blocks), [blocks]);
  const running = session?.status === "running" || session?.status === "waiting";

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [blocks, running]);

  const createSession = async () => {
    const { customModel, ...choices } = readPrefs(profile?.id);
    // A custom API profile picks its model by process, not by the agent's model option.
    if (profile?.kind !== "account") delete choices.model;
    const meta = await api<SessionMeta>("/api/ai/sessions", {
      body: {
        work: work.id,
        repo: work.repo,
        profile: profile?.id,
        model: profile?.kind !== "account" ? customModel || profile?.defaultModel || "" : "",
        // The server applies (and keeps re-applying) the last model/mode/effort choices.
        choices,
      },
    });
    setSessions((list) => [meta, ...list.filter((item) => item.id !== meta.id)]);
    setCurrent(meta.id);
    setEntries([]);
    return meta.id;
  };

  const send = async (prompt = text, extra: ChatAttachment[] = attachments) => {
    if (!prompt.trim() && !extra.length) return;
    if (profile?.kind === "account" && accounts[profile.agent] === false) {
      toast(`请先登录 ${profile.name}`, "error");
      openSettings("ai");
      return;
    }
    setSending(true);
    stick.current = true;
    const restore = { text, attachments };
    setText("");
    setAttachments([]);
    setPending({ text: prompt, attachments: extra });
    try {
      const id = current && sessions.some((item) => item.id === current) ? current : await createSession();
      const result = await api<{ queued: boolean }>(`/api/ai/sessions/${id}/prompt`, { body: { text: prompt, attachments: extra, view: viewNow() } });
      if (result.queued) setPending(null); // the queue list shows it instead
    } catch (error) {
      toast((error as Error).message, "error");
      setPending(null);
      setText(restore.text);
      setAttachments(restore.attachments);
    } finally {
      setSending(false);
    }
  };

  useImperativeHandle(ref, () => ({
    attach(attachment, prompt) {
      setAttachments((list) => [...list.filter((item) => JSON.stringify(item) !== JSON.stringify(attachment)), attachment]);
      if (prompt) setText((value) => (value ? value + "\n" : "") + prompt);
      input.current?.focus();
    },
    send(prompt, extra = []) {
      void send(prompt, [...attachments, ...extra]);
    },
    insert(value) {
      insertText(value);
    },
    focus() {
      input.current?.focus();
    },
  }));

  const respond = (id: string, optionId?: string) =>
    api(`/api/ai/permissions/${id}`, { body: { optionId } }).catch((error) => toast((error as Error).message, "error"));
  const stop = () => current && api(`/api/ai/sessions/${current}/cancel`, { method: "POST" });
  /**
   * A new conversation with the first `keep` turns of this one (the AI's context forked
   * there); with text it continues with that message — editing an earlier message.
   */
  const branch = async (keep: number, text = "", messageAttachments: Record<string, unknown>[] = []) => {
    if (!session || branching) return;
    setBranching(true);
    stick.current = true;
    try {
      const meta = await api<SessionMeta>(`/api/ai/sessions/${session.id}/fork`, {
        body: { keep, text, attachments: messageAttachments, view: text ? viewNow() : null },
      });
      setSessions((list) => [meta, ...list.filter((item) => item.id !== meta.id)]);
      setCurrent(meta.id);
      if (!text) setTimeout(() => input.current?.focus(), 0);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBranching(false);
    }
  };
  /** The versions of the conversation at its k-th message: the one it branched from and its branches there. */
  const versionsAt = (k: number): SessionMeta[] => {
    if (!session) return [];
    const base = session.branch?.keep === k && sessions.some((item) => item.id === session.branch?.from) ? session.branch.from : session.id;
    const list = sessions.filter((item) => item.id === base || (item.branch?.from === base && item.branch.keep === k));
    return list.length > 1 ? list.sort((a, b) => (a.id === base ? -1 : b.id === base ? 1 : a.createdAt.localeCompare(b.createdAt))) : [];
  };
  const compact = () => {
    if (!current) return;
    stick.current = true;
    api(`/api/ai/sessions/${current}/compact`, { method: "POST" }).catch((error) => toast((error as Error).message, "error"));
  };
  const newChat = () => {
    setCurrent(null);
    setEntries([]);
    setShowHistory(false);
    input.current?.focus();
  };
  /** Another AI is another conversation: start one (the draft in the input box stays). */
  const startOver = (message: string) => {
    newChat();
    toast(message, "ok");
  };
  const captureFrame = async () => {
    try {
      const data = await stage.capture();
      setAttachments((list) => [...list, { type: "frame", time: stage.playback.get().time, data: data.split(",")[1], mimeType: "image/png" }]);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const commands = text.startsWith("/") && !text.includes(" ") ? (session?.commands ?? []).filter((command) => command.name.startsWith(text.slice(1))) : [];

  return (
    <div className="chat">
      <div className="chat-head">
        <button className="chat-title" data-history-toggle onClick={() => setShowHistory(!showHistory)} title="对话记录">
          <span className="ellipsis">{session?.title ?? "新对话"}</span>
          <ChevronDown size={13} />
        </button>
        <span className="grow" />
        <button className="icon-btn" title="新对话" onClick={newChat}>
          <Plus size={16} />
        </button>
        <button className={`icon-btn ${showHistory ? "active" : ""}`} data-history-toggle title="对话记录" onClick={() => setShowHistory(!showHistory)}>
          <History size={15} />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {showHistory && (
        <div className="chat-history" ref={historyList}>
          {!sessions.length && <div className="empty small-text">还没有对话</div>}
          {sessions.map((item) => (
            <div
              key={item.id}
              className={`history-row ${item.id === current ? "active" : ""}`}
              onClick={() => {
                setCurrent(item.id);
                setShowHistory(false);
              }}
              onContextMenu={(event) =>
                openMenu(event, [
                  {
                    label: "重命名",
                    icon: <Pencil size={14} />,
                    onClick: async () => {
                      const title = await prompt("对话名称", item.title);
                      if (title) void patch(`/api/ai/sessions/${item.id}`, { title });
                    },
                  },
                  {
                    label: "删除",
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => void del(`/api/ai/sessions/${item.id}`).then(() => item.id === current && newChat()),
                  },
                ])
              }
            >
              {item.status !== "idle" ? (
                <span className="spinner" />
              ) : item.branch ? (
                <GitBranch size={13} className="faint" />
              ) : (
                <Sparkles size={13} className="faint" />
              )}
              <span className="ellipsis grow">{item.title}</span>
              <span className="faint small-text">{timeAgo(item.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
        }}
      >
        {turns.length === 0 && !pending ? (
          <div className="chat-welcome">
            <div className="chat-welcome-icon">
              <Sparkles size={22} />
            </div>
            <h3>和 AI 一起做视频</h3>
            <p className="muted">描述想要的效果。AI 会写代码、查看画面、修正问题；满意后在「版本与同步」中保存版本。</p>
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} onClick={() => send(suggestion, attachments)}>
                  {suggestion}
                </button>
              ))}
            </div>
            {profile?.kind === "account" && accounts[profile.agent] === false && (
              <button className="btn primary" onClick={() => openSettings("ai")}>
                <LogIn size={14} /> 登录 {profile.name}
              </button>
            )}
          </div>
        ) : (
          (() => {
            // k counts the user's own messages (not ones steered into a running turn): the server's turn index.
            let k = -1;
            return turns.map((turn, index) => {
              if (turn.branch) {
                const parent = sessions.find((item) => item.id === turn.branch!.from);
                return (
                  <div className="branch-divider" key={"branch" + index}>
                    <GitBranch size={12} />
                    <span>
                      以上来自
                      {parent ? (
                        <button className="link-btn" onClick={() => setCurrent(parent.id)}>
                          「{parent.title}」
                        </button>
                      ) : (
                        `「${turn.branch.title}」`
                      )}
                      ，从这里开始是分支
                    </span>
                  </div>
                );
              }
              if (turn.user && !turn.user.steered) k += 1;
              const turnIndex = k;
              const live = running && index === turns.length - 1;
              const next = turns[index + 1];
              // The branch point is after a whole turn, so only its last part offers it.
              const endOfTurn = turnIndex >= 0 && !live && (!next || Boolean(next.branch) || Boolean(next.user && !next.user.steered));
              const versions = turn.user && !turn.user.steered ? versionsAt(turnIndex) : [];
              const position = versions.findIndex((item) => item.id === session?.id);
              return (
                <div className="turn" key={turn.user?.id ?? index}>
                  {turn.user && (
                    <UserMessage
                      text={turn.user.text}
                      attachments={turn.user.attachments}
                      steered={turn.user.steered}
                      busy={branching}
                      onEdit={
                        turn.user.steered || turn.user.text.trim().startsWith("/")
                          ? undefined
                          : (text) => branch(turnIndex, text, turn.user!.attachments)
                      }
                      versions={
                        versions.length > 1
                          ? { index: Math.max(0, position), count: versions.length, go: (to) => setCurrent(versions[to].id) }
                          : undefined
                      }
                    />
                  )}
                  {(turn.items.length > 0 || live) && (
                    <TurnBlocks
                      items={turn.items}
                      running={live}
                      onRespond={respond}
                      footer={
                        endOfTurn && turn.items.some((item) => item.kind === "text") ? (
                          <button className="turn-action" disabled={branching} title="新建一个对话，包含到这里为止的内容，从这里换个方向继续" onClick={() => branch(turnIndex + 1)}>
                            <GitBranch size={12} /> 从这里分支
                          </button>
                        ) : null
                      }
                    />
                  )}
                </div>
              );
            });
          })()
        )}
        {branching && (
          <div className="chat-notice branching">
            <span className="spinner" /> 正在创建分支…
          </div>
        )}
        {pending && (
          <div className="turn">
            <UserMessage
              text={pending.text}
              attachments={
                pending.attachments.map((item) =>
                  item.type === "frame" || item.type === "image"
                    ? { type: "image", uri: `data:${item.mimeType};base64,${item.data}`, time: item.type === "frame" ? item.time : undefined }
                    : item,
                ) as never
              }
            />
            <div className="assistant">
              <div className="chat-notice">
                <span className="spinner" /> {session ? "正在发送…" : "正在启动 AI…"}
              </div>
            </div>
          </div>
        )}
        {session?.queue?.map((item) => (
          <div key={item.id} className="queued">
            <Clock size={12} />
            <span className="ellipsis grow" title={item.text}>
              排队中：{item.text}
            </span>
            <button
              className="link-btn"
              title="立即插入 AI 正在进行的这一轮，不等它做完"
              onClick={() =>
                api<{ outcome: string }>(`/api/ai/sessions/${session.id}/queue/${item.id}/steer`, { method: "POST" }).then(
                  () => (stick.current = true),
                  (error) => toast((error as Error).message, "error"),
                )
              }
            >
              <CornerDownRight size={12} /> 引导
            </button>
            <button
              className="icon-btn tiny"
              title="取消这条消息"
              onClick={() => del(`/api/ai/sessions/${session.id}/queue/${item.id}`).catch((error) => toast((error as Error).message, "error"))}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div
        className={`chat-input ${dropping ? "dropping" : ""}`}
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes("Files")) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDropping(false);
          void dropFiles([...event.dataTransfer.files]);
        }}
      >
        {commands.length > 0 && (
          <div className="command-list">
            {commands.slice(0, 8).map((command) => (
              <button key={command.name} onClick={() => setText("/" + command.name + " ")}>
                <strong>/{command.name}</strong> <span className="muted ellipsis">{command.description}</span>
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((attachment, index) => (
              <AttachmentChip key={index} attachment={attachment} onRemove={() => setAttachments((list) => list.filter((_, i) => i !== index))} />
            ))}
          </div>
        )}
        {readOnly && <div className="chat-locked">作品已发布：AI 只能查看和讨论，不会修改作品；可以复盘、整理经验。</div>}
        <textarea
          ref={input}
          rows={1}
          placeholder={
            readOnly ? "和 AI 复盘这个作品，或者让它整理经验" : running ? "AI 正在工作，新消息会排队…" : "描述你想要的修改（Enter 发送，Shift+Enter 换行）"
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            const others = files.filter((item) => !item.type.startsWith("image/"));
            if (others.length) {
              event.preventDefault();
              void dropFiles(others);
            }
            // Pasted images go to the AI as images, not as frames of the work.
            const images = files.filter((item) => item.type.startsWith("image/"));
            if (!images.length) return;
            event.preventDefault();
            for (const file of images)
              readImage(file).then(
                (image) => setAttachments((list) => [...list, { type: "image", ...image }]),
                (error) => toast(`无法读取图片：${(error as Error).message}`, "error"),
              );
          }}
        />
        <div className="chat-toolbar">
          <button className="icon-btn" title="附上当前画面" onClick={captureFrame}>
            <Camera size={15} />
          </button>
          <button
            className="icon-btn"
            title="引用当前时间"
            onClick={() => {
              const time = stage.playback.get().time;
              setAttachments((list) => [...list, { type: "range", start: time, end: time }]);
            }}
          >
            <Clock size={15} />
          </button>
          <button
            className="icon-btn"
            title="上传文件给 AI（也可以直接拖到输入框）"
            onClick={() => {
              const picker = document.createElement("input");
              picker.type = "file";
              picker.multiple = true;
              picker.onchange = () => void dropFiles([...(picker.files ?? [])]);
              picker.click();
            }}
          >
            <Paperclip size={15} />
          </button>
          <PromptPicker draft={text} onPick={insertText} onManage={() => showView("prompts")} />
          <span className="grow" />
          <ContextRing usage={session?.usage} busy={running} onCompact={compact} />
          {running ? (
            <button className="send-btn stop" title="停止" onClick={stop}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" title="发送" disabled={sending || (!text.trim() && !attachments.length)} onClick={() => send()}>
              {sending ? <span className="spinner" /> : <Send size={14} />}
            </button>
          )}
        </div>
        <div className="chat-pickers">
          {/* An AI (or a custom API's model) belongs to a conversation: choosing another one starts a new conversation. */}
          <ProfilePicker
            profiles={profiles}
            accounts={accounts}
            value={profile?.id}
            inConversation={Boolean(session)}
            onChange={(id) => {
              setProfileId(id);
              if (session && id !== session.profile) startOver(`已新建对话，使用 ${profiles.find((item) => item.id === id)?.name ?? "所选 AI"}`);
            }}
          />
          {profile && profile.kind !== "account" && (profile.models?.length ?? 0) > 0 && (
            <OptionPicker
              label={session ? "模型（选择其他模型会新建对话）" : "模型"}
              value={session?.model || readPrefs(profile.id).customModel || profile.defaultModel || ""}
              options={(profile.models ?? []).map((model) => ({ value: model, name: model }))}
              onChange={(model) => {
                notePref("customModel", model);
                if (session && model !== session.model) startOver(`已新建对话，使用 ${model}`);
              }}
            />
          )}
          {(session?.configOptions ?? newChatOptions)
            .filter((option) => option.type === undefined || option.type === "select")
            .filter((option) => !(profile?.kind !== "account" && option.category === "model"))
            .filter(
              (option) =>
                ["model", "mode", "effort", "thought_level"].includes(option.category || option.id) || ["effort", "reasoning_effort"].includes(option.id),
            )
            .map((option) => (
              <OptionPicker
                key={option.id}
                label={option.name}
                value={
                  session
                    ? option.currentValue
                    : readPrefs(profile?.id)[option.category || option.id] ||
                      // What a new conversation really starts with: the default permission from settings.
                      ((option.id === "mode" || option.category === "mode") && profile ? defaultModes[profile.agent] : undefined) ||
                      option.currentValue
                }
                options={option.options}
                onChange={async (value) => {
                  notePref(option.category || option.id, value);
                  if (!session) return;
                  // Shown at once; the server confirms (or the list reloads to undo it).
                  setSessions((list) =>
                    list.map((item) =>
                      item.id === session.id
                        ? { ...item, configOptions: item.configOptions?.map((entry) => (entry.id === option.id ? { ...entry, currentValue: value } : entry)) }
                        : item,
                    ),
                  );
                  await patch<SessionMeta>(`/api/ai/sessions/${session.id}`, { configId: option.id, value }).then(applyMeta, (error) => {
                    toast((error as Error).message, "error");
                    void loadSessions();
                  });
                }}
              />
            ))}
        </div>
      </div>
      {menu}
      <CacheOptions session={session} />
    </div>
  );
}

// ---- remembered per-profile choices -------------------------------------------
function readPrefs(profile?: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(`frame:ai-pref:${profile}`) || "{}");
  } catch {
    return {};
  }
}
function writePref(profile: string | undefined, key: string, value: string) {
  const prefs = readPrefs(profile);
  prefs[key] = value;
  try {
    localStorage.setItem(`frame:ai-pref:${profile}`, JSON.stringify(prefs));
  } catch {}
}
function cachedOptions(profile?: string): ConfigOption[] {
  try {
    return JSON.parse(localStorage.getItem(`frame:ai-options:${profile}`) || "[]");
  } catch {
    return [];
  }
}
function CacheOptions({ session }: { session: SessionMeta | null }) {
  useEffect(() => {
    if (session?.configOptions?.length)
      try {
        localStorage.setItem(`frame:ai-options:${session.profile}`, JSON.stringify(session.configOptions));
      } catch {}
  }, [session?.configOptions, session?.profile]);
  return null;
}

// ---- small components -----------------------------------------------------------
function UserMessage({
  text,
  attachments,
  steered,
  onEdit,
  versions,
  busy,
}: {
  text: string;
  attachments: Record<string, unknown>[];
  steered?: boolean;
  /** Resend an edited version of this message, as a branch of the conversation. */
  onEdit?: (text: string) => void;
  /** This message's place among the versions of the conversation that differ from here. */
  versions?: { index: number; count: number; go: (index: number) => void };
  busy?: boolean;
}) {
  const { stage } = useWorkbench();
  const [draft, setDraft] = useState<string | null>(null);
  if (text.trim() === "/compact")
    return (
      <div className="command-msg">
        <Minimize2 size={12} /> 压缩上下文
      </div>
    );
  return (
    <div className="user-msg">
      {steered && (
        <div className="steered-tag">
          <CornerDownRight size={11} /> 引导：在 AI 工作中途插入
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((attachment, index) =>
            attachment.type === "image" ? (
              <img
                key={index}
                className="user-image"
                src={attachment.uri as string}
                alt=""
                title={attachment.time != null ? `画面 ${formatTime(attachment.time as number)}` : "图片"}
                style={attachment.time != null ? undefined : { cursor: "default" }}
                onClick={() => attachment.time != null && stage.seek(attachment.time as number)}
              />
            ) : (
              <AttachmentChip key={index} attachment={attachment as unknown as ChatAttachment} />
            ),
          )}
        </div>
      )}
      {draft === null ? (
        <div className="user-text">{text}</div>
      ) : (
        <div className="user-edit">
          <textarea
            className="textarea"
            autoFocus
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && draft.trim()) {
                event.preventDefault();
                onEdit?.(draft);
                setDraft(null);
              }
            }}
          />
          <div className="row">
            <span className="faint small-text grow">发送后会新建一个分支对话，原来的对话保留。</span>
            <button className="btn small" onClick={() => setDraft(null)}>
              取消
            </button>
            <button
              className="btn small primary"
              disabled={!draft.trim() || busy}
              onClick={() => {
                onEdit?.(draft);
                setDraft(null);
              }}
            >
              发送
            </button>
          </div>
        </div>
      )}
      {draft === null && (onEdit || versions) && (
        <div className="user-actions">
          {versions && (
            <span className="versions">
              <button className="icon-btn tiny" disabled={versions.index === 0} title="上一个版本" onClick={() => versions.go(versions.index - 1)}>
                <ChevronLeft size={12} />
              </button>
              {versions.index + 1}/{versions.count}
              <button
                className="icon-btn tiny"
                disabled={versions.index === versions.count - 1}
                title="下一个版本"
                onClick={() => versions.go(versions.index + 1)}
              >
                <ChevronRight size={12} />
              </button>
            </span>
          )}
          {onEdit && (
            <button className="icon-btn tiny edit-btn" title="编辑这条消息，从这里重新开始（新建分支）" disabled={busy} onClick={() => setDraft(text)}>
              <Pencil size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: ChatAttachment; onRemove?: () => void }) {
  const { stage, openFile, openMaterial } = useWorkbench();
  let icon = <Paperclip size={12} />,
    label = "";
  if (attachment.type === "frame") {
    icon = <Camera size={12} />;
    label = `画面 ${formatTime(attachment.time)}`;
  } else if (attachment.type === "image") {
    icon = <ImageIcon size={12} />;
    label = "图片";
  } else if (attachment.type === "range") {
    icon = <Film size={12} />;
    label = attachment.start === attachment.end ? formatTime(attachment.start) : `${formatTime(attachment.start)}–${formatTime(attachment.end)}`;
  } else if (attachment.type === "layer") {
    icon = <Layers size={12} />;
    label = `图层 ${attachment.name || attachment.id}`;
  } else if (attachment.type === "asset") {
    label = attachment.url.split("/").pop()!;
  } else if (attachment.type === "file") {
    icon = <FileText size={12} />;
    label = attachment.path;
  } else if (attachment.type === "experience") {
    icon = <BookOpen size={12} />;
    label = `经验：${attachment.library}/${attachment.path}`;
  } else if (attachment.type === "problem") {
    icon = <AlertCircle size={12} />;
    label = attachment.message.slice(0, 40);
  }
  return (
    <span
      className="chip"
      onClick={() => {
        if (attachment.type === "frame") void stage.seek(attachment.time);
        else if (attachment.type === "range") void stage.seek(attachment.start);
        else if (attachment.type === "asset") {
          // A material library file, or one of the work's own (films/<slug>/x is public/x).
          const material = /^materials\/(.+)$/.exec(attachment.url)?.[1];
          if (material) openMaterial(material, { preview: true });
          else openFile(attachment.path ?? attachment.url.replace(/^films\/[^/]+\//, "public/"), { preview: true });
        }
      }}
      title={attachment.type === "asset" ? `${attachment.url}（点击查看）` : undefined}
    >
      {(attachment.type === "frame" || attachment.type === "image") && attachment.data ? (
        <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
      ) : (
        icon
      )}
      <span className="ellipsis">{label}</span>
      {onRemove && (
        <button
          aria-label="移除"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function Popover({
  button,
  children,
  disabled,
  className = "picker",
  chevron = true,
  title,
  align = "left",
}: {
  button: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  disabled?: boolean;
  className?: string;
  chevron?: boolean;
  title?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref} title={disabled ? title : undefined}>
      <button className={className} disabled={disabled} title={disabled ? undefined : title} onClick={() => setOpen(!open)}>
        {button}
        {chevron && <ChevronDown size={11} />}
      </button>
      {open && <div className={`popover ${align === "right" ? "align-right" : ""}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** The prompt library at hand: click a prompt to put it into the input box. */
function PromptPicker({ draft, onPick, onManage }: { draft: string; onPick: (text: string) => void; onManage: () => void }) {
  const [items, save] = usePrompts();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const prompt = usePrompt();
  const toast = useToast();
  const rows = (nodes: PromptNode[], depth: number, close: () => void): React.ReactNode =>
    nodes.map((node) =>
      node.type === "folder" ? (
        <div key={node.id}>
          <button
            className="popover-item"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() =>
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
              })
            }
          >
            {open.has(node.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Folder size={13} className="folder-icon" />
            <span className="grow ellipsis">{node.name}</span>
          </button>
          {open.has(node.id) && rows(node.children, depth + 1, close)}
        </div>
      ) : (
        <button
          key={node.id}
          className="popover-item"
          style={{ paddingLeft: 8 + depth * 14 + 17 }}
          title={node.text.slice(0, 400)}
          onClick={() => {
            close();
            onPick(node.text);
          }}
        >
          <MessageSquareText size={13} className="faint" />
          <span className="grow">
            <span className="ellipsis block">{node.name}</span>
            <span className="popover-desc ellipsis">{node.text.trim().split("\n")[0]}</span>
          </span>
        </button>
      ),
    );
  return (
    <Popover className="icon-btn" chevron={false} title="提示词库" button={<BookMarked size={15} />}>
      {(close) => (
        <div className="prompt-picker">
          <div className="popover-label">提示词（点击放进输入框）</div>
          {items && !items.length && <div className="empty small-text">还没有提示词</div>}
          {rows(items ?? [], 0, close)}
          <div className="menu-separator" />
          <button
            className="popover-item"
            disabled={!draft.trim()}
            title={draft.trim() ? undefined : "先在输入框里写好内容"}
            onClick={async () => {
              close();
              const name = (await prompt("保存为提示词", draft.trim().split("\n")[0].slice(0, 30)))?.trim();
              if (!name || !items) return;
              await save(insertPrompt(items, { id: newPromptId(), type: "prompt", name, text: draft.trim() }, null)).then(
                () => toast(`已保存提示词「${name}」`, "ok"),
                (error) => toast((error as Error).message, "error"),
              );
            }}
          >
            <BookmarkPlus size={13} /> 把输入内容存为提示词…
          </button>
          <button
            className="popover-item"
            onClick={() => {
              close();
              onManage();
            }}
          >
            <Settings2 size={13} /> 管理提示词…
          </button>
        </div>
      )}
    </Popover>
  );
}

const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value));

/** How full the AI's context is, as a ring; the popover offers a manual compaction. */
function ContextRing({ usage, busy, onCompact }: { usage?: SessionMeta["usage"]; busy: boolean; onCompact: () => void }) {
  if (!usage?.size || usage.used == null) return null;
  const used = Math.min(1, Math.max(0, usage.used / usage.size));
  const left = Math.round((1 - used) * 100);
  const level = used >= 0.9 ? "danger" : used >= 0.75 ? "warn" : "";
  const radius = 6.5;
  const length = 2 * Math.PI * radius;
  return (
    <Popover
      className={`context-ring ${level}`}
      chevron={false}
      align="right"
      title={`上下文剩余 ${left}%`}
      button={
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ring-track" cx="9" cy="9" r={radius} />
          <circle className="ring-fill" cx="9" cy="9" r={radius} strokeDasharray={`${used * length} ${length}`} transform="rotate(-90 9 9)" />
        </svg>
      }
    >
      {(close) => (
        <div className="context-info">
          <div className="row">
            <strong className="grow">上下文</strong>
            <span className={level ? `${level}-text` : "muted"}>剩余 {left}%</span>
          </div>
          <div className="context-bar">
            <i className={level} style={{ width: `${used * 100}%` }} />
          </div>
          <div className="muted small-text">
            已用 {tokens(usage.used!)} / {tokens(usage.size!)} tokens
          </div>
          <p className="faint small-text">快满时 AI 会自动压缩。也可以现在手动压缩：AI 把之前的对话总结成摘要，在摘要的基础上继续。</p>
          <button
            className="btn small"
            disabled={busy}
            title={busy ? "AI 正在工作，等这一轮结束" : undefined}
            onClick={() => {
              close();
              onCompact();
            }}
          >
            <Minimize2 size={13} /> 压缩上下文
          </button>
        </div>
      )}
    </Popover>
  );
}

function ProfilePicker({
  profiles,
  accounts,
  value,
  onChange,
  inConversation,
}: {
  profiles: Profile[];
  accounts: Record<string, boolean | undefined>;
  value?: string;
  onChange: (id: string) => void;
  /** Choosing another AI then starts a new conversation (one conversation keeps one AI). */
  inConversation?: boolean;
}) {
  const { openSettings } = useWorkbench();
  const current = profiles.find((item) => item.id === value);
  return (
    <Popover title="选择 AI" button={<span className="ellipsis">{current?.name ?? "选择 AI"}</span>}>
      {(close) => (
        <>
          {inConversation && <div className="popover-label">这个对话使用「{current?.name}」。选择其他 AI 会新建一个对话。</div>}
          {profiles.map((item) => (
            <button
              key={item.id}
              className="popover-item"
              onClick={() => {
                onChange(item.id);
                close();
              }}
            >
              <span className="check">{item.id === value && <Check size={13} />}</span>
              <span className="grow ellipsis">{item.name}</span>
              <span className="faint small-text">{item.agent === "claude" ? "Claude Code" : "Codex"}</span>
              {item.kind === "account" && accounts[item.agent] === false && <span className="badge warn">未登录</span>}
            </button>
          ))}
          <div className="menu-separator" />
          <button
            className="popover-item"
            onClick={() => {
              close();
              openSettings("ai");
            }}
          >
            <span className="check" />
            管理 AI 账号与 API…
          </button>
        </>
      )}
    </Popover>
  );
}

function OptionPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; name: string; description?: string }[];
  onChange: (value: string) => void;
}) {
  const current = options.find((item) => item.value === value);
  return (
    <Popover
      button={
        <span className="ellipsis" title={label}>
          {current?.name ?? value ?? label}
        </span>
      }
    >
      {(close) => (
        <>
          <div className="popover-label">{label}</div>
          {options.map((item) => (
            <button
              key={item.value}
              className="popover-item"
              title={item.description}
              onClick={() => {
                onChange(item.value);
                close();
              }}
            >
              <span className="check">{item.value === value && <Check size={13} />}</span>
              <span className="grow">
                <span>{item.name}</span>
                {item.description && <span className="popover-desc">{item.description}</span>}
              </span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

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
} from "lucide-react";
import { api, del, patch, formatTime, timeAgo, useServerEvent } from "../lib/api";
import { useContextMenu, usePersistent, usePrompt, useToast } from "../lib/ui";
import { useWorkbench, type ChatAttachment } from "../workbench/store";
import { reduceTranscript, groupTurns, type Entry } from "./reduce";
import { TurnBlocks } from "./Transcript";
import { uploadBlobs } from "../views/upload";
import "./chat.css";

export interface ChatHandle {
  attach(attachment: ChatAttachment, prompt?: string): void;
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
  updatedAt: string;
  queue: { id: string; text: string }[];
  configOptions?: ConfigOption[];
  commands?: { name: string; description: string; hint?: string }[];
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
  const { work, stage, openSettings, viewNow } = useWorkbench();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [current, setCurrent] = usePersistent<string | null>(`chat:${work.repo}/${work.id}`, null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = usePersistent<string>("ai-profile", "");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [accounts, setAccounts] = useState<Record<string, boolean | undefined>>({});
  const [sending, setSending] = useState(false);
  // Shown until the server echoes the message (session start can take a few seconds).
  const [pending, setPending] = useState<{ text: string; attachments: ChatAttachment[] } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
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

  const loadSessions = useCallback(() => api<SessionMeta[]>(`/api/ai/sessions?work=${encodeURIComponent(work.id)}`).then(setSessions), [work.id]);
  useEffect(() => {
    void loadSessions();
    void api<{ profiles: Profile[]; defaultProfile: string }>("/api/ai/profiles").then((data) => {
      setProfiles(data.profiles);
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
        void api<{ profiles: Profile[] }>("/api/ai/profiles").then((data) => setProfiles(data.profiles));
      else if (event.type === "ai-login") setAccounts((map) => ({ ...map, [event.agent as string]: (event.status as { loggedIn: boolean }).loggedIn }));
    },
    [current, work.id],
  );

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

  // Initial prompt handed over by the "new work → AI" dialog.
  useEffect(() => {
    const key = `frame:initial-prompt:${work.repo}/${work.id}`;
    const initial = sessionStorage.getItem(key);
    if (!initial || !profiles.length) return;
    sessionStorage.removeItem(key);
    setCurrent(null);
    setTimeout(() => void send(initial, []), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.length]);

  useImperativeHandle(ref, () => ({
    attach(attachment, prompt) {
      setAttachments((list) => [...list.filter((item) => JSON.stringify(item) !== JSON.stringify(attachment)), attachment]);
      if (prompt) setText((value) => (value ? value + "\n" : "") + prompt);
      input.current?.focus();
    },
    send(prompt, extra = []) {
      void send(prompt, [...attachments, ...extra]);
    },
    focus() {
      input.current?.focus();
    },
  }));

  const respond = (id: string, optionId?: string) =>
    api(`/api/ai/permissions/${id}`, { body: { optionId } }).catch((error) => toast((error as Error).message, "error"));
  const stop = () => current && api(`/api/ai/sessions/${current}/cancel`, { method: "POST" });
  const newChat = () => {
    setCurrent(null);
    setEntries([]);
    setShowHistory(false);
    input.current?.focus();
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
        <button className="chat-title" onClick={() => setShowHistory(!showHistory)} title="对话记录">
          <span className="ellipsis">{session?.title ?? "新对话"}</span>
          <ChevronDown size={13} />
        </button>
        <span className="grow" />
        <button className="icon-btn" title="新对话" onClick={newChat}>
          <Plus size={16} />
        </button>
        <button className={`icon-btn ${showHistory ? "active" : ""}`} title="对话记录" onClick={() => setShowHistory(!showHistory)}>
          <History size={15} />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {showHistory && (
        <div className="chat-history">
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
              {item.status !== "idle" ? <span className="spinner" /> : <Sparkles size={13} className="faint" />}
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
          turns.map((turn, index) => (
            <div className="turn" key={turn.user?.id ?? index}>
              {turn.user && <UserMessage text={turn.user.text} attachments={turn.user.attachments} steered={turn.user.steered} />}
              {(turn.items.length > 0 || (running && index === turns.length - 1)) && (
                <TurnBlocks items={turn.items} running={running && index === turns.length - 1} onRespond={respond} />
              )}
            </div>
          ))
        )}
        {pending && (
          <div className="turn">
            <UserMessage
              text={pending.text}
              attachments={
                pending.attachments.map((item) =>
                  item.type === "frame" ? { type: "image", uri: `data:${item.mimeType};base64,${item.data}`, time: item.time } : item,
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
        <textarea
          ref={input}
          rows={1}
          placeholder={running ? "AI 正在工作，新消息会排队…" : "描述你想要的修改（Enter 发送，Shift+Enter 换行）"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onInput={(event) => {
            const element = event.currentTarget;
            element.style.height = "auto";
            element.style.height = Math.min(220, element.scrollHeight) + "px";
          }}
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
            const file = files.find((item) => item.type.startsWith("image/"));
            if (!file) return;
            event.preventDefault();
            const reader = new FileReader();
            reader.onload = () =>
              setAttachments((list) => [
                ...list,
                { type: "frame", time: stage.playback.get().time, data: String(reader.result).split(",")[1], mimeType: file.type, note: "粘贴的图片" },
              ]);
            reader.readAsDataURL(file);
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
          <span className="grow" />
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
          <ProfilePicker
            profiles={profiles}
            accounts={accounts}
            value={profile?.id}
            disabled={running}
            onChange={async (id) => {
              setProfileId(id);
              if (session) {
                const target = profiles.find((item) => item.id === id);
                await patch(`/api/ai/sessions/${session.id}`, { profile: id, model: target?.kind === "account" ? "" : target?.defaultModel || "" }).catch(
                  (error) => toast((error as Error).message, "error"),
                );
              }
            }}
          />
          {profile && profile.kind !== "account" && (profile.models?.length ?? 0) > 0 && (
            <OptionPicker
              label="模型"
              value={session?.model || readPrefs(profile.id).customModel || profile.defaultModel || ""}
              options={(profile.models ?? []).map((model) => ({ value: model, name: model }))}
              onChange={async (model) => {
                writePref(profile.id, "customModel", model);
                if (session)
                  await patch(`/api/ai/sessions/${session.id}`, { profile: profile.id, model }).catch((error) => toast((error as Error).message, "error"));
              }}
            />
          )}
          {(session?.configOptions ?? cachedOptions(profile?.id))
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
                value={session ? option.currentValue : readPrefs(profile?.id)[option.category || option.id] || option.currentValue}
                options={option.options}
                onChange={async (value) => {
                  writePref(profile?.id, option.category || option.id, value);
                  if (session)
                    await patch(`/api/ai/sessions/${session.id}`, { configId: option.id, value }).catch((error) => toast((error as Error).message, "error"));
                  else setText((current) => current);
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
function UserMessage({ text, attachments, steered }: { text: string; attachments: Record<string, unknown>[]; steered?: boolean }) {
  const { stage } = useWorkbench();
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
                title={attachment.time != null ? formatTime(attachment.time as number) : ""}
                onClick={() => attachment.time != null && stage.seek(attachment.time as number)}
              />
            ) : (
              <AttachmentChip key={index} attachment={attachment as unknown as ChatAttachment} />
            ),
          )}
        </div>
      )}
      <div className="user-text">{text}</div>
    </div>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: ChatAttachment; onRemove?: () => void }) {
  const { stage } = useWorkbench();
  let icon = <Paperclip size={12} />,
    label = "";
  if (attachment.type === "frame") {
    icon = <Camera size={12} />;
    label = `画面 ${formatTime(attachment.time)}`;
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
    label = `经验：${attachment.path}`;
  } else if (attachment.type === "problem") {
    icon = <AlertCircle size={12} />;
    label = attachment.message.slice(0, 40);
  }
  return (
    <span
      className="chip"
      onClick={() => (attachment.type === "frame" ? stage.seek(attachment.time) : attachment.type === "range" ? stage.seek(attachment.start) : undefined)}
    >
      {attachment.type === "frame" && attachment.data ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : icon}
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

function Popover({ button, children, disabled }: { button: React.ReactNode; children: (close: () => void) => React.ReactNode; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref}>
      <button className="picker" disabled={disabled} onClick={() => setOpen(!open)}>
        {button}
        <ChevronDown size={11} />
      </button>
      {open && <div className="popover">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function ProfilePicker({
  profiles,
  accounts,
  value,
  onChange,
  disabled,
}: {
  profiles: Profile[];
  accounts: Record<string, boolean | undefined>;
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const { openSettings } = useWorkbench();
  const current = profiles.find((item) => item.id === value);
  return (
    <Popover disabled={disabled} button={<span className="ellipsis">{current?.name ?? "选择 AI"}</span>}>
      {(close) => (
        <>
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

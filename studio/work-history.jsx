import { useCallback, useEffect, useRef, useState } from "react";
import { request, api, Button, ErrorNote, Loading, Modal } from "./ui";
import { ChatHistory } from "./chat-history";
import { AgentMarkdown } from "./agent/AgentMarkdown";
import { AgentTurn } from "./agent/AgentTurn";
import { WorkResult } from "./work-result";
import "./agent/agent-thread.css";
import "./ai-workbench.css";
export function WorkHistory({
  work,
  notify,
  onRecall,
  onAttachSummary,
  onChanged,
  target,
}) {
  const [chats, setChats] = useState(null),
    [chat, setChat] = useState(""),
    [history, setHistory] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [detail, setDetail] = useState(null),
    [result, setResult] = useState(null),
    [retry, setRetry] = useState(0),
    [detailLoading, setDetailLoading] = useState(false);
  const mounted = useRef(true),
    detailRequest = useRef(0),
    handledTarget = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      detailRequest.current++;
    };
  }, []);
  useEffect(() => {
    const control = new AbortController();
    setLoading(true);
    setError("");
    request(`/api/paseo/works/${work.id}/history`, { signal: control.signal })
      .then((rows) => {
        setChats(rows);
        setChat((old) =>
          rows.some((row) => row.id === old) ? old : (rows[0]?.id ?? ""),
        );
      })
      .catch((error) => {
        if (!control.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
  }, [work.id, retry]);
  useEffect(() => {
    setHistory(null);
    if (!chat) return;
    const control = new AbortController();
    setLoading(true);
    setError("");
    request(`/api/paseo/works/${work.id}/history/${chat}`, {
      signal: control.signal,
    })
      .then(setHistory)
      .catch((error) => {
        if (!control.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
  }, [work.id, chat, retry]);
  const showDetail = useCallback(
    async (id) => {
      const requestId = ++detailRequest.current;
      setDetailLoading(true);
      try {
        const task = await api("agent_turn_read", { work: work.id, task: id });
        const events = [];
        let after = 0;
        for (let page = 0; page < 200; page++) {
          const result = await api("task_get", { id, after });
          const rows = result.events ?? [];
          events.push(...rows);
          if (!rows.length || !(result.hasMore ?? rows.length === 100)) break;
          const next = Number(rows.at(-1)?.id ?? 0);
          if (next <= after)
            throw new Error("旧版记录分页没有继续，请重新读取。");
          after = next;
          if (page === 199)
            throw new Error("这轮过程记录过长，请通过后台任务查看完整日志。");
        }
        if (mounted.current && detailRequest.current === requestId)
          setDetail({ task, events });
      } catch (error) {
        if (mounted.current && detailRequest.current === requestId)
          notify(error.message, "error");
      } finally {
        if (mounted.current && detailRequest.current === requestId)
          setDetailLoading(false);
      }
    },
    [work.id, notify],
  );
  useEffect(() => {
    if (
      !target ||
      target.work !== work.id ||
      handledTarget.current === target.nonce ||
      !chats
    )
      return;
    handledTarget.current = target.nonce;
    if (chats.some((row) => row.id === target.chat)) setChat(target.chat);
    void showDetail(target.task);
    try {
      const stored = JSON.parse(
        sessionStorage.getItem("frame.agent-navigation") || "null",
      );
      if (stored?.nonce === target.nonce)
        sessionStorage.removeItem("frame.agent-navigation");
    } catch {}
  }, [work.id, target, chats, showDetail]);
  const attach = () => {
    if (!history) return;
    const newline = String.fromCharCode(10);
    const text = [
      "旧版 Frame 对话记录（只读；未验证旧提供商会话，作为新对话背景）",
      history.chat.title,
      ...history.turns.map((turn) =>
        [
          "用户：" + turn.prompt,
          "AI：" + turn.response,
          ...(turn.error ? ["错误：" + turn.error] : []),
        ].join(newline),
      ),
    ].join(newline + newline);
    onAttachSummary({
      id: crypto.randomUUID(),
      identifier: "frame-legacy-history:" + chat,
      title: "旧版记录：" + history.chat.title,
      url: location.href,
      text,
      resourceType: "frame-history",
    });
  };
  return (
    <section className="paseo-history" aria-label="旧版创作记录">
      <header>
        <h3>旧版记录</h3>
        <ChatHistory
          chats={chats ?? []}
          selected={chats?.find((row) => row.id === chat)}
          onChange={setChat}
        />
      </header>
      <p className="paseo-help">
        记录继续保留。旧提供商会话未验证时，在 Paseo
        新建对话后可附加摘要；不会自动发送。
      </p>
      {history && <Button onClick={attach}>将摘要附加到 Paseo 输入框</Button>}
      {(loading || detailLoading) && <Loading />}
      <ErrorNote error={error} />
      {error && (
        <Button onClick={() => setRetry((value) => value + 1)}>
          重试读取旧版记录
        </Button>
      )}
      {!loading && chats?.length === 0 && <p>这个作品没有旧版对话记录。</p>}
      {history?.truncated && (
        <p className="paseo-help">
          当前显示最近记录，摘要大小最多 64 KB。可查看单轮完整过程与修改。
        </p>
      )}
      <div className="paseo-history-turns">
        {history?.turns.map((turn) => (
          <article key={turn.id} className="paseo-history-turn">
            <h4>
              {new Date(turn.created).toLocaleString()} · {turn.state}
            </h4>
            <div className="agent-human-text">{turn.prompt}</div>
            <AgentMarkdown
              text={turn.response}
              onRecall={onRecall}
              notify={notify}
            />
            <ErrorNote error={turn.error} />
            <Button
              disabled={detailLoading}
              onClick={() => void showDetail(turn.id)}
            >
              查看本轮完整过程与修改
            </Button>
          </article>
        ))}
      </div>
      {detail && (
        <Modal
          title="旧版创作过程（只读）"
          wide
          onClose={() => setDetail(null)}
        >
          <AgentTurn
            readOnly
            work={work}
            task={detail.task}
            events={detail.events}
            notify={notify}
            onRecall={onRecall}
            onResult={(task) => setResult(task)}
          />
        </Modal>
      )}
      {result && (
        <Modal title="原有创作结果" wide onClose={() => setResult(null)}>
          <WorkResult
            work={work}
            task={result}
            notify={notify}
            onChanged={onChanged}
          />
        </Modal>
      )}
    </section>
  );
}

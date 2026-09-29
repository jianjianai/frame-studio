import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleHelp, LoaderCircle, Send, Square } from "lucide-react";
import { api, ErrorNote } from "../ui";
import { validateAgentAnswers, agentAnswerLabels } from "../../src/contracts/agent.mjs";

const readDraft = (id) => { try { return JSON.parse(sessionStorage.getItem("frame.agent-answer:" + id) || "{}"); } catch { return {}; } };
export function AgentQuestion({ question, task, work, onStop, notify }) {
  const saved = useRef(readDraft(question.id));
  const [answers, setAnswers] = useState(saved.current.answers || {}), [index, setIndex] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState(null), [expanded, setExpanded] = useState(false);
  const key = useRef(saved.current.requestKey || null), mounted = useRef(true);
  const actual = receipt || question;
  const pending = actual.state === "pending" && task.state === "running";
  const questions = actual.payload.questions, current = questions[Math.min(index, questions.length - 1)];
  const value = answers[current.id] || { selected: [], text: "" };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!pending) { try { sessionStorage.removeItem("frame.agent-answer:" + question.id); } catch {} return; }
    try { sessionStorage.setItem("frame.agent-answer:" + question.id, JSON.stringify({ answers, requestKey: key.current })); } catch {}
  }, [answers, pending, question.id]);
  const change = (next) => { key.current = null; setError(""); setAnswers((old) => ({ ...old, [current.id]: next })); };
  const validCurrent = value.selected.length > 0 || value.text.trim().length > 0;
  const submit = async () => {
    if (busy || !pending) return;
    let payload;
    try { payload = validateAgentAnswers(actual.payload, Object.fromEntries(questions.map((q) => [q.id, answers[q.id] || { selected: [], text: "" }]))); }
    catch (err) { setError(err.message); const first = questions.findIndex((q) => !answers[q.id]?.selected.length && !answers[q.id]?.text.trim()); if (first >= 0) setIndex(first); return; }
    key.current ||= crypto.randomUUID();
    try { sessionStorage.setItem("frame.agent-answer:" + question.id, JSON.stringify({ answers, requestKey: key.current })); } catch {}
    setBusy(true); setError("");
    try {
      const result = await api("agent_question_answer", { work: work.id, task: task.id, question: question.id, requestKey: key.current, answers: payload });
      if (mounted.current) setReceipt(result);
    } catch (err) { if (mounted.current) setError(err.message || "答案未确认，请重试；输入已保留。"); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section id={"agent-question-" + question.id} className={"agent-question " + (pending ? "is-pending" : "is-resolved")} aria-label={pending ? "AI 正在等待你的回答" : "AI 提问记录"}>
    <header><CircleHelp size={17} /><div><strong>{actual.payload.title || "需要你的意见"}</strong><small>{pending ? "回答后继续本次创作，不会另起任务" : actual.state === "answered" ? "答案已发送，继续原任务" : "提问已结束，未使用默认答案"}</small></div>{!pending && actual.state === "answered" && <Check size={16} />}</header>
    {!pending ? <><button type="button" className="agent-answer-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span>{actual.state === "answered" ? questions.flatMap((q) => actual.answers?.[q.id] ? agentAnswerLabels(q, actual.answers[q.id]) : []).join(" · ") : "查看提问记录"}</span><ChevronRight size={13} className={expanded ? "is-open" : ""} /></button>{expanded && <div className="agent-answer-receipt">{questions.map((q) => <div key={q.id}><strong>{q.question}</strong><p>{actual.answers?.[q.id] ? agentAnswerLabels(q, actual.answers[q.id]).join(" · ") : "未回答"}</p></div>)}</div>}</> : <form onSubmit={(event) => { event.preventDefault(); if (index < questions.length - 1) { if (validCurrent) setIndex(index + 1); } else void submit(); }}>
      {questions.length > 1 && <nav className="agent-question-pages" aria-label="问题进度">{questions.map((q, n) => <button type="button" key={q.id} aria-current={n === index ? "step" : undefined} disabled={busy} onClick={() => setIndex(n)}><span>{answers[q.id]?.selected.length || answers[q.id]?.text.trim() ? <Check size={12} /> : n + 1}</span>{q.header || "问题 " + (n + 1)}</button>)}</nav>}
      <fieldset disabled={busy}><legend>{current.question}</legend>{current.multiSelect && <small className="agent-question-hint">可以选择多项</small>}
        <div className="agent-question-options">{current.options.map((option, n) => <label key={option.id} className={value.selected.includes(option.id) ? "selected" : ""}>
          <input type={current.multiSelect ? "checkbox" : "radio"} name={"agent-answer-" + question.id + "-" + current.id} checked={value.selected.includes(option.id)} onChange={() => change({ selected: current.multiSelect ? value.selected.includes(option.id) ? value.selected.filter((id) => id !== option.id) : [...value.selected, option.id] : [option.id], text: current.multiSelect ? value.text : "" })} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span><span className="agent-option-number" aria-hidden="true">{n + 1}</span>
        </label>)}</div>
        {(current.allowOther || !current.options.length) && <label className="agent-question-other"><span>{current.options.length ? "补充或其他想法" : "你的回答"}</span><textarea rows={2} maxLength={8000} aria-label={current.question + " 自由回答"} value={value.text} placeholder="输入具体要求，不要填写密码或 API 密钥…" onChange={(event) => change({ selected: current.multiSelect ? value.selected : [], text: event.target.value })} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); if (index < questions.length - 1 && validCurrent) setIndex(index + 1); else void submit(); } }} /></label>}
      </fieldset>
      <ErrorNote error={error} />
      <footer><button type="button" className="agent-question-stop" disabled={busy} onClick={() => onStop(task.id)} title="停止本次创作，不会自动采用任何选项"><Square size={12} />停止创作</button><div className="row">{index > 0 && <button type="button" disabled={busy} aria-label="上一题" onClick={() => setIndex(index - 1)}><ChevronLeft size={14} /></button>}
        <button type="submit" className="primary" disabled={busy || !validCurrent}>{busy ? <LoaderCircle size={14} className="spin" /> : index < questions.length - 1 ? <ChevronRight size={14} /> : <Send size={14} />}{busy ? "正在提交" : index < questions.length - 1 ? "下一题" : "提交并继续"}</button></div></footer>
    </form>}
  </section>;
}

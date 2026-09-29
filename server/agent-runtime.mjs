import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { createAgentStream } from "./agent-stream.mjs";
import { publicAgentText, publicAgentData } from "./agent-public-data.mjs";
import { agentQuestionRequestSchema, agentAnswerLabels } from "../src/contracts/agent.mjs";
import { waitForAgentAnswer } from "../scripts/agent-question-client.mjs";

const questionTool = {
  type: "function", name: "frame_ask_user",
  description: "Ask the human a necessary creative clarification and WAIT for their answer in the FRAME chat. This is not a permission approval. Use this instead of ending a turn with an unanswered question. Never request passwords, tokens or other credentials.",
  inputSchema: { type: "object", additionalProperties: false, required: ["questions"], properties: {
    title: { type: "string", description: "Short title of this clarification" },
    questions: { type: "array", minItems: 1, maxItems: 4, items: {
      type: "object", additionalProperties: false, required: ["id", "question"], properties: {
        id: { type: "string" }, header: { type: "string" }, question: { type: "string" }, multiSelect: { type: "boolean" }, allowOther: { type: "boolean" },
        options: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" } } } },
      },
    } },
  } },
};
export function normalizeAgentQuestion(provider, requestKey, input) {
  if (!Array.isArray(input?.questions) || input.questions.some((q) => q.isSecret))
    throw Error("请仅询问创作需求；凭据必须在提供商设置中填写，不能在聊天中收集");
  return agentQuestionRequestSchema.parse({
    requestKey: String(requestKey).slice(0, 200), title: input.title || "需要你的意见",
    questions: input.questions.map((q, i) => ({
      id: String(q.id || `question-${i + 1}`), header: q.header || "", question: q.question,
      options: (q.options || []).map((o, n) => ({ id: String(o.id || `option-${n + 1}`), label: o.label, description: o.description || "" })),
      multiSelect: !!q.multiSelect, allowOther: provider === "codex-native" ? q.isOther !== false || !q.options?.length : q.allowOther !== false,
    })),
  });
}

/** Bidirectional protocol used by real IDE hosts. The task container remains the
 * isolation boundary; asking a human does not create a new AI job or session.
 */
export async function runAgentTurn({ provider, bin, task, prompt, cwd, env = process.env, emit, signal,
  ask = (request, options) => waitForAgentAnswer(request, options), onToolComplete = async () => {}, onStderr = () => {}, processIdentity = {},
}) {
  const args = provider === "codex" ? ["app-server", "--listen", "stdio://"] : [
    "-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages",
    "--permission-mode", "bypassPermissions", "--permission-prompt-tool", "stdio",
    ...(task.upstream ? ["--resume", task.upstream] : []), ...(task.model ? ["--model", task.model] : []),
  ];
  if (provider === "codex" && task.authMode !== "official") args.push(
    "-c", 'model_provider="frame"', "-c", 'model_providers.frame.name="FRAME"',
    "-c", 'model_providers.frame.wire_api="responses"', "-c", 'model_providers.frame.env_key="CODEX_API_KEY"',
    "-c", 'model_providers.frame.base_url=' + JSON.stringify(task.baseUrl || "https://api.openai.com/v1"),
  );
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", ...processIdentity });
  const requests = new Map(), decoder = new StringDecoder("utf8"), adapter = createAgentStream();
  let pending = "", errors = "", sequence = 0, upstream = task.upstream || null, currentTurn = null, finished = false, closing = false, toolWork = Promise.resolve();
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // A rejection before the handshake is awaited must still be observed.
  done.catch(() => {});
  const fail = (error) => { if (!finished) { finished = true; rejectDone(error); } };
  const write = (packet) => {
    if (child.stdin.destroyed || closing) return;
    child.stdin.write(JSON.stringify(packet) + "\n");
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `frame-${++sequence}`;
    const timer = setTimeout(() => { requests.delete(id); reject(Error(`Agent handshake timed out: ${method}`)); }, 60000);
    requests.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    if (provider === "codex") write({ id, method, params });
    else write({ type: "control_request", request_id: id, request: { subtype: method, ...params } });
  });
  const publish = (packet) => {
    for (const event of adapter.feed(packet)) {
      if (event.type === "session") upstream = event.id;
      emit(event);
      if (event.type === "agent-item" && ["command", "files", "tool"].includes(event.kind) && ["completed", "failed"].includes(event.phase))
        toolWork = toolWork.then(() => onToolComplete(event)).catch((error) => emit({ type: "agent-item", version: 1, id: "file-inspection-warning", kind: "notice", phase: "failed", at: Date.now(), title: "文件差异暂不可用", text: publicAgentText(error.message) }));
    }
  };
  const question = async (format, key, input) => {
    await toolWork;
    const payload = normalizeAgentQuestion(format, `${provider}:${key}`, input);
    const answered = await ask(payload, { env, signal: activeSignal });
    if (answered.state !== "answered") throw Error("用户尚未回答，不能使用默认选项继续");
    return { payload, answered };
  };
  const serverRequest = async (packet) => {
    const p = packet.params || packet.request || {};
    try {
      if (provider === "codex") {
        if (packet.method === "item/tool/requestUserInput") {
          const { payload, answered } = await question("codex-native", p.itemId || packet.id, p);
          write({ id: packet.id, result: { answers: Object.fromEntries(payload.questions.map((q) => [q.id, { answers: agentAnswerLabels(q, answered.answers[q.id]) }])) } });
        } else if (packet.method === "item/tool/call" && p.tool === "frame_ask_user") {
          const { payload, answered } = await question("frame", p.callId || packet.id, p.arguments);
          write({ id: packet.id, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ answers: Object.fromEntries(payload.questions.map((q) => [q.question, agentAnswerLabels(q, answered.answers[q.id])])) }) }] } });
        } else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(packet.method)) {
          // Existing FRAME permission policy: direct execution inside the task isolation.
          write({ id: packet.id, result: { decision: "accept" } });
        } else if (packet.method === "item/permissions/requestApproval") {
          write({ id: packet.id, result: { permissions: p.permissions || {}, scope: "turn" } });
        } else {
          write({ id: packet.id, error: { code: -32601, message: "FRAME does not support this interactive request: " + packet.method } });
          emit({ type: "agent-item", version: 1, id: "unsupported:" + packet.id, kind: "notice", phase: "failed", at: Date.now(), title: "交互请求未支持", text: "未自动回答未知请求：" + packet.method });
        }
      } else if (p.subtype === "can_use_tool") {
        let response;
        if (p.tool_name === "AskUserQuestion") {
          const { payload, answered } = await question("claude", p.tool_use_id || packet.request_id, p.input);
          response = { behavior: "allow", updatedInput: { ...p.input, answers: Object.fromEntries(payload.questions.map((q) => [q.question, agentAnswerLabels(q, answered.answers[q.id]).join(", ")])) } };
        } else response = { behavior: "allow", updatedInput: p.input };
        write({ type: "control_response", response: { subtype: "success", request_id: packet.request_id, response } });
      } else {
        write({ type: "control_response", response: { subtype: "error", request_id: packet.request_id, error: "Unsupported FRAME control request: " + p.subtype } });
      }
    } catch (error) {
      if (provider === "codex") write({ id: packet.id, error: { code: -32000, message: publicAgentText(error.message) } });
      else write({ type: "control_response", response: { subtype: "success", request_id: packet.request_id, response: { behavior: "deny", message: publicAgentText(error.message) } } });
      if (activeSignal.aborted || [401, 403, 404, 409].includes(error.status) || /过期|已结束|中断|默认选项/.test(error.message)) fail(error);
    }
  };
  const receive = (packet) => {
    if (provider === "codex" && packet.id != null && !packet.method) {
      const entry = requests.get(packet.id); if (!entry) return;
      requests.delete(packet.id); packet.error ? entry.reject(Error(publicAgentText(packet.error.message))) : entry.resolve(packet.result); return;
    }
    if (provider === "claude" && packet.type === "control_response") {
      const r = packet.response, entry = requests.get(r?.request_id); if (!entry) return;
      requests.delete(r.request_id); r.subtype === "error" ? entry.reject(Error(publicAgentText(r.error))) : entry.resolve(r.response); return;
    }
    if ((provider === "codex" && packet.id != null && packet.method) || (provider === "claude" && packet.type === "control_request")) {
      void serverRequest(packet); return;
    }
    publish(packet);
    if (provider === "codex" && packet.method === "turn/started") currentTurn = packet.params?.turn?.id;
    if (provider === "codex" && packet.method === "turn/completed") {
      const turn = packet.params?.turn;
      if (currentTurn && turn?.id !== currentTurn) return;
      if (turn?.status !== "completed") fail(Error(publicAgentText(turn?.error?.message || "本轮创作已中断")));
      else if (!finished) { finished = true; resolveDone({ upstream }); }
    }
    if (provider === "claude" && packet.type === "result") {
      if (packet.is_error) fail(Error(publicAgentText(packet.result || packet.errors?.join("\n") || "Claude execution failed")));
      else if (!finished) { finished = true; resolveDone({ upstream: packet.session_id || upstream }); }
    }
  };
  child.stdout.on("data", (chunk) => {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch (error) { fail(Error("Agent returned an invalid protocol event: " + publicAgentText(error.message))); }
    }
    if (Buffer.byteLength(pending) > 4 * 1024 * 1024) fail(Error("Agent protocol event exceeds 4 MB"));
  });
  child.stderr.on("data", (chunk) => { const value = publicAgentText(chunk.toString(), { env }); errors = (errors + value).slice(-12000); onStderr(value); });
  child.stdin.on("error", (error) => { if (!closing) fail(error); });
  child.once("error", fail);
  const closed = new Promise((resolve) => child.once("close", (code) => {
    if (!finished) fail(Error(`Agent exited ${code} before completing its turn. ${errors}`));
    for (const entry of requests.values()) entry.reject(Error("Agent connection closed")); requests.clear(); resolve();
  }));
  const terminate = (sig) => {
    try { if (process.platform !== "win32") process.kill(-child.pid, sig); else child.kill(sig); } catch { /* Already exited. */ }
  };
  const abort = () => { fail(activeSignal.reason || Error("创作已停止")); terminate("SIGTERM"); };
  activeSignal.addEventListener("abort", abort, { once: true });
  try {
    activeSignal.throwIfAborted();
    if (provider === "codex") {
      await request("initialize", { clientInfo: { name: "frame_studio", title: "FRAME Agent Workbench", version: "1.0.0" }, capabilities: { experimentalApi: true, optOutNotificationMethods: ["item/reasoning/textDelta"] } });
      write({ method: "initialized" });
      const config = { cwd, approvalPolicy: "never", sandbox: "danger-full-access", ...(task.model ? { model: task.model } : {}), ...(task.authMode !== "official" ? { modelProvider: "frame" } : {}) };
      const thread = await request(task.upstream ? "thread/resume" : "thread/start", { ...config, ...(task.upstream ? { threadId: task.upstream } : {}), dynamicTools: [questionTool] });
      upstream = thread.thread.id; emit({ type: "session", id: upstream });
      await request("turn/start", { threadId: upstream, input: [{ type: "text", text: prompt, text_elements: [] }], ...(task.model ? { model: task.model } : {}) });
    } else {
      await request("initialize", { hooks: {}, sdkMcpServers: [] });
      write({ type: "user", session_id: task.upstream || "", message: { role: "user", content: prompt }, parent_tool_use_id: null, uuid: randomUUID() });
    }
    const outcome = await done;
    await toolWork;
    return outcome;
  } finally {
    closing = true;
    activeSignal.removeEventListener("abort", abort);
    controller.abort();
    child.stdin.end();
    terminate("SIGTERM");
    const force = setTimeout(() => terminate("SIGKILL"), 2000); force.unref();
    await closed; clearTimeout(force);
  }
}

import { setTimeout as delay } from "node:timers/promises";
import { agentQuestionRequestSchema } from "../src/contracts/agent.mjs";

/** Only the isolated executor owns this task credential. Answers are supplied by
 * the authenticated human UI, never by the model or this polling client.
 */
export async function waitForAgentAnswer(request, { env = process.env, signal, fetcher = fetch, interval = 1000, onWaiting = () => {} } = {}) {
  const payload = agentQuestionRequestSchema.parse(request);
  if (!env.FRAME_AGENT_URL || !env.FRAME_AGENT_TOKEN) throw Error("Human interaction requires an active FRAME task");
  const call = async (name, args) => {
    const response = await fetcher(env.FRAME_AGENT_URL.replace(/\/$/, "") + "/api/agent/action", {
      method: "POST", redirect: "error",
      headers: { Authorization: "Bearer " + env.FRAME_AGENT_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error || "无法读取用户回答"), { status: response.status });
    return value;
  };
  let question, failures = 0;
  const deadline = Date.now() + 24 * 3600 * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      question = question ? await call("question_poll", { id: question.id }) : await call("question_create", payload);
      failures = 0;
      if (question.state === "answered") return question;
      if (question.state !== "pending") throw Object.assign(Error(question.state === "expired" ? "等待回答已过期，请重新发起创作" : "提问已随任务结束，不能继续执行"), { status: 409 });
      onWaiting(question);
    } catch (error) {
      if (signal?.aborted || [400, 401, 403, 404, 409, 429].includes(error.status)) throw error;
      // Losing a response never invents an answer or creates a different question.
      if (++failures > 60) throw Error("与工作台的回答通道持续中断，未使用任何默认答案");
    }
    await delay(Math.min(5000, interval * Math.max(1, failures)), undefined, { signal });
  }
  throw Error("等待用户回答超过 24 小时，未使用任何默认答案");
}

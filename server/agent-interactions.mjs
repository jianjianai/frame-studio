import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { agentQuestionRequestSchema, agentQuestionAnswerRequestSchema, validateAgentAnswers } from "../src/contracts/agent.mjs";
import { agentEventTransaction } from "./agent-event-store.mjs";
import { publicAgentData } from "./agent-public-data.mjs";
import { problem } from "./security.mjs";

export class AgentInteractions {
  constructor({ db, data }) { Object.assign(this, { db, data }); }
  async forWork(workId, taskId) {
    const row = await this.db.one("SELECT t.* FROM tasks t JOIN works w ON w.repo=t.repo AND w.project=t.project WHERE w.id=$1 AND t.id=$2 AND t.kind='agent'", [workId, taskId]);
    if (!row) throw problem(404, "此作品中没有对应的创作任务");
    return row;
  }
  async create(taskId, raw) {
    const payload = agentQuestionRequestSchema.parse(publicAgentData(raw));
    const { result } = await agentEventTransaction(this.db, this.data, taskId, async (client, task, { more }) => {
      if (more) throw problem(503, "正在同步创作事件，请稍后重试");
      if (task.kind !== "agent" || task.state !== "running") throw problem(409, "创作已不在运行，不能继续提问");
      const old = (await client.query("SELECT * FROM agent_questions WHERE task=$1 AND request_key=$2", [taskId, payload.requestKey])).rows[0];
      if (old) {
        if (!isDeepStrictEqual(old.payload, payload)) throw problem(409, "该提问标识已用于不同内容");
        return old;
      }
      if ((await client.query("SELECT count(*)::int AS n FROM agent_questions WHERE task=$1", [taskId])).rows[0].n >= 50)
        throw problem(429, "本轮提问次数过多，请总结已有答案后结束本轮");
      if ((await client.query("SELECT count(*)::int AS n FROM agent_questions WHERE task=$1 AND state='pending'", [taskId])).rows[0].n >= 4)
        throw problem(409, "已有待回答的问题，请先等待答案");
      const row = (await client.query("INSERT INTO agent_questions(id,task,request_key,payload) VALUES($1,$2,$3,$4) RETURNING *", [randomUUID(), taskId, payload.requestKey, payload])).rows[0];
      await this.writeEvent(client, row);
      return row;
    });
    return result;
  }
  async writeEvent(client, row) {
    const event = { type: "agent-item", version: 1, id: "question:" + row.id, kind: "question", at: Date.now(), phase: row.state === "pending" ? "waiting" : row.state === "answered" ? "completed" : "cancelled", title: row.payload.title, question: row };
    await client.query("INSERT INTO events(task,kind,data) VALUES($1,'agent-item',$2)", [row.task, event]);
  }
  async poll(taskId, questionId) {
    const { result } = await agentEventTransaction(this.db, this.data, taskId, async (client, task) => {
      let row = (await client.query("SELECT * FROM agent_questions WHERE id=$1 AND task=$2 FOR UPDATE", [questionId, taskId])).rows[0];
      if (!row) throw problem(404, "此任务中没有对应的提问");
      if (row.state === "pending" && (task.state !== "running" || new Date(row.expires).getTime() <= Date.now())) {
        row = (await client.query("UPDATE agent_questions SET state=$2 WHERE id=$1 RETURNING *", [row.id, task.state === "running" ? "expired" : "cancelled"])).rows[0];
        await this.writeEvent(client, row);
      }
      return row;
    });
    return result;
  }
  async list(work, task) {
    await this.forWork(work, task);
    return this.db.all("SELECT * FROM agent_questions WHERE task=$1 ORDER BY created,id", [task]);
  }
  async answer(raw) {
    const args = agentQuestionAnswerRequestSchema.parse(raw);
    await this.forWork(args.work, args.task);
    const { result } = await agentEventTransaction(this.db, this.data, args.task, async (client, task) => {
      const old = (await client.query("SELECT * FROM agent_questions WHERE id=$1 AND task=$2 FOR UPDATE", [args.question, args.task])).rows[0];
      if (!old) throw problem(404, "此任务中没有对应的提问");
      if (old.state === "answered") {
        if (old.answer_key === args.requestKey && isDeepStrictEqual(old.answers, args.answers)) return old;
        throw problem(409, "此问题已在另一个页面提交答案，不能重复修改");
      }
      if (task.state !== "running" || old.state !== "pending" || new Date(old.expires).getTime() <= Date.now())
        throw problem(409, "此问题已结束或过期，答案未发送");
      try { validateAgentAnswers(old.payload, args.answers); } catch (error) { throw problem(400, error.message); }
      const row = (await client.query("UPDATE agent_questions SET state='answered',answers=$2,answer_key=$3,answered=now() WHERE id=$1 RETURNING *", [old.id, args.answers, args.requestKey])).rows[0];
      await this.writeEvent(client, row);
      return row;
    });
    return result;
  }
}

export function agentInteractionOperations({ add, db, data }) {
  const service = new AgentInteractions({ db, data });
  const uuid = z.string().uuid();
  add("agent_turn_read", "Locate one archived turn within its own work", { work: uuid, task: uuid }, (a) => service.forWork(a.work, a.task));
  add("agent_questions", "Read durable questions for an explicitly scoped work and task", { work: uuid, task: uuid }, (a) => service.list(a.work, a.task));
  add("agent_question_answer", "Submit human answers once and continue the original running task", agentQuestionAnswerRequestSchema, (a) => service.answer(a));
  add("agent_notifications", "Read persisted Agent completion, failure and input notifications", {
    work: uuid.optional(), before: z.string().regex(/^\d+$/).optional(), limit: z.number().int().min(1).max(100).default(30), unreadOnly: z.boolean().default(false),
  }, async (a) => {
    const where = "FROM agent_notifications n JOIN tasks t ON t.id=n.task JOIN works w ON w.repo=t.repo AND w.project=t.project WHERE NOT w.deleted AND ($1::uuid IS NULL OR w.id=$1)";
    const count = (await db.one("SELECT count(*)::int AS n " + where + " AND n.read_at IS NULL", [a.work || null])).n;
    const items = await db.all("SELECT n.*,w.id AS work,w.title AS work_title,t.chat,t.state AS task_state,t.input->>'prompt' AS prompt,t.input->>'model' AS model " + where + " AND ($2::bigint IS NULL OR n.id<$2) AND (NOT $3 OR n.read_at IS NULL) ORDER BY n.id DESC LIMIT $4", [a.work || null, a.before || null, a.unreadOnly, a.limit]);
    return { items, unread: count, next: items.length === a.limit ? String(items.at(-1).id) : null };
  });
  add("agent_notifications_read", "Mark observed Agent notifications as read without touching their tasks", { ids: z.array(z.string().regex(/^\d+$/)).min(1).max(100) }, async (a) => {
    await db.pool.query("UPDATE agent_notifications SET read_at=coalesce(read_at,now()) WHERE id=ANY($1::bigint[])", [a.ids]);
    return { ok: true };
  });
  return service;
}

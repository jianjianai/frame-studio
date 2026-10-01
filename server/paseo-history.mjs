import { z } from "zod";
import { publicAgentData, publicAgentText } from "./agent-public-data.mjs";
import { problem } from "./security.mjs";

const timestamp = (value) =>
  value instanceof Date ? value.toISOString() : value;
const chatDTO = (row) => ({
  id: row.id,
  provider: row.provider,
  title: publicAgentText(row.title, { limit: 120 }),
  created: timestamp(row.created),
  readOnly: true,
});
export async function paseoLegacyChats({ db, work, limit = 100 }) {
  z.number().int().min(1).max(200).parse(limit);
  return (
    await db.all(
      "SELECT id,provider,title,created FROM chats WHERE repo=$1 AND project=$2 ORDER BY created DESC,id DESC LIMIT $3",
      [work.repo, work.project, limit],
    )
  ).map(chatDTO);
}
/** Legacy PG rows remain read only; no raw provider envelopes, credentials or executor paths leave this adapter. */
export async function paseoLegacyHistory({
  db,
  work,
  chatId,
  limit = 50,
  maxTextBytes = 64000,
}) {
  z.uuid().parse(chatId);
  z.number().int().min(1).max(100).parse(limit);
  z.number().int().min(1).max(64000).parse(maxTextBytes);
  const chat = await db.one(
    "SELECT id,provider,title,created FROM chats WHERE id=$1 AND repo=$2 AND project=$3",
    [chatId, work.repo, work.project],
  );
  if (!chat)
    throw problem(404, "Legacy conversation does not belong to this work");
  const tasks = await db.all(
    "SELECT id,state,input,created,finished,error FROM tasks WHERE chat=$1 AND repo=$2 AND project=$3 ORDER BY created DESC,id DESC LIMIT $4",
    [chatId, work.repo, work.project, limit],
  );
  let remaining = Math.max(0, Math.min(64000, maxTextBytes));
  const take = (value) => {
    const text = publicAgentText(value, { limit: remaining });
    const bytes = Buffer.from(text);
    const bounded = bytes
      .subarray(0, remaining)
      .toString("utf8")
      .replace(/\uFFFD$/, "");
    remaining -= Buffer.byteLength(bounded);
    return bounded;
  };
  const turns = [];
  for (const task of tasks) {
    const events = await db.all(
      "SELECT id,kind,data,created FROM events WHERE task=$1 AND (kind IN ('message','summary') OR (kind='agent-item' AND (data->>'kind'='message' OR (data->>'kind'='question' AND data->'question'->>'state'='answered')))) ORDER BY id DESC LIMIT 50",
      [task.id],
    );
    const messages = new Map();
    for (const event of events) {
      const key = event.data?.id || event.kind;
      if (!messages.has(key)) messages.set(key, event);
    }
    const content = [...messages.values()]
      .reverse()
      .map((event) => {
        const data = publicAgentData(event.data);
        if (data?.kind === "question" && data.question?.state === "answered")
          return (
            "用户已回答：" +
            JSON.stringify({
              questions: data.question.payload?.questions,
              answers: data.question.answers,
            })
          );
        const text =
          typeof data === "string"
            ? data
            : (data?.text ?? data?.message ?? data?.content);
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n");
    turns.push({
      id: task.id,
      state: task.state,
      created: timestamp(task.created),
      finished: timestamp(task.finished),
      prompt: take(task.input?.prompt || ""),
      response: take(content),
      error: task.error ? take(task.error) : null,
    });
    if (!remaining) break;
  }
  return {
    version: 1,
    chat: chatDTO(chat),
    turns: turns.reverse(),
    readOnly: true,
    truncated: tasks.length >= limit || remaining === 0,
    recovery:
      "Start a new native conversation when the old provider session cannot be verified.",
  };
}
/** Private descriptor is input to manager verification, never proof that importing a provider session is safe. */
export async function paseoLegacyImportDescriptor({ db, work, chatId }) {
  z.uuid().parse(chatId);
  const chat = await db.one(
    "SELECT id,provider,upstream,connection FROM chats WHERE id=$1 AND repo=$2 AND project=$3",
    [chatId, work.repo, work.project],
  );
  if (!chat)
    throw problem(404, "Legacy conversation does not belong to this work");
  const latest = await db.one(
    "SELECT execution FROM tasks WHERE chat=$1 AND repo=$2 AND project=$3 AND execution IS NOT NULL ORDER BY created DESC,id DESC LIMIT 1",
    [chatId, work.repo, work.project],
  );
  return {
    workId: work.id,
    chatId,
    provider: chat.provider,
    nativeSessionId: chat.upstream || null,
    connection: chat.connection || null,
    execution: latest?.execution || null,
    verified: false,
  };
}

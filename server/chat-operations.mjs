import { z } from "zod";
import { randomUUID } from "node:crypto";
import { problem } from "./security.mjs";
import { chatSubmissionShape as submission, workChatCreateSchema, workChatSendSchema } from "../src/contracts/platform.mjs";

const uuid = z.string().uuid();
/** Legacy project identifiers are adapters, not a second conversation implementation. */
export function chatOperations({ add, db, works, repos, tasks, connections }) {
  const create = async ({ repo, project, connection, provider, title }) => {
    await repos.project(repo, project);
    if (Boolean(connection) === Boolean(provider))
      throw problem(400, "Choose exactly one model connection or legacy provider");
    if (connection && !connections) throw problem(503, "Model connections are unavailable");
    const tool = connection ? (await connections.resolve(connection)).tool : provider;
    return db.one(
      "INSERT INTO chats(id,repo,project,provider,title,connection) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [randomUUID(), repo, project, tool, title, connection || null],
    );
  };
  const send = async ({ id, repo, project, prompt, requestKey, context }) => {
    const chat = await db.one("SELECT * FROM chats WHERE id=$1", [id]);
    if (!chat || (repo && (chat.repo !== repo || chat.project !== project)))
      throw problem(404, "Conversation not found");
    if (chat.connection) {
      if (!connections) throw problem(503, "Model connections are unavailable");
      await connections.resolve(chat.connection);
    }
    for (const asset of context?.assets || [])
      if (!(await db.one("SELECT asset FROM asset_repos WHERE asset=$1 AND repo=$2", [asset, chat.repo])))
        throw problem(400, "素材不属于当前仓库");
    return tasks.create({
      repo: chat.repo, project: chat.project, kind: "agent", chat: chat.id,
      requestKey: requestKey || null,
      input: { provider: chat.provider, connection: chat.connection || undefined, prompt, context },
    });
  };
  add("chats_create", "Legacy project-addressed conversation creation", {
    repo: uuid, project: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64),
    provider: z.enum(["codex", "claude"]), title: z.string().min(1).max(120),
  }, create);
  add("chats_send", "Legacy conversation submission using the same durable protocol", {
    id: uuid, ...submission,
  }, send);
  add("works_chat_create", "Create a conversation bound to an explicit model connection", workChatCreateSchema, async ({ id, ...args }) => {
    const work = await works.get(id, { active: true });
    return create({ ...args, repo: work.repo, project: work.project });
  });
  add("works_chat_send", "Persist an idempotent creation turn with frozen review context", workChatSendSchema, async ({ id, chat, ...args }) => {
    const work = await works.get(id, { active: true });
    return send({ ...args, id: chat, repo: work.repo, project: work.project });
  });
}

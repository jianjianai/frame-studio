import { randomUUID } from "node:crypto";
import { freezeExecution } from "../../server/execution-selection.mjs";
import { freezeReviewReference } from "../../server/review-reference.mjs";

/** Persisted pre-Paseo history is a fixture, never an enabled legacy chat write operation. */
export async function insertLegacyChat(
  db,
  work,
  { provider, connection = null, title = "Legacy history" } = {},
) {
  provider ||= connection
    ? (await db.one("SELECT tool FROM connections WHERE id=$1", [connection]))
        ?.tool
    : "codex";
  return db.one(
    "INSERT INTO chats(id,repo,project,provider,connection,title) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [randomUUID(), work.repo, work.project, provider, connection, title],
  );
}

/** Exercise retained task admission/execution directly with the production freeze helpers. */
export async function legacyAgentTask(
  tasks,
  work,
  { chat, prompt, model, requestKey, context = {} },
) {
  const history = await tasks.db.one(
    "SELECT * FROM chats WHERE id=$1 AND repo=$2 AND project=$3",
    [chat, work.repo, work.project],
  );
  if (!history)
    throw Error("Legacy task fixture history must belong to its work");
  const input = {
    provider: history.provider,
    ...(history.connection ? { connection: history.connection } : {}),
    prompt,
    ...(model === undefined ? {} : { model }),
    context,
  };
  return tasks.create({
    repo: work.repo,
    project: work.project,
    kind: "agent",
    chat,
    requestKey,
    input,
    prepareInput: async (requested) => {
      const execution = await freezeExecution({
        db: tasks.db,
        connections: tasks.connections,
        secrets: tasks.secrets,
        input: requested,
      });
      const reviewReference = await freezeReviewReference({
        db: tasks.db,
        repos: tasks.repos,
        data: tasks.data,
        repo: work.repo,
        project: work.project,
        context: requested.context,
      });
      return {
        input: { ...requested, model: execution.model },
        execution,
        reviewReference,
      };
    },
  });
}

import fs from "node:fs";
import path from "node:path";
import { confined, problem } from "./security.mjs";
import { agentItemEventSchema } from "../src/contracts/agent.mjs";

/** A question must follow all output already emitted by the worker. Both the
 * controller and API use this same transaction/cursor, not independent readers.
 */
export async function agentEventTransaction(
  db,
  data,
  taskId,
  operation = async () => undefined,
) {
  const client = await db.pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "agent-events:" + taskId,
    ]);
    const task = (
      await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId])
    ).rows[0];
    if (!task) throw problem(404, "Task not found");
    const file = confined(path.join(data, "runs", taskId), "events.ndjson");
    let cursor = Number(task.log_cursor || 0),
      more = false;
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      const endAt = Math.min(size, cursor + 8 * 1024 * 1024);
      const fd = fs.openSync(file, "r");
      try {
        while (cursor < endAt) {
          const bytes = Buffer.alloc(Math.min(endAt - cursor, 1024 * 1024));
          const count = fs.readSync(fd, bytes, 0, bytes.length, cursor);
          if (!count) break;
          const newline = bytes.subarray(0, count).lastIndexOf(10);
          if (newline < 0) {
            if (count >= 1024 * 1024)
              throw Error("Agent event exceeds the 1 MB ingestion limit");
            break; // Only a complete UTF-8/JSON line advances the durable cursor.
          }
          let offset = cursor;
          for (const line of bytes
            .subarray(0, newline)
            .toString("utf8")
            .split("\n")) {
            offset += Buffer.byteLength(line) + 1;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (
              !event ||
              typeof event.type !== "string" ||
              event.type.length > 80
            )
              continue;
            if (event.type === "agent-item") {
              // Human input state is created by the authenticated interaction API,
              // never by model-controlled files. Malformed worker blocks cannot crash the UI.
              if (
                event.kind === "question" ||
                !agentItemEventSchema.safeParse(event).success
              )
                continue;
            }
            await client.query(
              "INSERT INTO events(task,kind,data,source_offset) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
              [taskId, event.type, event, offset],
            );
            if (
              event.type === "session" &&
              task.chat &&
              typeof event.id === "string"
            )
              await client.query(
                "UPDATE chats SET upstream=$2,upstream_execution=$3 WHERE id=$1",
                [task.chat, event.id, task.execution?.sessionKey || null],
              );
          }
          cursor += newline + 1;
        }
      } finally {
        fs.closeSync(fd);
      }
      more = cursor < size && size - cursor >= 1024 * 1024;
    }
    if (cursor !== Number(task.log_cursor || 0)) {
      await client.query("UPDATE tasks SET log_cursor=$2 WHERE id=$1", [
        taskId,
        String(cursor),
      ]);
      task.log_cursor = String(cursor);
    }
    // A busy worker cannot cause a question to overtake >8 MB of undrained output.
    const result = await operation(client, task, { more });
    await client.query("COMMIT");
    return { result, task, more };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}
export async function ingestAgentEvents(db, data, task) {
  const value = await agentEventTransaction(db, data, task.id);
  task.log_cursor = value.task.log_cursor;
  return value.more;
}

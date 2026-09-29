import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Tasks } from "../../server/tasks.mjs";

for (const moment of ["before-preparation", "during-preparation", "after-claim"]) {
  test("cancel cannot be resurrected: " + moment, async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-cancel-"));
    const task = { id: "fixture", kind: "build", state: "queued", input: {} };
    let dockerRuns = 0;
    const db = {
      async one(sql) {
        if (sql.startsWith("SELECT")) return { ...task };
        if (sql.includes("SET state=CASE")) {
          if (!["queued", "running"].includes(task.state)) return undefined;
          task.state = task.state === "queued" ? "cancelled" : "cancelling";
          return { ...task };
        }
        if (sql.includes("SET state='running'")) {
          if (task.state !== "queued") return undefined;
          task.state = moment === "after-claim" ? "cancelling" : "running";
          return { id: task.id };
        }
        throw Error("Unexpected query: " + sql);
      },
      pool: { async query(sql) {
        if (sql.includes("SET state='cancelled'")) task.state = "cancelled";
        return { rowCount: 1 };
      } },
      async event() {},
    };
    let tasks;
    tasks = new Tasks(db, data, {}, {}, { runCommand: async (bin, args) => {
      if (moment === "during-preparation" && bin === "chown") await tasks.cancel(task.id);
      if (bin === "docker" && args[0] === "run") dockerRuns++;
      return "";
    } });
    try {
      if (moment === "before-preparation") await tasks.cancel(task.id);
      await tasks.start({ ...task, state: "queued" });
      assert.equal(task.state, "cancelled");
      assert.equal(dockerRuns, 0);
    } finally { fs.rmSync(data, { recursive: true, force: true }); }
  });
}

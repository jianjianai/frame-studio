import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Tasks } from "../../server/tasks.mjs";

for (const scenario of ["partial-progress", "docker-unavailable", "logs-unavailable"]) {
  test("diagnostic failure must not kill execution: " + scenario, async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-monitor-"));
    const task = { id: "fixture", state: "running", kind: "build", container: "frame-task-fixture", started: new Date(), input: {} };
    const commands = [], queries = [];
    const db = {
      one: async () => ({ ...task }),
      pool: { query: async (sql) => { queries.push(sql); return { rowCount: 1 }; } },
      event: async () => {},
    };
    const tasks = new Tasks(db, data, {}, {}, { runCommand: async (_bin, args) => {
      commands.push(args);
      if (args[0] === "inspect") {
        if (scenario === "docker-unavailable") throw Error("Cannot connect to Docker daemon");
        return JSON.stringify({ Running: true, ExitCode: 0 });
      }
      if (args[0] === "logs" && scenario === "logs-unavailable") throw Error("log stream interrupted");
      return "";
    } });
    try {
      const run = path.join(data, "runs", task.id);
      fs.mkdirSync(run, { recursive: true });
      if (scenario === "partial-progress") fs.writeFileSync(path.join(run, "progress.json"), '{"stage":');
      await tasks.observeTask(task);
      assert.equal(task.state, "running");
      assert(!commands.some((args) => ["stop", "rm"].includes(args[0])));
      assert(!queries.some((sql) => sql.includes("state='failed'")));
      assert(queries.some((sql) => sql.includes("SET monitor=$2")));
    } finally { fs.rmSync(data, { recursive: true, force: true }); }
  });
}

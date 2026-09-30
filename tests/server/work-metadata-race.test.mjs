import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Works } from "../../server/works.mjs";

for (const scenario of ["fresh-under-lock", "stale-revision", "database-failure"]) {
  test("work metadata consistency: " + scenario, async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-info-"));
    const dir = path.join(data, "project");
    let row = { id: randomUUID(), repo: "repo", project: "film", title: "old", description: "old description", category: "", status: "draft", deleted: false };
    const db = {
      setting: async () => null,
      one: async () => ({ ...row }),
      lock: async (_key, fn) => {
        if (scenario !== "database-failure") row.title = "concurrent title";
        return fn();
      },
      pool: { query: async (_sql, p) => {
        if (scenario === "database-failure") throw Error("database unavailable");
        row = { ...row, title: p[1], category: p[2], status: p[3], description: p[4], deleted: p[5] };
      } },
    };
    const works = new Works(db, data, { writable: async () => {}, project: async () => ({ dir }) }, {}, {});
    try {
      await works.saveInfo(row);
      const revision = (await works.get(row.id)).metadataRevision;
      if (scenario === "fresh-under-lock") {
        const result = await works.update(row.id, { description: "new description" });
        assert.equal(result.title, "concurrent title");
        assert.equal(result.description, "new description");
      } else if (scenario === "stale-revision") {
        await assert.rejects(works.update(row.id, { title: "stale title" }, { expectedRevision: revision }), { statusCode: 409 });
        assert.equal(row.title, "concurrent title");
      } else {
        await assert.rejects(works.update(row.id, { title: "not committed" }), /database unavailable/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "production/work.json"))).title, "old");
        assert(!fs.existsSync(path.join(data, "metadata-recovery", row.id + ".json")));
      }
    } finally { fs.rmSync(data, { recursive: true, force: true }); }
  });
}

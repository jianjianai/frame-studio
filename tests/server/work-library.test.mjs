import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { Works } from "../../server/works.mjs";
import { workbenchOperations } from "../../server/workbench.mjs";
import { hash } from "../../server/security.mjs";

test("works_page accepts known catalog ordering and rejects arbitrary SQL", () => {
  let shape;
  workbenchOperations({
    add: (name, description, schema) => {
      if (name === "works_page") shape = schema;
    },
    db: {},
    data: ".",
    tasks: {},
  });
  const schema = z.object(shape);
  assert.equal(schema.parse({ recent: true }).sort, "");
  for (const sort of ["updated", "opened", "created", "title"])
    assert.equal(schema.parse({ sort }).sort, sort);
  assert.throws(() => schema.parse({ sort: "updated; DROP TABLE works" }));
});

test(
  "catalog orders globally before pagination, using actual modification and null-safe access dates",
  { skip: !process.env.FRAME_TEST_DATABASE_URL, timeout: 15000 },
  async () => {
    // Connection-local temporary tables shadow production names. No shared table is modified.
    const client = new pg.Client({
      connectionString: process.env.FRAME_TEST_DATABASE_URL,
    });
    await client.connect();
    try {
      await client.query(`CREATE TEMP TABLE repos(id uuid, name text, url text);
      CREATE TEMP TABLE works(id uuid, repo uuid, project text, title text, description text, category text, status text, deleted boolean, created timestamptz, updated timestamptz, opened timestamptz);
      CREATE TEMP TABLE tasks(id uuid, repo uuid, project text, kind text, state text, input jsonb, created timestamptz, finished timestamptz);`);
      const repo = randomUUID(),
        ids = [randomUUID(), randomUUID(), randomUUID()];
      await client.query("INSERT INTO repos VALUES($1,'catalog','')", [repo]);
      for (const [index, title, created, updated, opened] of [
        [0, "Alpha", 3, 1, 4],
        [1, "Bravo", 2, 4, 1],
        [2, "Charlie", 4, 2, null],
      ]) {
        const at = (day) =>
          day == null ? null : "2026-09-0" + day + "T00:00:00Z";
        await client.query(
          "INSERT INTO works VALUES($1,$2,$3,$4,'','','draft',false,$5,$6,$7)",
          [
            ids[index],
            repo,
            "film-" + index,
            title,
            at(created),
            at(updated),
            at(opened),
          ],
        );
      }
      // Creation publishes source; later frame/render outputs do not modify it.
      for (const [project, kind, finished] of [
        ["film-0", "new", "2026-09-05"],
        ["film-1", "frame", "2026-09-06"],
        ["film-2", "render", "2026-09-07"],
      ])
        await client.query(
          "INSERT INTO tasks VALUES($1,$2,$3,$4,'succeeded','{}',$5,$5)",
          [randomUUID(), repo, project, kind, finished],
        );
      const works = new Works(
        { all: async (sql, params) => (await client.query(sql, params)).rows },
        ".",
        {},
        {},
        {},
      );
      works.discovered = true;
      const titles = async (args) =>
        (await works.list(args)).map((work) => work.title);
      const listed = await works.list({ sort: "title" });
      assert.equal(
        listed[0].metadataRevision,
        hash(JSON.stringify(works.info(listed[0]))),
      );
      assert.deepEqual(listed.map((work) => [work.title, work.modified.toISOString()]), [
        ["Alpha", "2026-09-05T00:00:00.000Z"],
        ["Bravo", "2026-09-04T00:00:00.000Z"],
        ["Charlie", "2026-09-02T00:00:00.000Z"],
      ]);
      assert.deepEqual(listed.map((work) => work.activity.kind), ["new", "frame", "render"]);
      assert.deepEqual(await titles({ sort: "updated" }), [
        "Alpha",
        "Bravo",
        "Charlie",
      ]);
      assert.deepEqual(await titles({ sort: "created" }), [
        "Charlie",
        "Alpha",
        "Bravo",
      ]);
      assert.deepEqual(await titles({ sort: "opened" }), [
        "Alpha",
        "Bravo",
        "Charlie",
      ]);
      assert.deepEqual(await titles({ recent: true }), ["Alpha", "Bravo"]);
      assert.deepEqual(await titles({ sort: "title", limit: 1, offset: 1 }), [
        "Bravo",
      ]);
      assert.deepEqual(await titles({ sort: "created", limit: 1, offset: 1 }), [
        "Alpha",
      ]);
      assert.deepEqual(await titles({ sort: "updated", limit: 1, offset: 1 }), [
        "Bravo",
      ]);
      assert.deepEqual(await titles({ sort: "updated", search: "Charlie" }), [
        "Charlie",
      ]);
    } finally {
      await client.end();
    }
  },
);

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const base = process.env.FRAME_PERF_PLATFORM_ROOT || process.cwd(),
  require = createRequire(path.join(base, "package.json"));
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  options: "-c default_transaction_read_only=on",
});
let queries = 0;
const select = async (sql, args = []) => {
  if (!/^\s*(SELECT|EXPLAIN)\b/i.test(sql))
    throw Error("Read-only audit rejects non-SELECT SQL");
  queries++;
  return pool.query(sql, args);
};
const db = {
  pool: { query: select },
  all: async (s, a) => (await select(s, a)).rows,
  one: async (s, a) => (await select(s, a)).rows[0],
};
const load = (rel) => import(pathToFileURL(path.join(base, rel)));
const { Repositories } = await load("server/repositories.mjs"),
  { Works } = await load("server/works.mjs"),
  { readSource, listSource } = await load("server/project-text.mjs"),
  { readWorkPreview } = await load("server/preview-state.mjs");
const data = process.env.FRAME_DATA || "/data",
  repos = new Repositories(db, data, {}),
  works = new Works(db, data, repos, null, null);
works.discovered = true;
const result = {
  time: new Date().toISOString(),
  mode: "production SELECT-only transaction default; no token/session/data writes; separate probe process",
  node: process.version,
  revision: process.env.FRAME_REVISION,
  measurements: [],
};
async function measure(name, fn, n = 5) {
  const samples = [];
  const before = queries;
  let value;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    value = await fn();
    samples.push(performance.now() - t);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  result.measurements.push({
    name,
    n,
    medianMs: +sorted[Math.floor(n / 2)].toFixed(2),
    minMs: +sorted[0].toFixed(2),
    maxMs: +sorted.at(-1).toFixed(2),
    queries: queries - before,
    samplesMs: samples.map((v) => +v.toFixed(2)),
  });
  return value;
}
try {
  result.counts = await db.one(
    "SELECT (SELECT count(*) FROM works WHERE NOT deleted) AS works,(SELECT count(*) FROM tasks) AS tasks,(SELECT count(*) FROM assets WHERE NOT deleted) AS assets,(SELECT count(*) FROM tasks WHERE state IN ('running','publishing','queued','cancelling')) AS active_tasks",
  );
  const list = await measure(
    "production Works.list existing works",
    () => works.list({ limit: 60 }),
    5,
  );
  result.returnedWorks = list.length;
  result.projects = [];
  for (const w of list) {
    const { dir } = await repos.project(w.repo, w.project);
    let bytes = 0,
      files = 0,
      largest = 0;
    async function walk(folder) {
      for (const e of await fs.readdir(folder, { withFileTypes: true })) {
        if (
          e.name.startsWith(".") ||
          ["exports", "records", "node_modules"].includes(e.name)
        )
          continue;
        const f = path.join(folder, e.name);
        if (e.isDirectory()) await walk(f);
        else if (e.isFile()) {
          const s = await fs.stat(f);
          bytes += s.size;
          files++;
          largest = Math.max(largest, s.size);
        }
      }
    }
    await walk(dir);
    await measure(
      "production files_page underlying listSource work " +
        result.projects.length,
      () => listSource(dir),
      3,
    );
    await measure(
      "production read project.ts work " + result.projects.length,
      () => readSource(dir, "project.ts"),
      3,
    );
    await measure(
      "production preview SQL work " + result.projects.length,
      () => readWorkPreview({ db, work: w }),
      3,
    );
    result.projects.push({
      files,
      inputBytes: bytes,
      largestFileBytes: largest,
    });
  }
  result.taskPayloads = await db.one(
    "SELECT max(pg_column_size(result)) AS max_result_bytes,round(avg(pg_column_size(result))) AS mean_result_bytes FROM tasks",
  );
  result.taskIndexPlan = (
    await select(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id,kind,data,created FROM events WHERE task=(SELECT id FROM tasks ORDER BY created DESC LIMIT 1) AND id>0 ORDER BY id LIMIT 31",
    )
  ).rows;
} catch (error) {
  result.error = error.message;
  process.exitCode = 1;
} finally {
  await pool.end();
  console.log(JSON.stringify(result, null, 2));
}

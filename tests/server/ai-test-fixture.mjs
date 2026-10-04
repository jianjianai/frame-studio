import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { command } from "../../server/process.mjs";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { AiStore } from "../../server/ai-store.mjs";
import { AiWork } from "../../server/ai-work.mjs";

export async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "frame-ai-test-"),
  );
  const data = path.join(directory, "data"),
    canonical = path.join(directory, "canonical/projects/fixture");
  await fs.mkdir(path.join(canonical, "public"), { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(
    path.join(canonical, "project.ts"),
    "export default {id:'fixture',title:'Fixture',duration:2,fps:12,load:()=>import('./scene')};",
  );
  await fs.writeFile(
    path.join(canonical, "scene.ts"),
    "export const color='initial';",
    { mode: 0o644 },
  );
  await fs.writeFile(path.join(canonical, "public/sample.bin"), "sample-one");
  const canonicalRoot = path.dirname(path.dirname(canonical));
  const git = args => command("git", args, { cwd: canonicalRoot });
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "FRAME Test"]);
  await git(["config", "user.email", "frame@localhost"]);
  await git(["add", "--", "projects/fixture"]);
  await git(["commit", "-m", "Fixture baseline"]);
  const db = await sqliteDatabase(path.join(directory, "database.sqlite"));
  const work = {
    id: randomUUID(),
    repo: randomUUID(),
    project: "fixture",
    title: "Fixture",
    deleted: false,
  };
  await db.pool.query("INSERT INTO repos(id,name) VALUES($1,'Fixture')", [
    work.repo,
  ]);
  await db.pool.query(
    "INSERT INTO works(id,repo,project,title) VALUES($1,$2,'fixture','Fixture')",
    [work.id, work.repo],
  );
  const store = await new AiStore({ db }).initialize();
  const works = {
    async get(id) {
      if (id !== work.id) throw Error("Foreign work");
      return work;
    },
  };
  const repos = {
    async project(repo, project) {
      if (repo !== work.repo || project !== work.project)
        throw Error("Foreign project");
      return { dir: canonical };
    },
  };
  const workService = new AiWork({ data, db, store, works, repos });
  t.after(async () => {
    await db.pool.end();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    data,
    canonical,
    db,
    work,
    store,
    works,
    repos,
    workService,
  };
}
export async function until(
  callback,
  message = "Expected durable state",
  timeout = 5000,
) {
  const end = Date.now() + timeout;
  for (;;) {
    const result = await callback();
    if (result) return result;
    if (Date.now() > end) throw Error(message);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

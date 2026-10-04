import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { ControllerLease } from "../../server/controller-lease.mjs";
import { startT3 } from "../../scripts/start-t3.mjs";
import { freeLocalPort } from "../../server/local-app.mjs";
import { command } from "../../server/process.mjs";
import { fixture as filmFixture, repo as core } from "../mcp/helpers.mjs";
import { until } from "./ai-test-fixture.mjs";

/** A reader may observe an append in progress; only newline-terminated rows are complete. */
export function parseNativeCapture(text) {
  const end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n").filter(Boolean).map(JSON.parse);
}

/** Real FRAME HTTP, native T3 bundle and CLI process; only the paid provider is replaced. */
export async function nativeWorkflowFixture(t) {
  const originalUrl = new URL(process.env.FRAME_TEST_DATABASE_URL);
  assert.match(originalUrl.pathname, /frame_test/);
  const dbName = "frame_test_t3_workflow_" + randomUUID().replaceAll("-", ""), adminUrl = new URL(originalUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.href });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "frame-t3-workflow-")), data = path.join(directory, "data");
  const runtimeRoot = path.resolve(process.env.FRAME_T3_TEST_RUNTIME || process.env.FRAME_T3_ROOT || path.join(core, ".cache/t3-runtime"));
  await fs.access(path.join(runtimeRoot, "dist/bin.mjs")); await fs.access(path.join(runtimeRoot, "dist/client/index.html"));
  const port = await freeLocalPort(), nativePort = await freeLocalPort(), origin = "http://frame.insecure.test:" + port;
  const callback = "http://127.0.0.1:" + port;
  const names = ["FRAME_LOCAL_MODE", "FRAME_PUBLIC_URL", "FRAME_CALLBACK_URL", "FRAME_T3_URL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let db, app, services, native, film, browser, created = false, nativeLog = "";
  t.after(async () => {
    const errors = [], clean = async action => { try { await action(); } catch (error) { errors.push(error); } };
    await clean(() => browser?.close()); await clean(() => app?.close()); await clean(() => native?.stop());
    await clean(() => services?.tasks.lease?.close());
    await clean(async () => { if (db && !db.pool.ending && !db.pool.ended) await db.pool.end(); });
    if (created) {
      await clean(() => admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [dbName]));
      await clean(() => admin.query('DROP DATABASE "' + dbName + '"'));
    }
    await clean(() => admin.end()); await clean(() => film?.close());
    await clean(() => fs.rm(directory, { recursive: true, force: true }));
    for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
    if (errors.length) throw new AggregateError(errors, "Owned native workflow cleanup failed");
  });
  await admin.connect(); await admin.query('CREATE DATABASE "' + dbName + '"'); created = true;
  const ownUrl = new URL(originalUrl); ownUrl.pathname = "/" + dbName;
  process.env.FRAME_LOCAL_MODE = "1"; process.env.FRAME_PUBLIC_URL = callback; process.env.FRAME_CALLBACK_URL = callback;
  process.env.FRAME_T3_URL = "http://127.0.0.1:" + nativePort;
  db = await database(ownUrl.href, "owned-native-workflow-password");
  services = await createApp({ db, data, masterKey: "69".repeat(32), origin, scheduler: false, localMode: false });
  ({ app } = services); await app.ready();
  services.tasks.lease = new ControllerLease(db.pool); assert.equal(await services.tasks.lease.acquire(), true);
  const call = (name, args = {}) => services.actions.call(name, args);
  film = filmFixture({ browser: true, renderer: "canvas" });
  const works = [];
  for (const title of ["First native work", "Second native work"]) {
    const repository = await call("repositories_add", { name: title });
    const repoRoot = path.join(data, "repos", repository.id);
    await fs.mkdir(path.join(repoRoot, "projects"), { recursive: true });
    await fs.cp(film.file(""), path.join(repoRoot, "projects/test-film"), { recursive: true });
    await command("git", ["remote", "add", "origin", "https://github.com/frame-test/shared-origin.git"], { cwd: repoRoot });
    await services.actions.works.discover(repository.id);
    const work = (await call("works_page", { repo: repository.id })).items[0]; assert(work);
    const { dir } = await services.repos.project(repository.id, work.project);
    const baseline = await call("works_checkpoint", { id: work.id, name: "Before native workflow" });
    works.push({ ...work, canonical: dir, baseline, sceneBefore: await fs.readFile(path.join(dir, "scene.ts"), "utf8") });
  }
  const capture = path.join(directory, "native-provider.jsonl"), cli = path.join(directory, "owned-codex.mjs"), cliHome = path.join(directory, "owned-codex-home");
  await fs.mkdir(cliHome, { recursive: true });
  await fs.writeFile(cli, "#!" + process.execPath + "\nimport " + JSON.stringify(path.join(core, "tests/server/ai-fake-codex-app-server.mjs")) + ";\n", { mode: 0o755 });
  await fs.mkdir(path.join(data, "ai/t3/userdata"), { recursive: true });
  await fs.writeFile(path.join(data, "ai/t3/userdata/settings.json"), JSON.stringify({
    enableProviderUpdateChecks: false, responseStreamingMode: "token", providerInstances: { codex: { driver: "codex", displayName: "Owned native fixture", enabled: true,
      environment: [{ name: "FRAME_FAKE_CAPTURE", value: capture }], config: { binaryPath: cli, homePath: cliHome, customModels: ["owned-model"] } },
      claudeAgent: { driver: "claudeAgent", enabled: false, config: {} } },
  }));
  await app.listen({ host: "127.0.0.1", port });
  native = await startT3({ runtimeRoot, dataRoot: data, port: nativePort, stdio: ["ignore", "pipe", "pipe"],
    env: { FRAME_CALLBACK_URL: callback, FRAME_MASTER_KEY: undefined, DATABASE_URL: undefined, FRAME_TEST_DATABASE_URL: undefined } });
  for (const stream of [native.child.stdout, native.child.stderr]) stream.on("data", bytes => { nativeLog = (nativeLog + bytes).slice(-24000); });
  await until(async () => {
    if (native.child.exitCode !== null) throw Error("Native T3 exited: " + nativeLog);
    return services.ai.manager.client.shell().catch(() => null);
  }, "Native T3 did not become ready", 45000).catch(error => { throw new Error(error.message + "\n" + nativeLog); });
  for (const work of works) work.ready = await services.ai.manager.ensure(work);
  assert.notEqual(works[0].ready.projectId, works[1].ready.projectId); assert.notEqual(works[0].ready.cwd, works[1].ready.cwd);
  const material = path.join(data, "uploads/own-material.txt"); await fs.writeFile(material, "Owned native fixture material");
  const ownAsset = await services.assets.register(material, { name: "Own fixture material.txt", license: "Self-owned test", repo: works[0].repo });
  const captured = async () => fs.readFile(capture, "utf8").then(parseNativeCapture, error => { if (error.code === "ENOENT") return []; throw error; });
  return { directory, data, origin, app, db, services, call, works, ownAsset, capture, captured,
    client: services.ai.manager.client, nativeLog: () => nativeLog, registerBrowser: value => { browser = value; } };
}

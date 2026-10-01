import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { database } from "../../server/db.mjs";
import { createApp } from "../../server/app.mjs";
import { ControllerLease } from "../../server/controller-lease.mjs";
import { PaseoPublication } from "../../server/paseo-publication.mjs";
import {
  fixture as filmFixture,
  repo as platformRoot,
} from "../mcp/helpers.mjs";
import { until } from "./paseo-test-fixture.mjs";

export async function nativeWorkflowFixture(
  t,
  { port = Number(process.env.FRAME_TEST_PORT || 59488) } = {},
) {
  const originalUrl = new URL(process.env.FRAME_TEST_DATABASE_URL);
  assert.match(originalUrl.pathname, /^\/frame_test/);
  const dbName =
    "frame_test_native_workflow_" + randomUUID().replaceAll("-", "");
  const adminUrl = new URL(originalUrl);
  adminUrl.pathname = "/postgres";
  const ownUrl = new URL(originalUrl);
  ownUrl.pathname = "/" + dbName;
  const admin = new Client({ connectionString: adminUrl.href });
  const envKeys = [
    "FRAME_LOCAL_MODE",
    "FRAME_PUBLIC_URL",
    "FRAME_AGENT_URL",
    "FRAME_PASEO_ROOT",
    "FRAME_PASEO_UI",
    "FRAME_MASTER_KEY",
    "DATABASE_URL",
  ];
  const oldEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  const selectedRuntime =
    process.env.FRAME_PASEO_ROOT ||
    path.join(platformRoot, ".cache/paseo-runtime");
  const selectedUI =
    process.env.FRAME_PASEO_UI || path.join(selectedRuntime, "web");
  assert(
    await fs
      .stat(
        path.join(
          selectedRuntime,
          "node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js",
        ),
      )
      .catch(() => false),
    "Build the pinned native Paseo runtime before the actual full-stack workflow gate",
  );
  assert(
    await fs.stat(path.join(selectedUI, "index.html")).catch(() => false),
    "Build the full official WebUI before the workflow gate",
  );
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "frame-native-workflow-"),
  );
  const data = path.join(directory, "data"),
    origin = "http://127.0.0.1:" + port;
  let app,
    services,
    created = false,
    film,
    closeBrowser;
  t.after(async () => {
    const children = [...(services?.paseoManager?.children.values() || [])];
    try {
      await closeBrowser?.();
      await app?.close();
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        await until(
          () => child.exitCode !== null || child.signalCode !== null,
          "Owned native supervisor did not exit",
          8000,
        ).catch(() => child.kill("SIGKILL"));
      }
    } finally {
      if (created) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
          [dbName],
        );
        await admin.query('DROP DATABASE "' + dbName + '"');
      }
      await admin.end();
      film?.close();
      await fs.rm(directory, { recursive: true, force: true });
      for (const key of envKeys)
        oldEnv[key] === undefined
          ? delete process.env[key]
          : (process.env[key] = oldEnv[key]);
    }
  });
  await admin.connect();
  await admin.query('CREATE DATABASE "' + dbName + '"');
  created = true;
  process.env.FRAME_MASTER_KEY = "owned-unused-master-sentinel";
  process.env.DATABASE_URL = "owned-unused-database-sentinel";
  delete process.env.FRAME_LOCAL_MODE;
  process.env.FRAME_PUBLIC_URL = origin;
  process.env.FRAME_AGENT_URL = origin;
  process.env.FRAME_PASEO_ROOT = selectedRuntime;
  process.env.FRAME_PASEO_UI = selectedUI;
  const db = await database(ownUrl.href, "owned-native-workflow-password");
  const application = await createApp({
    db,
    data,
    masterKey: "69".repeat(32),
    origin,
    scheduler: false,
    localMode: false,
  });
  services = {
    ...application,
    paseoManager: application.paseo.manager,
    paseoWork: application.paseo.work,
    paseoStore: application.paseo.store,
    paseoDrafts: application.paseo.drafts,
  };
  app = application.app;
  await app.ready();
  // Only the owned daemon and validation worker run locally. API authentication
  // and provider admission retain their production semantics.
  services.paseoManager.localMode = true;
  const publication = new PaseoPublication({
    db,
    data,
    repos: services.repos,
    works: services.actions.works,
    tasks: services.tasks,
    manager: services.paseoManager,
    store: services.paseoStore,
    localMode: true,
  });
  services.paseoDrafts.validate = (candidate, options) =>
    publication.validate(candidate, options);
  services.paseoDrafts.publish = (candidate) => publication.publish(candidate);
  services.tasks.publication.beforeApply = (task) =>
    publication.beforeApply(task);
  services.tasks.lease = new ControllerLease(db.pool);
  assert.equal(
    await services.tasks.lease.acquire(),
    true,
    "Own database controller lease",
  );
  await services.tasks.assertLeadership();
  const call = (name, args = {}) => services.actions.call(name, args);
  const repo = await call("repositories_add", {
    name: "Native workflow fixture",
  });
  film = filmFixture({ browser: true, renderer: "canvas" });
  await fs.mkdir(path.join(data, "repos", repo.id, "projects"), {
    recursive: true,
  });
  await fs.cp(
    film.file(""),
    path.join(data, "repos", repo.id, "projects/test-film"),
    { recursive: true },
  );
  await services.actions.works.discover(repo.id);
  const work = (await call("works_page", { repo: repo.id })).items[0];
  assert(work);
  const { dir: canonical } = await services.repos.project(
    repo.id,
    work.project,
  );
  const baseline = await call("works_checkpoint", {
    id: work.id,
    name: "Before native workflow",
  });
  const sceneBefore = await fs.readFile(
    path.join(canonical, "scene.ts"),
    "utf8",
  );
  const ownMaterial = path.join(data, "uploads/own-material.txt");
  await fs.writeFile(ownMaterial, "Owned fixture material");
  const ownAsset = await services.assets.register(ownMaterial, {
    name: "Own fixture material.txt",
    license: "Self-owned test",
    repo: repo.id,
  });
  const foreignRepo = await call("repositories_add", {
    name: "Foreign asset scope fixture",
  });
  const foreignAsset = await services.assets.register(ownMaterial, {
    name: "Foreign fixture material.txt",
    license: "Self-owned test",
    repo: foreignRepo.id,
  });
  const profile = await call("connections_save", {
    name: "Owned native Codex fixture",
    tool: "codex",
    mode: "api",
    apiKey: "owned-fixture-key-not-real",
    model: "owned-model",
    models: [{ id: "owned-model", name: "Owned fixture model" }],
  });
  await app.listen({ host: "127.0.0.1", port });
  const ready = await services.paseoManager.ensure(work);
  const client = await services.paseoManager.client(work.id);
  const capture = path.join(directory, "native-provider.jsonl");
  const profileId = "frame-" + profile.id;
  await client.patchDaemonConfig({
    providers: {
      [profileId]: {
        command: [
          process.execPath,
          path.join(
            platformRoot,
            "tests/server/paseo-fake-codex-app-server.mjs",
          ),
        ],
        env: { FRAME_FAKE_CAPTURE: capture },
        models: [
          { id: "owned-model", label: "Owned fixture model", isDefault: true },
        ],
      },
    },
  });
  const agent = await client.createAgent({
    provider: profileId,
    model: "owned-model",
    cwd: ready.draftRoot,
    workspaceId: ready.workspaceId,
    title: "Native Frame workflow",
    modeId: "auto",
  });
  assert(agent.id);
  await services.paseoDrafts.start(work.id);
  const captured = async () => {
    try {
      return (await fs.readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    registerBrowser: (browser) => {
      closeBrowser = () => browser.close();
    },
    directory,
    data,
    origin,
    db,
    work,
    profileId,
    agent,
    client,
    ready,
    services,
    call,
    canonical,
    baseline,
    sceneBefore,
    captured,
    ownAsset,
    foreignAsset,
  };
}

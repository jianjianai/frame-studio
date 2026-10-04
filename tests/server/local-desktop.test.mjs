import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startLocalApp, freeLocalPort } from "../../server/local-app.mjs";
import { sqliteDatabase } from "../../server/sqlite.mjs";
import { AiManager } from "../../server/ai-manager.mjs";

test("local browser startup does not wait for speech and exit protects unsaved browser activity", async t => {
  const names = ["FRAME_TEST_LOCAL", "FRAME_LOCAL_MODE", "FRAME_PUBLIC_URL", "FRAME_DATA", "FRAME_SPEECH_URL", "FRAME_LAUNCH_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-desktop-protocol-"));
  let local, completeSpeech, closed = false;
  try {
    process.env.FRAME_TEST_LOCAL = "1"; process.env.FRAME_LAUNCH_TOKEN = "acceptance-private-token";
    local = await startLocalApp({ data, port: await freeLocalPort(), speechFactory: () => new Promise(resolve => { completeSpeech = resolve; }) });
    const headers = { host: new URL(local.origin).host, origin: local.origin };
    const invoke = (url, payload, extra = {}) => local.app.inject({ url, method: payload ? "POST" : "GET", payload, headers: { ...headers, ...extra } });
    assert.equal((await invoke("/api/me")).json().localMode, true);
    // Capture the actual manager without replacing createApp or the local services contract.
    let nativeManager;
    const originalActive = AiManager.prototype.active;
    const capture = t.mock.method(AiManager.prototype, "active", async function (...args) {
      nativeManager = this;
      return originalActive.apply(this, args);
    });
    try { assert.equal((await invoke("/api/desktop/status")).json().speech.state, "starting"); }
    finally { capture.mock.restore(); }
    assert.ok(nativeManager instanceof AiManager);
    const repos = (await invoke("/api/action", { name: "repositories_page", args: {} })).json();
    assert.equal(repos.items[0].name, "我的作品");
    const work = (await invoke("/api/action", { name: "works_create", args: { repo: repos.items[0].id, title: "Exit admission" } })).json();
    assert.ok(work.id);
    assert.equal((await invoke("/api/desktop/prepare-exit", {})).statusCode, 403);
    assert.equal((await invoke("/api/desktop/native", { action: "unrecognized" })).statusCode, 400);
    const session = randomUUID();
    assert.equal((await invoke("/api/desktop/activity", { session, dirty: true })).statusCode, 200);
    assert.equal((await invoke("/api/desktop/status")).json().unsaved, 1);
    assert.equal((await invoke("/api/desktop/prepare-exit", {}, { "x-frame-desktop": process.env.FRAME_LAUNCH_TOKEN })).statusCode, 409);
    await invoke("/api/desktop/activity", { session, dirty: false });
    let nativeActivity = [];
    const activity = t.mock.method(nativeManager, "active", async () => nativeActivity);
    try {
      const idle = { workId: work.id, repo: repos.items[0].id, project: "exit-admission", state: "ready",
        activeThreads: [], pendingPermissions: 0, activeTerminals: 0, incomplete: false };
      for (const [name, busy] of [
        ["native agent", { activeThreads: ["owned-native-agent"] }],
        ["native terminal", { activeTerminals: 1 }],
        ["pending permission", { pendingPermissions: 1 }],
        ["unknown native activity", { incomplete: true }],
      ]) {
        nativeActivity = [{ ...idle, ...busy }];
        const status = await invoke("/api/desktop/status");
        assert.equal(status.statusCode, 200, name);
        assert.equal(status.json().active, 1, name);
        assert.equal(status.json().unsaved, 0, name);
        const blocked = await invoke("/api/desktop/prepare-exit", {}, { "x-frame-desktop": process.env.FRAME_LAUNCH_TOKEN });
        assert.equal(blocked.statusCode, 409, name + " must prevent desktop shutdown");
        assert.equal(blocked.json().active, 1, name);
      }
      nativeActivity = [];
      assert.equal((await invoke("/api/desktop/status")).json().active, 0);
    } finally { activity.mock.restore(); }
    completeSpeech({ close: async () => { closed = true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await invoke("/api/desktop/status")).json().speech.state, "ready");
    assert.equal((await invoke("/api/desktop/prepare-exit", {}, { "x-frame-desktop": process.env.FRAME_LAUNCH_TOKEN })).statusCode, 200);
    const admission = await invoke("/api/action", { name: "works_task", args: { id: work.id, kind: "frame", input: {} } });
    assert.equal(admission.statusCode, 409);
  } finally {
    if (completeSpeech) completeSpeech({ close: async () => { closed = true; } });
    await local?.app.close();
    if (local) assert.equal(closed, true);
    fs.rmSync(data, { recursive: true, force: true });
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});

test("closing during speech preparation aborts only the owned service", async () => {
  const names = ["FRAME_TEST_LOCAL", "FRAME_LOCAL_MODE", "FRAME_PUBLIC_URL", "FRAME_DATA", "FRAME_SPEECH_URL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.FRAME_TEST_LOCAL = "1";
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-speech-cancel-"));
  let local, aborted = false;
  try {
    local = await startLocalApp({ data, port: await freeLocalPort(), speechFactory: (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(Error("Expected owned speech cancellation")); }, { once: true })) });
    await local.app.close();
    assert.equal(aborted, true);
  } finally {
    await local?.app.close(); fs.rmSync(data, { recursive: true, force: true });
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});

test("failed publication allows Windows restart and preserves its recovery record", async () => {
  const names = ["FRAME_TEST_LOCAL", "FRAME_LOCAL_MODE", "FRAME_PUBLIC_URL", "FRAME_DATA", "FRAME_SPEECH_URL", "FRAME_LAUNCH_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "frame-desktop-pending-"));
  let local, db;
  try {
    process.env.FRAME_TEST_LOCAL = "1"; process.env.FRAME_LAUNCH_TOKEN = "pending-publication-private-token";
    local = await startLocalApp({ data, port: await freeLocalPort(), speechFactory: async () => ({ close: async () => {} }) });
    db = await sqliteDatabase(path.join(data, "frame.sqlite"));
    const task = randomUUID();
    await db.pool.query("INSERT INTO tasks(id,kind,state,input,error) VALUES($1,'frame','publish_failed',$2,$3)", [task, {}, "Saved result awaits publication recovery"]);
    const status = await local.app.inject({ url: "/api/desktop/status", headers: { host: new URL(local.origin).host, origin: local.origin } });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().active, 0); assert.equal(status.json().pending, 1);
    const exit = await local.app.inject({ url: "/api/desktop/prepare-exit", method: "POST", payload: {}, headers: { host: new URL(local.origin).host, origin: local.origin, "x-frame-desktop": process.env.FRAME_LAUNCH_TOKEN } });
    assert.equal(exit.statusCode, 200);
    await local.app.close();
    assert.equal((await db.one("SELECT state,error FROM tasks WHERE id=$1", [task])).state, "publish_failed");
    local = await startLocalApp({ data, port: await freeLocalPort(), speechFactory: async () => ({ close: async () => {} }) });
    assert.equal((await local.app.inject({ url: "/api/desktop/status", headers: { host: new URL(local.origin).host, origin: local.origin } })).json().pending, 1);
    assert.equal((await db.one("SELECT error FROM tasks WHERE id=$1", [task])).error, "Saved result awaits publication recovery");
  } finally {
    await local?.app.close(); await db?.pool.end(); fs.rmSync(data, { recursive: true, force: true });
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startLocalApp, freeLocalPort } from "../../server/local-app.mjs";

test("local browser startup does not wait for speech and exit protects unsaved browser activity", async () => {
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
    assert.equal((await invoke("/api/desktop/status")).json().speech.state, "starting");
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

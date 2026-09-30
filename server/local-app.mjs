import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sqliteDatabase } from "./sqlite.mjs";
import { createApp } from "./app.mjs";
import { startLocalSpeech } from "./local-speech.mjs";

export function localDataPath(env = process.env) {
  if (env.FRAME_LOCAL_DATA) return path.resolve(env.FRAME_LOCAL_DATA);
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "FRAME Studio");
}

export async function freeLocalPort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

export async function startLocalApp({ data = localDataPath(), port = Number(process.env.FRAME_LOCAL_PORT || 43173), speechFactory = startLocalSpeech } = {}) {
  if (process.platform !== "win32" && process.env.FRAME_TEST_LOCAL !== "1")
    throw Error("Local desktop mode currently supports Windows only");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Invalid local port");
  fs.mkdirSync(data, { recursive: true });
  const keyFile = path.join(data, "master.key");
  try { fs.writeFileSync(keyFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const masterKey = fs.readFileSync(keyFile, "utf8").trim();
  const origin = `http://127.0.0.1:${port}`;
  process.env.FRAME_LOCAL_MODE = "1";
  process.env.FRAME_PUBLIC_URL = origin;
  process.env.FRAME_DATA = data;
  const speechPort = await freeLocalPort();
  process.env.FRAME_SPEECH_URL = `http://127.0.0.1:${speechPort}`;
  let app, speech, preparation, controller;
  const speechState = { state: "starting", message: "语音环境正在准备，其他功能可以正常使用。" };
  const prepareSpeech = () => {
    if (preparation || speech) return;
    if (process.env.FRAME_TEST_LOCAL === "1" && speechFactory === startLocalSpeech) { speechState.state = "disabled"; return; }
    controller = new AbortController();
    Object.assign(speechState, { state: "starting", message: "语音环境正在准备，其他功能可以正常使用。" });
    preparation = speechFactory(data, { port: speechPort, signal: controller.signal }).then((service) => {
      speech = service; Object.assign(speechState, { state: "ready", message: "语音服务已就绪，模型可在设置中按需下载。" });
    }, (error) => { Object.assign(speechState, { state: "failed", message: "语音服务未就绪，请重试或修复运行环境。" }); console.error(error.message); }).finally(() => { preparation = null; });
  };
  try {
    const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
    const services = await createApp({ db, data, masterKey, origin, localMode: true });
    ({ app } = services);
    // A fresh desktop is immediately usable; a remote repository remains optional.
    if (!(await db.one("SELECT id FROM repos LIMIT 1"))) await services.repos.add({ name: "我的作品" });
    const editors = new Map();
    const unsaved = () => { for (const [id, entry] of editors) if (Date.now() - entry.at > 300000) editors.delete(id); return editors.size; };
    const active = async () => Number((await db.one("SELECT count(*) AS n FROM tasks WHERE state IN ('queued','running','cancelling','publishing','publish_failed')")).n);
    app.get("/api/desktop/status", async () => ({ active: await active(), unsaved: unsaved(), speech: speechState, data, version: (await import("../src/contracts/version.mjs")).PLATFORM_VERSION }));
    app.post("/api/desktop/activity", async (request, reply) => {
      const { session, dirty } = request.body || {};
      if (!/^[a-f0-9-]{36}$/.test(session || "") || typeof dirty !== "boolean") return reply.code(400).send({ message: "Invalid activity" });
      unsaved(); if (dirty) { if (editors.size >= 100 && !editors.has(session)) return reply.code(429).send({ message: "Too many editors" }); editors.set(session, { at: Date.now() }); } else editors.delete(session);
      return { ok: true };
    });
    app.post("/api/desktop/native", async (request, reply) => {
      const { action, tab = "overview" } = request.body || {};
      if (!["show-center", "login-codex", "login-claude"].includes(action) || !["overview", "environment", "updates", "logs"].includes(tab)) return reply.code(400).send({ message: "Unknown desktop action" });
      console.log("FRAME_DESKTOP_ACTION " + JSON.stringify({ action, tab, token: process.env.FRAME_LAUNCH_TOKEN || "" }));
      return { ok: true };
    });
    app.get("/api/desktop/ai", async request => services.tasks.connections.localStatus(request.query.refresh === "1"));
    app.post("/api/desktop/speech-retry", async () => { prepareSpeech(); return speechState; });
    app.post("/api/desktop/prepare-exit", async (request, reply) => {
      if (!process.env.FRAME_LAUNCH_TOKEN || request.headers["x-frame-desktop"] !== process.env.FRAME_LAUNCH_TOKEN) return reply.code(403).send({ message: "Desktop credential required" });
      const count = await active();
      if (count || unsaved()) return reply.code(409).send({ active: count, unsaved: unsaved(), message: "请完成后台任务并保存浏览器中的编辑后再退出。" });
      services.tasks.desktopClosing = true;
      return { ok: true };
    });
    app.post("/api/desktop/cancel-exit", async (request, reply) => {
      if (!process.env.FRAME_LAUNCH_TOKEN || request.headers["x-frame-desktop"] !== process.env.FRAME_LAUNCH_TOKEN) return reply.code(403).send({ message: "Desktop credential required" });
      services.tasks.desktopClosing = false;
      return { ok: true };
    });
    app.addHook("onClose", async () => { controller?.abort(); await preparation; await speech?.close(); });
    await app.listen({ host: "127.0.0.1", port });
    prepareSpeech();
  } catch (error) { controller?.abort(); await app?.close(); await speech?.close(); throw error; }
  return { app, origin, data };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, origin } = await startLocalApp();
  console.log("FRAME_LOCAL_READY " + JSON.stringify({ origin, pid: process.pid, token: process.env.FRAME_LAUNCH_TOKEN || "" }));
  console.log(`FRAME local mode: ${origin}`);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.length > 32) input = input.slice(-32);
    if (input.includes("exit\n") || input.includes("exit\r\n"))
      void app.close().then(() => process.exit(0));
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}

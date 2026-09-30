import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sqliteDatabase } from "./sqlite.mjs";
import { createApp } from "./app.mjs";
import { startLocalSpeech } from "./local-speech.mjs";

export function localDataPath(env = process.env) {
  if (env.FRAME_LOCAL_DATA) return path.resolve(env.FRAME_LOCAL_DATA);
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "FRAME Studio");
}

export async function startLocalApp({ data = localDataPath(), port = 43173 } = {}) {
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
  const speech = process.env.FRAME_TEST_LOCAL === "1" ? null : await startLocalSpeech(data);
  process.env.FRAME_SPEECH_URL = speech?.url || "http://127.0.0.1:43174";
  let app;
  try {
    const db = await sqliteDatabase(path.join(data, "frame.sqlite"));
    ({ app } = await createApp({ db, data, masterKey, origin, localMode: true }));
    app.addHook("onClose", async () => { await speech?.close(); });
    await app.listen({ host: "127.0.0.1", port });
  } catch (error) { await app?.close(); await speech?.close(); throw error; }
  return { app, origin, data };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, origin } = await startLocalApp();
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

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** Runtime dependencies are cached independently; models are installed explicitly. */
export async function startLocalSpeech(data, { port = 0, timeoutMs = 90000 } = {}) {
  const python = process.env.FRAME_SPEECH_PYTHON || path.join(root, "python", "python.exe");
  if (!fs.existsSync(python)) throw Error("语音运行环境尚未安装，请从托盘退出后重新启动以重试下载");
  const drives = [];
  const asciiPath = (directory) => {
    if (process.platform !== "win32" || /^[\x00-\x7f]*$/.test(directory)) return directory;
    for (let code = 90; code >= 70; code--) {
      const drive = `${String.fromCharCode(code)}:`;
      if (fs.existsSync(drive + "\\")) continue;
      try {
        execFileSync("subst.exe", [drive, directory], { windowsHide: true, stdio: "ignore" });
        if (!fs.existsSync(drive + "\\")) continue;
        drives.push(drive);
        return drive + "\\";
      } catch { /* Another process may have claimed this drive. */ }
    }
    throw Error("无法为语音模型分配临时盘符，请释放一个 F: 到 Z: 的盘符后重试");
  };
  const releaseDrives = () => {
    for (const drive of drives.reverse()) {
      try { execFileSync("subst.exe", [drive, "/D"], { windowsHide: true, stdio: "ignore" }); }
      catch { /* Do not mask the original shutdown failure. */ }
    }
    drives.length = 0;
  };
  let mappedRoot, mappedData;
  try {
    mappedRoot = asciiPath(root);
    mappedData = asciiPath(data);
  } catch (error) { releaseDrives(); throw error; }
  if (!port) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
  }
  const log = fs.createWriteStream(path.join(data, "speech.log"), { flags: "a" });
  const child = spawn(python, ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(mappedRoot, "speech"), windowsHide: true,
    env: { ...process.env,
      FRAME_SPEECH_MODELS: path.join(mappedData, "models"),
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let startupError = null;
  child.once("error", (error) => { startupError = error; });
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + timeoutMs;
    let healthy = false;
    while (Date.now() < deadline) {
      if (startupError || child.exitCode !== null)
        throw Error(`本机语音服务启动失败，请查看 ${path.join(data, "speech.log")}: ${startupError?.message || child.exitCode}`);
      try {
        const response = await fetch(url + "/healthz", { signal: AbortSignal.timeout(1000) });
        if (response.ok) { healthy = true; break; }
      } catch { /* The model runtime is still loading. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!healthy) throw Error(`本机语音服务启动超时，请查看 ${path.join(data, "speech.log")}`);
  } catch (error) { child.kill(); releaseDrives(); log.end(); throw error; }
  let closed = false;
  return { url, async close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 5000).unref();
    });
    releaseDrives();
    log.end();
  } };
}

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const MAX_LOCK_BYTES = 4096;
const failure = (code, message, file, pid) =>
  Object.assign(new Error(`${message}; lock: ${file}`), {
    code,
    details: { lockPath: file, ...(pid === undefined ? {} : { pid }) },
  });

// Read bounded regular files only. In particular, never follow a lock symlink.
function snapshot(file) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_LOCK_BYTES)
      throw failure(
        "INVALID_SERVER_LOCK",
        "启动锁不是有效的普通文件，已保留，请检查",
        file,
      );
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1)
      throw failure("SERVER_LOCK_CHANGED", "启动锁已变化，请重新启动", file);
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_LOCK_BYTES)
      throw failure("INVALID_SERVER_LOCK", "启动锁过大，已保留，请检查", file);
    return { text: buffer.subarray(0, size).toString("utf8"), stat };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function owner(item, file) {
  let value;
  try {
    value = JSON.parse(item.text);
  } catch {
    /* Invalid locks stay in place. */
  }
  if (
    !value ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    value.pid > 2147483647 ||
    typeof value.token !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(value.token)
  )
    throw failure(
      "INVALID_SERVER_LOCK",
      "启动锁内容不完整或无效，不能确认归属，已保留，请检查",
      file,
    );
  return value;
}

function requireDead(pid, file) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw failure(
      "SERVER_LOCK_OWNER_UNKNOWN",
      "无法确认原进程状态，已保留启动锁，请检查该进程权限",
      file,
      pid,
    );
  }
  throw failure(
    "SERVER_ALREADY_RUNNING",
    `MCP 启动锁所属进程 PID ${pid} 仍在运行，请使用原窗口；需要重启时先在原窗口按 Ctrl+C`,
    file,
    pid,
  );
}

const unchanged = (a, b) =>
  a &&
  b &&
  a.text === b.text &&
  a.stat.dev === b.stat.dev &&
  a.stat.ino === b.stat.ino &&
  a.stat.mtimeMs === b.stat.mtimeMs;

/** Only a confirmed dead owner is recoverable. Never kill a PID or touch OAuth state. */
export function acquireRemoteLock(directory) {
  const file = path.join(directory, "server.lock");
  const token = randomUUID();
  const contents = JSON.stringify({
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  });
  let recovered;
  const claim = () => {
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    try {
      fs.writeFileSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (claim())
      return {
        file,
        token,
        recovered,
        close() {
          // A stale instance must never delete a successor's lock. Invalid/replaced
          // locks are deliberately left for inspection; close is idempotent.
          const current = snapshot(file);
          if (current?.text === contents) fs.unlinkSync(file);
        },
      };
    const previous = snapshot(file);
    if (!previous) continue;
    const priorOwner = owner(previous, file);
    requireDead(priorOwner.pid, file);

    // Serialize reclaimers of this specific lock generation. A second reclaimer
    // must re-read after acquiring the guard, so it cannot unlink a fresh owner.
    const digest = createHash("sha256").update(previous.text).digest("hex");
    const guard = path.join(directory, `server-recovery-${digest}.lock`);
    let guardFd;
    try {
      guardFd = fs.openSync(guard, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!unchanged(previous, snapshot(file))) continue;
      throw failure(
        "SERVER_LOCK_RECOVERY_BUSY",
        "另一个启动操作正在恢复旧锁；请稍后重试。若持续失败，请检查此恢复锁（恢复操作可能被中断）",
        guard,
      );
    }
    try {
      fs.writeFileSync(guardFd, contents);
      if (!unchanged(previous, snapshot(file))) continue;
      requireDead(priorOwner.pid, file);
      fs.unlinkSync(file);
      recovered = { pid: priorOwner.pid };
    } finally {
      fs.closeSync(guardFd);
      if (snapshot(guard)?.text === contents) fs.unlinkSync(guard);
    }
  }
  throw failure("SERVER_LOCK_CHANGED", "启动锁连续变化，请稍后重试", file);
}

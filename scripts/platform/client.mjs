import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export const cliError = (code, message, details = {}) =>
  Object.assign(new Error(message), { code, ...details });
export function platformUrl(value, allowHttp = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw cliError(
      "CONFIG_REQUIRED",
      "Set FRAME_URL to the Frame Studio server origin.",
    );
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw cliError(
      "INVALID_URL",
      "FRAME_URL must be an HTTP(S) base URL without credentials, query or fragment.",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !allowHttp
  )
    throw cliError(
      "INSECURE_TRANSPORT",
      "Use HTTPS; --allow-http is required for a trusted private test server.",
    );
  return url.href.replace(/\/+$/, "");
}
async function boundedJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024)
      throw cliError(
        "RESPONSE_TOO_LARGE",
        "Response exceeds 16 MiB. Use pagination or download an artifact.",
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw cliError(
      "INVALID_RESPONSE",
      `Server returned non-JSON (HTTP ${response.status}). Check FRAME_URL and the reverse proxy.`,
      { status: response.status },
    );
  }
}

/** Credential-safe, bounded HTTP client. No automatic retry of mutations and no credential-bearing redirects. */
export class PlatformClient {
  constructor({
    base,
    token,
    timeoutMs = 600000,
    pollMs = 1000,
    allowHttp = false,
    signal,
    progress = () => {},
    fetchImpl = fetch,
  }) {
    this.base = platformUrl(base, allowHttp);
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
      throw cliError(
        "CONFIG_REQUIRED",
        "Set FRAME_TOKEN or use --token-file. Tokens are never accepted in command-line arguments.",
      );
    this.token = token.trim();
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.signal = signal;
    this.progress = progress;
    this.fetch = fetchImpl;
  }
  async response(route, { method = "GET", body, deadline } = {}) {
    const remaining = deadline ? deadline - Date.now() : this.timeoutMs;
    if (remaining <= 0)
      throw cliError(
        "TIMEOUT",
        "Client deadline reached. The server task has NOT been cancelled; inspect its task ID before retrying.",
      );
    const timer = AbortSignal.timeout(Math.max(1, remaining));
    const signal = this.signal ? AbortSignal.any([this.signal, timer]) : timer;
    try {
      const response = await this.fetch(this.base + route, {
        method,
        redirect: "error",
        signal,
        headers: {
          Authorization: "Bearer " + this.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const value = await boundedJson(response);
        throw cliError(
          typeof value.code === "string" ? value.code : "HTTP_ERROR",
          typeof value.error === "string"
            ? value.error.replaceAll(this.token, "[redacted]")
            : `HTTP ${response.status}`,
          {
            status: response.status,
            recovery: value.recovery,
            retryable: value.retryable === true,
            details: value.details,
          },
        );
      }
      return response;
    } catch (error) {
      if (signal.aborted)
        throw cliError(
          this.signal?.aborted ? "INTERRUPTED" : "TIMEOUT",
          "Client request stopped. Server work was not cancelled; inspect the task or upload before resubmitting.",
        );
      if (typeof error.code === "string" && !error.code.startsWith("UND_ERR"))
        throw error;
      throw cliError(
        "NETWORK_ERROR",
        "Could not reach Frame Studio. Check FRAME_URL, network and TLS. No mutation was retried automatically.",
      );
    }
  }
  normalizeError(error) {
    if (["AbortError", "TimeoutError"].includes(error.name))
      return cliError(
        this.signal?.aborted ? "INTERRUPTED" : "TIMEOUT",
        "Client transfer stopped. Server work was not cancelled; inspect its status before retrying.",
      );
    if (typeof error.message === "string")
      error.message = error.message.replaceAll(this.token, "[redacted]");
    return error;
  }
  async request(route, options) {
    try {
      return await boundedJson(await this.response(route, options));
    } catch (error) {
      throw this.normalizeError(error);
    }
  }
  action(name, args = {}, options = {}) {
    return this.request("/api/action", {
      ...options,
      method: "POST",
      body: { name: name.replace(/^frame_/, ""), args },
    });
  }
  async wait(id, { deadline = Date.now() + this.timeoutMs } = {}) {
    let after = 0,
      previous;
    for (;;) {
      let value;
      try {
        value = await this.action("task_get", { id, after }, { deadline });
      } catch (error) {
        error.task = id;
        throw error;
      }
      const task = value.task;
      if (!task || task.id !== id || typeof task.state !== "string")
        throw cliError("INVALID_RESPONSE", "Invalid task response", {
          task: id,
        });
      if (task.state !== previous) {
        this.progress({ task: id, state: task.state });
        previous = task.state;
      }
      const events = value.events ?? [];
      const cursor = Number(events.at(-1)?.id ?? after);
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < after ||
        (events.length && cursor === after)
      )
        throw cliError(
          "INVALID_CURSOR",
          "Task event cursor did not advance safely",
          { task: id },
        );
      after = cursor;
      // Drain all event pages even if the task has already completed.
      if (events.length >= 100) continue;
      if (task.state === "succeeded") return task;
      if (["failed", "cancelled", "publish_failed"].includes(task.state))
        throw cliError(
          task.state === "publish_failed"
            ? "TASK_PUBLICATION_FAILED"
            : task.state === "cancelled"
              ? "TASK_CANCELLED"
              : "TASK_FAILED",
          task.state === "publish_failed"
            ? "Execution finished but saving the result failed. Inspect task_get and use task_retry_publish; do not run the work again."
            : `Task ${task.state}. Inspect task_get for diagnostics.`,
          { task: id, state: task.state },
        );
      if (
        !["queued", "running", "cancelling", "publishing"].includes(task.state)
      )
        throw cliError(
          "UNKNOWN_TASK_STATE",
          "Unknown task state; inspect task_get instead of retrying",
          { task: id, state: task.state },
        );
      if (Date.now() >= deadline)
        throw cliError(
          "TIMEOUT",
          "Task wait deadline reached. The task continues on the server; use platform wait with this task ID.",
          { task: id },
        );
      try {
        await delay(
          Math.min(this.pollMs, Math.max(1, deadline - Date.now())),
          undefined,
          { signal: this.signal },
        );
      } catch {
        throw cliError(
          "INTERRUPTED",
          "Stopped waiting; the server task was not cancelled.",
          { task: id },
        );
      }
    }
  }
  async run(name, args, wait = false) {
    const deadline = Date.now() + this.timeoutMs;
    let value = await this.action(name, args, { deadline });
    if (!wait) return value;
    const operation = name.replace(/^frame_/, "");
    if (operation === "works_browser") {
      // A queued validation may precede the build, so this can require more than one wait.
      while (value.state !== "ready") {
        if (typeof value.task !== "string")
          throw cliError(
            "INVALID_RESPONSE",
            "Browser response omitted its task ID",
          );
        await this.wait(value.task, { deadline });
        value = await this.action(
          operation,
          { ...args, rebuild: false },
          { deadline },
        );
      }
      return value;
    }
    const taskId =
      value?.task?.id ??
      (typeof value?.task === "string"
        ? value.task
        : value?.kind && value?.state
          ? value.id
          : null);
    return taskId ? this.wait(taskId, { deadline }) : value;
  }
  async download(id, artifactPath, output, { force = false } = {}) {
    if (
      !artifactPath ||
      artifactPath
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      /[\\\0]/.test(artifactPath)
    )
      throw cliError(
        "INVALID_PATH",
        "Use the exact artifact path from task_get.",
      );
    const deadline = Date.now() + this.timeoutMs;
    const { task } = await this.action("task_get", { id }, { deadline });
    if (task?.state !== "succeeded")
      throw cliError(
        "TASK_NOT_COMPLETE",
        "Wait for successful completion before downloading",
        { task: id },
      );
    const artifact = task.result?.artifacts?.find(
      (file) => file.path === artifactPath,
    );
    if (!artifact)
      throw cliError(
        "ARTIFACT_NOT_FOUND",
        "Path is not in this task's artifact manifest",
        { task: id },
      );
    const target = path.resolve(output),
      temp = target + ".frame-part-" + randomUUID();
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const existing = await fsp.lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing && (!force || !existing.isFile() || existing.isSymbolicLink()))
      throw cliError(
        "OUTPUT_EXISTS",
        "Output already exists; choose another path or explicitly use --force for a regular file.",
      );
    let bytes = 0;
    const digest = createHash("sha256");
    try {
      const response = await this.response(
        `/api/tasks/${encodeURIComponent(id)}/file/${artifactPath.split("/").map(encodeURIComponent).join("/")}`,
        { deadline },
      );
      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length;
            digest.update(chunk);
            done(null, chunk);
          },
        }),
        fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      );
      const sha256 = digest.digest("hex"),
        expected = artifact.bytes ?? artifact.size;
      if (typeof expected === "number" && bytes !== expected)
        throw cliError(
          "SIZE_MISMATCH",
          "Downloaded bytes do not match the artifact manifest",
        );
      if (artifact.sha256 && artifact.sha256 !== sha256)
        throw cliError(
          "CHECKSUM_MISMATCH",
          "Downloaded checksum does not match the artifact manifest",
        );
      if (force) await fsp.rename(temp, target);
      else {
        await fsp.link(temp, target);
        await fsp.unlink(temp);
      }
      return {
        task: id,
        path: artifactPath,
        output: target,
        bytes,
        sha256,
        checksumVerified: Boolean(artifact.sha256),
      };
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
  async upload(
    file,
    { repo, license, mime = "application/octet-stream", resume } = {},
  ) {
    if (!repo || !license?.trim())
      throw cliError(
        "UPLOAD_METADATA_REQUIRED",
        "Provide --repo and --license (or FRAME_REPOSITORY and FRAME_ASSET_LICENSE).",
      );
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 ** 3)
      throw cliError(
        "INVALID_UPLOAD",
        "Upload a regular, nonempty file no larger than 1 GiB.",
      );
    const digest = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    const sha256 = digest.digest("hex"),
      deadline = Date.now() + this.timeoutMs;
    const state = resume
      ? await this.action("upload_status", { id: resume }, { deadline })
      : await this.action(
          "upload_begin",
          {
            repo,
            name: path.basename(file),
            bytes: stat.size,
            sha256,
            license,
            mime,
          },
          { deadline },
        );
    const id = state.id;
    this.progress({ upload: id, offset: state.offset, bytes: stat.size });
    if (
      resume &&
      (state.sha256 !== sha256 ||
        state.bytes !== stat.size ||
        state.repo !== repo)
    )
      throw cliError(
        "UPLOAD_MISMATCH",
        "Resume ID belongs to different bytes or repository; no chunks were sent.",
        { upload: id },
      );
    let offset = state.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size)
      throw cliError("INVALID_OFFSET", "Invalid upload resume offset", {
        upload: id,
      });
    const handle = await fsp.open(file, "r"),
      buffer = Buffer.alloc(768 * 1024);
    try {
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - offset),
          offset,
        );
        if (!bytesRead)
          throw cliError("SOURCE_CHANGED", "Upload file changed while reading");
        const next = await this.action(
          "upload_chunk",
          {
            id,
            offset,
            base64: buffer.subarray(0, bytesRead).toString("base64"),
          },
          { deadline },
        );
        if (next.offset !== offset + bytesRead)
          throw cliError(
            "INVALID_OFFSET",
            "Unexpected chunk acknowledgment; inspect upload_status before resuming",
          );
        offset = next.offset;
      }
      const current = await handle.stat();
      if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)
        throw cliError(
          "SOURCE_CHANGED",
          "Upload file changed; upload was not finalized",
        );
      const asset = await this.action("upload_finish", { id }, { deadline });
      return { ...asset, upload: id };
    } catch (error) {
      error.upload = id;
      error.offset = offset;
      throw error;
    } finally {
      await handle.close();
    }
  }
}

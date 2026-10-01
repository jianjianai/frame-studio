import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

export const cliError = (code, message, details = {}) =>
  Object.assign(new Error(message), { code, ...details });
const MAX_RESPONSE = 16 * 1024 * 1024;
export class PlatformClient {
  constructor({ url, token, timeoutMs = 30000, signal, fetchImpl = fetch }) {
    if (!url || !token)
      throw cliError(
        "CONFIG_REQUIRED",
        "Set FRAME_URL and FRAME_TOKEN. Run --help without credentials for usage.",
      );
    let base;
    try {
      base = new URL(url);
    } catch {
      throw cliError(
        "INVALID_URL",
        "FRAME_URL must be an absolute HTTP(S) base URL.",
      );
    }
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw cliError(
        "INVALID_URL",
        "FRAME_URL must use HTTP(S), without credentials, query or fragment.",
      );
    base.pathname = base.pathname.replace(/\/+$/, "") + "/";
    this.base = base.href;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.fetch = fetchImpl;
  }
  redact(message) {
    return String(message).split(this.token).join("[redacted]");
  }
  async request(route, { body, raw = false, timeoutMs = this.timeoutMs } = {}) {
    if (!/^api\//.test(route) || route.split("/").some((part) => part === ".."))
      throw cliError("INVALID_ROUTE", "Expected a same-server API route.");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.signal
      ? AbortSignal.any([this.signal, timeout])
      : timeout;
    try {
      const response = await this.fetch(this.base + route, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: "Bearer " + this.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (raw && response.ok) return { response, signal };
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_RESPONSE) {
        await response.body?.cancel();
        throw cliError(
          "RESPONSE_TOO_LARGE",
          "Response exceeds 16 MiB; use compact context/status or narrower pages.",
        );
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE)
          throw cliError(
            "RESPONSE_TOO_LARGE",
            "Response exceeds 16 MiB; use compact context/status or narrower pages.",
          );
        chunks.push(chunk);
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw cliError(
          "INVALID_RESPONSE",
          `HTTP ${response.status}: expected JSON. Check FRAME_URL, authentication and the reverse proxy.`,
          { status: response.status },
        );
      }
      if (!response.ok)
        throw cliError(
          typeof value.code === "string" ? value.code : "HTTP_ERROR",
          this.redact(
            typeof value.error === "string"
              ? value.error
              : `HTTP ${response.status}`,
          ),
          {
            status: response.status,
            recovery: value.recovery ?? "check-status",
            requestId: value.requestId,
          },
        );
      return value;
    } catch (error) {
      if (this.signal?.aborted)
        throw cliError(
          "INTERRUPTED",
          "Interrupted locally. Remote tasks/uploads were NOT cancelled.",
          { exitCode: 130, recovery: "check-status" },
        );
      if (timeout.aborted)
        throw cliError(
          "REQUEST_TIMED_OUT",
          "Request timed out. A mutation may have completed; check its status before retrying.",
          { recovery: "check-status" },
        );
      if (error.code) throw error;
      throw cliError(
        "NETWORK_ERROR",
        this.redact(
          "Request failed: " +
            error.message +
            ". Check connectivity and FRAME_URL; redirects are not followed.",
        ),
        { recovery: "check-status" },
      );
    }
  }
  call(name, args = {}, options) {
    return this.request("api/action", {
      ...options,
      body: { name: name.replace(/^frame_/, ""), args },
    });
  }
  describe(name) {
    return this.request(
      "api/actions/" + encodeURIComponent(name.replace(/^frame_/, "")),
    );
  }
  async wait(
    id,
    {
      timeoutMs = 120000,
      after = "0",
      onStatus = () => {},
      onEvents = () => {},
    } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw cliError(
          "WAIT_TIMED_OUT",
          "Stopped waiting; the remote task is still available. Resume with platform wait or task_status.",
          { taskId: id, exitCode: 2, recovery: "task-status" },
        );
      let status;
      try {
        status = await this.call(
          "task_status",
          {
            id,
            after,
            waitMs: Math.min(
              10000,
              Math.max(0, remaining - 100),
              Math.max(0, this.timeoutMs - 100),
            ),
            limit: 100,
          },
          { timeoutMs: Math.max(1, Math.min(this.timeoutMs, remaining)) },
        );
      } catch (error) {
        if (error.code === "REQUEST_TIMED_OUT" && Date.now() >= deadline)
          throw cliError(
            "WAIT_TIMED_OUT",
            "Stopped waiting; the remote task was NOT cancelled. Resume with platform wait.",
            { taskId: id, exitCode: 2, recovery: "task-status" },
          );
        throw error;
      }
      if (
        !status.task ||
        !Array.isArray(status.events) ||
        !/^\d+$/.test(String(status.nextAfter)) ||
        BigInt(status.nextAfter) < BigInt(after) ||
        (status.hasMore && String(status.nextAfter) === String(after))
      )
        throw cliError(
          "INVALID_RESPONSE",
          "Invalid task event cursor; stopped to avoid duplicate or lost events.",
        );
      onStatus(status);
      onEvents(status.events);
      after = String(status.nextAfter);
      if (status.done && !status.hasMore) return status;
      if (!status.hasMore)
        await sleep(
          Math.min(250, Math.max(0, deadline - Date.now())),
          undefined,
          { signal: this.signal },
        );
    }
  }
  async waitForBrowser(id, initial, options = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? 120000);
    let result = initial;
    while (result?.state !== "ready") {
      if (typeof result?.task !== "string")
        throw cliError(
          "INVALID_RESPONSE",
          "Browser operation did not return a preview or compilation task.",
        );
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw cliError(
          "WAIT_TIMED_OUT",
          "Preview is not ready yet; resume with works_browser --wait. Remote compilation was NOT cancelled.",
          { taskId: result.task, exitCode: 2, recovery: "works-browser" },
        );
      const status = await this.wait(result.task, {
        ...options,
        timeoutMs: remaining,
        after: "0",
      });
      if (status.task.state !== "succeeded") return status;
      const requestBudget = deadline - Date.now();
      if (requestBudget <= 0)
        throw cliError(
          "WAIT_TIMED_OUT",
          "Compilation completed; call works_browser to obtain its preview URL.",
          { taskId: result.task, exitCode: 2, recovery: "works-browser" },
        );
      // A prior task may have been editing this work; request the current preview after it finishes.
      result = await this.call(
        "works_browser",
        { id, rebuild: false },
        { timeoutMs: Math.min(this.timeoutMs, requestBudget) },
      );
    }
    return result;
  }
  async upload(
    file,
    {
      repo,
      license,
      mime = "application/octet-stream",
      resume,
      onProgress = () => {},
    },
  ) {
    if (!resume && (!repo || !license?.trim()))
      throw cliError(
        "UPLOAD_METADATA_REQUIRED",
        "Use --repo and --license (or FRAME_REPOSITORY and FRAME_ASSET_LICENSE).",
      );
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 ** 3)
      throw cliError(
        "INVALID_FILE",
        "Upload a regular file between 1 byte and 1 GiB.",
      );
    const digest = createHash("sha256");
    for await (const chunk of fs.createReadStream(file, {
      signal: this.signal,
    }))
      digest.update(chunk);
    const sha256 = digest.digest("hex"),
      name = path.basename(file);
    let upload;
    if (resume) {
      upload = await this.call("upload_status", { id: resume });
      if (
        upload.bytes !== stat.size ||
        upload.sha256 !== sha256 ||
        upload.name !== name ||
        (repo && repo !== upload.repo)
      )
        throw cliError(
          "UPLOAD_MISMATCH",
          "The resume session belongs to different bytes, filename or repository. No data was sent.",
        );
      if (upload.state === "complete") return upload.result;
    } else {
      if (!repo || !license?.trim())
        throw cliError(
          "UPLOAD_METADATA_REQUIRED",
          "Use --repo and --license (or FRAME_REPOSITORY and FRAME_ASSET_LICENSE).",
        );
      const requestKey = randomUUID();
      onProgress({ uploadId: requestKey, stage: "begin", bytes: stat.size });
      try {
        upload = await this.call("upload_begin", {
          name,
          bytes: stat.size,
          sha256,
          repo,
          license,
          mime,
          requestKey,
        });
      } catch (error) {
        throw Object.assign(error, {
          uploadId: requestKey,
          recovery: "upload-resume-or-check-status",
        });
      }
    }
    const id = upload.id;
    onProgress({ uploadId: id, offset: upload.offset, bytes: stat.size });
    try {
      if (
        !Number.isSafeInteger(upload.offset) ||
        upload.offset < 0 ||
        upload.offset > stat.size ||
        !Number.isSafeInteger(upload.chunkBytes) ||
        upload.chunkBytes < 1 ||
        upload.chunkBytes > 768 * 1024
      )
        throw cliError(
          "INVALID_RESPONSE",
          "Invalid upload offset or chunk size.",
        );
      const handle = await fsp.open(file, "r");
      try {
        const opened = await handle.stat();
        if (
          opened.size !== stat.size ||
          opened.mtimeMs !== stat.mtimeMs ||
          opened.ino !== stat.ino
        )
          throw cliError(
            "FILE_CHANGED",
            "Local file changed after hashing; upload stopped.",
          );
        const buffer = Buffer.alloc(upload.chunkBytes);
        let offset = upload.offset;
        while (offset < stat.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, stat.size - offset),
            offset,
          );
          if (!bytesRead)
            throw cliError(
              "FILE_CHANGED",
              "Local file ended early; upload stopped.",
            );
          const next = await this.call("upload_chunk", {
            id,
            offset,
            base64: buffer.subarray(0, bytesRead).toString("base64"),
          });
          if (next.offset !== offset + bytesRead)
            throw cliError(
              "UPLOAD_OFFSET_CONFLICT",
              "Server offset changed; inspect upload_status before resuming.",
            );
          offset = next.offset;
          onProgress({ uploadId: id, offset, bytes: stat.size });
        }
        const after = await handle.stat();
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw cliError(
            "FILE_CHANGED",
            "Local file changed while uploading; checksum verification was not requested.",
          );
      } finally {
        await handle.close();
      }
      return await this.call("upload_finish", { id });
    } catch (error) {
      throw Object.assign(error, { uploadId: id, recovery: "upload-resume" });
    }
  }
  async download(id, name, output, { force = false } = {}) {
    let { task } = await this.call("task_status", { id });
    if (task.state !== "succeeded" || task.cleaned)
      throw cliError(
        "ARTIFACT_UNAVAILABLE",
        "Task outputs are unfinished or expired; inspect task_status.",
      );
    if (task.result?.artifactsTruncated)
      ({ task } = await this.call("task_get", { id }));
    const matches = (task.result?.artifacts ?? []).filter(
      (a) => a.path === name || a.name === name,
    );
    if (matches.length !== 1)
      throw cliError(
        "ARTIFACT_NOT_FOUND",
        "Choose one exact artifact path/name from task_status (or task_get for all artifacts).",
      );
    const artifact = matches[0],
      prefix = `projects/${task.project}/exports/`;
    if (
      !artifact.path.startsWith(prefix) ||
      artifact.path
        .split("/")
        .some((p) => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p))
    )
      throw cliError(
        "INVALID_ARTIFACT",
        "Server returned an unsafe artifact path.",
      );
    const target = path.resolve(output);
    let existing;
    try {
      existing = await fsp.lstat(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing && (!force || !existing.isFile() || existing.isSymbolicLink()))
      throw cliError(
        "OUTPUT_EXISTS",
        "Output already exists or is not a regular file; use another path or explicitly --force for a file.",
      );
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = target + ".frame-download-" + randomUUID();
    let owned = false;
    try {
      const { response, signal } = await this.request(
        "api/tasks/" +
          encodeURIComponent(id) +
          "/file/" +
          artifact.path.split("/").map(encodeURIComponent).join("/"),
        { raw: true },
      );
      const handle = await fsp.open(temporary, "wx", 0o600);
      owned = true;
      const digest = createHash("sha256");
      let bytes = 0;
      const expected = Number(artifact.bytes);
      const inspect = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (
            Number.isSafeInteger(expected) &&
            expected >= 0 &&
            bytes > expected
          ) {
            callback(
              cliError(
                "ARTIFACT_SIZE_MISMATCH",
                "Download exceeds the artifact's declared size.",
              ),
            );
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          inspect,
          handle.createWriteStream(),
          { signal },
        );
      } finally {
        await handle.close().catch(() => {});
      }
      if (Number.isSafeInteger(expected) && bytes !== expected)
        throw cliError(
          "ARTIFACT_SIZE_MISMATCH",
          "Download was incomplete; the previous output was preserved.",
        );
      const sha256 = digest.digest("hex");
      if (artifact.sha256 && artifact.sha256 !== sha256)
        throw cliError(
          "ARTIFACT_HASH_MISMATCH",
          "Downloaded bytes failed checksum verification.",
        );
      // link is an atomic no-clobber publish on the same filesystem; --force uses atomic replacement.
      if (force) await fsp.rename(temporary, target);
      else await fsp.link(temporary, target);
      return {
        taskId: id,
        path: artifact.path,
        output: target,
        bytes,
        sha256,
        checksumVerified: Boolean(artifact.sha256),
      };
    } finally {
      if (owned) await fsp.rm(temporary, { force: true });
    }
  }
}

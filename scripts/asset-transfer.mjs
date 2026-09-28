import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail, safePath, sha256 } from "./mcp/workspace.mjs";
import { assetTypes, assetType, validateAsset } from "./asset-format.mjs";
import { assetUrl, openPublicAsset } from "./asset-network.mjs";

export const CHUNK_BYTES = 1024 * 1024;
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const QUOTA_BYTES = 1024 * 1024 * 1024,
  TTL = 24 * 3600000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const terminal = new Set(["completed", "aborted"]);
export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
export function decodeChunk(value) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    fail(
      "INVALID_BASE64",
      "Use canonical base64, without a data URL; maximum decoded chunk is 1 MiB.",
    );
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > CHUNK_BYTES)
    fail("INVALID_BASE64", "Invalid or oversized base64 chunk.");
  return bytes;
}
function atomicJson(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function exited(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

/** Persistent receipts and bytes belong to one project and one authorization principal. */
export class AssetTransfers {
  constructor(
    workspace,
    { owner = "local", openUrl = openPublicAsset, now = Date.now } = {},
  ) {
    this.workspace = workspace;
    this.owner = sha256(owner);
    this.openUrl = openUrl;
    this.now = now;
    this.running = new Map();
  }
  capabilities() {
    return {
      maxAssetBytes: MAX_ASSET_BYTES,
      chunkBytes: CHUNK_BYTES,
      stagingQuotaBytes: QUOTA_BYTES,
      uploadTtlSeconds: TTL / 1000,
      extensions: Object.keys(assetTypes),
    };
  }
  folder(project, id) {
    this.workspace.project(project);
    if (!uuid.test(id))
      fail("INVALID_UPLOAD", "Use the uploadId returned by begin.");
    return this.workspace.file(project, `.cache/asset-transfers/${id}`, true);
  }
  file(project, id, name) {
    return safePath(this.folder(project, id), name, { internal: true });
  }
  load(project, id) {
    const file = this.file(project, id, "state.json");
    if (!fs.existsSync(file)) fail("UNKNOWN_UPLOAD", "Upload unavailable.");
    if (fs.statSync(file).size > 65536)
      fail("INVALID_UPLOAD", "Upload receipt is too large.");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      state.project !== project ||
      state.uploadId !== id ||
      state.owner !== this.owner
    )
      fail("UPLOAD_DENIED", "Upload belongs to another authorization.");
    return state;
  }
  save(state) {
    state.updatedAt = this.now();
    atomicJson(this.file(state.project, state.uploadId, "state.json"), state);
  }
  view(state) {
    const { owner, fetchPid, ...result } = state;
    const interrupted =
      state.status === "fetching" &&
      !this.running.has(state.uploadId) &&
      exited(fetchPid);
    return {
      ...result,
      ...(interrupted
        ? {
            status: "interrupted",
            nextAction:
              "Abort this interrupted URL download and fetch again; uploaded byte chunks can resume independently.",
          }
        : {}),
      expired: state.expiresAt <= this.now(),
      chunkBytes: CHUNK_BYTES,
    };
  }
  status(project, id) {
    return this.view(this.load(project, id));
  }
  lock(project, id) {
    const file = this.file(project, id, "io.lock");
    const token = randomUUID();
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), {
        flag: "wx",
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const recoverRelease = this.workspace.lock(
        project,
        "asset-lock-recovery",
      );
      try {
        let record;
        try {
          record = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        if (!record || !exited(record.pid))
          fail(
            "UPLOAD_BUSY",
            "Upload has an active operation; retry after it finishes.",
          );
        fs.unlinkSync(file);
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), {
          flag: "wx",
        });
      } finally {
        recoverRelease();
      }
    }
    return () => {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.token !== token)
        fail("UPLOAD_BUSY", "Upload lock changed; preserving it.");
      fs.unlinkSync(file);
    };
  }
  begin(
    project,
    {
      filename,
      bytes,
      sha256: expected,
      license,
      source = "Uploaded by an authorized client",
      kind = "upload",
      requestId,
    },
  ) {
    this.workspace.writable();
    if (
      typeof filename !== "string" ||
      filename.length > 120 ||
      filename.includes("/") ||
      !filename.length
    )
      fail(
        "INVALID_FILENAME",
        "Use a filename without directories (1..120 characters).",
      );
    safePath(this.workspace.project(project), filename);
    assetType(filename);
    if (!Number.isSafeInteger(bytes) || bytes < 12 || bytes > MAX_ASSET_BYTES)
      fail("INVALID_SIZE", "Material size must be 12 bytes..512 MiB.");
    if (expected !== undefined && !digest.test(expected))
      fail("INVALID_HASH", "Use a lowercase SHA-256.");
    if (requestId !== undefined && !uuid.test(requestId))
      fail(
        "INVALID_UPLOAD",
        "requestId must be a UUID for retry deduplication.",
      );
    if (
      typeof license !== "string" ||
      !license.trim() ||
      license.length > 4000 ||
      typeof source !== "string" ||
      source.length > 4000
    )
      fail(
        "INVALID_LICENSE",
        "Provide source/license text up to 4000 characters.",
      );
    const release = this.workspace.lock(project, "asset-upload-begin");
    try {
      const base = this.workspace.file(project, ".cache/asset-transfers", true);
      fs.mkdirSync(base, { recursive: true });
      if (requestId && fs.existsSync(this.folder(project, requestId))) {
        const prior = this.load(project, requestId);
        if (
          prior.filename !== filename ||
          prior.bytes !== bytes ||
          prior.expectedSha256 !== (expected ?? null) ||
          prior.license !== license ||
          prior.source !== source ||
          prior.kind !== kind
        )
          fail(
            "UPLOAD_CONFLICT",
            "requestId already belongs to different material metadata.",
          );
        return this.view(prior);
      }
      let reserved = 0,
        active = 0;
      const entries = fs.readdirSync(base);
      if (entries.length > 4096)
        fail(
          "UPLOAD_QUOTA",
          "Prune expired transfer receipts before starting more uploads.",
        );
      for (const id of entries.filter((name) => uuid.test(name))) {
        const file = this.file(project, id, "state.json");
        if (!fs.existsSync(file) || fs.statSync(file).size > 65536)
          fail(
            "UPLOAD_QUOTA",
            "Inspect incomplete transfer metadata before allocating more space.",
          );
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!terminal.has(state.status)) {
          reserved += state.bytes;
          active++;
        } else {
          const payload = this.file(project, id, "payload.part");
          if (fs.existsSync(payload)) reserved += fs.statSync(payload).size;
        }
      }
      if (reserved + bytes > QUOTA_BYTES || active >= 16)
        fail(
          "UPLOAD_QUOTA",
          "Project staging quota exceeded; complete or abort existing uploads.",
        );
      const uploadId = requestId ?? randomUUID();
      fs.mkdirSync(this.folder(project, uploadId));
      fs.writeFileSync(this.file(project, uploadId, "payload.part"), "", {
        flag: "wx",
      });
      const state = {
        schemaVersion: 1,
        project,
        uploadId,
        owner: this.owner,
        kind,
        filename,
        bytes,
        expectedSha256: expected ?? null,
        license,
        source,
        status: "uploading",
        receivedBytes: 0,
        createdAt: this.now(),
        expiresAt: this.now() + TTL,
      };
      this.save(state);
      return this.view(state);
    } finally {
      release();
    }
  }
  chunk(project, id, offset, bytes, expected, { fetching = false } = {}) {
    this.workspace.writable();
    this.load(project, id);
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > CHUNK_BYTES ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      fail(
        "INVALID_CHUNK",
        "Use an integer offset and 1 byte..1 MiB of binary data.",
      );
    if (
      expected !== undefined &&
      (!digest.test(expected) || sha256(bytes) !== expected)
    )
      fail("CHECKSUM_MISMATCH", "Chunk SHA-256 does not match.");
    const release = this.lock(project, id);
    try {
      const state = this.load(project, id);
      if (
        !(
          state.status === "uploading" ||
          (fetching && state.status === "fetching")
        ) ||
        state.expiresAt <= this.now()
      )
        fail(
          "UPLOAD_STATE",
          "Upload is not accepting chunks; inspect its status.",
        );
      if (offset + bytes.length > state.bytes || offset > state.receivedBytes)
        fail(
          "OFFSET_MISMATCH",
          "Resume at the acknowledged receivedBytes offset.",
          { receivedBytes: state.receivedBytes },
        );
      const file = this.file(project, id, "payload.part");
      const fd = fs.openSync(file, "r+");
      try {
        if (fs.fstatSync(fd).size < state.receivedBytes)
          fail("UPLOAD_CORRUPT", "Stored payload is shorter than its receipt.");
        // A crash after writing but before acknowledging leaves an uncommitted tail.
        fs.ftruncateSync(fd, state.receivedBytes);
        if (offset < state.receivedBytes) {
          const prior = Buffer.alloc(bytes.length);
          fs.readSync(fd, prior, 0, bytes.length, offset);
          if (
            offset + bytes.length > state.receivedBytes ||
            !prior.equals(bytes)
          )
            fail(
              "CHUNK_CONFLICT",
              "Retry bytes differ from the acknowledged chunk.",
            );
          return { ...this.view(state), replayed: true };
        }
        let written = 0;
        while (written < bytes.length)
          written += fs.writeSync(
            fd,
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
        fs.fsyncSync(fd);
        state.receivedBytes += bytes.length;
        this.save(state);
        return this.view(state);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      release();
    }
  }
  async complete(project, id) {
    this.workspace.writable();
    this.load(project, id);
    const release = this.lock(project, id);
    try {
      const state = this.load(project, id);
      if (state.status === "completed") {
        const payload = this.file(project, id, "payload.part");
        if (fs.existsSync(payload)) fs.unlinkSync(payload);
        return this.view(state);
      }
      if (
        !["uploading", "ready", "committing"].includes(state.status) ||
        state.expiresAt <= this.now()
      )
        fail(
          "UPLOAD_STATE",
          "Upload cannot be completed in its current state.",
        );
      if (state.receivedBytes !== state.bytes)
        fail("UPLOAD_INCOMPLETE", "Upload is incomplete.", {
          receivedBytes: state.receivedBytes,
          bytes: state.bytes,
        });
      const payload = this.file(project, id, "payload.part");
      if (fs.statSync(payload).size !== state.bytes)
        fail("UPLOAD_CORRUPT", "Payload length changed.");
      const hash = await hashFile(payload);
      if (state.expectedSha256 && state.expectedSha256 !== hash)
        fail(
          "CHECKSUM_MISMATCH",
          "Material SHA-256 does not match; it has not been published.",
        );
      const type = await validateAsset(payload, state.filename, state.bytes);
      const publishRelease = this.workspace.lock(project, "asset-publish");
      try {
        state.status = "committing";
        this.save(state);
        const stem =
          path
            .basename(state.filename, path.extname(state.filename))
            .replace(/[^\p{L}\p{N}_-]/gu, "-")
            .slice(0, 60) || "asset";
        const relative = `public/imports/${stem}-${id}.${type.ext}`;
        const target = this.workspace.file(project, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const catalogPath = this.workspace.file(project, "public/assets.json");
        if (
          fs.existsSync(catalogPath) &&
          fs.statSync(catalogPath).size > 8 * 1024 * 1024
        )
          fail("TOO_LARGE", "Asset catalog exceeds 8 MiB.");
        const before = fs.existsSync(catalogPath)
          ? fs.readFileSync(catalogPath)
          : null;
        const catalog = before ? JSON.parse(before) : [];
        if (!Array.isArray(catalog))
          fail("INVALID_CATALOG", "Asset catalog must be an array.");
        if (fs.existsSync(target)) {
          if ((await hashFile(target)) !== hash)
            fail(
              "ASSET_CONFLICT",
              "Published target was modified; preserving it.",
            );
        } else {
          const temporary = this.file(project, id, "publish.part");
          await fs.promises.copyFile(payload, temporary);
          fs.renameSync(temporary, target);
        }
        const item = {
          name: path.basename(target),
          url: `films/${project}/${relative.slice(7)}`,
          type: type.type,
          mimeType: type.mimeType,
          bytes: state.bytes,
          sha256: hash,
          license: state.license,
          source: state.source,
          transferId: id,
        };
        const previous = catalog.find((entry) => entry.transferId === id);
        if (previous && (previous.sha256 !== hash || previous.url !== item.url))
          fail(
            "ASSET_CONFLICT",
            "Transfer receipt conflicts with the catalog.",
          );
        if (
          fs.existsSync(catalogPath) &&
          fs.statSync(catalogPath).size > 8 * 1024 * 1024
        )
          fail("VERSION_CONFLICT", "Asset catalog changed during publication.");
        const current = fs.existsSync(catalogPath)
          ? fs.readFileSync(catalogPath)
          : null;
        if ((before?.toString() ?? null) !== (current?.toString() ?? null))
          fail(
            "VERSION_CONFLICT",
            "Asset catalog changed during publication; retry completion.",
          );
        if (!previous) atomicJson(catalogPath, [...catalog, item]);
        state.status = "completed";
        delete state.error;
        state.asset = {
          ...item,
          path: relative,
          absolutePath: target,
          assetUrl: item.url,
        };
        this.save(state);
        try {
          fs.unlinkSync(payload);
        } catch {
          state.cleanupPending = true;
          this.save(state);
        }
        return this.view(state);
      } finally {
        publishRelease();
      }
    } finally {
      release();
    }
  }
  async upload(project, options) {
    const bytes = decodeChunk(options.dataBase64);
    const state = this.begin(project, { ...options, bytes: bytes.length });
    try {
      if (["completed", "committing", "ready"].includes(state.status))
        return await this.complete(project, state.uploadId);
      this.chunk(project, state.uploadId, 0, bytes);
      return await this.complete(project, state.uploadId);
    } catch (error) {
      error.details = {
        ...error.details,
        uploadId: state.uploadId,
        nextAction: "Inspect the transfer and retry completion, or abort it.",
      };
      throw error;
    }
  }
  async abort(project, id) {
    this.workspace.writable();
    this.load(project, id);
    const running = this.running.get(id);
    if (running) {
      running.controller.abort();
      await running.done;
    }
    const release = this.lock(project, id);
    try {
      const state = this.load(project, id);
      if (state.status === "completed" || state.status === "committing")
        fail(
          "UPLOAD_STATE",
          "Published or committing material cannot be aborted; retry completion if needed.",
        );
      if (state.status === "fetching" && !exited(state.fetchPid))
        fail("UPLOAD_BUSY", "Download belongs to a live worker.");
      for (const name of ["payload.part", "publish.part"]) {
        const file = this.file(project, id, name);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      state.status = "aborted";
      this.save(state);
      return this.view(state);
    } finally {
      release();
    }
  }
  async prune(project) {
    this.workspace.writable();
    const base = this.workspace.file(project, ".cache/asset-transfers", true);
    const removed = [];
    if (!fs.existsSync(base)) return { removed };
    for (const id of fs.readdirSync(base).filter((name) => uuid.test(name))) {
      let state;
      try {
        state = this.load(project, id);
      } catch {
        continue;
      }
      if (state.expiresAt > this.now() || this.running.has(id)) continue;
      if (!terminal.has(state.status)) {
        try {
          await this.abort(project, id);
        } catch {
          continue;
        }
      }
      for (const name of ["payload.part", "publish.part"]) {
        const file = this.file(project, id, name);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      // Remove only known receipt files, never recurse through unexpected contents.
      const folder = this.folder(project, id);
      if (fs.readdirSync(folder).some((name) => name !== "state.json"))
        continue;
      fs.unlinkSync(this.file(project, id, "state.json"));
      fs.rmdirSync(folder);
      removed.push(id);
    }
    return { removed };
  }
  fetch(project, { url: value, maxBytes = MAX_ASSET_BYTES, ...options }) {
    const url = assetUrl(value);
    if (this.running.size >= 2)
      fail(
        "UPLOAD_BUSY",
        "At most two URL downloads can run per authorization.",
      );
    const state = this.begin(project, {
      ...options,
      bytes: maxBytes,
      kind: "url",
      source: url.origin + url.pathname,
    });
    const saved = this.load(project, state.uploadId);
    saved.status = "fetching";
    saved.fetchPid = process.pid;
    this.save(saved);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const entry = { controller, done: null };
    this.running.set(state.uploadId, entry);
    entry.done = (async () => {
      try {
        const response = await this.openUrl(value, {
          signal: controller.signal,
        });
        const length = Number(response.headers["content-length"]);
        if (Number.isFinite(length) && length > maxBytes) {
          response.destroy();
          fail("TOO_LARGE", "Download exceeds its byte limit.");
        }
        let offset = 0,
          buffered = 0,
          parts = [];
        for await (const buffer of response) {
          controller.signal.throwIfAborted();
          for (let start = 0; start < buffer.length;) {
            const size = Math.min(
              CHUNK_BYTES - buffered,
              buffer.length - start,
            );
            parts.push(buffer.subarray(start, start + size));
            buffered += size;
            start += size;
            if (offset + buffered > maxBytes)
              fail("TOO_LARGE", "Download exceeds its byte limit.");
            if (buffered === CHUNK_BYTES) {
              this.chunk(
                project,
                state.uploadId,
                offset,
                Buffer.concat(parts, buffered),
                undefined,
                { fetching: true },
              );
              offset += buffered;
              buffered = 0;
              parts = [];
            }
          }
        }
        if (buffered) {
          this.chunk(
            project,
            state.uploadId,
            offset,
            Buffer.concat(parts, buffered),
            undefined,
            { fetching: true },
          );
          offset += buffered;
        }
        if (offset < 12 || (Number.isFinite(length) && length !== offset))
          fail(
            "DOWNLOAD_INCOMPLETE",
            "Downloaded size is invalid or does not match Content-Length.",
          );
        const finished = this.load(project, state.uploadId);
        finished.bytes = offset;
        finished.status = "ready";
        this.save(finished);
        await this.complete(project, state.uploadId);
      } catch (error) {
        const current = this.load(project, state.uploadId);
        if (terminal.has(current.status)) return;
        if (current.status !== "committing")
          current.status = current.status === "ready" ? "ready" : "failed";
        current.error = {
          code: error.code ?? "DOWNLOAD_FAILED",
          message: error.code
            ? error.message
            : "URL download interrupted or failed; retry with a fresh download URL.",
        };
        this.save(current);
      } finally {
        clearTimeout(timer);
        this.running.delete(state.uploadId);
      }
    })();
    // A disk error can prevent persisting the failure receipt; keep that rejection
    // observable to wait/abort/close without turning it into an unhandled rejection.
    entry.done.catch(() => {});
    return this.status(project, state.uploadId);
  }
  async wait(project, id, waitMs = 0) {
    this.load(project, id);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 20000)
      fail("INVALID_WAIT", "waitMs must be 0..20000.");
    const entry = this.running.get(id);
    let timer;
    if (entry && waitMs)
      try {
        await Promise.race([
          entry.done,
          new Promise((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    return this.status(project, id);
  }
  describe(project, relative) {
    this.workspace.project(project);
    if (!relative?.startsWith("public/imports/"))
      fail("ASSET_DENIED", "Read a registered public/imports material.");
    const file = this.workspace.file(project, relative);
    const type = assetType(relative),
      stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES)
      fail("INVALID_ASSET", "Material is not a bounded regular file.");
    const index = this.workspace.file(project, "public/assets.json");
    if (fs.statSync(index).size > 8 * 1024 * 1024)
      fail("TOO_LARGE", "Asset catalog exceeds 8 MiB.");
    const url = `films/${project}/${relative.slice(7)}`;
    const item = JSON.parse(fs.readFileSync(index, "utf8")).find(
      (asset) => asset.url === url,
    );
    if (!item)
      fail("ASSET_DENIED", "Material is not registered in this project.");
    return {
      path: relative,
      absolutePath: file,
      bytes: stat.size,
      mimeType: type.mimeType,
      asset: item,
    };
  }
  read(
    project,
    relative,
    { offset = 0, length = CHUNK_BYTES, metadataOnly = true } = {},
  ) {
    const info = this.describe(project, relative);
    if (metadataOnly) return info;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > info.bytes ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > CHUNK_BYTES
    )
      fail("INVALID_RANGE", "Use a valid offset and length of 1..1048576.");
    const bytes = Buffer.alloc(Math.min(length, info.bytes - offset)),
      fd = fs.openSync(info.absolutePath, "r");
    try {
      fs.readSync(fd, bytes, 0, bytes.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    return {
      ...info,
      offset,
      length: bytes.length,
      chunkSha256: sha256(bytes),
      dataBase64: bytes.toString("base64"),
      nextOffset: offset + bytes.length,
      eof: offset + bytes.length === info.bytes,
    };
  }
  async close() {
    const entries = [...this.running.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map((entry) => entry.done));
  }
}

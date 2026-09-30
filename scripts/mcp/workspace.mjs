import fs from "node:fs";
import { referenceCatalog } from "../authoring-reference.mjs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { threadId } from "node:worker_threads";
import { validProjectId, readProject } from "../project-metadata.mjs";
import { inspectProject } from "../film.mjs";
import { checkProjects } from "../check-projects.mjs";

export const MAX_FILE = 1024 * 1024;
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".md",
  ".txt",
  ".svg",
  ".css",
  ".glsl",
  ".wgsl",
  ".vert",
  ".frag",
  ".csv",
  ".srt",
  ".vtt",
]);
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export class FrameError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export const fail = (code, message, details) => {
  throw new FrameError(code, message, details);
};

/** Every existing component is checked, including dangling symlinks and junctions. */
export function safePath(base, relative, { internal = false } = {}) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.length > 512 ||
    /[\\:%?#\u0000-\u001f]/.test(relative)
  )
    fail("INVALID_PATH", "Use a plain forward-slash relative path.");
  const parts = relative.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        reserved.test(part) ||
        (!internal && (part.startsWith(".") || part === "node_modules")),
    )
  )
    fail(
      "INVALID_PATH",
      "Hidden, reserved and traversal paths are not allowed.",
    );
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink > 1))
      fail("UNSAFE_LINK", "Links are not allowed: " + relative);
    if (stat && !stat.isFile() && !stat.isDirectory())
      fail("UNSAFE_FILE", "Only regular files and directories are allowed.");
  }
  return current;
}

export class Workspace {
  constructor(
    root,
    { projects = [], readOnly = false, sessionId = randomUUID(), ioWorkerId = null } = {},
  ) {
    this.root = fs.realpathSync(root);
    this.projects = new Set(projects);
    this.readOnly = readOnly;
    this.sessionId = sessionId;
    this.ioWorkerId = ioWorkerId;
    for (const id of projects)
      if (!validProjectId(id))
        fail("INVALID_PROJECT", "Invalid project id: " + id);
  }
  project(id, { exists = true } = {}) {
    if (!validProjectId(id)) fail("INVALID_PROJECT", "Invalid project id.");
    if (this.projects.size && !this.projects.has(id))
      fail("PROJECT_DENIED", "Project is outside this server's allowlist.");
    const folder = safePath(this.root, "projects/" + id);
    if (exists && !fs.existsSync(safePath(folder, "project.ts")))
      fail("UNKNOWN_PROJECT", "Unknown project: " + id);
    return folder;
  }
  writable() {
    if (this.readOnly)
      fail("READ_ONLY", "This server was started with --read-only.");
  }
  file(id, relative, internal = false) {
    return safePath(this.project(id, { exists: false }), relative, {
      internal,
    });
  }
  listProjects() {
    const directory = safePath(this.root, "projects");
    const projects = [],
      errors = [];
    for (const item of (fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [])
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        !validProjectId(item.name) ||
        (this.projects.size && !this.projects.has(item.name))
      )
        continue;
      try {
        const folder = this.project(item.name);
        const { meta } = readProject(safePath(folder, "project.ts"));
        projects.push({
          id: item.name,
          title: meta.title,
          renderer: meta.renderer,
          duration: meta.duration,
          fps: meta.fps,
        });
      } catch (error) {
        errors.push({ id: item.name, error: error.message });
      }
    }
    return { projects, errors };
  }
  git(args) {
    const result = spawnSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: MAX_FILE,
    });
    return {
      passed: result.status === 0,
      output: result.stdout ?? "",
      error: result.error?.message ?? result.stderr?.trim() ?? "",
    };
  }
  context(id, { detail = false } = {}) {
    this.project(id);
    // Inspect's known text inputs must pass the stronger MCP path policy too.
    for (const file of [
      "project.ts",
      "AGENTS.md",
      "README.md",
      "production/brief.md",
      "public/assets.json",
    ]) {
      const target = this.file(id, file);
      if (fs.existsSync(target) && fs.statSync(target).size > MAX_FILE)
        fail("TOO_LARGE", "Context file exceeds 1 MiB: " + file);
    }
    return {
      ...inspectProject(this.root, id, { detail }),
      git: {
        head: this.git(["rev-parse", "HEAD"]),
        status: this.git(["status", "--short", "--untracked-files=normal"]),
      },
      references: referenceCatalog().map(ref => ref.uri),
      referenceCatalog: referenceCatalog(),
      workflow:
        "Read context and references; read files for SHA-256; batch related edits; check structure and scope; inspect preview images; test related behavior; render a short clip before full export.",
      readOnly: this.readOnly,
    };
  }
  listFiles(id, { directory = "", offset = 0, limit = 200 } = {}) {
    const folder = this.project(id);
    const start = directory ? this.file(id, directory) : folder;
    const files = [];
    const walk = (dir, depth = 0) => {
      if (depth > 32) fail("TOO_DEEP", "File tree exceeds 32 levels.");
      for (const item of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (
          item.name.startsWith(".") ||
          ["node_modules", "exports"].includes(item.name)
        )
          continue;
        if (files.length >= 10000)
          fail("TOO_MANY_FILES", "Select a narrower directory.");
        const relative = path
          .relative(folder, path.join(dir, item.name))
          .replaceAll(path.sep, "/");
        const full = this.file(id, relative);
        if (item.isDirectory()) walk(full, depth + 1);
        else if (item.isFile())
          files.push({
            path: relative,
            bytes: fs.statSync(full).size,
            editable: textExtensions.has(path.extname(relative).toLowerCase()),
          });
      }
    };
    walk(start);
    return {
      project: id,
      files: files.slice(offset, offset + limit),
      total: files.length,
      nextOffset: offset + limit < files.length ? offset + limit : null,
    };
  }
  textFile(id, relative, { missing = false } = {}) {
    if (
      relative.split("/")[0] === "exports" ||
      !textExtensions.has(path.extname(relative).toLowerCase())
    )
      fail(
        "TEXT_ONLY",
        "Use project text files; generated outputs are read through frame_read_artifact.",
      );
    const full = this.file(id, relative);
    if (missing && !fs.existsSync(full)) return null;
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE)
      fail("TOO_LARGE", "Expected a regular text file no larger than 1 MiB.");
    const bytes = fs.readFileSync(full);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      fail("NOT_UTF8", "File is not valid UTF-8.");
    }
    if (text.includes("\0"))
      fail("NOT_TEXT", "Binary contents are not editable.");
    return { full, bytes, text, mode: stat.mode, sha256: sha256(bytes) };
  }
  readFile(id, relative, { startLine = 1, lineCount = 400 } = {}) {
    const file = this.textFile(id, relative);
    const lines = file.text.split("\n");
    const selected = lines
      .slice(startLine - 1, startLine - 1 + lineCount)
      .join("\n");
    if (Buffer.byteLength(selected) > 128 * 1024)
      fail("TOO_LARGE", "Read fewer lines (response limit is 128 KiB).");
    return {
      project: id,
      path: relative,
      sha256: file.sha256,
      bytes: file.bytes.length,
      startLine,
      totalLines: lines.length,
      content: selected,
      nextLine:
        startLine + lineCount <= lines.length ? startLine + lineCount : null,
    };
  }
  check(id) {
    this.project(id);
    this.assertTree(id);
    return checkProjects(this.root, { ids: [id], strict: true });
  }
  assertTree(id) {
    // Check paths that static validators or Vite might follow.
    const folder = this.project(id);
    const walk = (dir, depth = 0) => {
      if (depth > 32) fail("TOO_DEEP", "Project nesting is too deep.");
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        // Speech reads this project-owned credential file internally. It remains
        // inaccessible to file tools and excluded from fingerprints and context.
        if (item.name === ".env" && dir === folder) {
          this.file(id, ".env", true); // Reject symlinks/hardlinks, as for other files.
          if (!item.isFile()) fail("UNSAFE_FILE", "Project environment must be a regular file.");
          continue;
        }
        if (
          [".cache", ".history", "exports"].includes(item.name) &&
          dir === folder
        ) {
          this.file(id, item.name, true);
          continue;
        }
        const relative = path
          .relative(folder, path.join(dir, item.name))
          .replaceAll(path.sep, "/");
        const full = this.file(id, relative);
        if (item.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(folder);
  }
  fingerprint(id) {
    return sha256(
      this.listFiles(id, { limit: 10000 })
        .files.filter(
          (file) => file.editable && !file.path.startsWith("records/"),
        )
        .map(
          (file) =>
            file.path + ":" + sha256(fs.readFileSync(this.file(id, file.path))),
        )
        .join("\n"),
    );
  }
  operation(id) {
    const folder = this.project(id);
    const cache = safePath(folder, ".cache/mcp", { internal: true });
    const lock = safePath(folder, ".cache/mcp/operation.lock", {
      internal: true,
    });
    const transactions =
      fs.existsSync(cache) &&
      fs.readdirSync(cache).some((name) => name.startsWith("transaction-"));
    if (!fs.existsSync(lock))
      return {
        busy: false,
        status: transactions ? "recovery_required" : "idle",
        recoverable: false,
        transactions: !!transactions,
      };
    let record;
    try {
      const stat = fs.statSync(lock);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > 8192)
        throw new Error();
      record = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (!record || !Number.isInteger(record.pid) || record.pid <= 0)
        throw new Error();
    } catch {
      return {
        busy: true,
        status: "unknown",
        stale: null,
        recoverable: false,
        cancellable: false,
        message:
          "Lock is unreadable or invalid; preserve it for manual recovery.",
      };
    }
    const alive = (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === "ESRCH" ? false : null;
      }
    };
    const ownerAlive = alive(record.pid);
    const workerAlive = record.jobId ? alive(record.childPid) : false;
    const stale = ownerAlive === false && workerAlive === false;
    const identified =
      record.version === 2 && /^[\da-f-]{36}$/.test(record.lockId ?? "");
    let jobFinished = !record.jobId;
    if (record.jobId && /^[\da-f-]{36}$/.test(record.jobId)) {
      try {
        const report = this.file(id, `exports/mcp/${record.jobId}/job.json`);
        if (fs.statSync(report).size <= MAX_FILE) {
          const state = JSON.parse(fs.readFileSync(report, "utf8"));
          jobFinished =
            state.id === record.jobId &&
            state.project === id &&
            ["succeeded", "failed", "cancelled", "timed_out"].includes(
              state.status,
            );
        }
      } catch {}
    }
    return {
      busy: true,
      status: stale ? "stale" : ownerAlive === true ? "running" : "unobserved",
      lockId: record.lockId ?? null,
      jobId: record.jobId ?? null,
      kind: record.purpose,
      startedAt: record.startedAt,
      ownerSession: record.ownerSession ?? null,
      sameSession: record.ownerSession === this.sessionId,
      ownerAlive,
      workerAlive,
      stale,
      transactions: !!transactions,
      jobFinished,
      cancellable: false,
      recoverable: identified && stale && !transactions && jobFinished,
      nextAction:
        stale && identified && !transactions && jobFinished
          ? "Recover this exact lockId with frame_recover_operation or film operation --recover."
          : "Query the job or wait. Never delete a live, unknown, legacy or unfinished-transaction lock. An unfinished crashed job needs process-tree inspection before recovery.",
    };
  }
  recoverOperation(id, expectedLockId) {
    this.writable();
    const operation = this.operation(id);
    if (!operation.busy) return { recovered: false, ...operation };
    if (
      !operation.recoverable ||
      !expectedLockId ||
      operation.lockId !== expectedLockId
    )
      fail(
        "RECOVERY_REFUSED",
        "Only the exact identified lock with both owner and worker confirmed exited can be recovered, without unfinished transactions.",
        { activeOperation: operation },
      );
    const lock = this.file(id, ".cache/mcp/operation.lock", true);
    const current = this.operation(id);
    if (!current.recoverable || current.lockId !== expectedLockId)
      fail(
        "VERSION_CONFLICT",
        "Operation changed during recovery; inspect it again.",
      );
    fs.unlinkSync(lock);
    return { recovered: true, lockId: expectedLockId, status: "idle" };
  }
  lock(id, purpose, { jobId = null } = {}) {
    this.writable();
    const folder = this.project(id);
    const cache = safePath(folder, ".cache/mcp", { internal: true });
    fs.mkdirSync(cache, { recursive: true });
    const lock = safePath(folder, ".cache/mcp/operation.lock", {
      internal: true,
    });
    let fd;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (error) {
      if (error.code === "EEXIST")
        fail(
          "PROJECT_BUSY",
          "Project is busy. Query its active operation; serialize writes and rendering for this project.",
          { activeOperation: this.operation(id), retryable: true },
        );
      throw error;
    }
    const record = {
      version: 2,
      lockId: randomUUID(),
      ownerSession: this.sessionId,
      pid: process.pid,
      ...(this.ioWorkerId ? { ownerWorkerId: this.ioWorkerId, ownerThreadId: threadId } : {}),
      purpose,
      jobId,
      childPid: null,
      startedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
    } finally {
      fs.closeSync(fd);
    }
    if (fs.readdirSync(cache).some((name) => name.startsWith("transaction-"))) {
      fs.unlinkSync(lock);
      fail(
        "RECOVERY_REQUIRED",
        "An unfinished transaction remains in " +
          cache +
          ". Inspect its manifest and backups before editing.",
      );
    }
    let released = false;
    const release = () => {
      if (!released) {
        if (fs.existsSync(lock)) {
          const current = JSON.parse(fs.readFileSync(lock, "utf8"));
          if (current.lockId !== record.lockId)
            fail(
              "LOCK_CHANGED",
              "Operation lock ownership changed; preserving it.",
            );
          fs.unlinkSync(lock);
        }
        released = true;
      }
    };
    release.update = (values) => {
      const current = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (current.lockId !== record.lockId)
        fail("LOCK_CHANGED", "Operation lock ownership changed.");
      Object.assign(record, values);
      fs.writeFileSync(lock, JSON.stringify(record));
    };
    return release;
  }
  edit(id, changes, { dryRun = false, restoring = false } = {}) {
    this.writable();
    this.project(id);
    const seen = new Set();
    let total = 0;
    const entries = changes.map((change) => {
      const key = change.path.toLowerCase();
      if (
        seen.has(key) ||
        changes.some(
          (other) =>
            other !== change && other.path.toLowerCase().startsWith(key + "/"),
        )
      )
        fail("DUPLICATE_PATH", "Duplicate or overlapping edit paths.");
      seen.add(key);
      const before = this.textFile(id, change.path, { missing: true });
      if ((before?.sha256 ?? null) !== change.expectedSha256)
        fail(
          "VERSION_CONFLICT",
          "File changed; read it again: " + change.path,
          { path: change.path, currentSha256: before?.sha256 ?? null },
        );
      if (change.content === null && !before)
        fail("MISSING_FILE", "Cannot delete a missing file.");
      const after =
        change.content === null ? null : Buffer.from(change.content, "utf8");
      if (after?.includes(0))
        fail("NOT_TEXT", "NUL characters are not allowed.");
      if (after && after.length > MAX_FILE)
        fail("TOO_LARGE", "Each file must be at most 1 MiB.");
      total += after?.length ?? 0;
      return {
        path: change.path,
        before,
        after,
        newHash: after === null ? null : sha256(after),
      };
    });
    if (
      !entries.length ||
      entries.length > (restoring ? 400 : 20) ||
      total > (restoring ? 32 : 2) * MAX_FILE
    )
      fail("TOO_LARGE", "Use 1..20 changes, at most 2 MiB total.");
    const summary = entries.map((entry) => ({
      path: entry.path,
      operation:
        entry.after === null ? "delete" : entry.before ? "replace" : "create",
      beforeSha256: entry.before?.sha256 ?? null,
      afterSha256: entry.newHash,
    }));
    if (dryRun)
      return {
        applied: false,
        dryRun: true,
        changes: summary,
        validation: "Not run; dryRun writes no files.",
      };
    const release = this.lock(id, "edit");
    const transaction = randomUUID();
    const journal = this.file(
      id,
      ".cache/mcp/transaction-" + transaction,
      true,
    );
    const applied = [],
      madeDirectories = [];
    let recoveryNeeded = false;
    const ensureParent = (full) => {
      const missing = [];
      for (
        let dir = path.dirname(full);
        !fs.existsSync(dir);
        dir = path.dirname(dir)
      )
        missing.push(dir);
      for (const dir of missing.reverse()) {
        fs.mkdirSync(dir);
        madeDirectories.push(dir);
      }
    };
    try {
      fs.mkdirSync(journal);
      fs.writeFileSync(
        path.join(journal, "manifest.json"),
        JSON.stringify({ project: id, changes: summary }, null, 2),
      );
      for (const [index, entry] of entries.entries()) {
        if (entry.before) {
          fs.writeFileSync(
            path.join(journal, index + ".before"),
            entry.before.bytes,
          );
          fs.chmodSync(
            path.join(journal, index + ".before"),
            entry.before.mode,
          );
        }
        if (entry.after !== null) {
          fs.writeFileSync(path.join(journal, index + ".after"), entry.after);
          if (entry.before)
            fs.chmodSync(
              path.join(journal, index + ".after"),
              entry.before.mode,
            );
        }
      }
      // Compare again after acquiring the cross-process lock and staging backups.
      for (const entry of entries) {
        const current = this.textFile(id, entry.path, { missing: true });
        if ((current?.sha256 ?? null) !== (entry.before?.sha256 ?? null))
          fail("VERSION_CONFLICT", "File changed while staging: " + entry.path);
      }
      for (const [index, entry] of entries.entries()) {
        const full = this.file(id, entry.path);
        ensureParent(full);
        if (entry.after === null) fs.unlinkSync(full);
        else fs.renameSync(path.join(journal, index + ".after"), full);
        applied.push({ entry, index });
      }
      const validation = this.check(id);
      if (!validation.passed)
        fail(
          "VALIDATION_FAILED",
          "Strict project checks failed. Changes were rolled back.",
          { validation },
        );
      const auditPath = "records/mcp/" + transaction + ".json";
      const audit = this.file(id, auditPath);
      ensureParent(audit);
      fs.writeFileSync(
        audit,
        JSON.stringify(
          {
            schemaVersion: 1,
            transaction,
            time: new Date().toISOString(),
            changes: summary,
            validation: {
              passed: true,
              errors: validation.errors,
              warnings: validation.warnings,
            },
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
      return { applied: true, changes: summary, validation, auditPath };
    } catch (error) {
      for (const { entry, index } of applied.reverse()) {
        try {
          const current = this.textFile(id, entry.path, { missing: true });
          if ((current?.sha256 ?? null) !== entry.newHash)
            throw new Error("External edit during rollback");
          const full = this.file(id, entry.path);
          if (entry.before)
            fs.renameSync(path.join(journal, index + ".before"), full);
          else fs.unlinkSync(full);
        } catch {
          recoveryNeeded = true;
        }
      }
      for (const dir of madeDirectories.reverse()) {
        try {
          fs.rmdirSync(dir);
        } catch {}
      }
      if (recoveryNeeded)
        fail(
          "RECOVERY_REQUIRED",
          "External changes prevented full rollback. Lock and backup preserved: " +
            journal,
          { originalError: error.message },
        );
      throw error;
    } finally {
      if (!recoveryNeeded) {
        try {
          fs.rmSync(journal, { recursive: true, force: true });
        } catch (error) {
          fail(
            "RECOVERY_REQUIRED",
            "Transaction cleanup failed; lock retained for inspection: " +
              journal,
            { originalError: error.message },
          );
        }
        release();
      }
    }
  }
}

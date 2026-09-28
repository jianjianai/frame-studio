import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  constructor(root, { projects = [], readOnly = false } = {}) {
    this.root = fs.realpathSync(root);
    this.projects = new Set(projects);
    this.readOnly = readOnly;
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
    for (const item of fs
      .readdirSync(directory, { withFileTypes: true })
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
  context(id) {
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
      ...inspectProject(this.root, id),
      git: {
        head: this.git(["rev-parse", "HEAD"]),
        status: this.git(["status", "--short", "--untracked-files=normal"]),
      },
      references: [
        "rules",
        "standard",
        "authoring",
        "workflow",
        "audio",
        "scene-types",
      ].map((name) => "frame://reference/" + name),
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
  lock(id, purpose) {
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
          "Project has an active operation or a crash lock. Inspect " +
            lock +
            " before recovery.",
        );
      throw error;
    }
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          purpose,
          startedAt: new Date().toISOString(),
        }),
      );
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
    return () => {
      if (!released) {
        fs.unlinkSync(lock);
        released = true;
      }
    };
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

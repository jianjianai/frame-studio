import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { confinedAsync } from "./project-files.mjs";
import { hash, problem } from "./security.mjs";

const MAX_FILE = 1024 * 1024;
const extensions = new Set([
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
const ignored = new Set(["exports", "node_modules"]);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(512);
const fileError = (status, code, message, recovery = "correct-input") =>
  Object.assign(problem(status, message), { code, recovery });

export function authoringPath(relativePath) {
  if (
    relativePath
      .split("/")
      .some((part) => part.startsWith(".") || ignored.has(part))
  )
    throw fileError(
      400,
      "INVALID_PATH",
      "Use a project-relative source path, not hidden files, exports or dependencies.",
    );
  return relativePath;
}
const editable = (file) => extensions.has(path.extname(file).toLowerCase());
async function sourcePath(dir, relativePath) {
  authoringPath(relativePath);
  if (!editable(relativePath))
    throw fileError(
      400,
      "TEXT_ONLY",
      "Use a supported UTF-8 source file. Import binary media through upload tools.",
    );
  return confinedAsync(dir, relativePath);
}

/** Hash the original bytes, never a lossy UTF-8 decoding. Reads are bounded even if a file grows. */
export async function readSource(dir, relativePath, { missing = false } = {}) {
  let handle;
  try {
    const file = await sourcePath(dir, relativePath);
    handle = await fsp.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw fileError(
        400,
        "NOT_REGULAR_FILE",
        "Expected a regular, unlinked source file.",
      );
    if (before.size > MAX_FILE)
      throw fileError(
        413,
        "FILE_TOO_LARGE",
        "Source files must not exceed 1 MiB.",
      );
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await fsp.lstat(file);
    if (
      length !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs ||
      current.ctimeMs !== after.ctimeMs
    )
      throw fileError(
        409,
        "FILE_CHANGED",
        "File changed while reading; read the current version again.",
        "read-current-file",
      );
    const bytes = buffer.subarray(0, length);
    let content;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw fileError(
        400,
        "NOT_UTF8",
        "The file is not valid UTF-8; use the asset tools for binary media.",
      );
    }
    if (content.includes("\0"))
      throw fileError(
        400,
        "NOT_TEXT",
        "Binary contents cannot be edited as text.",
      );
    return {
      file,
      content,
      bytes: length,
      mode: before.mode,
      sha256: hash(bytes),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      if (missing) return null;
      throw fileError(
        404,
        "FILE_NOT_FOUND",
        "Project file not found: " + relativePath,
        "list-project-files",
      );
    }
    if (error.code === "EISDIR" || error.code === "ENOTDIR")
      throw fileError(
        400,
        "NOT_REGULAR_FILE",
        "Expected a project file, not a directory.",
      );
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function listSource(dir, directory = "") {
  const start = directory
    ? await confinedAsync(dir, authoringPath(directory))
    : dir;
  const files = [];
  let visited = 0;
  const walk = async (folder, prefix, depth) => {
    if (depth > 32)
      throw fileError(
        400,
        "TREE_TOO_DEEP",
        "Select a narrower directory (maximum depth: 32).",
      );
    let names;
    try {
      names = (await fsp.readdir(folder)).sort();
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code))
        throw fileError(
          404,
          "DIRECTORY_NOT_FOUND",
          "Project directory not found: " + directory,
          "list-project-files",
        );
      throw error;
    }
    for (const name of names) {
      if (name.startsWith(".") || ignored.has(name)) continue;
      if (++visited > 20000 || files.length >= 10000)
        throw fileError(
          400,
          "TREE_TOO_LARGE",
          "Select a narrower directory (maximum: 10,000 files).",
        );
      const rel = prefix ? prefix + "/" + name : name;
      const full = await confinedAsync(dir, rel),
        stat = await fsp.lstat(full);
      if (stat.isDirectory()) await walk(full, rel, depth + 1);
      else
        files.push({
          path: rel,
          bytes: stat.size,
          editable: editable(rel) && stat.size <= MAX_FILE,
        });
    }
  };
  await walk(start, directory, 0);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sliceSource(source, { startLine, lineCount }) {
  const lines = source.content.split("\n");
  if (startLine > lines.length)
    throw fileError(
      400,
      "LINE_OUT_OF_RANGE",
      `startLine exceeds totalLines (${lines.length}).`,
    );
  const endLine = Math.min(
    lines.length,
    startLine + (lineCount ?? lines.length) - 1,
  );
  const content = lines.slice(startLine - 1, endLine).join("\n");
  if (lineCount !== undefined && Buffer.byteLength(content) > 128 * 1024)
    throw fileError(
      413,
      "READ_TOO_LARGE",
      "Read fewer lines (maximum response: 128 KiB). Use a local checkout for a single oversized line.",
    );
  return {
    content,
    sha256: source.sha256,
    bytes: source.bytes,
    startLine,
    endLine,
    totalLines: lines.length,
    complete: startLine === 1 && endLine === lines.length,
    nextLine: endLine < lines.length ? endLine + 1 : null,
  };
}
const assertContent = (content) => {
  if (content.includes("\0"))
    throw fileError(
      400,
      "NOT_TEXT",
      "NUL characters are not allowed in source files.",
    );
  if (Buffer.byteLength(content) > MAX_FILE)
    throw fileError(
      413,
      "FILE_TOO_LARGE",
      "Source files must not exceed 1 MiB of UTF-8 bytes.",
    );
};

/** One file is replaced atomically. Recheck the hash after every awaited invalidation. */
async function saveSource(dir, args, before, repos) {
  assertContent(args.content);
  await repos.revisions?.invalidate(args.repo, args.project);
  const current = await readSource(dir, args.path, { missing: true });
  if ((current?.sha256 ?? null) !== args.expectedSha256)
    throw fileError(
      409,
      "FILE_CHANGED",
      "File changed; read the current version first.",
      "read-current-file",
    );
  const file = await sourcePath(dir, args.path);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + ".frame-" + randomUUID();
  try {
    await fsp.writeFile(temporary, args.content, {
      flag: "wx",
      mode: before?.mode ?? 0o644,
    });
    // Do not clobber an external edit that landed while staging the replacement.
    const latest = await readSource(dir, args.path, { missing: true });
    if ((latest?.sha256 ?? null) !== args.expectedSha256)
      throw fileError(
        409,
        "FILE_CHANGED",
        "File changed while staging; read the current version first.",
        "read-current-file",
      );
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  await repos.revisions?.invalidate(args.repo, args.project);
  return {
    path: args.path,
    sha256: hash(args.content),
    bytes: Buffer.byteLength(args.content),
  };
}

export function projectTextOperations({ add, db, repos, uuid, project }) {
  const target = { repo: uuid, project };
  add(
    "project_files",
    "List source files. Use works_files_page for a bounded directory page.",
    target,
    async (a) => listSource((await repos.project(a.repo, a.project)).dir),
  );
  add(
    "project_files_page",
    "Page source files, with editability and nextOffset; paths are relative to this work.",
    {
      ...target,
      directory: z.string().max(512).default(""),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(60),
    },
    async (a) => {
      const files = await listSource(
        (await repos.project(a.repo, a.project)).dir,
        a.directory,
      );
      return {
        files: files.slice(a.offset, a.offset + a.limit),
        total: files.length,
        nextOffset:
          a.offset + a.limit < files.length ? a.offset + a.limit : null,
      };
    },
  );
  add(
    "project_read",
    "Read UTF-8 source (complete by default for compatibility). Set startLine/lineCount for bounded slices; SHA-256 always covers the WHOLE file. Never write a partial slice as a replacement; use works_patch.",
    {
      ...target,
      path: relative,
      startLine: z.number().int().positive().default(1),
      lineCount: z.number().int().min(1).max(4000).optional(),
    },
    async (a) => ({
      path: a.path,
      ...sliceSource(
        await readSource((await repos.project(a.repo, a.project)).dir, a.path),
        a,
      ),
    }),
  );
  add(
    "project_write",
    "Create or replace a complete UTF-8 source file; expectedSha256:null asserts it is new. Never write a read slice as the whole file.",
    {
      ...target,
      path: relative,
      expectedSha256: sha.nullable(),
      content: z.string().max(MAX_FILE),
    },
    (a) =>
      db.lock(`${a.repo}:${a.project}`, async () => {
        await repos.writable(a.repo, a.project);
        const { dir } = await repos.project(a.repo, a.project);
        const before = await readSource(dir, a.path, { missing: true });
        if ((before?.sha256 ?? null) !== a.expectedSha256)
          throw fileError(
            409,
            "FILE_CHANGED",
            "File changed; read the current version first.",
            "read-current-file",
          );
        return saveSource(dir, a, before, repos);
      }),
  );
  add(
    "project_delete_file",
    "Delete one UTF-8 source file only after checking its whole-file hash. project.ts is protected. Use dryRun first; checkpoint before deleting important files.",
    {
      ...target,
      path: relative,
      expectedSha256: sha,
      dryRun: z.boolean().default(false),
    },
    (a) =>
      db.lock(`${a.repo}:${a.project}`, async () => {
        await repos.writable(a.repo, a.project);
        if (a.path === "project.ts" || a.path === "production/work.json")
          throw fileError(
            400,
            "PROTECTED_FILE",
            "Work identity files cannot be deleted; edit them or restore a checkpoint.",
          );
        const { dir } = await repos.project(a.repo, a.project),
          before = await readSource(dir, a.path);
        if (before.sha256 !== a.expectedSha256)
          throw fileError(
            409,
            "FILE_CHANGED",
            "File changed; read it again before deleting.",
            "read-current-file",
          );
        if (!a.dryRun) {
          await repos.revisions?.invalidate(a.repo, a.project);
          const current = await readSource(dir, a.path);
          if (current.sha256 !== a.expectedSha256)
            throw fileError(
              409,
              "FILE_CHANGED",
              "File changed before deletion; nothing was deleted.",
              "read-current-file",
            );
          await fsp.unlink(await sourcePath(dir, a.path));
          await repos.revisions?.invalidate(a.repo, a.project);
        }
        return {
          path: a.path,
          beforeSha256: before.sha256,
          sha256: a.dryRun ? before.sha256 : null,
          deleted: !a.dryRun,
          dryRun: a.dryRun,
        };
      }),
  );
  add(
    "project_patch",
    "Apply ordered exact-text replacements atomically within one file. Checks hash and occurrence counts; dryRun never writes.",
    {
      ...target,
      path: relative,
      expectedSha256: sha,
      edits: z
        .array(
          z.strictObject({
            oldText: z.string().min(1).max(MAX_FILE),
            newText: z.string().max(MAX_FILE),
            expectedMatches: z.number().int().min(1).max(10000).default(1),
          }),
        )
        .min(1)
        .max(32),
      dryRun: z.boolean().default(false),
    },
    (a) =>
      db.lock(`${a.repo}:${a.project}`, async () => {
        await repos.writable(a.repo, a.project);
        const { dir } = await repos.project(a.repo, a.project),
          before = await readSource(dir, a.path);
        if (before.sha256 !== a.expectedSha256)
          throw fileError(
            409,
            "FILE_CHANGED",
            "File changed; read the current version first.",
            "read-current-file",
          );
        let content = before.content;
        for (const [index, edit] of a.edits.entries()) {
          const parts = content.split(edit.oldText),
            matches = parts.length - 1;
          if (matches !== edit.expectedMatches)
            throw fileError(
              409,
              "PATCH_MATCH_CONFLICT",
              `Edit ${index + 1}: expected ${edit.expectedMatches} exact matches, found ${matches}; nothing was written.`,
              "read-current-file",
            );
          const expectedBytes =
            Buffer.byteLength(content) +
            matches *
              (Buffer.byteLength(edit.newText) -
                Buffer.byteLength(edit.oldText));
          if (expectedBytes > MAX_FILE)
            throw fileError(
              413,
              "FILE_TOO_LARGE",
              "Patched source would exceed 1 MiB.",
            );
          content = parts.join(edit.newText);
          assertContent(content);
        }
        const result = {
          path: a.path,
          beforeSha256: before.sha256,
          sha256: hash(content),
          bytes: Buffer.byteLength(content),
          applied: !a.dryRun,
          dryRun: a.dryRun,
          replacements: a.edits.reduce(
            (n, edit) => n + edit.expectedMatches,
            0,
          ),
        };
        if (!a.dryRun) await saveSource(dir, { ...a, content }, before, repos);
        return result;
      }),
  );
  add(
    "project_search",
    "Search literal text in source files. Bounded pages return line numbers, file hashes and a resumable nextCursor; binary files are skipped.",
    {
      ...target,
      query: z
        .string()
        .min(1)
        .max(200)
        .refine((s) => !/[\r\n]/.test(s), "Search one line at a time"),
      directory: z.string().max(512).default(""),
      caseSensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z
        .strictObject({ path: relative, line: z.number().int().positive() })
        .optional(),
    },
    async (a) => {
      const { dir } = await repos.project(a.repo, a.project),
        files = await listSource(dir, a.directory);
      const matches = [],
        skipped = [];
      let scannedFiles = 0,
        scannedBytes = 0,
        nextCursor = null;
      const query = a.caseSensitive ? a.query : a.query.toLowerCase();
      for (const file of files) {
        if (a.cursor && file.path < a.cursor.path) continue;
        if (!file.editable) continue;
        if (scannedFiles >= 500 || scannedBytes + file.bytes > 4 * MAX_FILE) {
          nextCursor = { path: file.path, line: 1 };
          break;
        }
        scannedFiles++;
        scannedBytes += file.bytes;
        let source;
        try {
          source = await readSource(dir, file.path);
        } catch (error) {
          if (
            [
              "NOT_UTF8",
              "NOT_TEXT",
              "FILE_NOT_FOUND",
              "FILE_TOO_LARGE",
            ].includes(error.code)
          ) {
            if (skipped.length < 20)
              skipped.push({ path: file.path, reason: error.code });
            continue;
          }
          throw error;
        }
        const lines = source.content.split("\n");
        for (
          let i = a.cursor?.path === file.path ? a.cursor.line - 1 : 0;
          i < lines.length;
          i++
        ) {
          if (
            !(a.caseSensitive ? lines[i] : lines[i].toLowerCase()).includes(
              query,
            )
          )
            continue;
          if (matches.length === a.limit) {
            nextCursor = { path: file.path, line: i + 1 };
            break;
          }
          const position = (
            a.caseSensitive ? lines[i] : lines[i].toLowerCase()
          ).indexOf(query);
          const begin = Math.max(0, position - 200);
          matches.push({
            path: file.path,
            line: i + 1,
            sha256: source.sha256,
            text: lines[i].slice(begin, begin + 1000),
            truncated: begin > 0 || lines[i].length > 1000,
          });
        }
        if (nextCursor) break;
      }
      return {
        matches,
        nextCursor,
        hasMore: nextCursor !== null,
        scannedFiles,
        scannedBytes,
        skipped,
      };
    },
  );
}

import fs from "node:fs";
import { z } from "zod";
import { writeText, removePath, movePath, TEXT_LIMIT } from "../files.mjs";
import { problem, confined, sha256 } from "../util.mjs";

/**
 * Several file changes in one tool call (work files, experience documents): planned
 * against the files as each operation leaves them, then written. By default everything
 * that can be done is done and every failure is explained per item, so the AI retries only
 * those; `atomic` writes nothing unless all succeed.
 */

export const editList = z
  .array(z.strictObject({ oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false) }))
  .min(1)
  .max(50);

/** Explain why an exact replacement missed: usually indentation or a stale copy of the file. */
export function nearMiss(content, oldText, reader) {
  const squash = (text) => text.replace(/\s+/g, " ").trim();
  if (squash(content).includes(squash(oldText))) return "忽略空白后能找到：请按文件中的缩进和换行逐字复制。";
  const first = oldText
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const lines = content.split("\n");
  const at = first ? lines.findIndex((line) => line.includes(first)) : -1;
  if (at >= 0) return `第一行出现在第 ${at + 1} 行，但后面的内容不同；先用 ${reader} 读取最新内容。`;
  return `文件可能已经改变，先用 ${reader} 读取最新内容。`;
}

/** Exact replacements in order; each oldText must occur once unless replaceAll. */
export function applyEdits(content, edits, reader) {
  for (const [index, edit] of edits.entries()) {
    const count = content.split(edit.oldText).length - 1;
    if (count === 0) throw problem(400, `第 ${index + 1} 处替换找不到 oldText。${nearMiss(content, edit.oldText, reader)}`);
    if (count > 1 && !edit.replaceAll) throw problem(400, `第 ${index + 1} 处替换：oldText 出现了 ${count} 次，请提供更多上下文或设置 replaceAll`);
    content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, () => edit.newText);
  }
  return content;
}

const READ_BUDGET = 1024 * 1024; // text of reads returned in one call

/**
 * Run `operations` ({op: read|write|edit|delete|move, …}) under `root`. `allow(item, paths)`
 * throws for an operation the caller does not permit; `reader` names the tool to re-read
 * with. Returns per-item results and whether the changes were written.
 */
export function runFileOperations(root, operations, { atomic = false, allow = () => {}, reader }) {
  const files = new Map(); // path → { content: string | null (absent), hash, folder }
  const look = (file) => {
    if (!files.has(file)) {
      const full = confined(root, file);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (stat?.isDirectory()) files.set(file, { content: null, hash: null, folder: true });
      else if (stat?.isFile()) {
        if (stat.size > TEXT_LIMIT) throw problem(413, `${file} 超过 ${TEXT_LIMIT / 1048576} MiB，不能作为文本处理`);
        const content = fs.readFileSync(full, "utf8");
        files.set(file, { content, hash: sha256(content) });
      } else files.set(file, { content: null, hash: null });
    }
    return files.get(file);
  };
  const exists = (entry) => entry.content !== null || entry.folder;
  const failed = new Set();
  const results = [];
  const steps = []; // { index, apply }
  let readBytes = 0;
  for (const [index, item] of operations.entries()) {
    const paths = item.op === "move" ? [item.from, item.to] : [item.path];
    const blocked = paths.find((file) => failed.has(file));
    if (blocked) {
      results.push({ index, op: item.op, path: paths.join(" → "), status: "skipped", message: `跳过：${blocked} 前面的操作失败` });
      continue;
    }
    try {
      allow(item, paths);
      if (item.op === "read") {
        const entry = look(item.path);
        if (entry.content === null) throw problem(404, entry.folder ? `${item.path} 是文件夹` : `文件不存在：${item.path}`, "NOT_FOUND");
        const lines = entry.content.split("\n");
        const from = Math.min((item.startLine || 1) - 1, lines.length);
        const shown = item.startLine || item.lineCount ? lines.slice(from, from + (item.lineCount || lines.length)).join("\n") : entry.content;
        readBytes += Buffer.byteLength(shown);
        const cut = readBytes > READ_BUDGET;
        results.push({
          index,
          op: "read",
          path: item.path,
          status: "ok",
          sha256: entry.hash,
          lines: lines.length,
          content: cut ? null : shown,
          ...(cut ? { message: "这次读取的内容太多，这个文件没有返回，单独再读" } : {}),
        });
      } else if (item.op === "write" || item.op === "edit") {
        const entry = look(item.path);
        if (entry.folder) throw problem(400, `${item.path} 是文件夹`);
        let content;
        if (item.op === "write") {
          if (item.expectedSha256 !== undefined && (entry.hash ?? "") !== item.expectedSha256)
            throw problem(409, `${item.path} 已被其他人修改，最新 sha256 是 ${entry.hash ?? "（文件不存在）"}`, "CONFLICT", { currentHash: entry.hash });
          content = item.content;
        } else {
          if (entry.content === null) throw problem(404, `文件不存在：${item.path}`, "NOT_FOUND");
          content = applyEdits(entry.content, item.edits, reader);
        }
        const before = entry.hash;
        const hash = sha256(content);
        files.set(item.path, { content, hash });
        results.push({ index, op: item.op, path: item.path, status: "ok", sha256: hash, ...(item.op === "edit" ? { edits: item.edits.length } : {}) });
        steps.push({ index, paths, apply: () => writeText(root, item.path, content, { expectedHash: before ?? null }) });
      } else if (item.op === "delete") {
        const entry = look(item.path);
        if (!exists(entry)) throw problem(404, `文件不存在：${item.path}`, "NOT_FOUND");
        files.set(item.path, { content: null, hash: null });
        results.push({ index, op: "delete", path: item.path, status: "ok" });
        steps.push({ index, paths, apply: () => removePath(root, item.path) });
      } else {
        const source = look(item.from);
        if (!exists(source)) throw problem(404, `文件不存在：${item.from}`, "NOT_FOUND");
        if (exists(look(item.to))) throw problem(409, `目标已存在：${item.to}`, "CONFLICT");
        files.set(item.to, source);
        files.set(item.from, { content: null, hash: null });
        results.push({ index, op: "move", path: `${item.from} → ${item.to}`, status: "ok" });
        steps.push({ index, paths, apply: () => movePath(root, item.from, item.to) });
      }
    } catch (error) {
      for (const file of paths) failed.add(file);
      results.push({
        index,
        op: item.op,
        path: paths.join(" → "),
        status: "failed",
        message: error.message,
        ...(error.details?.currentHash !== undefined ? { currentSha256: error.details.currentHash } : {}),
      });
    }
  }

  const applied = !(atomic && results.some((result) => result.status !== "ok"));
  const changed = [];
  if (applied)
    for (const step of steps)
      try {
        step.apply();
        changed.push(...step.paths);
      } catch (error) {
        // Changed on disk since it was read a moment ago.
        Object.assign(
          results.find((result) => result.index === step.index),
          { status: "failed", message: error.message },
        );
      }
  return { results, applied, changed, wrote: applied && steps.length > 0 };
}

/** The result as the AI reads it: a head line and one line per item; the files read separately. */
export function describeFileOperations({ results, applied }) {
  const icon = { ok: "✓", failed: "✗", skipped: "–" };
  const failedCount = results.filter((result) => result.status !== "ok").length;
  const head = !applied
    ? `atomic：${failedCount} 项不能完成，所有改动都没有写入：`
    : failedCount
      ? `完成 ${results.length - failedCount} 项，${failedCount} 项没有完成（只需重试这些）：`
      : `全部完成（${results.length} 项）：`;
  const lines = results.map(
    (result) =>
      `${icon[result.status]} ${result.index + 1}. ${result.op} ${result.path}${result.status === "ok" ? (result.op === "edit" ? `（${result.edits} 处）` : "") : `：${result.message}`}`,
  );
  const reads = results
    .filter((result) => result.op === "read" && result.status === "ok")
    .map(
      (result) =>
        `=== ${result.path}（sha256 ${result.sha256}，共 ${result.lines} 行）${result.content === null ? `\n${result.message}` : `\n${result.content}`}`,
    );
  return { summary: [head, ...lines].join("\n"), reads: reads.join("\n\n") };
}

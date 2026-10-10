import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { workArg } from "./registry.mjs";
import { problem } from "../util.mjs";
import { appRoot } from "../config.mjs";

const SCOPES = ["work", "used", "materials", "experience", "guide", "engine"];
const FILE_LIMIT = 8 * 1024 * 1024; // larger files are skipped (and counted)
const FILE_COUNT = 20000;
const SHOWN = 300; // characters of a line shown; longer lines are cut around the match
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", "exports", ".materials"]);
// Known binary formats are skipped without reading them; anything else is read and judged by content.
const BINARY = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|psd|ico|mp3|wav|m4a|aac|flac|ogg|oga|opus|weba|mp4|m4v|mov|webm|mkv|avi|ttf|otf|woff2?|glb|fbx|usdz|hdr|exr|ktx2|sf2|sf3|bin|zip|onnx|pdf|gz|7z)$/i;

/** Expand "{a,b}" alternatives: "*.{ts,tsx}" → ["*.ts", "*.tsx"]. */
function braces(glob) {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (!match) return [glob];
  return match[1].split(",").flatMap((part) => braces(glob.slice(0, match.index) + part + glob.slice(match.index + match[0].length)));
}

/**
 * Path patterns like "scenes/**" and "*.{ts,tsx}" (any of several); one without "/"
 * matches the file name anywhere.
 */
export function globTest(globs) {
  const list = [globs ?? []].flat().flatMap(braces);
  if (!list.length) return null;
  const tests = list.map((glob) => {
    const source = glob
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) => (part === "**/" || part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    const pattern = new RegExp(`^${source}$`, "i");
    return glob.includes("/") ? (file) => pattern.test(file) : (file) => pattern.test(file.split("/").pop());
  });
  return (file) => tests.some((test) => test(file));
}

/** Files under a folder (relative paths), without generated and dependency folders. */
async function walk(dir, out = [], prefix = "") {
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= FILE_COUNT) break;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walk(dir, out, relative);
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/** A line as shown: whole when short, else the part around the match. */
function shown(line, test) {
  if (line.length <= SHOWN) return line;
  const at = test ? Math.max(0, line.search(test)) : 0;
  const from = Math.max(0, at - 100);
  return `${from ? "…" : ""}${line.slice(from, from + SHOWN)}${from + SHOWN < line.length ? "…" : ""}`;
}

/**
 * Search text in the work and everything around it that an AI writes against: the
 * material libraries (as the work uses them, or as they are now), the experience
 * libraries, the production guide and the engine. One call, file:line with context.
 */
export function registerSearchTools(registry) {
  const { services } = registry;

  /** The files of each scope: label, and how to get the text (null: skip). */
  const sources = async (work, scopes, skipped) => {
    const out = [];
    const folder = async (scope, dir, label) => {
      for (const file of await walk(dir)) out.push({ scope, file, label: label(file), read: () => readText(path.join(dir, file), skipped) });
    };
    for (const scope of scopes) {
      if (scope === "work") await folder(scope, work.dir, (file) => file);
      if (scope === "materials" && services.materials) await folder(scope, await services.materials.dir(work.repo), (file) => `materials/${file}`);
      if (scope === "experience" && services.experience) await folder(scope, await services.experience.dir(work.repo), (file) => `经验库 ${file}`);
      if (scope === "guide") await folder(scope, path.join(appRoot, "docs", "guide"), (file) => `frame_guide ${file.replace(/\.md$/, "")}`);
      if (scope === "engine") await folder(scope, path.join(appRoot, "src", "engine"), (file) => `src/engine/${file}`);
      if (scope === "used" && services.materials) {
        // The library files the work uses, at the versions it locked (what actually runs).
        const locks = services.materials.readLocks(work.dir);
        const refs = new Set([...Object.keys(locks), ...(await services.materials.references(work))]);
        const dir = await services.materials.dir(work.repo);
        for (const ref of [...refs].sort())
          out.push({
            scope,
            file: ref,
            label: `materials/${ref}${locks[ref] ? "（本作品锁定的版本）" : "（未锁定，当前版本）"}`,
            read: async () => (BINARY.test(ref) ? null : locks[ref] ? services.materials.text(work.repo, locks[ref]).catch(() => null) : readText(path.join(dir, ref), skipped)),
          });
      }
    }
    return out;
  };
  async function readText(file, skipped) {
    if (BINARY.test(file)) return null;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    if (stat.size > FILE_LIMIT) {
      skipped.large++;
      return null;
    }
    const buffer = await fs.promises.readFile(file);
    // Binary content (a NUL byte early on), as grep decides.
    if (buffer.subarray(0, 8000).includes(0)) {
      skipped.binary++;
      return null;
    }
    return buffer.toString("utf8");
  }

  registry.add({
    name: "search",
    title: "搜索",
    description:
      "搜索文字或正则，返回 文件:行号 和上下文（长行只显示匹配附近）。scope：work 作品、used 作品用到的素材库文件（按锁定的版本，即实际运行的代码）、materials 素材库当前版本、experience 经验库、guide 制作指南、engine 引擎源码，可以组合。几个关键词一起搜用 patterns（任一匹配）；wholeWord 整词；multiline 跨行匹配（正则里用 \\n）；glob / exclude 选文件。找定义、调用处、用法、相关经验时用它，不用逐个读文件。",
    readOnly: true,
    input: {
      work: workArg,
      pattern: z.string().min(1).max(500).optional().describe("要找的文字；regex: true 时是正则表达式"),
      patterns: z.array(z.string().min(1).max(500)).max(10).optional().describe("几个一起搜，任一匹配"),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      wholeWord: z.boolean().default(false).describe("只匹配完整的词（前后不是字母、数字、下划线或汉字）"),
      multiline: z.boolean().default(false).describe("跨行匹配：在整个文件上匹配，正则里可以用 \\n"),
      scope: z.array(z.enum(SCOPES)).min(1).default(["work"]),
      glob: z.union([z.string().max(200), z.array(z.string().max(200)).max(10)]).optional().describe('只搜这些文件，例如 "*.{ts,tsx}"、"scenes/**"、["特效/**", "*.md"]'),
      exclude: z.union([z.string().max(200), z.array(z.string().max(200)).max(10)]).optional().describe('不搜这些文件，例如 "*.json"'),
      context: z.number().int().min(0).max(50).default(1).describe("每处匹配前后各显示几行"),
      before: z.number().int().min(0).max(200).optional().describe("匹配前显示几行（覆盖 context）"),
      after: z.number().int().min(0).max(200).optional().describe("匹配后显示几行（覆盖 context；看整个函数可以给 60）"),
      limit: z.number().int().min(1).max(1000).default(100).describe("最多返回几处"),
      maxPerFile: z.number().int().min(1).max(1000).optional().describe("每个文件最多返回几处"),
      filesOnly: z.boolean().default(false).describe("只列出包含匹配的文件和处数"),
    },
    async run(args, ctx) {
      const { pattern, patterns, regex, caseSensitive, wholeWord, multiline, scope, glob, exclude, context, limit, maxPerFile, filesOnly } = args;
      const before = args.before ?? context;
      const after = args.after ?? context;
      const wanted = [...(pattern ? [pattern] : []), ...(patterns ?? [])];
      if (!wanted.length) throw problem(400, "需要 pattern 或 patterns");
      let test;
      try {
        let source = wanted.map((item) => (regex ? `(?:${item})` : item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("|");
        // Word characters include CJK, so a word boundary works for Chinese text too.
        if (wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
        test = new RegExp(source, `${caseSensitive ? "" : "i"}${wholeWord ? "u" : ""}${multiline ? "gm" : ""}`);
      } catch (error) {
        throw problem(400, `正则表达式无效：${error.message}`);
      }
      const include = globTest(glob);
      const leave = globTest(exclude);
      const work = await ctx.work();
      const skipped = { large: 0, binary: 0 };
      const files = [];
      let total = 0;
      let returned = 0;
      let truncated = false;
      for (const source of await sources(work, [...new Set(scope)], skipped)) {
        if ((include && !include(source.file)) || (leave && leave(source.file))) continue;
        // Files FRAME manages itself only add noise.
        if (/(^|\/)(materials\.lock\.json|\.aliases\.json|\.manifest\.json)$/.test(source.file)) continue;
        const text = await source.read();
        if (text === null) continue;
        const lines = text.split("\n");
        // Matches as line ranges [first, last] (equal unless multiline).
        const hits = [];
        if (multiline) {
          const starts = [0];
          for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
          const lineOf = (offset) => {
            let low = 0,
              high = starts.length - 1;
            while (low < high) {
              const middle = (low + high + 1) >> 1;
              if (starts[middle] <= offset) low = middle;
              else high = middle - 1;
            }
            return low;
          };
          test.lastIndex = 0;
          for (let match = test.exec(text); match; match = test.exec(text)) {
            if (!match[0].length) test.lastIndex++;
            hits.push([lineOf(match.index), lineOf(match.index + Math.max(0, match[0].length - 1))]);
            if (hits.length > 10000) break;
          }
        } else for (let index = 0; index < lines.length; index++) if (test.test(lines[index])) hits.push([index, index]);
        if (!hits.length) continue;
        total += hits.length;
        if (filesOnly) {
          files.push({ file: source.label, scope: source.scope, count: hits.length });
          continue;
        }
        const room = Math.min(limit - returned, maxPerFile ?? Infinity);
        if (room <= 0) {
          truncated = true;
          continue;
        }
        if (hits.length > room) truncated = true;
        const kept = hits.slice(0, room);
        returned += kept.length;
        // Lines to show: the matches with their context, each line once.
        const marks = new Map();
        const lineTest = multiline ? null : test;
        for (const [first, last] of kept) {
          for (let at = Math.max(0, first - before); at < first; at++) if (!marks.has(at)) marks.set(at, "-");
          for (let at = first; at <= Math.min(last, first + 30); at++) marks.set(at, ":");
          for (let at = last + 1; at <= Math.min(lines.length - 1, last + after); at++) if (!marks.has(at)) marks.set(at, "-");
        }
        const numbers = [...marks.keys()].sort((a, b) => a - b);
        const body = numbers
          .map((at, index) => `${index && at - numbers[index - 1] > 1 ? "  …\n" : ""}  ${at + 1}${marks.get(at)} ${shown(lines[at], marks.get(at) === ":" ? lineTest : null)}`)
          .join("\n");
        files.push({ file: source.label, scope: source.scope, matches: kept.map(([first, last]) => ({ line: first + 1, ...(last > first ? { endLine: last + 1 } : {}) })), body });
      }
      const notes = [
        skipped.large ? `跳过了 ${skipped.large} 个超过 8 MB 的文件` : "",
        skipped.binary ? `${skipped.binary} 个二进制文件` : "",
      ].filter(Boolean);
      const where = `范围：${scope.join("、")}${glob ? `，文件 ${[glob].flat().join("、")}` : ""}${exclude ? `，排除 ${[exclude].flat().join("、")}` : ""}`;
      if (!files.length) return { data: { files: [], total: 0 }, text: `没有找到「${wanted.join("」「")}」（${where}）${notes.length ? `；${notes.join("，")}` : ""}` };
      const text = filesOnly ? files.map((item) => `${item.file}（${item.count} 处）`).join("\n") : files.map((item) => `${item.file}\n${item.body}`).join("\n\n");
      const shownCount = filesOnly ? total : returned;
      return {
        data: { files: files.map(({ body, ...item }) => item), total, truncated },
        text: `${text}\n\n共 ${total} 处，${files.length} 个文件${truncated ? `（只显示了 ${shownCount} 处：缩小范围、用 glob，或调大 limit / maxPerFile）` : ""}${notes.length ? `；${notes.join("，")}` : ""}`,
      };
    },
  });
}

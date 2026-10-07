import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { workArg } from "./registry.mjs";
import { tree, isText } from "../files.mjs";
import { problem } from "../util.mjs";
import { appRoot } from "../config.mjs";

const SCOPES = ["work", "materials", "experience", "guide", "engine"];
const FILE_LIMIT = 1024 * 1024; // larger text files are skipped
const LINE_LIMIT = 2000; // characters of a line that are searched and shown

/** "scenes/**" style patterns; one without "/" matches the file name anywhere. */
export function globTest(glob) {
  if (!glob) return () => true;
  const source = glob
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => (part === "**/" || part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const pattern = new RegExp(`^${source}$`, "i");
  return glob.includes("/") ? (file) => pattern.test(file) : (file) => pattern.test(file.split("/").pop());
}

/**
 * Search text in the work and everything around it that an AI writes against: the
 * material libraries (their code), the experience libraries, the production guide and the
 * engine. One call, file:line with context, instead of reading files one by one.
 */
export function registerSearchTools(registry) {
  const { services } = registry;

  /** The folders of each scope with the label its matches are shown under. */
  const roots = async (work, scopes) => {
    const out = [];
    for (const scope of scopes) {
      if (scope === "work") out.push({ scope, dir: work.dir, label: (file) => file });
      if (scope === "materials" && services.materials) out.push({ scope, dir: await services.materials.dir(work.repo), label: (file) => `materials/${file}` });
      if (scope === "experience" && services.experience) out.push({ scope, dir: await services.experience.dir(work.repo), label: (file) => `经验库 ${file}` });
      if (scope === "guide") out.push({ scope, dir: path.join(appRoot, "docs", "guide"), label: (file) => `frame_guide ${file.replace(/\.md$/, "")}` });
      if (scope === "engine") out.push({ scope, dir: path.join(appRoot, "src", "engine"), label: (file) => `src/engine/${file}` });
    }
    return out;
  };

  registry.add({
    name: "search",
    title: "搜索",
    description:
      "在作品文件里搜索文字或正则，返回 文件:行号 和上下文；scope 还可以搜素材库（含其中的代码）、经验库、制作指南（guide）、引擎源码（engine）。找定义、调用处、用法、相关经验时用它，不用逐个读文件。几个关键词一起搜用 patterns（任一匹配）。",
    readOnly: true,
    input: {
      work: workArg,
      pattern: z.string().min(1).max(500).optional().describe("要找的文字；regex: true 时是正则表达式"),
      patterns: z.array(z.string().min(1).max(500)).max(10).optional().describe("几个一起搜，任一匹配"),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      scope: z.array(z.enum(SCOPES)).min(1).default(["work"]).describe("work 作品、materials 素材库、experience 经验库、guide 制作指南、engine 引擎源码"),
      glob: z.string().max(200).optional().describe('只搜这些文件，例如 "*.ts"、"scenes/**"、"特效/**"'),
      context: z.number().int().min(0).max(5).default(1).describe("每处匹配前后各显示几行"),
      limit: z.number().int().min(1).max(500).default(100).describe("最多返回几处"),
      filesOnly: z.boolean().default(false).describe("只列出包含匹配的文件"),
    },
    async run({ pattern, patterns, regex, caseSensitive, scope, glob, context, limit, filesOnly }, ctx) {
      const wanted = [...(pattern ? [pattern] : []), ...(patterns ?? [])];
      if (!wanted.length) throw problem(400, "需要 pattern 或 patterns");
      let test;
      try {
        const source = wanted.map((item) => (regex ? `(?:${item})` : item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("|");
        test = new RegExp(source, caseSensitive ? "" : "i");
      } catch (error) {
        throw problem(400, `正则表达式无效：${error.message}`);
      }
      const inScope = globTest(glob);
      const work = await ctx.work();
      const files = [];
      let total = 0;
      let truncated = false;
      for (const root of await roots(work, [...new Set(scope)])) {
        for (const entry of tree(root.dir, { maxEntries: 20000 })) {
          if (entry.type !== "file" || !isText(entry.path) || entry.size > FILE_LIMIT || !inScope(entry.path)) continue;
          // Generated or managed files that only add noise.
          if (/(^|\/)(materials\.lock\.json|\.aliases\.json)$/.test(entry.path)) continue;
          const lines = fs.readFileSync(path.join(root.dir, entry.path), "utf8").split("\n");
          const hits = [];
          for (let index = 0; index < lines.length; index++) if (test.test(lines[index].slice(0, LINE_LIMIT))) hits.push(index);
          if (!hits.length) continue;
          total += hits.length;
          if (filesOnly) {
            files.push({ file: root.label(entry.path), scope: root.scope, count: hits.length });
            continue;
          }
          const room = limit - files.reduce((sum, item) => sum + item.matches.length, 0);
          if (room <= 0) {
            truncated = true;
            continue;
          }
          if (hits.length > room) truncated = true;
          const matches = hits.slice(0, room).map((at) => ({
            line: at + 1,
            text: lines[at].slice(0, LINE_LIMIT),
            before: lines.slice(Math.max(0, at - context), at).map((text) => text.slice(0, LINE_LIMIT)),
            after: lines.slice(at + 1, at + 1 + context).map((text) => text.slice(0, LINE_LIMIT)),
          }));
          files.push({ file: root.label(entry.path), scope: root.scope, matches });
        }
      }
      if (!files.length) return { data: { files: [], total: 0 }, text: `没有找到「${wanted.join("」「")}」（范围：${scope.join("、")}${glob ? `，文件 ${glob}` : ""}）` };
      const text = filesOnly
        ? files.map((item) => `${item.file}（${item.count} 处）`).join("\n")
        : files
            .map((item) => {
              // Context lines that belong to two nearby matches are shown once.
              const shown = new Map();
              for (const match of item.matches) {
                match.before.forEach((line, offset) => !shown.has(match.line - match.before.length + offset) && shown.set(match.line - match.before.length + offset, `${match.line - match.before.length + offset}- ${line}`));
                shown.set(match.line, `${match.line}: ${match.text}`);
                match.after.forEach((line, offset) => !shown.has(match.line + 1 + offset) && shown.set(match.line + 1 + offset, `${match.line + 1 + offset}- ${line}`));
              }
              const numbers = [...shown.keys()].sort((a, b) => a - b);
              const body = numbers.map((number, index) => (index && number - numbers[index - 1] > 1 ? `  …\n  ${shown.get(number)}` : `  ${shown.get(number)}`)).join("\n");
              return `${item.file}\n${body}`;
            })
            .join("\n\n");
      const count = filesOnly ? files.length : files.reduce((sum, item) => sum + item.matches.length, 0);
      return {
        data: { files, total, truncated },
        text: `${text}\n\n共 ${total} 处，${files.length} 个文件${truncated ? `（只显示前 ${count} 处：缩小范围、用 glob，或调大 limit）` : ""}`,
      };
    },
  });
}

import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { z } from "zod";
import sharp from "sharp";
import { problem, notFound, sha256, writeFileAtomic, Lru } from "./util.mjs";
import { sendFile, sendJson } from "./http.mjs";
import { workArg, asJson } from "./tools/registry.mjs";
import { contactSheet } from "./render.mjs";

/**
 * The resources of material library code, read without running it (the studio never runs
 * work or library code on the server): `export const resources = defineResources({ id:
 * resource({ … }) })`, `export default defineSounds(rate, { id: { … } })`, and every export
 * with its signature and doc comment. Literal fields are evaluated; `params` (zod) is
 * described from its source; everything else is kept as source text.
 */

export const RESOURCE_KINDS = {
  character: "角色",
  prop: "物品",
  set: "场景",
  ui: "界面",
  effect: "效果",
  transition: "转场",
  text: "文字",
  sound: "音效",
};
export const CODE_FILE = /\.(m?[jt]sx?)$/i;

const squash = (text, limit = 400) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
};

/** The text of a doc comment (/** … *\/ or a run of // lines). */
function commentText(comments) {
  if (!comments?.length) return "";
  const last = comments[comments.length - 1];
  if (last.type === "CommentBlock") {
    if (!last.value.startsWith("*")) return "";
    return last.value
      .replace(/^\*+/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, ""))
      .join("\n")
      .trim();
  }
  // Consecutive line comments directly above; section rulers (// ---- easing) are not docs.
  const lines = [];
  for (let index = comments.length - 1; index >= 0 && comments[index].type === "CommentLine"; index--) {
    if (index < comments.length - 1 && comments[index + 1].loc.start.line - comments[index].loc.end.line > 1) break;
    if (/^\s*[-=─━]{4,}/.test(comments[index].value)) break;
    lines.unshift(comments[index].value.trim());
  }
  return lines.join("\n").trim();
}

function parseCode(code, ref) {
  const plugins = /\.tsx$/i.test(ref) ? ["typescript", "jsx"] : /\.m?ts$/i.test(ref) ? ["typescript"] : ["jsx"];
  return parse(code, { sourceType: "module", plugins, errorRecovery: true, attachComment: true, sourceFilename: ref });
}

/**
 * Static values: literals, arrays, objects, template strings without expressions, numeric
 * arithmetic and top-level constants. `undefined` for anything that needs running code.
 */
function evaluator(bindings) {
  const visiting = new Set();
  const value = (node, depth = 0) => {
    if (!node || depth > 40) return undefined;
    switch (node.type) {
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
        return node.value;
      case "NullLiteral":
        return null;
      case "TemplateLiteral":
        return node.expressions.length ? undefined : node.quasis[0].value.cooked;
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "ParenthesizedExpression":
        return value(node.expression, depth + 1);
      case "UnaryExpression": {
        const operand = value(node.argument, depth + 1);
        if (typeof operand !== "number") return undefined;
        return node.operator === "-" ? -operand : node.operator === "+" ? operand : undefined;
      }
      case "BinaryExpression": {
        const left = value(node.left, depth + 1);
        const right = value(node.right, depth + 1);
        if (typeof left === "string" && typeof right === "string" && node.operator === "+") return left + right;
        if (typeof left !== "number" || typeof right !== "number") return undefined;
        return { "+": left + right, "-": left - right, "*": left * right, "/": left / right }[node.operator];
      }
      case "Identifier": {
        if (!bindings.has(node.name) || visiting.has(node.name)) return undefined;
        visiting.add(node.name);
        try {
          return value(bindings.get(node.name), depth + 1);
        } finally {
          visiting.delete(node.name);
        }
      }
      case "ArrayExpression": {
        const items = node.elements.map((element) => (element && element.type !== "SpreadElement" ? value(element, depth + 1) : undefined));
        return items.some((item) => item === undefined) ? undefined : items;
      }
      case "ObjectExpression": {
        const result = {};
        for (const property of node.properties) {
          if (property.type === "SpreadElement") {
            const spread = value(property.argument, depth + 1);
            if (!spread || typeof spread !== "object" || Array.isArray(spread)) return undefined;
            Object.assign(result, spread);
            continue;
          }
          if (property.type !== "ObjectProperty" || property.computed) return undefined;
          const key = keyOf(property);
          const item = value(property.value, depth + 1);
          if (item === undefined) return undefined;
          result[key] = item;
        }
        return result;
      }
      case "MemberExpression": {
        // CAST.jie, CAST["a"] of a constant object.
        const object = value(node.object, depth + 1);
        const key = node.computed ? value(node.property, depth + 1) : node.property.name;
        return object && typeof object === "object" && (typeof key === "string" || typeof key === "number") && Object.hasOwn(object, key) ? object[key] : undefined;
      }
      default:
        return undefined;
    }
  };
  return value;
}
const keyOf = (property) => (property.key.type === "Identifier" ? property.key.name : String(property.key.value));
/** The properties of an object literal, including those spread in from constant object literals (`...SCREEN`). */
function propertiesOf(object, bindings, depth = 0) {
  const found = new Map();
  if (object?.type === "Identifier" && bindings?.has(object.name) && depth < 8) return propertiesOf(bindings.get(object.name), bindings, depth + 1);
  for (const property of object?.type === "ObjectExpression" ? object.properties : []) {
    if (property.type === "SpreadElement") for (const [key, value] of propertiesOf(property.argument, bindings, depth + 1)) found.set(key, value);
    else if ((property.type === "ObjectProperty" || property.type === "ObjectMethod") && !property.computed) found.set(keyOf(property), property);
  }
  return found;
}

/** A zod schema from its source: z.number().min(0).max(1).default(0.5).describe("…") and friends. */
function zodDescriber(code, bindings, value) {
  const describe = (node, depth = 0) => {
    if (!node || depth > 30) return { type: "unknown" };
    if (node.type === "Identifier" && bindings.has(node.name)) return describe(bindings.get(node.name), depth + 1);
    if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" || node.type === "ParenthesizedExpression") return describe(node.expression, depth + 1);
    // Unwind the method chain down to z.<base>(…).
    const chain = [];
    let current = node;
    while (current.type === "CallExpression" && current.callee.type === "MemberExpression" && !current.callee.computed) {
      const method = current.callee.property.name;
      const object = current.callee.object;
      if (object.type === "Identifier" && object.name === "z") {
        chain.unshift({ method, args: current.arguments, base: true });
        break;
      }
      chain.unshift({ method, args: current.arguments });
      current = object;
    }
    const base = chain[0]?.base ? chain.shift() : null;
    let schema;
    if (!base) {
      // A schema kept in a constant and refined here: describe the constant, then the calls.
      schema = current.type === "Identifier" && bindings.has(current.name) ? describe(bindings.get(current.name), depth + 1) : { type: "unknown", source: squash(code.slice(node.start, node.end), 160) };
    } else {
      const [first, second] = base.args;
      switch (base.method) {
        case "number":
          schema = { type: "number" };
          break;
        case "string":
          schema = { type: "string" };
          break;
        case "boolean":
          schema = { type: "boolean" };
          break;
        case "enum":
          schema = { type: "enum", values: value(first) ?? [] };
          break;
        case "literal":
          schema = { type: "literal", value: value(first) };
          break;
        case "array":
          schema = { type: "array", items: describe(first, depth + 1) };
          break;
        case "tuple":
          schema = { type: "tuple", items: (first?.elements ?? []).map((element) => describe(element, depth + 1)) };
          break;
        case "union":
          schema = { type: "union", options: (first?.elements ?? []).map((element) => describe(element, depth + 1)) };
          break;
        case "record":
          schema = { type: "record", values: describe(second ?? first, depth + 1) };
          break;
        case "object":
        case "strictObject":
        case "looseObject":
          schema = { type: "object", fields: fieldsOf(first, depth + 1) };
          break;
        default:
          schema = { type: base.method };
      }
    }
    for (const { method, args } of chain) {
      const argument = args[0] ? value(args[0]) : undefined;
      if (method === "optional") schema.optional = true;
      else if (method === "nullable") schema.nullable = true;
      else if (method === "default") {
        schema.default = argument;
        schema.optional = true;
      } else if (method === "describe" && typeof argument === "string") schema.description = argument;
      else if (["min", "gte"].includes(method) && typeof argument === "number") schema.min = argument;
      else if (["max", "lte"].includes(method) && typeof argument === "number") schema.max = argument;
      else if (method === "int") schema.int = true;
      else if (method === "positive") schema.min = schema.min ?? 0;
      else if (method === "nonnegative") schema.min = schema.min ?? 0;
      else if (method === "meta" && argument && typeof argument === "object") {
        if (typeof argument.description === "string") schema.description = argument.description;
        if (typeof argument.title === "string") schema.label = argument.title;
        if (typeof argument.step === "number") schema.step = argument.step;
      }
    }
    return schema;
  };
  const fieldsOf = (object, depth) => {
    if (object?.type === "Identifier" && bindings.has(object.name)) return fieldsOf(bindings.get(object.name), depth + 1);
    if (object?.type !== "ObjectExpression") return [];
    return object.properties
      .filter((property) => property.type === "ObjectProperty" && !property.computed)
      .map((property) => {
        const field = { name: keyOf(property), ...describe(property.value, depth) };
        // A comment above the field documents it when .describe() does not.
        const note = commentText(property.leadingComments);
        if (note && !field.description) field.description = note;
        return field;
      });
  };
  return describe;
}

/** One line for a parameter: name?: type = default — description */
export function paramLine(param) {
  const type =
    param.type === "enum"
      ? param.values.map((item) => JSON.stringify(item)).join(" | ")
      : param.type === "literal"
        ? JSON.stringify(param.value)
        : param.type === "number" && (param.min !== undefined || param.max !== undefined)
          ? `${param.int ? "整数" : "number"} ${param.min ?? ""}–${param.max ?? ""}`
          : param.type === "array"
            ? `${param.items?.type ?? "unknown"}[]`
            : param.type === "object"
              ? `{ ${param.fields.map((field) => field.name).join(", ")} }`
              : param.type === "unknown"
                ? param.source ?? "unknown"
                : param.type;
  const fallback = param.default !== undefined ? ` = ${JSON.stringify(param.default)}` : "";
  return `${param.name}${param.optional ? "?" : ""}: ${type}${fallback}${param.description ? ` — ${param.description}` : ""}`;
}

/** Everything a library code file declares. */
export function extractModule(code, ref) {
  let ast;
  try {
    ast = parseCode(code, ref);
  } catch (error) {
    return { ref, doc: "", exports: [], resources: [], sounds: [], errors: [error.message] };
  }
  const program = ast.program;
  const bindings = new Map();
  for (const raw of program.body) {
    const statement = raw.type === "ExportNamedDeclaration" ? raw.declaration : raw;
    if (statement?.type === "VariableDeclaration")
      for (const declaration of statement.declarations) if (declaration.id.type === "Identifier" && declaration.init) bindings.set(declaration.id.name, declaration.init);
  }
  const value = evaluator(bindings);
  const zod = zodDescriber(code, bindings, value);
  const source = (node) => code.slice(node.start, node.end);
  const lineOf = (node) => node.loc?.start.line ?? 1;

  // A comment at the top, before the first import or statement, describes the module.
  const first = program.body[0];
  const head = (ast.comments ?? []).filter((comment) => !first || comment.end <= first.start);
  const doc = head.length ? commentText(head) || commentText([head[0]]) : "";

  const exports = [];
  const resources = [];
  const sounds = [];
  const errors = (ast.errors ?? []).slice(0, 5).map((error) => error.message);

  const readSounds = (call, exportName) => {
    const table = call.arguments[1];
    for (const property of table?.type === "ObjectExpression" ? table.properties : []) {
      if (property.type !== "ObjectProperty" || property.computed) continue;
      const fields = propertiesOf(property.value, bindings);
      const field = (name) => (fields.get(name)?.value ? value(fields.get(name).value) : undefined);
      sounds.push({
        key: keyOf(property),
        title: field("title") ?? keyOf(property),
        duration: field("duration"),
        hit: field("hit"),
        description: field("description") ?? (commentText(property.leadingComments) || undefined),
        tags: field("tags") ?? [],
        line: lineOf(property),
        export: exportName,
      });
    }
  };
  const readResources = (object) => {
    for (const property of object?.type === "ObjectExpression" ? object.properties : []) {
      if (property.type !== "ObjectProperty" || property.computed) continue;
      let node = property.value;
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "resource") node = node.arguments[0];
      if (node?.type !== "ObjectExpression") continue;
      const fields = propertiesOf(node, bindings);
      const field = (name) => (fields.get(name)?.type === "ObjectProperty" ? value(fields.get(name).value) : undefined);
      const preview = propertiesOf(fields.get("preview")?.value, bindings);
      const previewField = (name) => (preview.get(name)?.type === "ObjectProperty" ? value(preview.get(name).value) : undefined);
      const draw = preview.get("draw");
      const params = fields.get("params") ? zod(fields.get("params").value) : null;
      const presetsNode = fields.get("presets")?.value;
      const presets = {};
      for (const preset of presetsNode?.type === "ObjectExpression" ? presetsNode.properties : []) {
        if (preset.type !== "ObjectProperty" || preset.computed) continue;
        presets[keyOf(preset)] = value(preset.value) ?? { "(代码)": squash(source(preset.value), 200) };
      }
      resources.push({
        key: keyOf(property),
        kind: field("kind"),
        title: field("title") ?? keyOf(property),
        description: field("description") ?? (commentText(property.leadingComments) || undefined),
        tags: field("tags") ?? [],
        usage: field("usage"),
        params: params?.type === "object" ? params.fields : [],
        presets,
        preview: {
          width: previewField("width"),
          height: previewField("height"),
          duration: previewField("duration") ?? 0,
          time: previewField("time"),
          background: previewField("background"),
          draw: draw ? squash(draw.type === "ObjectMethod" ? source(draw.body) : source(draw.value), 600) : undefined,
        },
        line: lineOf(property),
      });
    }
  };

  for (const statement of program.body) {
    const docOf = () => commentText(statement.leadingComments);
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (declaration.type === "CallExpression" && declaration.callee.type === "Identifier" && declaration.callee.name === "defineSounds") readSounds(declaration, "default");
      else exports.push({ name: "default", kind: "default", signature: squash(`export default ${source(declaration)}`, 160), doc: docOf(), line: lineOf(statement) });
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (!statement.declaration) {
      for (const specifier of statement.specifiers ?? [])
        if (specifier.type === "ExportSpecifier")
          exports.push({
            name: specifier.exported.name ?? specifier.exported.value,
            kind: "reexport",
            signature: statement.source ? `从 ${statement.source.value} 导出` : `导出 ${specifier.local.name}`,
            doc: docOf(),
            line: lineOf(statement),
          });
      continue;
    }
    const declaration = statement.declaration;
    if (declaration.type === "FunctionDeclaration" || declaration.type === "TSDeclareFunction") {
      const end = declaration.body?.start ?? declaration.end;
      const signature = code
        .slice(declaration.start, end)
        .replace(/\{\s*$/, "")
        .replace(/^(?:declare\s+)?(async\s+)?function\s*\*?\s*/, (_, async) => (async ? "async " : ""));
      exports.push({ name: declaration.id.name, kind: "function", signature: squash(signature), doc: docOf(), line: lineOf(statement) });
    } else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const name = declarator.id.name;
        const init = declarator.init;
        if (name === "resources" && init?.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === "defineResources") {
          readResources(init.arguments[0]);
          continue;
        }
        if (init?.type === "CallExpression" && init.callee.type === "Identifier" && init.callee.name === "defineSounds") {
          readSounds(init, name);
          continue;
        }
        const fn = init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") ? init : null;
        const signature = fn
          ? `${name}${squash(code.slice(fn.params[0]?.start != null ? code.lastIndexOf("(", fn.params[0].start) : fn.start, fn.body.start).replace(/=>\s*$/, "").replace(/^async\s*/, ""))}`
          : declarator.id.typeAnnotation
            ? `${declaration.kind} ${name}${squash(source(declarator.id.typeAnnotation), 200)}`
            : `${declaration.kind} ${name} = ${squash(init ? source(init) : "", 120)}`;
        exports.push({ name, kind: fn ? "function" : "const", signature, doc: docOf(), line: lineOf(statement) });
      }
    } else if (declaration.type === "TSInterfaceDeclaration") {
      const members = declaration.body.body
        .filter((member) => member.key)
        .map((member) => ({
          name: member.key.type === "Identifier" ? member.key.name : String(member.key.value),
          optional: Boolean(member.optional),
          type: member.typeAnnotation ? squash(source(member.typeAnnotation).replace(/^:\s*/, ""), 200) : squash(source(member), 200),
          doc: commentText(member.leadingComments),
        }));
      exports.push({ name: declaration.id.name, kind: "interface", signature: `interface ${declaration.id.name}`, doc: docOf(), members, line: lineOf(statement) });
    } else if (declaration.type === "TSTypeAliasDeclaration") {
      exports.push({ name: declaration.id.name, kind: "type", signature: squash(source(declaration), 300), doc: docOf(), line: lineOf(statement) });
    } else if (declaration.type === "ClassDeclaration") {
      exports.push({ name: declaration.id.name, kind: "class", signature: `class ${declaration.id.name}`, doc: docOf(), line: lineOf(statement) });
    } else if (declaration.type === "TSEnumDeclaration") {
      exports.push({ name: declaration.id.name, kind: "enum", signature: squash(source(declaration), 200), doc: docOf(), line: lineOf(statement) });
    }
  }
  return { ref, doc, exports, resources, sounds, errors };
}

/** Lower-case words of a query: "下雨 街道" → ["下雨", "街道"]. */
const terms = (query) =>
  String(query || "")
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter(Boolean);

/** How well an entry matches the query terms (0: not at all). */
export function score(entry, query) {
  const wanted = terms(query);
  if (!wanted.length) return 1;
  const fields = [
    [entry.title, 6],
    [entry.key ?? entry.name, 5],
    [(entry.tags ?? []).join(" "), 4],
    [entry.kindLabel, 3],
    [entry.description ?? entry.doc, 2],
    [entry.text, 1],
  ];
  // Several words name several things ("小狗 雨夜 街道"): an entry matching more of them ranks
  // first, one matching any of them is still found.
  let total = 0;
  let matched = 0;
  for (const term of wanted) {
    let best = 0;
    for (const [text, weight] of fields) if (text && String(text).toLowerCase().includes(term)) best = Math.max(best, weight);
    if (best) matched++;
    total += best;
  }
  return matched ? matched * 100 + total : 0;
}

// ---- the catalog of a repository's libraries, routes and AI tools ------------------------

const FORMAT = "1"; // part of every thumbnail key: bump to redo cached thumbnails after changing how they are made
const importOf = (ref) => `@materials/${ref.replace(/\.(m?[jt]sx?)$/i, "")}`;
const firstLine = (text) => String(text || "").split(/\n|(?<=[。.!?！？])\s/)[0].trim();

export class ResourceCatalog {
  constructor(services) {
    this.services = services;
    this.parsed = new Lru(1000); // blob → what the file declares (blobs never change); the limit grows with the libraries
    this.dir = path.join(services.config.dirs.cache, "resources");
    this.jobs = new Map(); // thumbnail file → { work, ref, key, id, version }, waiting or being rendered
    this.waiting = []; // thumbnail files not started yet, latest request last
    this.rendering = null; // the thumbnail file being rendered (one at a time)
    this.failed = new Lru(2000); // thumbnail file → { message, at }: not retried for a while
    this.overviews = new Map(); // repo → Promise of overview(), until the libraries change
    this.overviewed = new Map(); // repo → its last overview, for the (synchronous) session brief
  }
  get materials() {
    return this.services.materials;
  }

  async module(repo, ref, blob) {
    let parsed = this.parsed.get(blob);
    if (!parsed) {
      parsed = extractModule(await this.materials.text(repo, blob), ref);
      this.parsed.set(blob, parsed);
    }
    return { ...parsed, ref, library: ref.split("/")[0], blob };
  }

  /**
   * The library code modules as the libraries have them now — what previews and thumbnails
   * run too. `outdated`: the work locked another version of the file (it runs that one).
   */
  async modules(work, { library } = {}) {
    const head = await this.materials.headOf(work.repo);
    const locks = this.materials.readLocks(work.dir);
    const result = [];
    const refs = [...head.keys()].filter((ref) => CODE_FILE.test(ref) && (!library || ref.startsWith(library + "/"))).sort();
    // Every module of the libraries stays parsed, however many there are.
    this.parsed.limit = Math.max(this.parsed.limit, refs.length * 2);
    for (const ref of refs) {
      try {
        const mod = await this.module(work.repo, ref, head.get(ref));
        result.push({ ...mod, outdated: Boolean(locks[ref] && locks[ref] !== head.get(ref)) });
      } catch {}
    }
    return result;
  }

  resourceEntry(mod, item) {
    return {
      id: `${mod.ref}#${item.key}`,
      type: "resource",
      ...item,
      kindLabel: RESOURCE_KINDS[item.kind] ?? item.kind ?? "资源",
      ref: mod.ref,
      library: mod.library,
      import: importOf(mod.ref),
      outdated: mod.outdated,
      text: [item.usage, item.params.map(paramLine).join(" "), Object.keys(item.presets).join(" ")].filter(Boolean).join(" "),
    };
  }
  soundEntry(mod, item) {
    return { id: `${mod.ref}#${item.key}`, type: "sound", ...item, kind: "sound", kindLabel: RESOURCE_KINDS.sound, ref: mod.ref, library: mod.library, module: `materials/${mod.ref}`, outdated: mod.outdated, text: (item.tags ?? []).join(" ") };
  }
  codeEntry(mod, item) {
    return {
      id: `${mod.ref}#${item.name}`,
      type: "code",
      kind: "code",
      kindLabel: item.kind === "interface" || item.kind === "type" ? "类型" : "代码",
      title: item.name,
      name: item.name,
      doc: item.doc,
      signature: item.signature,
      members: item.members,
      ref: mod.ref,
      library: mod.library,
      line: item.line,
      import: importOf(mod.ref),
      text: [item.signature, ...(item.members ?? []).map((member) => `${member.name} ${member.doc}`)].join(" "),
    };
  }
  entries(modules) {
    return modules.flatMap((mod) => [...mod.resources.map((item) => this.resourceEntry(mod, item)), ...mod.sounds.map((item) => this.soundEntry(mod, item))]);
  }

  async search(work, { query, kind, library, limit = 30 }) {
    const modules = await this.modules(work, { library });
    let entries = this.entries(modules);
    if (kind && kind !== "code") entries = entries.filter((entry) => entry.kind === kind);
    // Exported functions and types join the results only when looking for something.
    const code = query && (!kind || kind === "code") ? modules.flatMap((mod) => mod.exports.filter((item) => item.kind !== "reexport").map((item) => this.codeEntry(mod, item))) : [];
    return [...(kind === "code" ? [] : entries), ...code]
      .map((entry) => ({ entry, score: score(entry, query) * (entry.type === "code" ? 0.6 : 1) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query ? limit : 1000)
      .map((item) => item.entry);
  }

  /** `<library>/<path>` (a module) or `<library>/<path>#<id>` (a resource, sound or export). */
  async get(work, id) {
    const [ref, key] = String(id).replace(/^materials\//, "").split("#");
    if (!ref || !CODE_FILE.test(ref)) throw problem(400, `资源地址应为 <素材库>/<路径>.ts#<名称>，例如 s0rrow/code/kid.ts#kid（收到 ${id}）`);
    const head = await this.materials.headOf(work.repo);
    const locks = this.materials.readLocks(work.dir);
    const blob = head.get(ref);
    if (!blob) throw notFound(`素材库里没有 materials/${ref}`);
    const mod = { ...(await this.module(work.repo, ref, blob)), outdated: Boolean(locks[ref] && locks[ref] !== blob) };
    if (!key) return { module: mod };
    const resource = mod.resources.find((item) => item.key === key);
    if (resource) return { module: mod, entry: this.resourceEntry(mod, resource) };
    const sound = mod.sounds.find((item) => item.key === key);
    if (sound) return { module: mod, entry: this.soundEntry(mod, sound) };
    const exported = mod.exports.find((item) => item.name === key);
    if (exported) return { module: mod, entry: this.codeEntry(mod, exported) };
    throw notFound(`materials/${ref} 里没有 ${key}（资源：${mod.resources.map((item) => item.key).join("、") || "无"}；音效 ${mod.sounds.length} 个；导出 ${mod.exports.length} 个）`);
  }

  /**
   * A sound to place, by its id: the generated source audio.json needs and its length. Using
   * a library's sound means using the library, so the work links it if it does not yet.
   */
  async sound(work, id) {
    const { entry } = await this.get(work, id);
    if (entry?.type !== "sound") throw problem(400, `${id} 不是音效（音效模块用 export default defineSounds(…) 声明）`);
    const names = this.materials.names(work);
    if (!names.includes(entry.library)) await this.services.works.update(work, { materials: [...names, entry.library] });
    return { module: entry.module, id: entry.key, duration: entry.duration, title: entry.title };
  }

  /** What a module's pictures depend on: its code and everything it reaches (as the libraries have them now), and the work's tempo. */
  async version(work, ref) {
    const head = await this.materials.headOf(work.repo);
    const { refs } = await this.materials.follow(work.repo, {}, [{ spec: ref, from: "" }]);
    const meta = this.services.works.meta(work);
    const parts = [...refs].sort().map((item) => `${item}:${head.get(item) ?? ""}`);
    return sha256(JSON.stringify([FORMAT, parts, meta.ok ? (meta.meta.tempo ?? null) : null])).slice(0, 24);
  }

  /**
   * A small picture of a resource, cached by version: `{ file }`, `{ error }`, or `{ pending }`
   * — then it is rendered in the background, one at a time, the latest request first (what
   * the panel shows now), and a `resource-thumb` event says when it is there.
   */
  async thumbnail(work, id) {
    const [ref, key] = String(id).split("#");
    if (!ref || !key || !CODE_FILE.test(ref)) throw problem(400, `资源地址应为 <素材库>/<路径>.ts#<名称>（收到 ${id}）`);
    const version = await this.version(work, ref);
    const file = path.join(this.dir, `${sha256(`${version}|${key}`).slice(0, 32)}.webp`);
    if (fs.existsSync(file)) return { file, version };
    const failed = this.failed.get(file);
    if (failed && Date.now() - failed.at < FAILED_FOR) return { error: failed.message, version };
    if (!this.jobs.has(file)) this.jobs.set(file, { work, ref, key, id, version });
    if (this.rendering !== file) {
      const index = this.waiting.indexOf(file);
      if (index >= 0) this.waiting.splice(index, 1);
      this.waiting.push(file);
      this.next();
    }
    return { pending: true, version };
  }
  next() {
    if (this.rendering || !this.waiting.length) return;
    const file = (this.rendering = this.waiting.pop());
    const job = this.jobs.get(file);
    const done = (error) => {
      if (error) this.failed.set(file, { message: error.message, at: Date.now() });
      else this.failed.delete(file);
      this.services.events.emit({ type: "resource-thumb", repo: job.work.repo, id: job.id, version: job.version, ...(error ? { error: error.message } : {}) });
    };
    this.renderThumbnail(job, file)
      .then(() => done(), done)
      .finally(() => {
        this.jobs.delete(file);
        this.rendering = null;
        this.next();
      });
  }
  async renderThumbnail({ work, ref, key }, file) {
    const { frames } = await this.services.renderer.resourceFrames(work, { ref, key, width: 360 });
    fs.mkdirSync(this.dir, { recursive: true });
    const image = await sharp(frames[0].png).resize({ width: 240, height: 240, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    writeFileAtomic(file, image);
  }
  /**
   * What each library of a repository holds, for an AI starting on a work: resources by kind,
   * sounds, files, the canvas most of its resources are drawn on, and the lead of its README.
   * Cached until the libraries change.
   */
  overview(repo) {
    if (!this.overviews.has(repo)) {
      const pending = this.computeOverview(repo).then((value) => (this.overviewed.set(repo, value), value));
      pending.catch(() => this.overviews.delete(repo));
      this.overviews.set(repo, pending);
    }
    return this.overviews.get(repo);
  }
  async computeOverview(repo) {
    const head = await this.materials.headOf(repo);
    const dir = await this.materials.dir(repo);
    const result = [];
    for (const library of await this.materials.libraries(repo)) {
      const kinds = new Map();
      const canvases = new Map();
      let resources = 0;
      let sounds = 0;
      for (const ref of [...head.keys()].filter((ref) => CODE_FILE.test(ref) && ref.startsWith(library.id + "/"))) {
        let mod;
        try {
          mod = await this.module(repo, ref, head.get(ref));
        } catch {
          continue;
        }
        sounds += mod.sounds.length;
        for (const item of mod.resources) {
          resources++;
          const label = RESOURCE_KINDS[item.kind] ?? item.kind;
          kinds.set(label, (kinds.get(label) ?? 0) + 1);
          const { width, height } = item.preview ?? {};
          if (width > 0 && height > 0) canvases.set(`${width}×${height}`, (canvases.get(`${width}×${height}`) ?? 0) + 1);
        }
      }
      const canvas = [...canvases].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const order = (label) => (Object.values(RESOURCE_KINDS).indexOf(label) + 100) % 100;
      const sorted = Object.fromEntries([...kinds].sort(([a], [b]) => order(a) - order(b)));
      result.push({ id: library.id, title: library.title, files: library.files, resources, sounds, kinds: sorted, canvas, about: readmeLead(path.join(dir, library.id, "README.md")) });
    }
    return result;
  }
  /** work_context's view of the libraries: all of them, which the work links, and how they fit its picture. */
  async librariesFor(work) {
    const linked = new Set(this.materials.names(work));
    const meta = this.services.works.meta(work);
    const libraries = (await this.overview(work.repo)).map((library) => {
      const note = library.canvas && meta.ok ? canvasNote(library.canvas, meta.meta) : "";
      return { ...library, linked: linked.has(library.id), ...(note ? { canvasNote: note } : {}) };
    });
    return {
      libraries,
      hint: libraries.some((library) => library.resources || library.sounds)
        ? "画角色、场景、道具、效果，配音效之前先用 resources_search 找现成的，resource_view 看用法、参数和预览图；第一次用一个素材库先读它的 README（material_read）。"
        : "素材库里还没有声明资源；共用的文件用 materials_list 查看。",
    };
  }
  /** The session brief's section on the libraries (from the last overview; the agent manager prepares it). */
  brief(work) {
    const overview = this.overviewed.get(work.repo);
    if (!overview?.length) return null;
    const linked = new Set(this.materials.names(work));
    const meta = this.services.works.meta(work);
    const lines = overview.map((library) => {
      const kinds = Object.entries(library.kinds).map(([label, count]) => `${label} ${count}`).join("、");
      const holds = [library.resources ? `资源 ${library.resources} 个（${kinds}）` : "", library.sounds ? `音效 ${library.sounds} 个` : "", `文件 ${library.files} 个`].filter(Boolean).join("、");
      const note = library.canvas && meta.ok ? canvasNote(library.canvas, meta.meta) : "";
      return `- 「${library.title}」${linked.has(library.id) ? "（本作品已关联）" : ""}：${holds}。${library.about ? library.about + " " : ""}${note}`.trim();
    });
    return {
      text: `## 素材库\n\n多个作品共用的角色、场景、道具、效果、转场、文字、音效和代码。画一个东西、配一个音效之前先用 resources_search 找，有就导入复用（不合适就给素材库代码加参数）；resource_view 看用法、参数和预览图；第一次用一个素材库先读它的 README（material_read）。\n\n${lines.join("\n")}`,
    };
  }

  /** The libraries changed: thumbnails waiting for versions that are gone are not wanted any more. */
  async dropOutdated(repo) {
    for (const file of [...this.waiting]) {
      const job = this.jobs.get(file);
      if (job?.work.repo !== repo || (await this.version(job.work, job.ref).catch(() => "")) === job.version) continue;
      const index = this.waiting.indexOf(file);
      if (index >= 0) this.waiting.splice(index, 1);
      this.jobs.delete(file);
    }
  }
}

const FAILED_FOR = 5 * 60 * 1000; // a resource that fails to render is tried again after this (or as soon as its code changes)

const kindArg = z.enum([...Object.keys(RESOURCE_KINDS), "code"]);
const OUTDATED = "（这里是素材库现在的版本；本作品锁定了另一个版本，运行时用锁定的，要改用这个版本：materials_use 加 update: true）";

function describeModule(mod) {
  const lines = [`materials/${mod.ref}${mod.outdated ? OUTDATED : ""}`, `导入：import { … } from "${importOf(mod.ref)}"`];
  if (mod.doc) lines.push("", mod.doc);
  if (mod.resources.length) {
    lines.push("", `资源（${mod.resources.length}）：`);
    for (const item of mod.resources) lines.push(`- [${RESOURCE_KINDS[item.kind] ?? item.kind}] ${mod.ref}#${item.key} ${item.title}${item.description ? " — " + firstLine(item.description) : ""}`);
  }
  if (mod.sounds.length) {
    lines.push("", `音效（${mod.sounds.length}，在 audio.json 里写 module "materials/${mod.ref}"，trackId 为名称；用 audio_place 的 sound 放到音轨）：`);
    for (const item of mod.sounds) lines.push(`- ${item.key} ${item.title}${item.duration ? `，${item.duration} 秒` : ""}${item.hit !== undefined ? `，重音在 ${item.hit} 秒` : ""}`);
  }
  const exported = mod.exports.filter((item) => item.kind !== "reexport" || item.doc);
  if (exported.length) {
    lines.push("", `导出（${exported.length}）：`);
    // The names of one `export { … }` statement share a line (and its comment).
    const rows = [];
    const statements = new Map();
    for (const item of exported) {
      if (item.kind !== "reexport") rows.push({ item });
      else if (statements.has(item.line)) statements.get(item.line).names.push(item.name);
      else {
        const row = { item, names: [item.name] };
        statements.set(item.line, row);
        rows.push(row);
      }
    }
    for (const { item, names } of rows) {
      const signature = names ? `${item.signature.startsWith("从 ") ? item.signature : "导出"} ${names.join("、")}` : item.signature;
      lines.push(`- ${signature}${item.doc ? `  // ${firstLine(item.doc)}` : ""}`);
    }
  }
  if (mod.errors.length) lines.push("", "解析问题：" + mod.errors.join("；"));
  return lines.join("\n");
}

function describeEntry(entry) {
  if (entry.type === "code") {
    const lines = [`${entry.kindLabel} ${entry.ref}#${entry.name}（第 ${entry.line} 行）`, `导入：import { ${entry.name} } from "${entry.import}"`, "", entry.signature];
    if (entry.doc) lines.push("", entry.doc);
    if (entry.members?.length) {
      lines.push("", "字段：");
      for (const member of entry.members) lines.push(`- ${member.name}${member.optional ? "?" : ""}: ${member.type}${member.doc ? ` — ${member.doc.replace(/\s+/g, " ")}` : ""}`);
    }
    return lines.join("\n");
  }
  if (entry.type === "sound") {
    return [
      `[音效] ${entry.id} ${entry.title}`,
      entry.description,
      `时长 ${entry.duration ?? "?"} 秒${entry.hit !== undefined ? `，重音在第 ${entry.hit} 秒（片段开始 = 事件时间 − ${entry.hit}）` : ""}`,
      `放到音轨：audio_place 的 sound: "${entry.id}"；或在 audio.json 里加生成音源 { kind: "generated", module: "${entry.module}", trackId: "${entry.key}" }`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const lines = [`[${entry.kindLabel}] ${entry.id} ${entry.title}${entry.outdated ? OUTDATED : ""}`];
  if (entry.description) lines.push(entry.description);
  if (entry.tags?.length) lines.push(`标签：${entry.tags.join("、")}`);
  lines.push("", `导入：import { … } from "${entry.import}"`);
  if (entry.usage) lines.push(`用法：${entry.usage}`);
  if (entry.preview?.draw) lines.push(`预览里的画法：${entry.preview.draw}`);
  if (entry.params.length) {
    lines.push("", "参数：");
    for (const param of entry.params) lines.push(`- ${paramLine(param)}`);
  }
  const presets = Object.entries(entry.presets);
  if (presets.length) {
    lines.push("", "预设：");
    for (const [name, values] of presets) lines.push(`- ${name}：${JSON.stringify(values)}`);
  }
  const { width, height, duration } = entry.preview;
  lines.push("", `预览画布 ${width}×${height}${duration ? `，动画 ${duration} 秒（times 可看不同时刻）` : "（静止）"}`);
  return lines.join("\n");
}

/**
 * A library canvas ("1080×1920") of another shape than the work's picture: said plainly, since
 * drawn whole it is cropped or letterboxed and nothing reports that. Empty when they fit.
 */
export function canvasNote(canvas, meta) {
  const [width, height] = String(canvas).split("×").map(Number);
  const { width: W, height: H } = meta.composition ?? { width: 1920, height: 1080 };
  if (!(width > 0 && height > 0 && W > 0 && H > 0) || Math.abs(Math.log(width / height / (W / H))) < 0.08) return "";
  const shape = (w, h) => (w > h * 1.05 ? "横屏" : h > w * 1.05 ? "竖屏" : "方形");
  return `按 ${width}×${height}（${shape(width, height)}）的画布设计，本作品画面是 ${W}×${H}（${shape(W, H)}）：整幅铺满会被裁切或留边，先按素材库 README 的说明安排，或只取其中一部分。`;
}

/** The lead paragraph of a library README (the line under its title), shortened. */
function readmeLead(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const line = text.split("\n").find((item) => item.trim() && !item.startsWith("#")) ?? "";
  return line.length > 160 ? line.slice(0, 159) + "…" : line.trim();
}

const DIRECTORY_LIMIT = 8000; // characters of the full directory before resources_search lists a summary instead

/** resources_search without a query: every entry by library and kind, or (summary) counts and the first few titles. */
function directory(entries, linked, summary) {
  const libraries = new Map();
  for (const entry of entries) libraries.set(entry.library, [...(libraries.get(entry.library) ?? []), entry]);
  return [...libraries]
    .map(([name, list]) => {
      const kinds = new Map();
      for (const entry of list) kinds.set(entry.kind, [...(kinds.get(entry.kind) ?? []), entry]);
      const lines = [`## 素材库「${name}」${linked.has(name) ? "（本作品已关联）" : "（本作品未关联，materials_use 时会自动关联）"}`];
      const order = (kind) => (Object.keys(RESOURCE_KINDS).indexOf(kind) + 100) % 100; // known kinds in their order, others after
      for (const [kind, group] of [...kinds].sort(([a], [b]) => order(a) - order(b))) {
        const label = `${group[0].kindLabel}（${group.length}）`;
        if (summary) {
          const shown = group.slice(0, kind === "sound" ? 12 : 8).map((entry) => entry.title);
          lines.push(`${label}：${shown.join("、")}${group.length > shown.length ? `……（kind: "${kind}"）` : ""}`);
        } else if (kind === "sound")
          lines.push(`${label}：${[...new Set(group.map((entry) => entry.ref))].map((ref) => `${ref}#…：${group.filter((entry) => entry.ref === ref).map((entry) => `${entry.key} ${entry.title}`).join("、")}`).join("\n")}`);
        else lines.push(`${label}：${group.map((entry) => `${entry.id} ${entry.title}`).join("；")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function resourcesPlugin(services) {
  const { router, tools } = services;
  const catalog = (services.resources = new ResourceCatalog(services));
  services.works.briefProviders.push((work) => catalog.brief(work));
  const open = (params) => services.openWork(params.id, params.repo);

  /** The libraries' resources and sounds for the workbench (all libraries, marked when the work links them). */
  router.get("/api/works/:repo/:id/resources", async ({ params, query }) => {
    const work = await open(params);
    const linked = new Set(services.materials.names(work));
    const modules = await catalog.modules(work, { library: query.library || undefined });
    const versions = new Map();
    for (const mod of modules) if (mod.resources.length) versions.set(mod.ref, await catalog.version(work, mod.ref).catch(() => ""));
    const libraries = (await services.materials.libraries(work.repo)).map((item) => ({ id: item.id, title: item.title, linked: linked.has(item.id) }));
    const items = catalog.entries(modules).map(({ text, ...entry }) => ({ ...entry, version: versions.get(entry.ref) ?? "" }));
    return { libraries, items, errors: modules.filter((mod) => mod.errors.length).map((mod) => ({ ref: mod.ref, errors: mod.errors })) };
  });
  router.get("/api/works/:repo/:id/resources/item", async ({ params, query }) => {
    const work = await open(params);
    const { module, entry } = await catalog.get(work, String(query.id || ""));
    return { module: { ref: module.ref, doc: module.doc, exports: module.exports, outdated: module.outdated }, entry: entry ?? null };
  });
  // Never held open while rendering (a browser has only a few connections per server): 202 means "wait for resource-thumb".
  router.get("/api/works/:repo/:id/resources/thumb", async ({ params, query, req, res }) => {
    const work = await open(params);
    const thumb = await catalog.thumbnail(work, String(query.id || ""));
    if (thumb.error) throw problem(422, thumb.error, "RENDER_FAILED");
    if (thumb.pending) return sendJson(res, 202, { pending: true, version: thumb.version });
    sendFile(req, res, thumb.file, { cache: query.v === thumb.version ? "private, max-age=31536000, immutable" : "no-cache" });
  });
  services.events.subscribe((event) => {
    if (event.type === "materials" && event.repo) {
      catalog.overviews.delete(event.repo);
      void catalog.dropOutdated(event.repo).catch(() => {});
    }
  });

  tools.add({
    name: "resources_search",
    title: "找可复用资源",
    description:
      "在素材库里找可以直接复用的资源：角色、物品、场景、界面、效果、转场、文字（歌词等）、音效，以及素材库代码导出的函数和类型。query 用中文或英文关键词（例如「下雨 街道」「手机 聊天」「甩镜」）；不给 query 列出目录（资源多时每类只列前几个，再用 kind 列出一类）。kind 限定类别（code 只找函数和类型）。动手画一个东西之前先找，有就导入复用，不要重画。看详情和预览图用 resource_view。",
    readOnly: true,
    input: {
      work: workArg,
      query: z.string().max(200).optional(),
      kind: kindArg.optional().describe("character 角色、prop 物品、set 场景、ui 界面、effect 效果、transition 转场、text 文字、sound 音效、code 函数和类型"),
      library: z.string().max(60).optional().describe("只找这个素材库"),
      limit: z.number().int().min(1).max(100).default(30),
    },
    async run({ query, kind, library, limit }, ctx) {
      const work = await ctx.work();
      const linked = new Set(services.materials.names(work));
      const found = await catalog.search(work, { query, kind, library, limit });
      const line = (entry) =>
        entry.type === "code"
          ? `- [${entry.kindLabel}] ${entry.id} ${entry.signature}${entry.doc ? `  // ${firstLine(entry.doc)}` : ""}`
          : `- [${entry.kindLabel}] ${entry.id} ${entry.title}${entry.type === "sound" && entry.duration && !/\d\s*秒/.test(entry.title) ? `（${entry.duration} 秒）` : ""}${entry.description ? " — " + firstLine(entry.description) : ""}`;
      if (!found.length) return asJson({ items: [] }, query ? `没有找到「${query}」相关的资源。可以换个说法，或不给 query 看全部目录。` : "素材库里还没有声明资源（见 frame_guide resources）。");
      let text;
      if (query) text = `找到 ${found.length} 个：\n${found.map(line).join("\n")}`;
      else {
        // The directory, by library and kind; once it gets long, only the first few of each kind.
        text = directory(found, linked, false);
        const summary = text.length > DIRECTORY_LIMIT;
        if (summary) text = directory(found, linked, true);
        text += summary
          ? `\n\n资源较多，每类只列出前几个：${kind ? "用 query 搜索这一类" : "用 kind 列出一类，或用 query 搜索"}，拿到地址后用 resource_view 看详情。`
          : "\n\n地址写法 <素材库>/<文件>#<名称>；resource_view 看详情和预览图，音效用 audio_place 的 sound 放到音轨。";
      }
      return asJson({ items: found.map(({ text: _text, ...entry }) => entry) }, text);
    },
  });

  tools.add({
    name: "resource_view",
    title: "查看资源",
    description:
      "看素材库里一个资源的详情和预览图：用法、导入语句、参数（类型、取值、默认值、说明）、预设，并按作品的节拍渲染出来（素材库现在的版本）。id 是 resources_search 给出的地址：资源或音效 <素材库>/<文件>#<名称>，函数和类型同样写法；只写 <素材库>/<文件> 看整个模块（文档、全部资源和导出）。params / preset 按给定参数渲染，times 看动画的几个时刻。",
    readOnly: true,
    input: {
      work: workArg,
      id: z.string().min(3).max(300),
      preset: z.string().max(100).optional(),
      params: z.record(z.string(), z.json()).optional().describe("覆盖预设的参数值"),
      times: z.array(z.number().nonnegative()).max(12).optional().describe("动画资源看哪些时刻（秒）"),
      image: z.boolean().default(true).describe("是否渲染预览图"),
      width: z.number().int().min(160).max(1600).default(720),
    },
    async run({ id, preset, params, times, image, width }, ctx) {
      const work = await ctx.work();
      const { module, entry } = await catalog.get(work, id);
      if (!entry) {
        const text = describeModule(module);
        if (!image || !module.resources.length) return asJson({ ref: module.ref, resources: module.resources.map((item) => item.key), sounds: module.sounds.length }, text);
        // A sheet of the module's resources as they look by default.
        const shots = [];
        const errors = [];
        for (const item of module.resources.slice(0, 16))
          try {
            const { frames } = await services.renderer.resourceFrames(work, { ref: module.ref, key: item.key, width: 320 });
            shots.push({ png: await sharp(frames[0].png).resize({ width: 240, height: 240, fit: "contain", background: "#16191d" }).png().toBuffer(), label: item.key });
          } catch (error) {
            errors.push(`${item.key}：${error.message}`);
          }
        const sheet = shots.length ? await contactSheet(shots, 240, 240, Math.min(4, shots.length)) : null;
        return {
          data: { ref: module.ref, resources: module.resources.map((item) => item.key), errors },
          text: text + (errors.length ? `\n\n渲染出错：\n${errors.join("\n")}` : ""),
          ...(sheet ? { images: [{ data: sheet, mimeType: "image/jpeg" }] } : {}),
        };
      }
      const meta = services.works.meta(work);
      const note = entry.type === "resource" && meta.ok ? canvasNote(`${entry.preview.width}×${entry.preview.height}`, meta.meta) : "";
      const text = describeEntry(entry) + (note ? `\n\n注意：${note}` : "");
      if (entry.type !== "resource" || !image) return asJson({ id: entry.id, type: entry.type }, text);
      const { frames } = await services.renderer.resourceFrames(work, { ref: entry.ref, key: entry.key, preset, values: params, times, width });
      const images =
        frames.length > 1
          ? [
              {
                data: await contactSheet(
                  await Promise.all(frames.map(async (frame) => ({ ...frame, png: await sharp(frame.png).resize({ width: 360 }).png().toBuffer() }))),
                  360,
                  Math.round((360 * (entry.preview.height || 1)) / (entry.preview.width || 1)),
                ),
                mimeType: "image/jpeg",
              },
            ]
          : [{ data: await sharp(frames[0].png).jpeg({ quality: 85 }).toBuffer(), mimeType: "image/jpeg" }];
      return { data: { id: entry.id, times: frames.map((frame) => frame.time) }, text: text + `\n\n预览：${frames.map((frame) => `${frame.time} 秒`).join("、")}${preset ? `，预设「${preset}」` : ""}${params ? `，参数 ${JSON.stringify(params)}` : ""}`, images };
    },
  });
}

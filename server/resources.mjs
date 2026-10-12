import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { z } from "zod";
import sharp from "sharp";
import { problem, notFound, sha256, writeFileAtomic, Lru } from "./util.mjs";
import { sendFile, sendJson } from "./http.mjs";
import { workArg, repoArg, asJson } from "./tools/registry.mjs";
import { contactSheet } from "./render.mjs";
import { Thumbnails } from "./thumbnails.mjs";
import { closestLibraries, offerOrder, SUGGEST } from "./libraries.mjs";

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
/** Engines a resource preview draws with (src/engine/resources.ts); canvas when it does not say. */
export const RESOURCE_ENGINES = { canvas: "Canvas 2D", three: "Three.js 三维", pixi: "PixiJS" };
const ENGINE_TAGS = { three: "三维", pixi: "Pixi" };

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
/** `x as const`, `x satisfies T`, `(x)`, `x!` → x */
const unwrap = (node) => {
  while (node && ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression", "TSNonNullExpression"].includes(node.type)) node = node.expression;
  return node;
};
/** The properties of an object literal, including those spread in from constant object literals (`...SCREEN`). */
function propertiesOf(object, bindings, depth = 0) {
  object = unwrap(object);
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
      else if (method === "gt" && typeof argument === "number") Object.assign(schema, { min: argument, minExclusive: true });
      else if (method === "lt" && typeof argument === "number") Object.assign(schema, { max: argument, maxExclusive: true });
      else if (method === "int") schema.int = true;
      else if (method === "positive") Object.assign(schema, { min: 0, minExclusive: true });
      else if (method === "nonnegative") schema.min = schema.min ?? 0;
      else if (method === "meta" && argument && typeof argument === "object") {
        if (typeof argument.description === "string") schema.description = argument.description;
        if (typeof argument.title === "string") schema.label = argument.title;
        if (typeof argument.step === "number") schema.step = argument.step;
      }
    }
    return schema;
  };
  // `{ ...sizes }` and `{ ...base.shape }` (another z.object's fields) count as fields too.
  const shapes = (object, depth) => {
    object = unwrap(object);
    if (depth > 8) return [];
    if (object?.type === "Identifier" && bindings.has(object.name)) return shapes(bindings.get(object.name), depth + 1);
    if (object?.type === "MemberExpression" && !object.computed && object.property.name === "shape") {
      let schema = object.object;
      while (schema?.type === "Identifier" && bindings.has(schema.name)) schema = bindings.get(schema.name);
      return schema?.type === "CallExpression" ? shapes(schema.arguments[0], depth + 1) : [];
    }
    if (object?.type !== "ObjectExpression") return [];
    return object.properties.flatMap((property) =>
      property.type === "SpreadElement" ? shapes(property.argument, depth + 1) : property.type === "ObjectProperty" && !property.computed ? [property] : [],
    );
  };
  const fieldsOf = (object, depth) => {
    const found = new Map(shapes(object, 0).map((property) => [keyOf(property), property]));
    return [...found.values()].map((property) => {
      const field = { name: keyOf(property), ...describe(property.value, depth) };
      // A comment above the field documents it when .describe() does not.
      const note = commentText(property.leadingComments);
      if (note && !field.description) field.description = note;
      return field;
    });
  };
  return describe;
}

/** "10–200", "> 0", "≥ 0", "≤ 1", "0–1（不含 0）" */
function range({ min, max, minExclusive, maxExclusive }) {
  if (min !== undefined && max !== undefined) {
    const open = [minExclusive && min, maxExclusive && max].filter((value) => value !== false && value !== undefined);
    return `${min}–${max}${open.length ? `（不含 ${open.join("、")}）` : ""}`;
  }
  if (min !== undefined) return `${minExclusive ? ">" : "≥"} ${min}`;
  return `${maxExclusive ? "<" : "≤"} ${max}`;
}
/** One line for a parameter: name?: type = default — description */
export function paramLine(param) {
  const type =
    param.type === "enum"
      ? param.values.map((item) => JSON.stringify(item)).join(" | ")
      : param.type === "literal"
        ? JSON.stringify(param.value)
        : param.type === "number" && (param.min !== undefined || param.max !== undefined)
          ? `${param.int ? "整数" : "number"} ${range(param)}`
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
/**
 * The constants a module gets from its library neighbours (`import { W } from "./draw"` with
 * `export const W = 1080` there), so declarations written with them still read statically.
 */
export function importedConstants(code, ref, readNeighbour) {
  const found = new Map();
  let ast;
  try {
    ast = parseCode(code, ref);
  } catch {
    return found;
  }
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration" || !statement.source.value.startsWith(".")) continue;
    const neighbour = readNeighbour(path.posix.join(path.posix.dirname(ref), statement.source.value));
    if (!neighbour) continue;
    let other;
    try {
      other = parseCode(neighbour.code, neighbour.ref).program;
    } catch {
      continue;
    }
    const constants = new Map();
    for (const raw of other.body) {
      const declaration = raw.type === "ExportNamedDeclaration" ? raw.declaration : null;
      if (declaration?.type === "VariableDeclaration" && declaration.kind === "const")
        for (const item of declaration.declarations)
          if (item.id.type === "Identifier" && ["NumericLiteral", "StringLiteral", "BooleanLiteral", "UnaryExpression", "BinaryExpression"].includes(item.init?.type)) constants.set(item.id.name, item.init);
    }
    for (const specifier of statement.specifiers)
      if (specifier.type === "ImportSpecifier" && constants.has(specifier.imported.name ?? specifier.imported.value)) found.set(specifier.local.name, constants.get(specifier.imported.name ?? specifier.imported.value));
  }
  return found;
}

export function extractModule(code, ref, imported = new Map()) {
  let ast;
  try {
    ast = parseCode(code, ref);
  } catch (error) {
    return { ref, doc: "", exports: [], resources: [], sounds: [], errors: [error.message] };
  }
  const program = ast.program;
  const bindings = new Map(imported);
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
      const draw = preview.get("draw") ?? preview.get("build");
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
          engine: previewField("engine") ?? "canvas",
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
    this.thumbs = new Thumbnails(this.dir);
    this.overviews = new Map(); // repo → Promise of overview(), until the libraries change
    this.overviewed = new Map(); // repo → its last overview, for the (synchronous) session brief
  }
  get materials() {
    return this.services.materials;
  }

  async module(repo, ref, blob) {
    const code = await this.materials.text(repo, blob);
    // Constants imported from neighbouring files count, so their versions are part of the key.
    const head = await this.materials.headOf(repo);
    const neighbours = new Map();
    for (const match of code.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = path.posix.join(path.posix.dirname(ref), match[1]);
      const found = [base, ...[".ts", ".mts", ".js", ".mjs", "/index.ts"].map((ending) => base + ending)].find((candidate) => head.has(candidate));
      if (found) neighbours.set(base, { ref: found, blob: head.get(found) });
    }
    const key = [blob, ...[...neighbours.values()].map((item) => item.blob)].join("+");
    let parsed = this.parsed.get(key);
    if (!parsed) {
      const texts = new Map();
      for (const [base, item] of neighbours) texts.set(base, { ref: item.ref, code: await this.materials.text(repo, item.blob) });
      parsed = extractModule(code, ref, importedConstants(code, ref, (base) => texts.get(base)));
      this.parsed.set(key, parsed);
    }
    return { ...parsed, ref, library: ref.split("/")[0], blob };
  }

  /**
   * The library code modules as the libraries have them now — what previews and thumbnails
   * run too. `outdated`: the work locked another version of the file (it runs that one).
   */
  async modules(work, { library, libraries } = {}) {
    const head = await this.materials.headOf(work.repo);
    const locks = this.materials.readLocks(work.dir);
    const result = [];
    // Dot folders are no libraries (.trash holds deleted ones).
    const wanted = (ref) => !ref.startsWith(".") && (!library || ref.startsWith(library + "/")) && (!libraries || libraries.has(ref.split("/")[0]));
    const refs = [...head.keys()].filter((ref) => CODE_FILE.test(ref) && wanted(ref)).sort();
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
      engine: item.preview.engine,
      ref: mod.ref,
      library: mod.library,
      import: importOf(mod.ref),
      outdated: mod.outdated,
      text: [RESOURCE_ENGINES[item.preview.engine], ENGINE_TAGS[item.preview.engine], item.usage, item.params.map(paramLine).join(" "), Object.keys(item.presets).join(" ")].filter(Boolean).join(" "),
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

  async search(work, { query, kind, library, engine, limit = 30 }) {
    const modules = await this.modules(work, { library });
    let entries = this.entries(modules);
    if (kind && kind !== "code") entries = entries.filter((entry) => entry.kind === kind);
    if (engine) entries = entries.filter((entry) => entry.type === "resource" && entry.engine === engine);
    // Exported functions and types join the results only when looking for something.
    const code = query && (!kind || kind === "code") && !engine ? modules.flatMap((mod) => mod.exports.filter((item) => item.kind !== "reexport").map((item) => this.codeEntry(mod, item))) : [];
    // Among equally good matches, the work's own libraries first.
    const linked = new Set(work.dir ? this.materials.names(work) : []);
    return [...(kind === "code" ? [] : entries), ...code]
      .map((entry) => ({ entry, score: score(entry, query) * (entry.type === "code" ? 0.6 : 1) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Number(linked.has(b.entry.library)) - Number(linked.has(a.entry.library)))
      .slice(0, query ? limit : Infinity)
      .map((item) => item.entry);
  }

  /**
   * Library files (Lottie, images, models, audio…) that match a query: by name, kind and the
   * README lines that mention them (where libraries say what a file is).
   */
  async searchFiles(repo, { query, library, limit = 20 }) {
    if (!terms(query).length) return [];
    const libraries = (await this.materials.libraries(repo)).filter((item) => !library || item.id === library);
    const dir = await this.materials.dir(repo);
    const found = [];
    for (const { id } of libraries) {
      let readme = [];
      try {
        readme = fs.readFileSync(path.join(dir, id, "README.md"), "utf8").split("\n");
      } catch {}
      for (const file of await this.materials.files(repo, id)) {
        if (file.kind === "file" || CODE_FILE.test(file.path)) continue;
        const name = path.posix.basename(file.path);
        // Lines naming the file, or its stem as a word ("Fox" for models/Fox.glb).
        const stem = name.replace(/\.[^.]+$/, "");
        const word = stem.length >= 3 ? new RegExp(`(^|[^A-Za-z0-9])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i") : null;
        const mentions = readme.filter((line) => line.includes(file.path) || line.includes(name) || word?.test(line)).map((line) => line.replace(/^[-*|#\s]+/, "").trim());
        const entry = { type: "file", id: `materials/${file.ref}`, title: name, key: file.path, kindLabel: FILE_KINDS[file.kind] ?? file.kind, kind: file.kind, description: mentions.join(" "), tags: [id] };
        const value = score(entry, query);
        if (value > 0) found.push({ entry, value });
      }
    }
    return found.sort((a, b) => b.value - a.value).slice(0, limit).map((item) => item.entry);
  }

  /** `<library>/<path>` (a module) or `<library>/<path>#<id>` (a resource, sound or export). */
  async get(work, id) {
    const [ref, key] = String(id).replace(/^materials\//, "").split("#");
    if (!ref || !CODE_FILE.test(ref)) throw problem(400, `资源地址应为 <素材库>/<路径>.ts#<名称>，例如 s0rrow/code/kid.ts#kid（收到 ${id}）`);
    const head = await this.materials.headOf(work.repo);
    const locks = this.materials.readLocks(work.dir);
    const blob = head.get(ref);
    if (!blob) {
      const library = ref.split("/")[0];
      const known = [...new Set([...head.keys()].filter((path) => path.includes("/") && !path.startsWith(".")).map((path) => path.split("/")[0]))];
      if (known.includes(library)) throw notFound(`素材库「${library}」里没有 ${ref.slice(library.length + 1)}（resources_search 找资源的地址）`);
      const close = closestLibraries(library, known.map((id) => ({ id, title: id })));
      throw notFound(`作品库 ${work.repo} 里没有素材库「${library}」${close.length ? `。最接近的：${close.map((item) => `「${item.id}」`).join("")}` : ""}（resources_search 找资源的地址）`);
    }
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
    const job = {
      work,
      ref,
      key,
      id,
      version,
      render: (file) => this.renderThumbnail(job, file),
      done: (error) => this.services.events.emit({ type: "resource-thumb", repo: work.repo, id, version, ...(error ? { error: error.message } : {}) }),
    };
    return { ...this.thumbs.request(`${sha256(`${version}|${key}`).slice(0, 32)}.webp`, job), version };
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
    const result = [];
    for (const library of await this.materials.libraries(repo)) {
      const kinds = new Map();
      const canvases = new Map();
      const engines = {};
      // What the library holds, in words: how a work finds the library that suits it.
      const words = new Set();
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
        for (const item of mod.sounds) for (const word of [item.title, ...(item.tags ?? [])]) if (word) words.add(String(word));
        for (const item of mod.resources) {
          resources++;
          const label = RESOURCE_KINDS[item.kind] ?? item.kind;
          kinds.set(label, (kinds.get(label) ?? 0) + 1);
          for (const word of [label, item.title, ...(item.tags ?? []), ENGINE_TAGS[item.preview?.engine]]) if (word) words.add(String(word));
          if (ENGINE_TAGS[item.preview?.engine]) engines[ENGINE_TAGS[item.preview.engine]] = (engines[ENGINE_TAGS[item.preview.engine]] ?? 0) + 1;
          const { width, height } = item.preview ?? {};
          // A three resource's picture is only a view of it (the work's camera frames it): not a layout canvas.
          if (width > 0 && height > 0 && item.preview?.engine !== "three") canvases.set(`${width}×${height}`, (canvases.get(`${width}×${height}`) ?? 0) + 1);
        }
      }
      const canvas = [...canvases].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const order = (label) => (Object.values(RESOURCE_KINDS).indexOf(label) + 100) % 100;
      const sorted = Object.fromEntries([...kinds].sort(([a], [b]) => order(a) - order(b)));
      if (sounds) words.add("音效");
      result.push({ id: library.id, title: library.title, files: library.files, resources, sounds, kinds: sorted, ...(Object.keys(engines).length ? { engines } : {}), canvas, about: library.about, words: [...words].join(" ").slice(0, 3000) });
    }
    return result;
  }
  /**
   * Which libraries to describe to an AI for a work: all of a few; of many, the work's own and
   * the ones that suit it (else the most used). `annotated`: the libraries as the library index
   * ranked them for the work (null: not known yet). Returns the overview entries and how many
   * were left out.
   */
  pick(work, overview, annotated, { few = 10, offers = 6 } = {}) {
    const linked = this.materials.names(work);
    const own = linked.map((id) => overview.find((library) => library.id === id)).filter(Boolean);
    const info = new Map((annotated ?? []).map((library) => [library.id, library]));
    // The overview's facts, with how much each library is used and how well it suits the work.
    const others = offerOrder(overview.filter((library) => !linked.includes(library.id)).map((library) => ({ ...info.get(library.id), ...library })));
    if (overview.length <= few) return { shown: [...own, ...others], rest: 0 };
    const suitable = others.filter((library) => library.score >= SUGGEST).slice(0, offers);
    const shown = [...own, ...(suitable.length ? suitable : others.filter((library) => library.works).slice(0, offers))];
    return { shown, rest: overview.length - shown.length, offered: suitable.length ? "suitable" : "used" };
  }

  /**
   * The libraries as materials.libraries() lists them, with `extra`: the words of what they
   * hold (resource and sound titles, tags, kinds), for search and for what suits a work.
   */
  async librariesWithWords(repo) {
    const [libraries, overview] = await Promise.all([this.materials.libraries(repo), this.overview(repo).catch(() => [])]);
    const words = new Map(overview.map((library) => [library.id, library.words]));
    return libraries.map((library) => ({ ...library, extra: words.get(library.id) ?? "" }));
  }

  /** work_context's view of the libraries: the work's own and some others, and how they fit its picture. */
  async librariesFor(work) {
    const linked = new Set(this.materials.names(work));
    const meta = this.services.works.meta(work);
    const overview = await this.overview(work.repo);
    const annotated = this.services.libraries ? await this.services.libraries.annotate("materials", work.repo, overview.map((library) => ({ ...library, extra: library.words })), work) : null;
    const { shown, rest } = this.pick(work, overview, annotated);
    const libraries = shown.map((library) => {
      const note = library.canvas && meta.ok ? canvasNote(library.canvas, meta.meta) : "";
      const { score: _score, usedAt: _usedAt, why, linked: _linked, words: _words, extra: _extra, ...facts } = library;
      return { ...facts, linked: linked.has(library.id), ...(!linked.has(library.id) && why?.length ? { why } : {}), ...(note ? { canvasNote: note } : {}) };
    });
    return {
      total: overview.length,
      libraries,
      ...(rest ? { more: `作品库里还有 ${rest} 个素材库没有列出：materials_list 的 query 按名称和介绍查找，resources_search 按内容找（角色、效果、音效、图片、模型等）。` } : {}),
      hint: overview.some((library) => library.resources || library.sounds)
        ? "画角色、场景、道具、效果，配音效之前先用 resources_search 找现成的，resource_view 看用法、参数和预览图；第一次用一个素材库先读它的 README（material_read）。"
        : "素材库里还没有声明资源；共用的文件用 materials_list 查看。",
    };
  }

  /**
   * The session brief's section on the libraries (from the last overview and library ranking;
   * the agent manager prepares both). Kept within a budget however many libraries there are.
   */
  brief(work) {
    const overview = this.overviewed.get(work.repo);
    if (!overview?.length) return null;
    const linked = new Set(this.materials.names(work));
    const meta = this.services.works.meta(work);
    const { shown, rest, offered } = this.pick(work, overview, this.services.libraries?.preparedFor(work)?.materials ?? null);
    const name = (library) => `「${library.id}」${library.title !== library.id ? `（${library.title}）` : ""}`;
    const full = (library) => {
      const kinds = Object.entries(library.kinds).map(([label, count]) => `${label} ${count}`).join("、");
      const engines = Object.entries(library.engines ?? {}).map(([label, count]) => `${label} ${count}`).join("、");
      const holds = [library.resources ? `资源 ${library.resources} 个（${kinds}${engines ? `；其中 ${engines}` : ""}）` : "", library.sounds ? `音效 ${library.sounds} 个` : "", `文件 ${library.files} 个`].filter(Boolean).join("、");
      const note = library.canvas && meta.ok ? canvasNote(library.canvas, meta.meta) : "";
      const why = !linked.has(library.id) && library.why?.length ? `（${library.why.join("；")}）` : "";
      return `- ${name(library)}${linked.has(library.id) ? "（本作品已关联）" : why}：${holds}。${library.about ? library.about + " " : ""}${note}`.trim();
    };
    const short = (library) => `- ${name(library)}${linked.has(library.id) ? "（本作品已关联）" : ""}：${[library.resources ? `资源 ${library.resources} 个` : "", library.sounds ? `音效 ${library.sounds} 个` : "", `文件 ${library.files} 个`].filter(Boolean).join("、")}`;
    // However many libraries the work links, the section stays small: details give way to names.
    const budget = 6000;
    const size = (lines) => Buffer.byteLength(lines.join("\n"), "utf8");
    let lines = shown.map(full);
    if (size(lines) > budget) lines = shown.map((library) => (linked.has(library.id) ? full(library) : short(library)));
    if (size(lines) > budget) lines = shown.map(short);
    let dropped = 0;
    while (lines.length && size(lines) > budget) {
      lines.pop();
      dropped++;
    }
    const left = rest + dropped;
    const label = rest ? `下面是${linked.size ? `本作品关联的和${offered === "suitable" ? "可能适合它的" : "用得最多的"}` : offered === "suitable" ? "可能适合本作品的" : "用得最多的"}` : "";
    const tail = left
      ? `\n\n作品库里共有 ${overview.length} 个素材库，${label ? label + "，" : ""}还有 ${left} 个没有列出：materials_list 的 query 按名称和介绍查找，resources_search 按内容找。`
      : "";
    return {
      text: `## 素材库\n\n多个作品共用的角色、场景、道具、效果、转场、文字、音效和代码。画一个东西、配一个音效之前先用 resources_search 找，有就导入复用（不合适就给素材库代码加参数）；resource_view 看用法、参数和预览图；第一次用一个素材库先读它的 README（material_read）。地址里写素材库的文件夹名（「」里的第一个名字）。\n\n${lines.join("\n")}${tail}`,
    };
  }

  /** The libraries changed: thumbnails waiting for versions that are gone are not wanted any more. */
  dropOutdated(repo) {
    return this.thumbs.drop(async (job) => job.work.repo === repo && (await this.version(job.work, job.ref).catch(() => "")) !== job.version);
  }
}

const kindArg = z.enum([...Object.keys(RESOURCE_KINDS), "code", "file"]);
/** Words a file's kind is found by. */
const FILE_KINDS = {
  image: "图片 图像 照片 插画",
  video: "视频 片段",
  audio: "音频 声音 音乐 配乐 音效",
  model: "三维模型 模型 3D",
  lottie: "Lottie 动画 动效 贴纸 图标",
  environment: "全景图 环境光 HDR",
  font: "字体",
};
const OUTDATED = "（这里是素材库现在的版本；本作品锁定了另一个版本，运行时用锁定的，要改用这个版本：materials_use 加 update: true）";

function describeModule(mod) {
  const lines = [`materials/${mod.ref}${mod.outdated ? OUTDATED : ""}`, `导入：import { … } from "${importOf(mod.ref)}"`];
  if (mod.doc) lines.push("", mod.doc);
  if (mod.resources.length) {
    lines.push("", `资源（${mod.resources.length}）：`);
    for (const item of mod.resources) lines.push(`- [${RESOURCE_KINDS[item.kind] ?? item.kind}${engineTag(item.preview?.engine)}] ${mod.ref}#${item.key} ${item.title}${item.description ? " — " + firstLine(item.description) : ""}`);
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

const engineTag = (engine) => (ENGINE_TAGS[engine] ? ` · ${ENGINE_TAGS[engine]}` : "");
/** Where a resource of each engine goes in a work. */
const ENGINE_USE = {
  canvas: "（在 Canvas 2D 场景里调用；见 frame_guide scene）",
  three: "（在 three 场景里用：createThreeScene 的 build 里调用，作为 visual.json 的 scene 图层时 engine 写 three；见 frame_guide three）",
  pixi: "（在 Pixi 场景里用：createPixiScene 的 build 里调用，作为 scene 图层时 engine 写 pixi；见 frame_guide pixi）",
};

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
  const lines = [`[${entry.kindLabel}${engineTag(entry.engine)}] ${entry.id} ${entry.title}${entry.outdated ? OUTDATED : ""}`];
  if (entry.description) lines.push(entry.description);
  if (entry.tags?.length) lines.push(`标签：${entry.tags.join("、")}`);
  lines.push(`引擎：${RESOURCE_ENGINES[entry.engine] ?? entry.engine}${ENGINE_USE[entry.engine] ?? ""}`);
  lines.push("", `导入：import { … } from "${entry.import}"`);
  if (entry.usage) lines.push(`用法：${entry.usage}`);
  if (entry.preview?.draw) lines.push(`${entry.engine === "canvas" ? "预览里的画法" : "预览里的搭法"}：${entry.preview.draw}`);
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
export function canvasNote(canvas, meta, engine) {
  const [width, height] = String(canvas).split("×").map(Number);
  const { width: W, height: H } = meta.composition ?? { width: 1920, height: 1080 };
  if (!(width > 0 && height > 0 && W > 0 && H > 0)) return "";
  if (Math.abs(Math.log(width / height / (W / H))) < 0.08) {
    // Same shape, other size: coordinates and sizes copied from the preview come out too small or large.
    const factor = W / width;
    if (Math.abs(Math.log(factor)) < 0.2) return "";
    const times = Number(factor.toFixed(2));
    const how =
      engine === "pixi"
        ? `给资源的容器 scale.set(${times})，或者资源有 width/height 参数时传作品的尺寸`
        : engine === "canvas"
          ? `在作品的场景里先 ctx.scale(${times}, ${times}) 再按预览的坐标画，或者把坐标和尺寸乘以 ${times}`
          : `Canvas 资源先 ctx.scale(${times}, ${times}) 再画，Pixi 资源给容器 scale.set(${times})，或者把坐标和尺寸乘以 ${times}`;
    return `预览按 ${width}×${height} 的画布设计，本作品画面是 ${W}×${H}（${times} 倍）：照搬预览里的坐标和尺寸会${factor > 1 ? "偏小" : "偏大"}，${how}。`;
  }
  const shape = (w, h) => (w > h * 1.05 ? "横屏" : h > w * 1.05 ? "竖屏" : "方形");
  return `按 ${width}×${height}（${shape(width, height)}）的画布设计，本作品画面是 ${W}×${H}（${shape(W, H)}）：要铺满整个画面时会被裁切或留边（先看素材库 README 的说明）；只用作画面里的局部元素时，按比例换算位置和大小即可。`;
}

const DIRECTORY_LIMIT = 8000; // characters of the full directory before resources_search lists a summary instead

/**
 * resources_search without a query: every entry by library and kind ("full"), counts and the
 * first few titles of each kind ("summary"), or — for many libraries — that for the work's
 * own libraries and one line of counts for each other one ("libraries"). The work's libraries
 * come first.
 */
function directory(entries, linked, level) {
  const libraries = new Map();
  for (const entry of entries) libraries.set(entry.library, [...(libraries.get(entry.library) ?? []), entry]);
  const order = (kind) => (Object.keys(RESOURCE_KINDS).indexOf(kind) + 100) % 100; // known kinds in their order, others after
  const byKind = (list) => {
    const kinds = new Map();
    for (const entry of list) kinds.set(entry.kind, [...(kinds.get(entry.kind) ?? []), entry]);
    return [...kinds].sort(([a], [b]) => order(a) - order(b));
  };
  const sorted = [...libraries].sort(([a], [b]) => Number(linked.has(b)) - Number(linked.has(a)) || a.localeCompare(b, "zh"));
  const sections = [];
  const others = [];
  for (const [name, list] of sorted) {
    if (level === "libraries" && !linked.has(name)) {
      others.push(`- 「${name}」：${byKind(list).map(([, group]) => `${group[0].kindLabel} ${group.length}`).join("、")}`);
      continue;
    }
    const lines = [`## 素材库「${name}」${linked.has(name) ? "（本作品已关联）" : "（本作品未关联，materials_use 时会自动关联）"}`];
    for (const [kind, group] of byKind(list)) {
      const label = `${group[0].kindLabel}（${group.length}）`;
      if (level !== "full") {
        const shown = group.slice(0, kind === "sound" ? 12 : 8).map((entry) => entry.title);
        lines.push(`${label}：${shown.join("、")}${group.length > shown.length ? `……（kind: "${kind}"）` : ""}`);
      } else if (kind === "sound")
        lines.push(`${label}：${[...new Set(group.map((entry) => entry.ref))].map((ref) => `${ref}#…：${group.filter((entry) => entry.ref === ref).map((entry) => `${entry.key} ${entry.title}`).join("、")}`).join("\n")}`);
      else lines.push(`${label}：${group.map((entry) => `${entry.id} ${entry.title}${ENGINE_TAGS[entry.engine] ? `（${ENGINE_TAGS[entry.engine]}）` : ""}`).join("；")}`);
    }
    sections.push(lines.join("\n"));
  }
  if (others.length) {
    const shown = others.slice(0, 60);
    sections.push(`## 其他素材库（${others.length} 个，本作品未关联；用 library 看一个的目录）\n${shown.join("\n")}${others.length > shown.length ? `\n……还有 ${others.length - shown.length} 个（用 query 搜索）` : ""}`);
  }
  return sections.join("\n\n");
}

export function resourcesPlugin(services) {
  const { router, tools } = services;
  const catalog = (services.resources = new ResourceCatalog(services));
  services.works.briefProviders.push((work) => catalog.brief(work));
  services.repos.beforeRemove.push((repo) => (catalog.overviews.delete(repo), catalog.overviewed.delete(repo)));
  const open = (params) => services.openWork(params.id, params.repo);

  /**
   * The libraries' resources and sounds for the workbench, marked when the work links their
   * library: of every library, one (`library`), or the work's own (`scope=linked`).
   */
  router.get("/api/works/:repo/:id/resources", async ({ params, query }) => {
    const work = await open(params);
    const linked = new Set(services.materials.names(work));
    const modules = await catalog.modules(work, { library: query.library || undefined, libraries: query.scope === "linked" ? linked : undefined });
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
      "在素材库里找可以直接复用的资源：角色、物品、场景、界面、效果、转场、文字（歌词等）、音效，以及素材库代码导出的函数和类型。query 用中文或英文关键词（例如「下雨 街道」「手机 聊天」「甩镜」）；不给 query 列出目录（资源多时每类只列前几个，再用 kind 列出一类）。kind 限定类别（code 只找函数和类型）。给了 query 时还会一起找素材库里的文件（Lottie、图片、模型、音频、字体：按文件名、类型和素材库 README 里对它的说明），kind 设为 file 只找文件。动手画一个东西之前先找，有就导入复用，不要重画。看详情和预览图用 resource_view。还没有作品时用 repo 指定作品库。",
    readOnly: true,
    input: {
      work: workArg,
      repo: repoArg,
      query: z.string().max(200).optional(),
      kind: kindArg.optional().describe("character 角色、prop 物品、set 场景、ui 界面、effect 效果、transition 转场、text 文字、sound 音效、code 函数和类型、file 只找素材库里的文件"),
      library: z.string().max(60).optional().describe("只找这个素材库"),
      engine: z.enum(Object.keys(RESOURCE_ENGINES)).optional().describe("只找用这个引擎画的资源：canvas（Canvas 2D）、three（三维）、pixi"),
      limit: z.number().int().min(1).max(100).default(30),
    },
    async run({ query, kind, library, engine, limit }, ctx) {
      const work = await ctx.place();
      const linked = new Set(services.materials.names(work));
      const found = kind === "file" ? [] : await catalog.search(work, { query, kind, library, engine, limit });
      // Files (Lottie, images, models, audio) are looked for too: people ask for "爱心" meaning either.
      const fileHits = query && !engine && (!kind || kind === "file") ? await catalog.searchFiles(work.repo, { query, library, limit: kind === "file" ? limit : 8 }) : [];
      const fileLine = (entry) => `- [文件 · ${entry.kindLabel.split(" ")[0]}] ${entry.id}${entry.description ? " — " + entry.description.slice(0, 120) : ""}`;
      // Library file names are mostly English: a Chinese query that found no file may find one in English.
      const english = query && /[\u4e00-\u9fff]/.test(query) && !fileHits.length && !engine && (!kind || kind === "file") ? "\n\n素材库里的文件名多是英文：找图片、Lottie、模型等文件时也用英文关键词试一次（例如 heart、fox、star）。" : "";
      const filesPart = fileHits.length ? `\n\n素材库里的文件 ${fileHits.length} 个（图层、代码里直接用这个地址；asset_view 看样子）：\n${fileHits.map(fileLine).join("\n")}` : "";
      const line = (entry) =>
        entry.type === "code"
          ? `- [${entry.kindLabel}] ${entry.id} ${entry.signature}${entry.doc ? `  // ${firstLine(entry.doc)}` : ""}`
          : `- [${entry.kindLabel}${engineTag(entry.engine)}] ${entry.id} ${entry.title}${entry.type === "sound" && entry.duration && !/\d\s*秒/.test(entry.title) ? `（${entry.duration} 秒）` : ""}${entry.description ? " — " + firstLine(entry.description) : ""}`;
      const files = "素材库里的文件（Lottie、图片、模型、音频、字体）用 materials_list 列出、asset_view 查看。";
      if (!found.length && fileHits.length) return asJson({ items: [], files: fileHits }, kind === "file" ? filesPart.trim() : `没有找到「${query}」相关的资源（代码声明的）。${filesPart.trim()}`);
      if (!found.length) return asJson({ items: [] }, query ? `没有找到「${query}」相关的资源和文件。可以换个说法，或不给 query 看全部目录。${files}${english}` : `素材库里还没有声明资源（见 frame_guide resources）。${files}`);
      let text;
      // Several words that nothing matches together: say the list is the partial matches.
      const words = terms(query ?? "");
      const partial = words.length > 1 && !found.some((entry) => score(entry, query) >= 100 * words.length);
      if (query) text = `${partial ? `没有同时符合「${words.join("」「")}」的；下面是符合其中一部分的 ` : "找到 "}${found.length} 个：\n${found.map(line).join("\n")}${filesPart}${english}`;
      else {
        // The directory, by library and kind; once it gets long, only the first few of each kind,
        // and for many libraries only counts of the ones the work does not link.
        text = directory(found, linked, "full");
        const summary = text.length > DIRECTORY_LIMIT;
        if (summary) text = directory(found, linked, "summary");
        if (text.length > DIRECTORY_LIMIT && !library) text = directory(found, linked, "libraries");
        text += summary
          ? `\n\n资源较多，只列出了一部分：${kind ? "用 query 搜索这一类" : "用 kind 列出一类、library 只看一个素材库，或用 query 搜索"}，拿到地址后用 resource_view 看详情。`
          : "\n\n地址写法 <素材库>/<文件>#<名称>；resource_view 看详情和预览图，音效用 audio_place 的 sound 放到音轨。";
      }
      return asJson({ items: found.slice(0, 500).map(({ text: _text, ...entry }) => entry), ...(fileHits.length ? { files: fileHits } : {}) }, text);
    },
  });

  tools.add({
    name: "resource_view",
    title: "查看资源",
    description:
      "看素材库里一个资源的详情和预览图：用法、导入语句、参数（类型、取值、默认值、说明）、预设，并按作品的节拍渲染出来（素材库现在的版本）。id 是 resources_search 给出的地址：资源或音效 <素材库>/<文件>#<名称>，函数和类型同样写法；只写 <素材库>/<文件> 看整个模块（文档、全部资源和导出）。params / preset 按给定参数渲染，times 看动画的几个时刻。还没有作品时用 repo 指定作品库（不按作品的节拍）。",
    readOnly: true,
    input: {
      work: workArg,
      repo: repoArg,
      id: z.string().min(3).max(300),
      preset: z.string().max(100).optional(),
      params: z.record(z.string(), z.json()).optional().describe("覆盖预设的参数值"),
      times: z.array(z.number().nonnegative()).max(12).optional().describe("动画资源看哪些时刻（秒）"),
      image: z.boolean().default(true).describe("是否渲染预览图"),
      width: z.number().int().min(160).max(1600).default(720),
    },
    async run({ id, preset, params, times, image, width }, ctx) {
      const work = await ctx.place();
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
      let note = entry.type === "resource" && entry.engine !== "three" && meta.ok ? canvasNote(`${entry.preview.width}×${entry.preview.height}`, meta.meta, entry.engine) : "";
      // A resource with its own scale parameter: that is the way to size it, not scaling the canvas
      // too — whether the picture has the preview's shape or not (then the factor that fits it).
      if (note && entry.params?.some((param) => param.name === "scale")) {
        const W = meta.meta.composition?.width ?? 1920, H = meta.meta.composition?.height ?? 1080;
        const factor = Math.round(Math.min(W / entry.preview.width, H / entry.preview.height) * 100) / 100;
        note = `预览按 ${entry.preview.width}×${entry.preview.height} 的画布设计，本作品画面是 ${W}×${H}：用资源自己的 scale 参数调大小（按画面放得下算是 scale: ${factor}，只占一部分时按需要的大小换算），不要再缩放画布。`;
      }
      const text = describeEntry(entry) + (note ? `\n\n注意：${note}` : "");
      if (entry.type !== "resource" || !image) return asJson({ id: entry.id, type: entry.type }, text);
      // An animated resource is shown at a few moments unless asked: one still hides the motion.
      const duration = entry.preview.duration;
      const moments = times ?? (duration ? [0.15, 0.5, 0.85].map((share) => Math.round(share * duration * 100) / 100) : undefined);
      const { frames } = await services.renderer.resourceFrames(work, { ref: entry.ref, key: entry.key, preset, values: params, times: moments, width });
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

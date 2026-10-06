import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

export const validSlug = (id) =>
  typeof id === "string" && id.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id);

const loaders = { load: "scene", loadAudio: "audio", loadVisual: "visual", loadAudioDocument: "audioDocument", loadRemotion: "remotion" };

function parseSource(code, filename = "project.ts") {
  return parse(code, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
    createImportExpressions: true,
    attachComment: false,
  });
}

/**
 * Read project.ts metadata without executing it. Only literals, local constants
 * and `() => import("./x")` loaders are allowed, so listing works never runs code.
 * Returns property source ranges so simple fields can be edited in place.
 */
export function readProjectSource(code) {
  const program = parseSource(code).program;
  const bindings = new Map();
  for (const raw of program.body) {
    const statement = raw.type === "ExportNamedDeclaration" ? raw.declaration : raw;
    if (statement?.type === "VariableDeclaration" && statement.kind === "const")
      for (const declaration of statement.declarations)
        if (declaration.id.type === "Identifier" && declaration.init) bindings.set(declaration.id.name, declaration.init);
  }
  const exported = program.body.find((node) => node.type === "ExportDefaultDeclaration");
  if (!exported) throw new Error("project.ts must export the project as default");
  const loads = {};
  const ranges = {};
  const visiting = new Set();
  function value(node, depth = 0, top = false) {
    if (!node || depth > 64) throw new Error("Missing or excessively nested metadata");
    if (["ParenthesizedExpression", "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(node.type))
      return value(node.expression, depth + 1, top);
    if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(node.type)) return node.value;
    if (node.type === "NullLiteral") return null;
    if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
    if (node.type === "UnaryExpression" && ["-", "+"].includes(node.operator)) {
      const operand = value(node.argument, depth + 1);
      if (typeof operand !== "number") throw new Error("Only numeric unary expressions are allowed in metadata");
      return node.operator === "-" ? -operand : operand;
    }
    if (node.type === "Identifier") {
      if (!bindings.has(node.name) || visiting.has(node.name)) throw new Error(`Non-static metadata: ${node.name}`);
      visiting.add(node.name);
      try {
        return value(bindings.get(node.name), depth + 1, top);
      } finally {
        visiting.delete(node.name);
      }
    }
    if (node.type === "ArrayExpression")
      return node.elements.flatMap((element) => {
        if (element?.type !== "SpreadElement") return [value(element, depth + 1)];
        const array = value(element.argument, depth + 1);
        if (!Array.isArray(array)) throw new Error("Array spread must reference an array literal");
        return array;
      });
    if (node.type === "ObjectExpression") {
      const result = {};
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          Object.assign(result, value(property.argument, depth + 1, top));
          continue;
        }
        if (property.type !== "ObjectProperty" || property.computed) throw new Error("Metadata must use ordinary literal properties");
        const name = property.key.type === "Identifier" ? property.key.name : property.key.value;
        if (name in loaders) {
          const fn = property.value;
          if (fn.type !== "ArrowFunctionExpression" || fn.body.type !== "ImportExpression" || fn.body.source.type !== "StringLiteral")
            throw new Error(`${name} must be () => import("./file")`);
          loads[loaders[name]] = fn.body.source.value;
        } else {
          result[name] = value(property.value, depth + 1);
          if (top) ranges[name] = [property.value.start, property.value.end];
        }
      }
      return result;
    }
    throw new Error("Metadata must be static literals or local constants, not " + node.type);
  }
  const meta = value(exported.declaration, 0, true);
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Project metadata is not an object");
  return { meta, loads, ranges };
}

/** Replace top-level literal fields of project.ts, keeping all other formatting. */
export function updateProjectSource(code, changes) {
  const { ranges } = readProjectSource(code);
  const edits = Object.entries(changes).map(([key, next]) => {
    if (!ranges[key]) throw new Error(`project.ts has no top-level literal field "${key}" to update`);
    return { range: ranges[key], text: JSON.stringify(next) };
  });
  edits.sort((a, b) => b.range[0] - a.range[0]);
  for (const { range, text } of edits) code = code.slice(0, range[0]) + text + code.slice(range[1]);
  return code;
}

export function readProjectDir(dir) {
  const file = path.join(dir, "project.ts");
  const result = readProjectSource(fs.readFileSync(file, "utf8"));
  const json = (name) => {
    const target = path.join(dir, name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`${name} must be a regular file under 4 MiB`);
    return JSON.parse(fs.readFileSync(target, "utf8"));
  };
  if (result.loads.visual === "./visual.json") result.meta.visual = json("visual.json");
  if (result.loads.audioDocument === "./audio.json") result.meta.audioDocument = json("audio.json");
  return { ...result, dir, slug: path.basename(dir) };
}

/** Add a top-level property (raw source) to the default-exported project object if it is missing. */
export function insertProjectProperty(code, key, valueSource) {
  const program = parseSource(code).program;
  const bindings = new Map();
  for (const statement of program.body)
    if (statement.type === "VariableDeclaration")
      for (const declaration of statement.declarations) if (declaration.id.type === "Identifier") bindings.set(declaration.id.name, declaration.init);
  let node = program.body.find((item) => item.type === "ExportDefaultDeclaration")?.declaration;
  while (node && ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type)) node = node.expression;
  if (node?.type === "Identifier") node = bindings.get(node.name);
  while (node && ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type)) node = node.expression;
  if (node?.type !== "ObjectExpression") throw new Error("project.ts 的默认导出不是对象字面量");
  if (node.properties.some((property) => (property.key?.name ?? property.key?.value) === key)) return code;
  const last = node.properties.at(-1);
  const insertion = `\n  ${key}: ${valueSource},`;
  if (!last) return code.slice(0, node.start + 1) + insertion + "\n" + code.slice(node.start + 1);
  let at = last.end;
  const rest = code.slice(at).match(/^\s*,/);
  if (rest) at += rest[0].length;
  else return code.slice(0, at) + "," + insertion + code.slice(at);
  return code.slice(0, at) + insertion + code.slice(at);
}

/** Remove a top-level field (with its comma and line) from the exported object. */
export function removeProjectProperty(code, key) {
  const program = parseSource(code).program;
  const bindings = new Map();
  for (const statement of program.body)
    if (statement.type === "VariableDeclaration")
      for (const declaration of statement.declarations) if (declaration.id.type === "Identifier") bindings.set(declaration.id.name, declaration.init);
  let node = program.body.find((item) => item.type === "ExportDefaultDeclaration")?.declaration;
  while (node && ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type)) node = node.expression;
  if (node?.type === "Identifier") node = bindings.get(node.name);
  while (node && ["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type)) node = node.expression;
  const property = node?.properties?.find((item) => (item.key?.name ?? item.key?.value) === key);
  if (!property) return code;
  let start = property.start;
  let end = property.end;
  const comma = code.slice(end).match(/^\s*,/);
  if (comma) end += comma[0].length;
  // The whole line when the property sits on its own.
  const lineStart = code.lastIndexOf("\n", start - 1) + 1;
  if (!code.slice(lineStart, start).trim()) start = lineStart;
  const rest = code.slice(end).match(/^[ \t]*\r?\n/);
  if (rest && start === lineStart) end += rest[0].length;
  return code.slice(0, start) + code.slice(end);
}

/** Update existing literal fields and add missing ones. */
export function setProjectFields(code, changes) {
  const { ranges } = readProjectSource(code);
  const existing = Object.fromEntries(Object.entries(changes).filter(([key]) => ranges[key]));
  if (Object.keys(existing).length) code = updateProjectSource(code, existing);
  for (const [key, value] of Object.entries(changes)) if (!ranges[key]) code = insertProjectProperty(code, key, JSON.stringify(value));
  return code;
}

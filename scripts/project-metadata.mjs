import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

export const validProjectId = (id) =>
  typeof id === "string" &&
  id.length <= 64 &&
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id);

export function sourceFile(file) {
  return parse(fs.readFileSync(file, "utf8"), {
    sourceType: "module",
    sourceFilename: file,
    plugins: ["typescript", "jsx"],
    createImportExpressions: true,
    attachComment: false,
  });
}
export function visitNodes(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key))
      continue;
    if (Array.isArray(value))
      value.forEach((child) => visitNodes(child, visit));
    else if (
      value &&
      typeof value === "object" &&
      typeof value.type === "string"
    )
      visitNodes(value, visit);
  }
}
export function expressionName(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
    const key = node.computed
      ? node.property.type === "StringLiteral"
        ? node.property.value
        : "?"
      : node.property.name;
    return expressionName(node.object) + "." + key;
  }
  return "";
}

/** Parse literal metadata; never eval it, import a renderer, or start a server. */
export function readProject(file) {
  const source = sourceFile(file),
    bindings = new Map();
  for (const raw of source.program.body) {
    const statement =
      raw.type === "ExportNamedDeclaration" ? raw.declaration : raw;
    if (statement?.type === "VariableDeclaration" && statement.kind === "const")
      for (const declaration of statement.declarations)
        if (declaration.id.type === "Identifier" && declaration.init)
          bindings.set(declaration.id.name, declaration.init);
  }
  const exported = source.program.body.find(
    (node) => node.type === "ExportDefaultDeclaration",
  );
  if (!exported)
    throw new Error("project.ts must have a default project export");
  const visiting = new Set();
  let loadPath, audioLoadPath;
  function value(node, depth = 0) {
    if (!node || depth > 64)
      throw new Error("Missing or excessively nested metadata");
    if (
      [
        "ParenthesizedExpression",
        "TSAsExpression",
        "TSSatisfiesExpression",
        "TSNonNullExpression",
      ].includes(node.type)
    )
      return value(node.expression, depth + 1);
    if (
      ["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(node.type)
    )
      return node.value;
    if (node.type === "NullLiteral") return null;
    if (node.type === "TemplateLiteral" && !node.expressions.length)
      return node.quasis[0].value.cooked;
    if (node.type === "UnaryExpression" && ["-", "+"].includes(node.operator)) {
      const operand = value(node.argument, depth + 1);
      if (typeof operand !== "number")
        throw new Error(
          "Only numeric unary expressions are allowed in metadata",
        );
      return node.operator === "-" ? -operand : operand;
    }
    if (node.type === "Identifier") {
      if (!bindings.has(node.name) || visiting.has(node.name))
        throw new Error(`Non-static or circular metadata: ${node.name}`);
      visiting.add(node.name);
      try {
        return value(bindings.get(node.name), depth + 1);
      } finally {
        visiting.delete(node.name);
      }
    }
    if (node.type === "ArrayExpression")
      return node.elements.flatMap((element) => {
        if (element?.type !== "SpreadElement")
          return [value(element, depth + 1)];
        const array = value(element.argument, depth + 1);
        if (!Array.isArray(array))
          throw new Error("Array spread must reference an array literal");
        return array;
      });
    if (node.type === "ObjectExpression") {
      const result = Object.create(null);
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          const spread = value(property.argument, depth + 1);
          if (!spread || Array.isArray(spread) || typeof spread !== "object")
            throw new Error("Object spread must reference an object literal");
          Object.assign(result, spread);
          continue;
        }
        if (property.type !== "ObjectProperty" || property.computed)
          throw new Error("Metadata must use ordinary literal properties");
        const name =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.value;
        if (name === "load" || name === "loadAudio") {
          const fn = property.value;
          if (
            fn.type !== "ArrowFunctionExpression" ||
            fn.body.type !== "ImportExpression" ||
            fn.body.source.type !== "StringLiteral"
          )
            throw new Error('load must be () => import("./scene")');
          if (name === "load") loadPath = fn.body.source.value;
          else audioLoadPath = fn.body.source.value;
        } else result[name] = value(property.value, depth + 1);
      }
      return result;
    }
    throw new Error(
      "Metadata must be static literals or local constants, not " + node.type,
    );
  }
  const meta = value(exported.declaration);
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("Project metadata is not an object");
  return {
    file,
    directory: path.basename(path.dirname(file)),
    meta,
    loadPath,
    audioLoadPath,
  };
}

export function readProjectCatalog(root = process.cwd()) {
  const directory = path.join(root, "projects");
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (item) =>
        item.isDirectory() &&
        !item.name.startsWith(".") &&
        fs.existsSync(path.join(directory, item.name, "project.ts")),
    )
    .map((item) => readProject(path.join(directory, item.name, "project.ts")))
    .sort((a, b) => a.directory.localeCompare(b.directory));
}

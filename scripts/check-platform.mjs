import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(file);
    else if (/\.(mjs|js|jsx|ts|tsx)$/.test(file)) files.push(file);
  }
}
for (const dir of ["server", "studio"]) walk(dir);
const errors = [];
for (const file of files) {
  try {
    const ast = parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["jsx", "typescript"] });
    function visit(node) {
      if (!node || typeof node !== "object") return;
      let specifier;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) specifier = node.source?.value;
      else if (node.type === "CallExpression" && node.callee?.type === "Import") specifier = node.arguments?.[0]?.value;
      if (typeof specifier === "string" && specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier.split(/[?#]/)[0]);
        const candidates = [target, ...[".js", ".jsx", ".mjs", ".ts", ".tsx", ".json"].flatMap((ext) => [target + ext, path.join(target, "index" + ext)])];
        if (!candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()))
          errors.push(`${file}:${node.loc?.start.line || 0} missing relative import: ${specifier}`);
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "comments", "tokens"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(ast.program);
  } catch (error) { errors.push(`${file}: ${error.message}`); }
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`Platform syntax and relative imports checked: ${files.length} files (not a type or runtime test).`);

import { parse } from "@babel/parser";
import path from "node:path";
/** Bind staticFile to the owning project, even with multiple thumbnail Players. */
export function remotionProjectAssets(code, file, root) {
  const relative = path
    .relative(root, file.split("?")[0])
    .replaceAll("\\", "/");
  const match = /^projects\/([a-z][a-z0-9-]*)\/.*\.[cm]?[jt]sx?$/.exec(
    relative,
  );
  if (!match || !code.includes("remotion")) return;
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const edits = [];
  for (const node of ast.program.body) {
    if (
      node.type !== "ImportDeclaration" ||
      node.source.value !== "remotion" ||
      node.importKind === "type"
    )
      continue;
    const statics = node.specifiers.filter(
      (s) =>
        s.type === "ImportSpecifier" &&
        s.imported.name === "staticFile" &&
        s.importKind !== "type",
    );
    const spaces = node.specifiers.filter(
      (s) => s.type === "ImportNamespaceSpecifier",
    );
    if (!statics.length && !spaces.length) continue;
    const helper =
      '(file)=>{if(typeof file!=="string"||/^(?:[a-z]+:|[.])|\\\\\\\\/.test(file)||file.split("/").some(part=>part==="."||part==="..")||file.includes(String.fromCharCode(92)))throw Error("Invalid project staticFile path");return import.meta.env.BASE_URL+"films/' +
      match[1] +
      '/"+file.replace(/^\\//,"").split("/").map(encodeURIComponent).join("/");}';
    const keep = node.specifiers.filter(
      (s) => !statics.includes(s) && !spaces.includes(s),
    );
    const defaults = keep
      .filter((s) => s.type === "ImportDefaultSpecifier")
      .map((s) => s.local.name);
    const named = keep
      .filter((s) => s.type === "ImportSpecifier")
      .map((s) => code.slice(s.start, s.end));
    const imports = [
      ...defaults,
      ...(named.length ? ["{" + named.join(",") + "}"] : []),
    ];
    let replacement = imports.length
      ? "import " + imports.join(",") + ' from "remotion";'
      : "";
    for (const s of statics)
      replacement += "const " + s.local.name + "=" + helper + ";";
    for (const [i, s] of spaces.entries()) {
      let binding = "__frameRemotion" + node.start + "_" + i;
      while (code.includes(binding)) binding += "_";
      replacement +=
        "import * as " +
        binding +
        ' from "remotion";const ' +
        s.local.name +
        "={..." +
        binding +
        ",staticFile:" +
        helper +
        "};";
    }
    edits.push({ start: node.start, end: node.end, replacement });
  }
  if (!edits.length) return;
  for (const e of edits.reverse())
    code = code.slice(0, e.start) + e.replacement + code.slice(e.end);
  return { code, map: null };
}

import fs from "node:fs";
import path from "node:path";
import { validProjectId } from "./project-metadata.mjs";

export function inside(base, file) {
  const relative = path.relative(base, file);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  );
}

/** Resolve writes before creating anything, including existing symlink ancestors. */
export function projectPath(root, id, relative = "") {
  if (!validProjectId(id)) throw new Error("Invalid project id");
  const base = path.resolve(root, "projects", id);
  const file = path.resolve(base, relative);
  if (!inside(base, file))
    throw new Error("Output must stay inside projects/" + id);
  const projectParent = path.resolve(root, "projects");
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  // Do not allow a project or any child directory to redirect into another project.
  if (fs.existsSync(projectParent) && inside(projectParent, ancestor)) {
    const expected = path.join(fs.realpathSync(projectParent), id);
    if (
      ancestor !== projectParent &&
      !inside(expected, fs.realpathSync(ancestor))
    )
      throw new Error("Project path symlink escapes its directory");
  }
  return file;
}

export function assetPath(root, reference, owner) {
  if (
    typeof reference !== "string" ||
    !reference ||
    /[\\:%?#\u0000-\u001f]/.test(reference) ||
    reference.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid local asset path");
  const match = /^films\/([^/]+)\/(.+)$/.exec(reference);
  if (match) {
    if (owner && owner !== match[1])
      throw new Error("Cross-project asset reference");
    return projectPath(root, match[1], "public/" + match[2]);
  }
  if (owner)
    throw new Error("Project assets must belong to films/" + owner + "/");
  const base = path.resolve(root, "public"),
    file = path.resolve(base, reference);
  if (
    !inside(base, file) ||
    (fs.existsSync(file) &&
      !inside(fs.realpathSync(base), fs.realpathSync(file)))
  )
    throw new Error("Asset symlink escapes public/");
  return file;
}

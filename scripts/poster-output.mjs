import fs from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { assetPath } from "./project-paths.mjs";
import {
  readProject,
  readProjectCatalog,
  validProjectId,
} from "./project-metadata.mjs";
const inside = (base, file) => {
  const rel = path.relative(base, file);
  return (
    !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep)
  );
};

/** Update the path the registry actually references, not a second hard-coded poster folder. */
export async function writeProjectPoster(root, id, png) {
  if (!validProjectId(id)) throw new Error("Invalid project id");
  const { meta } = readProject(path.join(root, "projects", id, "project.ts"));
  const relative = meta.poster;
  if (
    typeof relative !== "string" ||
    !relative ||
    /[\\:%?#\u0000-\u001f]/.test(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid public-relative poster path");
  if (
    readProjectCatalog(root).some(
      (project) => project.meta.id !== id && project.meta.poster === relative,
    )
  )
    throw new Error(
      "Poster is shared with another project; assign a project-owned path before rewriting",
    );
  const base = path.resolve(root, "projects", id),
    output = assetPath(root, relative, id);
  if (!inside(base, output) || !existsSync(base))
    throw new Error("Poster destination must be under public/");
  let ancestor = output;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!inside(realpathSync(base), realpathSync(ancestor)))
    throw new Error("Poster destination symlink escapes public/");
  if (existsSync(output) && !statSync(output).isFile())
    throw new Error("Poster destination is not a regular file");
  const extension = path.extname(output).toLowerCase();
  let bytes;
  if (extension === ".svg") {
    const info = await sharp(png).metadata();
    if (!info.width || !info.height)
      throw new Error("Poster image has no dimensions");
    bytes = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}" viewBox="0 0 ${info.width} ${info.height}"><image width="${info.width}" height="${info.height}" href="data:image/png;base64,${png.toString("base64")}"/></svg>`,
    );
  } else {
    const format = {
      ".webp": "webp",
      ".png": "png",
      ".jpg": "jpeg",
      ".jpeg": "jpeg",
    }[extension];
    if (!format)
      throw new Error(
        "Supported poster extensions: .svg, .webp, .png, .jpg, .jpeg",
      );
    bytes = await sharp(png).toFormat(format, { quality: 92 }).toBuffer();
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(
    path.dirname(output),
    "." + path.basename(output) + "." + randomUUID() + ".tmp",
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.rename(temporary, output);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return output;
}

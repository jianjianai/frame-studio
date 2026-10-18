import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { appRoot } from "./config.mjs";

/**
 * The FRAME 连接器 extension (extension/) as a zip to load unpacked, filled in with this studio's
 * address. Its files sit at the top of the zip: Windows' 全部解压缩 already puts them in a folder
 * named after the zip, and one more folder inside left manifest.json a level too deep.
 */
export function extensionZip(server) {
  const root = path.join(appRoot, "extension");
  const files = {};
  const add = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) add(relative);
      else files[relative] = fs.readFileSync(path.join(root, relative));
    }
  };
  add("");
  files["defaults.json"] = Buffer.from(JSON.stringify({ server }) + "\n");
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** The studio's address as the user's browser reaches it. */
export function studioOrigin(req, config) {
  if (config.publicUrl) return new URL(config.publicUrl).origin;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

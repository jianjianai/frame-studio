import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { appRoot } from "./config.mjs";

const root = path.join(appRoot, "extension");

/**
 * The extension's id and version. The manifest carries a public key, so the id is the same
 * wherever the extension is loaded from: the studio finds it at chrome-extension://<id>/.
 */
export function extensionInfo() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
  return { id: [...digest].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join(""), version: manifest.version };
}

/**
 * The FRAME 连接器 extension (extension/) as a zip to load unpacked, made for this studio: its
 * address to fill in, and its pages (only) allowed to see that the extension is there and to
 * open the one-click pairing page. The files sit at the top of the zip: Windows' 全部解压缩
 * already puts them in a folder named after the zip, and one more folder inside left
 * manifest.json a level too deep.
 */
export function extensionZip(server) {
  const files = {};
  const add = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) add(relative);
      else files[relative] = fs.readFileSync(path.join(root, relative));
    }
  };
  add("");
  const url = new URL(server);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  manifest.web_accessible_resources = [{ resources: ["icons/16.png", "pair.html"], matches: [`${url.protocol}//${url.hostname}/*`] }];
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  files["defaults.json"] = Buffer.from(JSON.stringify({ server: url.origin }) + "\n");
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** The studio's address as the user's browser reaches it. */
export function studioOrigin(req, config) {
  if (config.publicUrl) return new URL(config.publicUrl).origin;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

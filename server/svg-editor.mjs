import path from "node:path";
import { appRoot } from "./config.mjs";
import { sendFile } from "./http.mjs";
import { problem, inside } from "./util.mjs";

/** Our page that hosts the editor (src/svg-editor); everything else is SVG-Edit's own build. */
const HOST = path.join(appRoot, "src", "svg-editor");
const HOST_FILES = new Set(["frame.html", "frame.js"]);
const EDITOR = path.join(appRoot, "node_modules", "svgedit", "dist", "editor");

/**
 * /svg-editor/: SVG-Edit and its host page. The studio shows them in a sandboxed frame (an
 * origin of its own, without the session cookie), so they are public and readable from any
 * origin; they are the editor's code only — the SVG being edited is passed by postMessage.
 */
export function serveSvgEditor(req, res, pathname) {
  const relative = decodeURIComponent(pathname.slice("/svg-editor/".length));
  const base = HOST_FILES.has(relative) ? HOST : EDITOR;
  const file = path.resolve(base, relative);
  if (!inside(base, file)) throw problem(400, "Invalid path");
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Code is revalidated (a patched or upgraded editor shows at once); its icons are kept a day.
  sendFile(req, res, file, { cache: /\.(js|css|html)$/.test(file) ? "no-cache" : "public, max-age=86400" });
}

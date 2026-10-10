import path from "node:path";
import { appRoot } from "./config.mjs";

/**
 * Browser errors from the preview page are hard to act on as-is: long origins, /@fs/
 * absolute paths, ?t= cache busters and positions in Vite's transformed output. This
 * rewrites stack frames to work-relative files (library code as materials/<library>/<path>)
 * at their original TypeScript lines and drops frames that are not the work's, its library
 * code's or the engine's.
 */
export function cleanBrowserError(text, { work, vite } = {}) {
  const lines = String(text)
    .replace(/(Error: )?page\.evaluate: /g, "")
    .split("\n");
  const out = [];
  let engineFrames = 0;
  let libraryFrames = 0;
  const copies = `${path.sep}.materials${path.sep}`; // library code runs from copies in <root>/.materials/
  for (const line of lines) {
    const frame = /^\s*at (?:(.*?) \()?(https?:\/\/[^/\s)]+)(\/[^\s)?]+)(?:\?[^\s):]*)?:(\d+):(\d+)\)?\s*$/.exec(line);
    if (!frame) {
      if (/^\s*at /.test(line)) continue; // <anonymous>, native and evaluate wrapper frames
      out.push(line);
      continue;
    }
    const [, fn, , urlPath, rawLine, rawColumn] = frame;
    const file = urlPath.startsWith("/@fs/") ? decodeURIComponent(urlPath.slice(4)) : path.join(appRoot, decodeURIComponent(urlPath));
    const position = originalPosition(vite, file, Number(rawLine), Number(rawColumn)) ?? { line: Number(rawLine), column: Number(rawColumn) };
    let shown;
    if (file.includes(copies)) {
      // A few frames of library code: where it failed and how the work got there.
      if (libraryFrames++ >= 3) continue;
      shown = "materials/" + file.slice(file.lastIndexOf(copies) + copies.length).split(path.sep).join("/");
    } else if (work && inside(work.dir, file)) shown = path.relative(work.dir, file).split(path.sep).join("/");
    else if (inside(path.join(appRoot, "src", "engine"), file)) {
      // One engine frame is enough context; the rest is the engine's own plumbing.
      if (engineFrames++ >= 1) continue;
      shown = "engine/" + path.relative(path.join(appRoot, "src", "engine"), file).split(path.sep).join("/");
    } else continue;
    out.push(`    at ${fn ? fn + " " : ""}${shown}:${position.line}:${position.column}`);
  }
  return out.join("\n").trim();
}

/**
 * Same error at several times ("0:07.50 渲染失败：X", "0:09.95 渲染失败：X") becomes one
 * line listing the times.
 */
export function mergeTimedErrors(errors) {
  const groups = new Map();
  for (const error of errors) {
    const match = /^(\d+:\d{2}(?:\.\d+)?) (.*)$/s.exec(error);
    const [time, message] = match ? [match[1], match[2]] : [null, error];
    if (!groups.has(message)) groups.set(message, []);
    if (time) groups.get(message).push(time);
  }
  return [...groups].map(([message, times]) => (times.length ? `${times.join("、")} ${message}` : message));
}

const inside = (dir, file) => {
  const relative = path.relative(dir, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const decoded = new WeakMap();

/** Map a generated position back through the module's Vite source map (1-based in and out). */
function originalPosition(vite, file, line, column) {
  const environment = vite?.environments?.client;
  if (!environment) return null;
  let map = null;
  for (const mod of environment.moduleGraph.getModulesByFile(file) ?? []) if ((map = mod.transformResult?.map)) break;
  if (!map?.mappings) return null;
  if (!decoded.has(map)) decoded.set(map, decodeMappings(map.mappings));
  const segments = decoded.get(map)[line - 1];
  if (!segments?.length) return null;
  let best = segments[0];
  for (const segment of segments) if (segment[0] <= column - 1) best = segment;
  return { line: best[2] + 1, column: best[3] + 1 };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Source map v3 "mappings" → per generated line: [generatedColumn, source, originalLine, originalColumn]. */
export function decodeMappings(mappings) {
  const result = [];
  let source = 0,
    originalLine = 0,
    originalColumn = 0;
  for (const line of mappings.split(";")) {
    const segments = [];
    let generatedColumn = 0;
    if (line)
      for (const segment of line.split(",")) {
        const values = decodeVlq(segment);
        generatedColumn += values[0];
        if (values.length < 4) continue;
        source += values[1];
        originalLine += values[2];
        originalColumn += values[3];
        segments.push([generatedColumn, source, originalLine, originalColumn]);
      }
    result.push(segments);
  }
  return result;
}

function decodeVlq(text) {
  const values = [];
  let value = 0,
    shift = 0;
  for (const char of text) {
    const digit = BASE64.indexOf(char);
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = shift = 0;
    }
  }
  return values;
}

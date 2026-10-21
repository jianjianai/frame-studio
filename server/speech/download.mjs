import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import * as tar from "tar";

const require = createRequire(import.meta.url);

/**
 * Download a model archive (.tar.bz2) and extract it into `dir`, marked installed. Goes through
 * `<dir>.partial`, so an interrupted download never looks installed. `progress(received, total)`.
 */
export async function fetchModel(model, dir, { signal, progress } = {}) {
  const temp = dir + ".partial";
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  try {
    const response = await fetch(model.archive, { signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length")) || model.size;
    let received = 0;
    const counted = Readable.fromWeb(response.body).on("data", (chunk) => {
      received += chunk.length;
      if (received % (2 * 1024 * 1024) < chunk.length) progress?.(received, total);
    });
    await pipeline(counted, require("unbzip2-stream")(), tar.x({ cwd: temp, strict: true }), { signal });
    fs.writeFileSync(path.join(temp, ".installed"), new Date().toISOString());
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(temp, dir);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Download one file (the VAD model, Beat This!'s weights) through `<file>.partial`, so an
 * interrupted download is never taken for the file.
 */
export async function fetchFile(url, file, { timeoutMs = 120000 } = {}) {
  const temp = file + ".partial";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return file;
}

import fs from "node:fs";
import path from "node:path";

export function createTestLink(target, link) {
  try { fs.symlinkSync(target, link, "file"); }
  catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    // Standard Windows accounts may lack file-symlink privileges. A real
    // directory junction still exercises link rejection without changing OS policy.
    fs.symlinkSync(path.dirname(target), link, "junction");
  }
}

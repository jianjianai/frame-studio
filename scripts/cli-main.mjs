import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A work's shared script link must execute, while importing the module stays inert. */
export function isCliMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

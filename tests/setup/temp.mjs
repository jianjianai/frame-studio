import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Write permission back on everything (published works are read-only on disk), so it can be removed. */
function writable(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return;
  fs.chmodSync(target, stat.mode | 0o700);
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) writable(path.join(target, name));
}

/** The tests' temporary data homes and remotes go into one folder per run, removed afterwards (they used to pile up in /tmp). */
export default function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-tests-"));
  process.env.TMPDIR = dir;
  return () => {
    writable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

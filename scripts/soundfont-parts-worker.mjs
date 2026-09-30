import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { splitSoundfont } from "./soundfont-parts.mjs";

const split = splitSoundfont(fs.readFileSync(workerData.file), {
  onPart({ file, bytes }) {
    const output = path.join(workerData.directory, file);
    // Several presets can serialize to the same content address.
    if (!fs.existsSync(output)) fs.writeFileSync(output, bytes, { flag: "wx" });
  },
});
if (split)
  fs.writeFileSync(
    path.join(workerData.directory, "index.json"),
    JSON.stringify(split.manifest),
    { flag: "wx" },
  );
parentPort.postMessage(split?.manifest || null);

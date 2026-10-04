import fs from "node:fs";
import path from "node:path";
import { localToolBinary } from "./local-tools.mjs";
import { problem } from "./security.mjs";

export function toolBinary(data, tool) {
  const bin = tool === "codex" ? "codex" : "claude";
  if (process.env.FRAME_LOCAL_MODE === "1") return localToolBinary(bin);
  const marker = path.join(data, "tools", tool, "current");
  if (!fs.existsSync(marker)) return bin;
  const version = fs.readFileSync(marker, "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
    throw problem(500, "Invalid tool version marker");
  return path.join(data, "tools", tool, version, "node_modules", ".bin", bin);
}

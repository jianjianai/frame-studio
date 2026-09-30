import { assetCatalog } from "./project-assets.mjs";
import { assetPath } from "./project-paths.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { browserOptions } from "./browser.mjs";
let failed = false;
const check = (name, fn) => {
  try {
    const detail = fn();
    console.log("[OK] " + name + (detail ? ": " + detail : ""));
  } catch (e) {
    failed = true;
    console.error("[FAIL] " + name + ": " + e.message);
  }
};
const command = (name, args = ["-version"]) => {
  const p = spawnSync(name, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  if (p.error || p.status !== 0) throw new Error(p.error?.message || p.stderr);
  return p.stdout.trim().split("\n")[0];
};
check("Node", () => process.version);
check("pnpm lockfile", () => {
  if (!fs.existsSync("pnpm-lock.yaml")) throw new Error("Run pnpm install");
  return "present";
});
for (const pkg of [
  "react",
  "vite",
  "three",
  "pixi.js",
  "gsap",
  "flubber",
  "@playwright/test",
  "sharp",
  "svgo",
  "mediabunny",
])
  check(pkg, () => import.meta.resolve(pkg));
check("FFmpeg", () => command(process.env.FFMPEG_PATH || "ffmpeg"));
check("FFprobe", () => command(process.env.FFPROBE_PATH || "ffprobe"));
check("Chromium browser", () => browserOptions().executablePath);
check("Asset index", () => {
  const a = assetCatalog(process.cwd());
  for (const item of a)
    if (!fs.existsSync(assetPath(process.cwd(), item.url)))
      throw new Error("Missing " + item.url);
  return a.length + " files";
});
check("Project folders", () =>
  (fs.existsSync("projects") ? fs.readdirSync("projects", { withFileTypes: true }) : [])
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .join(", "),
);
console.log(
  failed
    ? "Environment checks need attention."
    : "Environment ready. Run pnpm dev to open the studio.",
);
process.exitCode = failed ? 1 : 0;

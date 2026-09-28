import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { readProject, validProjectId } from "./project-metadata.mjs";
import { projectPath } from "./project-paths.mjs";
import { createRenderSession, framePng } from "./render-session.mjs";
import { createExportPlan } from "../src/engine/export-plan.mjs";

const [id, ...args] = process.argv.slice(2);
let session;
const temporary = [];
try {
  if (!validProjectId(id))
    throw new Error(
      "Usage: pnpm film storyboard <id> [--times 0,2,5] [--width 480] [--out path.png] [--force]",
    );
  const values = new Map(),
    flags = new Set();
  for (let i = 0; i < args.length; i++) {
    if (["--force", "--no-subtitles"].includes(args[i])) flags.add(args[i]);
    else if (
      ["--times", "--width", "--out"].includes(args[i]) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    ) {
      if (values.has(args[i])) throw new Error("Duplicate option: " + args[i]);
      values.set(args[i], args[++i]);
    } else throw new Error("Unknown or incomplete option: " + args[i]);
  }
  const root = process.cwd();
  const entry = readProject(projectPath(root, id, "project.ts"));
  if (!entry) throw new Error("Unknown project: " + id);
  const { meta } = entry;
  const {
    width,
    height,
    frames: frameCount,
  } = createExportPlan({
    duration: meta.duration,
    width: Number(values.get("--width") ?? 480),
    fps: meta.fps,
  });
  const times = values.has("--times")
    ? values
        .get("--times")
        .split(",")
        .map((s) => (s.trim() === "" ? NaN : Number(s)))
    : [
        ...new Set([
          0,
          ...meta.beats.map((b) => b.at),
          (frameCount - 1) / meta.fps,
        ]),
      ].sort((a, b) => a - b);
  if (
    !times.length ||
    times.length > 48 ||
    times.some((t) => !Number.isFinite(t) || t < 0 || t >= meta.duration)
  )
    throw new Error(
      "Choose 1..48 timestamps inside the project; use --times to select a subset",
    );
  const output = values.has("--out")
    ? path.resolve(values.get("--out"))
    : projectPath(root, id, "exports/storyboard.png");
  if (path.extname(output).toLowerCase() !== ".png")
    throw new Error("Storyboard output must end with .png");
  for (const file of [output, output + ".json"]) {
    projectPath(root, id, path.relative(projectPath(root, id), file));
    if (existsSync(file) && !flags.has("--force"))
      throw new Error("Output exists; use --force: " + file);
  }
  session = await createRenderSession({ root, width });
  const page = await session.page(id);
  const columns = Math.min(3, times.length),
    labelHeight = 36;
  const layers = [],
    frames = [];
  for (const [index, time] of times.entries()) {
    const left = (index % columns) * width,
      top = Math.floor(index / columns) * (height + labelHeight);
    layers.push({
      input: await framePng(page, time, !flags.has("--no-subtitles")),
      left,
      top,
    });
    const frame = Math.floor(time * meta.fps + 1e-8);
    const label = `${time.toFixed(3)}s | frame ${frame}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${labelHeight}"><rect width="100%" height="100%" fill="#202725"/><text x="12" y="24" fill="#fff" font-family="sans-serif" font-size="16">${label}</text></svg>`;
    layers.push({ input: Buffer.from(svg), left, top: top + height });
    frames.push({
      time,
      frame,
      beat: [...meta.beats].reverse().find((b) => b.at <= time)?.title ?? null,
    });
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const imageTemp = projectPath(
    root,
    id,
    path.relative(projectPath(root, id), output + "." + randomUUID() + ".tmp"),
  );
  temporary.push(imageTemp);
  await sharp({
    create: {
      width: columns * width,
      height: Math.ceil(times.length / columns) * (height + labelHeight),
      channels: 3,
      background: "#202725",
    },
  })
    .composite(layers)
    .png()
    .toFile(imageTemp);
  const reportTemp = imageTemp + ".json";
  temporary.push(reportTemp);
  await fs.writeFile(
    reportTemp,
    JSON.stringify(
      {
        schemaVersion: 1,
        input: session.input(id),
        project: id,
        output,
        width,
        height,
        fps: meta.fps,
        subtitles: !flags.has("--no-subtitles"),
        frames,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await fs.rename(imageTemp, output);
  await fs.rename(reportTemp, output + ".json");
  console.log(`Storyboard: ${output}\nFrame manifest: ${output}.json`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await session?.close();
  for (const file of temporary)
    await fs.rm(file, { force: true }).catch(() => {});
}

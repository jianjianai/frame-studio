import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { processLaunch } from "./local-tools.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { browserVersion } from "../scripts/browser.mjs";
import { installToolVersion } from "./tool-installation.mjs";
import { linkSharedRuntime } from "../scripts/shared-runtime.mjs";
const work = process.env.FRAME_EXECUTOR_WORK || "/workspace",
  core = process.env.FRAME_EXECUTOR_CORE || "/opt/frame";
const task = JSON.parse(fs.readFileSync(work + "/task.json", "utf8"));
const redact = (value) => {
  let text = String(value);
  for (const [key, secret] of Object.entries(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && secret?.length >= 8)
      text = text.split(secret).join("[redacted]");
  return text.replace(
    /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,})/g,
    "[redacted]",
  );
};
let actualRuntime = null;
const executorStarted = performance.now(),
  validation = [],
  executorMetrics = {};
const measured = async (name, fn, { check = false } = {}) => {
  const started = performance.now();
  try {
    const output = await fn();
    const durationMs = Math.round(performance.now() - started);
    executorMetrics[name] = durationMs;
    if (check) validation.push({ check: name, status: "passed", durationMs });
    return output;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    executorMetrics[name] = durationMs;
    if (check) validation.push({ check: name, status: "failed", durationMs });
    throw error;
  }
};
const result = (value) =>
  fs.writeFileSync(
    work + "/result.json",
    JSON.stringify({
      ...value,
      validation,
      executorMetrics: {
        ...executorMetrics,
        totalMs: Math.round(performance.now() - executorStarted),
      },
      runtime: actualRuntime,
      runtimeFingerprint: actualRuntime?.fingerprint || null,
    }),
  );
const run = (bin, args, options = {}) =>
  new Promise((resolve, reject) => {
    const launch = processLaunch(bin, args);
    const child = spawn(launch.bin, launch.args, {
      cwd: work,
      env: {
        ...process.env,
        FRAME_PROJECT: task.project,
        FRAME_TASK_PROGRESS_FILE: work + "/progress.json",
        FRAME_SHARED_RUNTIME_ROOT: core,
        FRAME_SHARED_RUNTIME_FINGERPRINT: actualRuntime?.fingerprint,
        ...(task.kind === "build" ? { FRAME_WORK_PREVIEW: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let output = "", errors = "";
    child.stdout.on("data", (value) => {
      output = (output + value).slice(-8 * 1024 * 1024);
      process.stdout.write(redact(value));
    });
    child.stderr.on("data", (v) => {
      errors = (errors + redact(v)).slice(-12000);
      process.stderr.write(redact(v));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${path.basename(bin)} exited ${code}\n${[errors.trim(), redact(output).slice(-6000).trim()].filter(Boolean).join("\n")}`,
            ),
          );
    });
    child.stdin.end(options.input);
  });
try {
  actualRuntime = {
    ...(await runtimeIdentity(core)),
    image: process.env.FRAME_RUNTIME_IMAGE || null,
    sourceCommit: task.sourceCommit || null,
  };
  if (
    task.runtime?.fingerprint &&
    task.runtime.fingerprint !== actualRuntime.fingerprint
  )
    throw Error(
      "Executor runtime differs from the controller; deploy matching platform and executor images",
    );
  if (task.runtime?.image && task.runtime.image !== actualRuntime.image)
    throw Error("Executor image does not match the frozen task runtime");
  if (task.kind === "tools-update") {
    result(
      await installToolVersion({
        provider: task.input.provider,
        version: task.input.version,
        run,
        onProgress: (stage) =>
          fs.writeFileSync(work + "/progress.json", JSON.stringify({ stage })),
      }),
    );
  } else {
    // Vite emits HTML relative to its real path. Keep this tiny entry local;
    // every engine, tool and public resource still links to the pinned core.
    linkSharedRuntime(work, core, { mutableIndex: true });
    actualRuntime.ffmpeg = (
      await run(process.env.FFMPEG_PATH || "ffmpeg", ["-version"])
    ).split("\n")[0];
    actualRuntime.browser = await browserVersion();
    let value = { status: "passed" };
    const input = task.input;
    let args = [
      "--",
      core + "/scripts/film.mjs",
      task.kind === "new" ? "new" : task.kind,
      task.project,
    ];
    if (task.kind === "new")
      args.push(
        input.title || task.project,
        "--renderer",
        input.renderer || "composition",
        "--duration",
        String(input.duration || 12),
      );
    if (["frame", "storyboard", "render"].includes(task.kind)) {
      if (input.width) args.push("--width", String(input.width));
      if (input.fps && task.kind !== "storyboard") args.push("--fps", String(input.fps));
      if (input.subtitles === false) args.push("--no-subtitles");
      if (task.kind === "frame") args.push("--time", String(input.time || 0));
      if (task.kind === "render") {
        if (input.start !== undefined)
          args.push("--start", String(input.start));
        if (input.end !== undefined) args.push("--end", String(input.end));
      }
      args.push("--json");
    }
    if (["build", "validate"].includes(task.kind)) args.push("--json");
    const out = await measured("commandMs", () => run("node", args));
    try {
      value = { ...value, ...JSON.parse(out) };
    } catch {}
    if (value.status === "failed" || value.passed === false)
      throw new Error("FRAME validation failed");
    if (task.kind === "build") value.previewVersion = PREVIEW_VERSION;
    result(value);
  }
} catch (e) {
  console.error(e.stack);
  result({ status: "failed", error: redact(e.message) });
  process.exitCode = 1;
}

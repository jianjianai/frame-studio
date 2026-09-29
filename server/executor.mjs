import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { agentEvent } from "./agent-events.mjs";
import { runAgentTurn } from "./agent-runtime.mjs";
import { createAgentFileInspector } from "./agent-file-changes.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { installToolVersion } from "./tool-installation.mjs";
import { creatorTaskIgnores, creatorPrompt } from "./creator-workspace.mjs";
const work = "/workspace",
  core = "/opt/frame";
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
let reportCommands = false, commandSerial = 0;
const abortController = new AbortController();
process.once("SIGTERM", () => abortController.abort(new Error("创作已停止")));
const emitAgentEvent = (event) => {
  const line = redact(JSON.stringify(event));
  if (Buffer.byteLength(line) > 768 * 1024) throw Error("Agent event exceeds the bounded event store");
  fs.appendFileSync(work + "/events.ndjson", line + "\n");
};
const executorStarted = performance.now(), validation = [], executorMetrics = {};
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
  fs.writeFileSync(work + "/result.json", JSON.stringify({ ...value, validation, executorMetrics: { ...executorMetrics, totalMs: Math.round(performance.now() - executorStarted) }, runtime: actualRuntime, runtimeFingerprint: actualRuntime?.fingerprint || null }));
const run = (bin, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: work,
      env: {
        ...process.env,
        FRAME_PROJECT: task.project,
        FRAME_TASK_PROGRESS_FILE: work + "/progress.json",
        ...(task.kind === "build" ? { FRAME_WORK_PREVIEW: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    const commandId = reportCommands ? `platform-command:${++commandSerial}` : null, commandStarted = Date.now();
    if (commandId) emitAgentEvent({ type: "agent-item", version: 1, id: commandId, kind: "command", phase: "running", at: commandStarted,
      title: "验证与构建", command: [bin, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" "), cwd: work });
    let output = "", errors = "", lineOutput = "";
    const showOutput = (v) => {
      if (!commandId) return;
      lineOutput += v.toString();
      const end = lineOutput.lastIndexOf("\n");
      if (end >= 0) {
        emitAgentEvent({ type: "agent-item", version: 1, id: commandId, kind: "command", phase: "running", at: Date.now(), outputDelta: redact(lineOutput.slice(0, end + 1)).slice(-32000) });
        lineOutput = lineOutput.slice(end + 1);
      }
      if (lineOutput.length > 32000) lineOutput = lineOutput.slice(-32000);
    };
    let pending = "";
    child.stdout.on("data", (v) => {
      output = (output + v).slice(-8 * 1024 * 1024);
      showOutput(v);
      if (!options.agent) process.stdout.write(redact(v));
      if (options.agent) {
        pending += v.toString();
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const event = agentEvent(JSON.parse(line));
            if (event)
              fs.appendFileSync(
                work + "/events.ndjson",
                redact(JSON.stringify(event)) + "\n",
              );
          } catch {}
        }
        if (pending.length > 2 * 1024 * 1024) pending = "";
      }
    });
    child.stderr.on("data", (v) => {
      errors = (errors + redact(v)).slice(-12000);
      showOutput(v);
      process.stderr.write(redact(v));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (commandId) emitAgentEvent({ type: "agent-item", version: 1, id: commandId, kind: "command", phase: code === 0 ? "completed" : "failed", at: Date.now(),
        exitCode: code, durationMs: Date.now() - commandStarted, output: redact(output + (errors ? "\n" + errors : "")).slice(-32000), outputTruncated: output.length + errors.length > 32000 });
      code === 0 ? resolve(output) : reject(new Error(`${path.basename(bin)} exited ${code}\n${errors.trim() || redact(output).slice(-6000).trim()}`));
    });
    child.stdin.end(options.input);
  });
try {
  actualRuntime = { ...(await runtimeIdentity(core)), image: process.env.FRAME_RUNTIME_IMAGE || null, sourceCommit: task.sourceCommit || null };
  if (task.runtime?.fingerprint && task.runtime.fingerprint !== actualRuntime.fingerprint)
    throw Error("Executor runtime differs from the controller; deploy matching platform and executor images");
  if (task.runtime?.image && task.runtime.image !== actualRuntime.image)
    throw Error("Executor image does not match the frozen task runtime");
  if (task.kind === "tools-update") {
    result(await installToolVersion({ provider: task.input.provider, version: task.input.version, run }));
  } else {
    for (const name of [
      "src",
      "scripts",
      "templates",
      "docs",
      "public",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "tsconfig.json",
      "index.html",
      "vite.config.ts",
      "vitest.config.ts",
      "AGENTS.md",
    ])
      if (fs.existsSync(core + "/" + name))
        fs.cpSync(core + "/" + name, work + "/" + name, { recursive: true });
    fs.symlinkSync(core + "/node_modules", work + "/node_modules", "dir");
    await run("git", ["init", "-b", "frame-task"]);
    await run("git", ["config", "user.name", "FRAME"]);
    await run("git", ["config", "user.email", "frame@localhost"]);
    const skip = creatorTaskIgnores;
    fs.writeFileSync(work + "/.gitignore", skip.join("\n") + "\n");
    const baseline = [
      "src",
      "scripts",
      "templates",
      "docs",
      "public",
      "projects",
      "review",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      ".gitignore",
      "tsconfig.json",
      "index.html",
      "vite.config.ts",
      "vitest.config.ts",
      "AGENTS.md",
    ].filter((name) => fs.existsSync(work + "/" + name));
    await run("git", ["add", "--", ...baseline]);
    await run("git", ["commit", "-qm", "Initialize isolated task workspace"]);
    const baselineCommit = (await run("git", ["rev-parse", "HEAD"])).trim();
    actualRuntime.ffmpeg = (await run(process.env.FFMPEG_PATH || "ffmpeg", ["-version"])).split("\n")[0];
    actualRuntime.browser = (await run(process.env.FRAME_BROWSER || "/usr/bin/chromium", ["--version"])).trim();
    let value = { status: "passed" };
    if (task.kind === "agent") {
      const p = task.input.provider;
      let bin = p === "codex" ? "codex" : "claude";
      const pinned = task.runtime?.tool;
      if (pinned?.provider && pinned.provider !== p) throw Error("Pinned tool/provider mismatch");
      if (pinned?.version) {
        if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pinned.version)) throw Error("Invalid pinned tool version");
        bin = `/tools/${p}/${pinned.version}/node_modules/.bin/${bin}`;
      }
      actualRuntime.tool = { provider: p, pinnedVersion: pinned?.version || null, actualVersion: (await run(bin, ["--version"])).trim(), model: task.model, authMode: task.authMode };
      const prompt = creatorPrompt(task.project) + "\n\n" + task.input.prompt;
      const context = task.input.context
        ? `\n\nReview context (seconds, selected range, material ids): ${JSON.stringify(task.input.context)}` : "";
      const reference = task.reviewReference
        ? `\n\nVersion-bound review reference: ${JSON.stringify(task.reviewReference)}. Timecodes and shot ids belong to this reference, not automatically to the current work. If disposition is compare-to-latest, inspect the read-only reference source at the supplied path and compare it with projects/${task.project} before mapping the user's request. Never overwrite the current work with the old reference. Do not modify review/; continue editing the latest work directly with the available tools. If a mapping is ambiguous, explain that limitation rather than claiming an exact unaffected range.`
        : "";
      const inspectFiles = createAgentFileInspector({ cwd: work, project: task.project, baseline: baselineCommit, emit: emitAgentEvent });
      const outcome = await measured("agentMs", () => runAgentTurn({
        provider: p, bin, task, cwd: work,
        prompt: prompt + context + reference + (task.previousTurns?.length ? `\n\nPersisted context from earlier turns (new execution session; current instruction above takes precedence):\n${JSON.stringify(task.previousTurns)}` : "") + "\n\nWhen a creative decision genuinely requires human input, ask through " +
          (p === "codex" ? "frame_ask_user" : "AskUserQuestion") +
          ". The question is presented directly in the FRAME chat and its answer continues this same task. Do not end the turn with an unanswered question. For a tool-independent fallback use node scripts/work-tool.mjs ask with JSON questions. Never request credentials through chat. Share concise progress and a plan for complex work; do not invent progress or validation results.",
        env: { ...process.env, FRAME_PROJECT: task.project, FRAME_TASK_PROGRESS_FILE: work + "/progress.json" },
        emit: emitAgentEvent, signal: abortController.signal, onToolComplete: inspectFiles,
        onStderr: (value) => process.stderr.write(redact(value)),
      }));
      value.upstream = outcome.upstream;
      await inspectFiles();
      reportCommands = true;
      fs.appendFileSync(
        work + "/events.ndjson",
        JSON.stringify({
          type: "activity",
          id: "validation",
          tool: "validation",
          phase: "running",
          text: "正在验证作品并准备预览",
        }) + "\n",
      );
      await measured("scope", () => run("node", [
        core + "/scripts/project-scope.mjs",
        task.project,
        "--base",
        baselineCommit,
      ]), { check: true });
      await measured("structure", () => run("node", [
        core + "/scripts/check-projects.mjs",
        task.project,
        "--strict",
      ]), { check: true });
      await measured("project-tests", () => run("node", [
        core + "/scripts/film.mjs",
        "test",
        task.project,
        "--json",
      ]), { check: true });
      const { base, file } = await measured("preview-build", async () => {
        const built = await run(
        "node",
        [work + "/scripts/film.mjs", "build", task.project, "--json"],
        {
          env: {
            ...process.env,
            FRAME_PROJECT: task.project,
            FRAME_WORK_PREVIEW: "1",
          },
        },
      );
      let buildResult;
      try {
        buildResult = JSON.parse(built);
      } catch {
        throw new Error("Preview build did not return a valid result");
      }
      if (buildResult.status === "failed" || buildResult.passed === false)
        throw new Error("Preview build failed");
      value.buildMetrics = buildResult.buildMetrics || null;
      const base = path.join(work, "projects", task.project, "exports");
      const file = path.resolve(buildResult.output || "", "index.html");
      if (
        !file.startsWith(base + path.sep) ||
        !fs.existsSync(file) ||
        fs.lstatSync(file).isSymbolicLink()
      )
        throw new Error("Preview entry missing or outside work output");
        return { base, file };
      }, { check: true });
      value.previewVersion = PREVIEW_VERSION;
      value.previewArtifacts = [
        {
          name: path.relative(base, file).replaceAll("\\", "/"),
          path: path.relative(work, file).replaceAll("\\", "/"),
          bytes: fs.statSync(file).size,
        },
      ];
      fs.appendFileSync(
        work + "/events.ndjson",
        JSON.stringify({
          type: "activity",
          id: "validation",
          tool: "validation",
          phase: "done",
          text: "作品验证通过，预览已准备",
        }) + "\n",
      );
    } else {
      const input = task.input;
      let args = [
        "--",
        work + "/scripts/film.mjs",
        task.kind === "new" ? "new" : task.kind,
        task.project,
      ];
      if (task.kind === "new")
        args.push(
          input.title || task.project,
          "--renderer",
          input.renderer || "canvas",
          "--duration",
          String(input.duration || 12),
        );
      if (["frame", "storyboard", "render"].includes(task.kind)) {
        if (input.width) args.push("--width", String(input.width));
        if (input.fps) args.push("--fps", String(input.fps));
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
      const out = await run("node", args);
      try {
        value = { ...value, ...JSON.parse(out) };
      } catch {}
      if (value.status === "failed" || value.passed === false)
        throw new Error("FRAME validation failed");
    }
    if (task.kind === "build") value.previewVersion = PREVIEW_VERSION;
    result(value);
  }
} catch (e) {
  console.error(e.stack);
  result({ status: "failed", error: redact(e.message) });
  process.exitCode = 1;
}

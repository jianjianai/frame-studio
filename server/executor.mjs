import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { agentEvent } from "./agent-events.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";
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
const result = (value) =>
  fs.writeFileSync(work + "/result.json", JSON.stringify(value));
const run = (bin, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: work,
      env: {
        ...process.env,
        FRAME_PROJECT: task.project,
        ...(task.kind === "build" ? { FRAME_WORK_PREVIEW: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let output = "",
      errors = "";
    let pending = "";
    child.stdout.on("data", (v) => {
      output = (output + v).slice(-8 * 1024 * 1024);
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
      process.stderr.write(redact(v));
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${path.basename(bin)} exited ${code}\n${errors.trim() || redact(output).slice(-6000).trim()}`,
            ),
          ),
    );
    child.stdin.end(options.input);
  });
try {
  if (task.kind === "tools-update") {
    const provider = task.input.provider,
      version = task.input.version,
      dir = `/tools/${provider}/${version}`;
    const pkg =
      provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
    await run("npm", ["install", "--prefix", dir, pkg + "@" + version]);
    await run(
      dir + "/node_modules/.bin/" + (provider === "codex" ? "codex" : "claude"),
      ["--version"],
    );
    fs.writeFileSync(`/tools/${provider}/current.tmp`, version);
    fs.renameSync(
      `/tools/${provider}/current.tmp`,
      `/tools/${provider}/current`,
    );
    result({ status: "passed", provider, version });
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
    const skip = [
      "node_modules",
      ".cache/",
      "projects/*/.cache/",
      "projects/*/.history/",
      "projects/*/exports/",
      "task.json",
      "result.json",
      "events.ndjson",
    ];
    fs.writeFileSync(work + "/.gitignore", skip.join("\n") + "\n");
    const baseline = [
      "src",
      "scripts",
      "templates",
      "docs",
      "public",
      "projects",
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
    let value = { status: "passed" };
    if (task.kind === "agent") {
      const p = task.input.provider;
      let bin = p === "codex" ? "codex" : "claude";
      const marker = `/tools/${p}/current`;
      if (fs.existsSync(marker))
        bin = `/tools/${p}/${fs.readFileSync(marker, "utf8").trim()}/node_modules/.bin/${bin}`;
      const prompt = `You are creating one work in FRAME: ${task.project}. Only edit projects/${task.project}/. The surrounding engine and tools are the platform runtime, not another project to create or install. Read AGENTS.md, docs/AUTHORING.md and the work README. Use pnpm --silent film context ${task.project} --json, frame/storyboard/render for visual inspection. Use node scripts/work-tool.mjs help for searching global assets, copying assets into this work, and synthesizing narration with configured engines. These tools save material into the current work; wire returned URLs into scenes/audioTracks as needed. Never print credentials. Validate before finishing; a preview is built automatically after successful completion.\n\n${task.input.prompt}`;
      let args;
      if (p === "codex") {
        args = [
          "exec",
          ...(task.upstream ? ["resume", task.upstream] : []),
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          ...(task.model ? ["-m", task.model] : []),
          ...(task.authMode !== "official"
            ? [
                "-c",
                'model_provider="frame"',
                "-c",
                'model_providers.frame.name="FRAME connection"',
                "-c",
                'model_providers.frame.wire_api="responses"',
                "-c",
                'model_providers.frame.env_key="CODEX_API_KEY"',
                "-c",
                "model_providers.frame.base_url=" +
                  JSON.stringify(task.baseUrl || "https://api.openai.com/v1"),
              ]
            : []),
          "-",
        ];
      } else
        args = [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--permission-mode",
          "bypassPermissions",
          ...(task.upstream ? ["--resume", task.upstream] : []),
          ...(task.model ? ["--model", task.model] : []),
        ];
      const context = task.input.context
        ? `\n\nReview context (seconds, selected range, material ids): ${JSON.stringify(task.input.context)}`
        : "";
      const output = await run(bin, args, {
        input: prompt + context,
        agent: true,
      });
      for (const line of output.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.thread_id || event.session_id)
            value.upstream = event.thread_id || event.session_id;
          if (event.type === "result" && event.is_error)
            throw new Error(event.result || "Agent failed");
          if (event.type === "turn.failed" || event.type === "error")
            throw new Error(
              event.error?.message || event.message || "Agent failed",
            );
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
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
      await run("node", [
        core + "/scripts/project-scope.mjs",
        task.project,
        "--base",
        baselineCommit,
      ]);
      await run("node", [
        core + "/scripts/check-projects.mjs",
        task.project,
        "--strict",
      ]);
      await run("node", [
        core + "/scripts/film.mjs",
        "test",
        task.project,
        "--json",
      ]);
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
      const base = path.join(work, "projects", task.project, "exports");
      const file = path.resolve(buildResult.output || "", "index.html");
      if (
        !file.startsWith(base + path.sep) ||
        !fs.existsSync(file) ||
        fs.lstatSync(file).isSymbolicLink()
      )
        throw new Error("Preview entry missing or outside work output");
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

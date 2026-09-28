import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const work = "/workspace",
  core = "/opt/frame";
const task = JSON.parse(fs.readFileSync(work + "/task.json", "utf8"));
const result = (value) =>
  fs.writeFileSync(work + "/result.json", JSON.stringify(value));
const run = (bin, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: work,
      env: { ...process.env, FRAME_PROJECT: task.project },
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let output = "";
    child.stdout.on("data", (v) => {
      output = (output + v).slice(-8 * 1024 * 1024);
      process.stdout.write(v);
    });
    child.stderr.on("data", (v) => process.stderr.write(v));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`Process exited ${code}`)),
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
    let value = { status: "passed" };
    if (task.kind === "agent") {
      const p = task.input.provider;
      let bin = p === "codex" ? "codex" : "claude";
      const marker = `/tools/${p}/current`;
      if (fs.existsSync(marker))
        bin = `/tools/${p}/${fs.readFileSync(marker, "utf8").trim()}/node_modules/.bin/${bin}`;
      const prompt = `You are working on FRAME animation ${task.project}. Only edit projects/${task.project}/. Read AGENTS.md, docs/AUTHORING.md and the project README. Use pnpm --silent film context ${task.project} --json, frame/storyboard/render for previews, and validate before finishing. All changes stay in this project.\n\n${task.input.prompt}`;
      let args;
      if (p === "codex") {
        args = [
          "exec",
          ...(task.upstream ? ["resume", task.upstream] : []),
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          ...(task.model ? ["-m", task.model] : []),
          ...(task.baseUrl
            ? ["-c", "openai_base_url=" + JSON.stringify(task.baseUrl)]
            : []),
          "-",
        ];
      } else
        args = [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          "--permission-mode",
          "bypassPermissions",
          ...(task.upstream ? ["--resume", task.upstream] : []),
          ...(task.model ? ["--model", task.model] : []),
        ];
      const output = await run(bin, args, { input: prompt });
      for (const line of output.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.thread_id || event.session_id)
            value.upstream = event.thread_id || event.session_id;
          if (event.type === "result" && event.is_error)
            throw new Error(event.result || "Agent failed");
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
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
    result(value);
  }
} catch (e) {
  console.error(e.stack);
  result({ status: "failed", error: e.message });
  process.exitCode = 1;
}

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { build, createServer } from "vite";
import react from "@vitejs/plugin-react";
import { projectAssets } from "./project-assets.mjs";
import { projectPath } from "./project-paths.mjs";
import { checkProjects } from "./check-projects.mjs";
import { inputManifest } from "./production-input.mjs";
import { sharedRuntime } from "./shared-runtime.mjs";
import { browserOptions } from "./browser.mjs";
import { buildPreviewAudio, previewProgress } from "./preview-audio.mjs";

export function runProcess(
  command,
  args,
  { root, timeoutMs = 600000, signal, onLog, env } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      timedOut = false;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", () => child.kill());
        killer.once("close", (code) => {
          if (code !== 0 && child.exitCode === null) child.kill();
        });
      } else child.kill();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const log = (data) => {
      output = (output + data).slice(-128 * 1024);
      onLog?.(String(data));
    };
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({
        status: code === 0 && !timedOut ? "passed" : "failed",
        exitCode: code,
        timedOut,
        output,
      });
    });
  });
}
export function projectConfig(root, id, outDir) {
  projectPath(root, id);
  const runtime = sharedRuntime(root);
  return {
    root,
    configFile: false,
    // Keep pnpm's normal realpath resolution for transitive dependencies. The
    // selected catalog import alone resolves to this task's frozen project.
    ...(runtime ? { resolve: { alias: [{
      find: new RegExp("^\\.\\./\\.\\./projects/" + id + "/project$"),
      replacement: path.join(root, "projects", id, "project.ts"),
    }] } } : {}),
    logLevel: "error",
    base: "./",
    define: {
      "import.meta.env.VITE_FRAME_PREVIEW_AUDIO": JSON.stringify(
        process.env.FRAME_PREVIEW_AUDIO || "1",
      ),
    },
    plugins: [
      react(),
      projectAssets({ project: id }),
      {
        name: "work-preview-entry",
        transformIndexHtml: {
          order: "pre",
          handler(html) {
            return process.env.FRAME_WORK_PREVIEW === "1"
              ? html.replace("/src/main.tsx", "/src/work-preview.tsx")
              : html;
          },
        },
      },
    ],
    optimizeDeps: { include: ["tone", "tone/build/esm/classes.js", "remotion", "@remotion/player", "@remotion/media", "@remotion/web-renderer"] },
    worker: { format: "iife" },
    cacheDir: projectPath(root, id, ".cache/vite"),
    build: { target: "es2022", outDir, emptyOutDir: false },
    server: {
      // Query imports such as Signalsmith ?raw must also reach shared dependencies
      // when the isolated project links node_modules outside its Vite root.
      fs: { allow: [root, fs.realpathSync(path.join(root, "node_modules")), ...(runtime ? [runtime.root] : [])] },
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      open: false,
      watch: {
        ignored: [
          "**/.cache/**",
          "**/.history/**",
          "**/exports/**",
          "**/records/**",
        ],
      },
    },
  };
}
export async function executeProject(root, id, action, options = {}) {
  const folder = projectPath(root, id);
  const structure = checkProjects(root, { ids: [id], strict: true });
  if (!structure.passed) return { status: "failed", structure };
  const cache = projectPath(root, id, ".cache/checks/" + randomUUID());
  fs.mkdirSync(cache, { recursive: true });
  const js = (value) => JSON.stringify(value);
  const node = async (relative, args) =>
    runProcess(
      process.execPath,
      [path.join(root, "node_modules", relative), ...args],
      { root, ...options },
    );
  const typecheck = async () => {
    const config = path.join(cache, "tsconfig.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        extends: path.join(root, "tsconfig.json"),
        include: [
          path.join(root, "src", "**", "*.d.ts").replaceAll("\\", "/"),
          folder.replaceAll("\\", "/") + "/**/*.ts",
          folder.replaceAll("\\", "/") + "/**/*.tsx",
        ],
        exclude: [
          folder + "/.cache",
          folder + "/.history",
          folder + "/exports",
          folder + "/node_modules",
        ],
      }),
    );
    return node("typescript/bin/tsc", [
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      config,
    ]);
  };
  const unit = async () => {
    const config = path.join(cache, "vitest.config.mjs");
    fs.writeFileSync(
      config,
      `export default {root:${js(root)},cacheDir:${js(path.join(cache, "vitest"))},test:{include:[${js("projects/" + id + "/tests/unit/**/*.test.ts")}],environment:'node',passWithNoTests:true}}`,
    );
    if (!fs.existsSync(path.join(folder, "tests/unit")))
      return { status: "not_run", reason: "No project unit tests" };
    // This generated config is plain ESM. Load it directly so Vite never writes
    // a bundled config into the canonical checkout's read-only shared dependencies.
    return node("vitest/vitest.mjs", ["run", "--config", config, "--configLoader", "native"]);
  };
  try {
    if (action === "dev") {
      const server = await createServer(projectConfig(root, id));
      await server.listen();
      const url =
        "http://127.0.0.1:" +
        server.httpServer.address().port +
        "/?debug=1#/film/" +
        id;
      return { status: "running", url, close: () => server.close() };
    }
    if (action === "typecheck") return await typecheck();
    if (action === "test") return await unit();
    if (action === "test-e2e") {
      const testDir = path.join(folder, "tests/e2e");
      if (!fs.existsSync(testDir))
        return { status: "not_run", reason: "No project browser tests" };
      const server = await createServer(projectConfig(root, id));
      try {
        await server.listen();
        const url = "http://127.0.0.1:" + server.httpServer.address().port;
        const config = path.join(cache, "playwright.config.mjs");
        fs.writeFileSync(
          config,
          `export default ${JSON.stringify({ testDir, timeout: 60000, workers: 1, reporter: [["list"]], outputDir: projectPath(root, id, "exports/test-results/" + randomUUID()), use: { baseURL: url, viewport: { width: 1440, height: 1000 }, launchOptions: browserOptions() } })}`,
        );
        return await node("@playwright/test/cli.js", [
          "test",
          "--config",
          config,
        ]);
      } finally {
        await server.close();
      }
    }
    if (action === "build") {
      const started = performance.now();
      previewProgress("检查作品代码");
      const checked = await typecheck();
      if (checked.status !== "passed") return checked;
      const typecheckMs = Math.round(performance.now() - started);
      const output = projectPath(root, id, "exports/build-" + randomUUID());
      previewProgress("构建画面播放器");
      const buildStarted = performance.now();
      await build(projectConfig(root, id, output));
      const compileMs = Math.round(performance.now() - buildStarted);
      let audioPreviewMetrics = null;
      if (
        process.env.FRAME_WORK_PREVIEW === "1" &&
        process.env.FRAME_PREVIEW_AUDIO !== "0"
      )
        audioPreviewMetrics = (await buildPreviewAudio(output, { ...options, root, project: id })).metrics;
      previewProgress("预览准备完成", 1, 1);
      return { status: "passed", output, input: inputManifest(root, id), buildMetrics: { typecheckMs, compileMs, audio: audioPreviewMetrics, totalMs: Math.round(performance.now() - started) } };
    }
    if (action !== "validate")
      throw new Error("Unknown project action: " + action);
    const types = await typecheck();
    const tests = await unit();
    return {
      schemaVersion: 1,
      project: id,
      status: [types, tests].some((r) => r.status === "failed")
        ? "failed"
        : "passed",
      input: inputManifest(root, id),
      engineering: { structure, types, tests },
      runtime: {
        status: "not_run",
        command: `pnpm film review ${id} --start 0 --end 3`,
      },
      media: { status: "not_run" },
      contentReview: { visual: "not_run", listening: "not_run" },
    };
  } finally {
    // This unique directory belongs to this invocation only.
    fs.rmSync(cache, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

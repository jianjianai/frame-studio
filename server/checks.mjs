import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appRoot } from "./config.mjs";
import { projectSchema } from "../src/engine/types.ts";

const tsc = path.join(appRoot, "node_modules", "typescript", "bin", "tsc");

function run(command, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [command, ...args], { cwd, windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** TypeScript errors inside the work's projects/ folder (engine files are not the work's problem). */
export async function typeCheck(work) {
  const { out } = await run(tsc, ["--noEmit", "-p", "tsconfig.json", "--pretty", "false"], work.root);
  const problems = [];
  for (const line of out.split("\n")) {
    const match = /^(projects\/[^(]+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line.trim());
    if (match)
      problems.push({
        severity: match[4],
        source: "types",
        file: match[1].replace(/^projects\/[^/]+\//, ""),
        line: Number(match[2]),
        column: Number(match[3]),
        message: `${match[6]} (${match[5]})`,
      });
  }
  return problems.slice(0, 100);
}

/** Static references films/<slug>/... must point at existing files of this work. */
export function assetReferences(work) {
  const problems = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Only source the preview loads: skip hidden folders (.cache, old .history) and notes, records and tests.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (["public", "exports", "production", "records", "tests"].includes(entry.name) && dir === work.dir) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const match of text.matchAll(/films\/([a-z0-9-]+)\/([^"'`\s)\\]+)/g)) {
          if (match[2].includes("${")) continue;
          const relative = path.relative(work.dir, full).split(path.sep).join("/");
          if (match[1] !== work.slug) problems.push({ severity: "error", source: "assets", file: relative, message: `引用了其他作品的素材：${match[0]}` });
          else if (!match[2].endsWith("/") && !fs.existsSync(path.join(work.dir, "public", match[2])))
            problems.push({ severity: "error", source: "assets", file: relative, message: `素材不存在：${match[0]}（应位于 public/${match[2]}）` });
        }
      }
    }
  };
  walk(work.dir);
  return problems;
}

/**
 * Full check: metadata, types, asset references and a real browser load that
 * renders a few frames and a little audio. Results are kept for the UI and AI.
 */
export async function checkWork(services, work, { runtime = true } = {}) {
  const started = Date.now();
  const problems = [];
  const meta = services.works.meta(work);
  if (!meta.ok) problems.push({ severity: "error", source: "project", file: "project.ts", message: meta.error });
  else {
    const parsed = projectSchema.safeParse({ ...meta.meta, visual: undefined, audioDocument: undefined });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        problems.push({ severity: "error", source: "project", file: "project.ts", message: `${issue.path.join(".") || "(根)"}：${issue.message}` });
  }
  const [types, assets] = await Promise.all([typeCheck(work), Promise.resolve(assetReferences(work))]);
  problems.push(...types, ...assets);
  let runtimeResult = null;
  if (runtime && meta.ok && !problems.some((problem) => problem.source === "project")) {
    runtimeResult = await services.renderer.check(work);
    for (const error of runtimeResult.errors) problems.push({ severity: "error", source: "runtime", message: error });
  }
  const head = await services.works.status(work).then(
    (status) => ({ commit: status.head?.commit, dirty: status.files.length }),
    () => null,
  );
  const result = {
    ok: !problems.some((problem) => problem.severity === "error"),
    checkedAt: new Date().toISOString(),
    ms: Date.now() - started,
    version: head,
    problems,
    console: runtimeResult?.console?.slice(-20) ?? [],
  };
  services.checks.set(`${work.repo}/${work.id}`, result);
  services.events.emit({ type: "work-check", work: work.id, repo: work.repo, result });
  return result;
}

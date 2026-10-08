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

/**
 * TypeScript errors inside the work's projects/ folder and in the material library code it
 * imports (copied to .materials/); engine files are not the work's problem.
 */
export async function typeCheck(work) {
  const { out } = await run(tsc, ["--noEmit", "-p", "tsconfig.json", "--pretty", "false"], work.root);
  const problems = [];
  for (const line of out.split("\n")) {
    const library = /^\.materials\/([^(]+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line.trim());
    if (library) {
      const [, ref, row, column, severity, code, message] = library;
      const engine = code === "TS2307" && /'([^']*src\/engine\/[^']*)'/.exec(message)?.[1];
      const hint = engine ? `。素材库第一层的文件写 "../../src/engine/…"，每深一层多一个 "../"` : "";
      problems.push({ severity, source: "types", message: `素材库代码 materials/${ref}:${row}:${column}：${message} (${code})${hint}` });
      continue;
    }
    const match = /^(projects\/[^(]+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line.trim());
    if (match) {
      const file = match[1].replace(/^projects\/[^/]+\//, "");
      problems.push({
        severity: match[4],
        source: "types",
        file,
        line: Number(match[2]),
        column: Number(match[3]),
        message: `${match[6]} (${match[5]})${engineImportHint(file, match[5], match[6])}`,
      });
    }
  }
  return problems.slice(0, 100);
}

/** The most common slip: copying a scene.ts import into scenes/x.ts keeps one "../" too few. */
export function engineImportHint(file, code, message) {
  const spec = code === "TS2307" && /'([^']*src\/engine\/[^']*)'/.exec(message)?.[1];
  if (!spec) return "";
  const correct = "../".repeat(file.split("/").length + 1) + "src/engine/" + spec.split("src/engine/")[1];
  return correct === spec ? "" : `。这个文件应写 "${correct}"`;
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

/** materials/<library>/<path> references: the library file (or the version the work locked) must exist. */
export async function materialReferences(services, work) {
  if (!services.materials) return [];
  const status = await services.materials.status(work);
  const linked = new Set(status.libraries.map((item) => item.id));
  const problems = [];
  for (const file of status.files) {
    if (!file.used) continue;
    const library = file.ref.split("/")[0];
    if (!file.locked && !file.current) problems.push({ severity: "error", source: "assets", message: `素材不存在：${file.url}` });
    else if (!linked.has(library))
      problems.push({ severity: "warning", source: "assets", message: `用到了没有引用的素材库「${library}」的文件 ${file.url}，用 materials_link 引用它` });
  }
  for (const name of status.missing) problems.push({ severity: "warning", source: "assets", message: `引用的素材库「${name}」不存在` });
  for (const { spec, from } of status.unresolved ?? [])
    problems.push({ severity: "error", source: "assets", ...(from.startsWith("materials/") ? {} : { file: from }), message: `素材库里没有 ${spec}（${from} 导入）` });
  return problems;
}

/** A voice track: its name or id says so, or it plays generated voice-over (public/voice/). */
const VOICE = /voice|vocal|narrat|dialog|speech|\bvo\b|配音|旁白|人声|对白|解说|朗读|台词/i;
function voiceTrack(document, id) {
  const track = document.tracks?.find((item) => item.id === id);
  if (!track) return false;
  if (VOICE.test(`${track.id} ${track.name ?? ""}`)) return true;
  const sources = new Map((document.sources ?? []).map((source) => [source.id, source]));
  const clips = (document.clips ?? []).filter((clip) => clip.track === id);
  return clips.length > 0 && clips.every((clip) => /\/voice\//.test(sources.get(clip.source)?.src ?? ""));
}

/**
 * The user's mixing rule: sound effects never push the music down. A duck processor may
 * only listen to a voice track (and only when the user asked for it, which a check cannot see).
 */
export function mixingRules(document) {
  const problems = [];
  if (!document) return problems;
  for (const owner of [...(document.tracks ?? []), ...(document.buses ?? []), { id: "master", name: "主输出", processors: document.master?.processors }])
    for (const processor of owner.processors ?? [])
      if (processor.type === "duck" && !voiceTrack(document, processor.track)) {
        const trigger = document.tracks?.find((item) => item.id === processor.track);
        problems.push({
          severity: "warning",
          source: "audio",
          file: "audio.json",
          message: `「${owner.name ?? owner.id}」的 duck 由「${trigger?.name ?? processor.track}」触发，它不是人声音轨。混音原则：音效响时不要压低音乐，只有人声（配音、旁白）才可能压低音乐，而且要用户明确要求；去掉这个 duck，用音量调平衡。`,
        });
      }
  return problems;
}

/**
 * Full check: metadata, types, asset references and a real browser load that
 * renders a few frames and a little audio. Results are kept for the UI and AI.
 */
export async function checkWork(services, work, { runtime = true, frames = false } = {}) {
  const started = Date.now();
  const problems = [];
  const meta = services.works.meta(work);
  if (!meta.ok) problems.push({ severity: "error", source: "project", file: "project.ts", message: meta.error });
  else {
    const parsed = projectSchema.safeParse({ ...meta.meta, visual: undefined, audioDocument: undefined });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        problems.push({ severity: "error", source: "project", file: "project.ts", message: `${issue.path.join(".") || "(根)"}：${issue.message}` });
    problems.push(...mixingRules(meta.meta.audioDocument));
  }
  // The library code the work imports, at its versions, where tsc finds it.
  await services.materials?.refreshCopies({ root: work.root, repo: work.repo, dir: work.dir }, { all: true }).catch(() => {});
  const [types, assets, materials] = await Promise.all([typeCheck(work), Promise.resolve(assetReferences(work)), materialReferences(services, work)]);
  problems.push(...types, ...assets, ...materials);
  let runtimeResult = null;
  if (runtime && meta.ok && !problems.some((problem) => problem.source === "project")) {
    runtimeResult = await services.renderer.check(work, { frames });
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
  // The rendered moments go to the caller only (an AI looking), not into the kept result.
  return runtimeResult?.sheet ? { ...result, sheet: runtimeResult.sheet, sheetTimes: runtimeResult.checkedTimes } : result;
}

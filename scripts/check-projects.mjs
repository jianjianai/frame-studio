import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assetPath } from "./project-paths.mjs";
import { assetCatalog } from "./project-assets.mjs";
import {
  readProject,
  sourceFile,
  validProjectId,
  visitNodes,
  expressionName,
} from "./project-metadata.mjs";

const inside = (parent, file) => {
  const rel = path.relative(parent, file);
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
};
export function localAsset(root, reference, owner) {
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    /[\\:%?#\u0000-\u001f]/.test(reference) ||
    reference.startsWith("/") ||
    reference.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "Use a plain public-relative local path, without URL, traversal, query or fragment",
    );
  const file = assetPath(root, reference, owner);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    throw new Error("Local asset is missing: " + reference);
  return file;
}
function codeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) return [];
    if (item.isDirectory())
      return [
        "scripts",
        "tests",
        "public",
        "production",
        "exports",
        ".cache",
        ".history",
      ].includes(item.name)
        ? []
        : codeFiles(file);
    return /\.(?:[cm]?[jt]sx?)$/.test(item.name) &&
      !/\.d\.[cm]?ts$/.test(item.name)
      ? [file]
      : [];
  });
}
function importFile(file, specifier) {
  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mjs", ".js", ".json", "/index.ts"].map(
      (ext) => base + ext,
    ),
  ];
  return candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
}
/** Static code and file-layout checks only. No content or production-policy checks. */
export function checkProjects(root = process.cwd(), options = {}) {
  root = path.resolve(root);
  const issues = [],
    projects = [];
  const report = (severity, code, file, message, line) =>
    issues.push({
      severity,
      code,
      file: path.relative(root, file).replaceAll("\\", "/"),
      ...(line ? { line } : {}),
      message,
    });
  const projectRoot = path.join(root, "projects");
  const directories = fs.existsSync(projectRoot)
    ? fs
        .readdirSync(projectRoot, { withFileTypes: true })
        .filter((item) => item.isDirectory() && !item.name.startsWith("."))
        .map((item) => item.name)
    : [];
  const selected = options.ids?.length ? options.ids : directories;
  let catalog = [];
  try {
    catalog = assetCatalog(root, selected.filter(validProjectId));
    if (fs.existsSync(path.join(root, "public/assets.json")))
      catalog = JSON.parse(
        fs.readFileSync(path.join(root, "public/assets.json"), "utf8"),
      );
  } catch (error) {
    report(
      "error",
      "ASSET_CATALOG",
      path.join(root, "public/assets.json"),
      error.message,
    );
  }
  if (!Array.isArray(catalog)) {
    report(
      "error",
      "ASSET_CATALOG",
      path.join(root, "public/assets.json"),
      "Asset catalog must be an array",
    );
    catalog = [];
  }
  const seen = new Set();
  for (const directory of selected) {
    const folder = path.join(projectRoot, directory),
      file = path.join(folder, "project.ts");
    if (!validProjectId(directory)) {
      report("error", "PROJECT_ID", file, "Invalid project directory name");
      continue;
    }
    if (!directories.includes(directory)) {
      report(
        "error",
        "UNKNOWN_PROJECT",
        file,
        "Project directory does not exist",
      );
      continue;
    }
    if (!fs.existsSync(file)) {
      report(
        "warning",
        "UNREGISTERED",
        file,
        "Directory is not registered; finish the scene before publishing project.ts",
      );
      continue;
    }
    let record;
    try {
      record = readProject(file);
    } catch (error) {
      report("error", "STATIC_METADATA", file, error.message);
      continue;
    }
    const { meta, loadPath } = record;
    if (
      meta.posterTime !== undefined &&
      (!Number.isFinite(meta.posterTime) ||
        meta.posterTime < 0 ||
        meta.posterTime >= meta.duration)
    )
      report(
        "error",
        "POSTER_TIME",
        file,
        "posterTime must be inside the project duration",
      );
    if (meta.audioTracks !== undefined) {
      const tracks = meta.audioTracks;
      const ids = new Set();
      if (
        !Array.isArray(tracks) ||
        tracks.length > 32 ||
        (meta.audio && tracks.length)
      )
        report(
          "error",
          "AUDIO_TRACKS",
          file,
          "Use up to 32 audioTracks; do not also set audio",
        );
      for (const track of Array.isArray(tracks) ? tracks : []) {
        if (
          !track ||
          !["file", "generated"].includes(track.kind) ||
          typeof track.id !== "string" ||
          !track.id ||
          ids.has(track.id) ||
          typeof track.name !== "string" ||
          !track.name ||
          !Number.isFinite(track.start ?? 0) ||
          (track.start ?? 0) < 0 ||
          (track.start ?? 0) >= meta.duration ||
          !Number.isFinite(track.offset ?? 0) ||
          (track.offset ?? 0) < 0 ||
          !Number.isFinite(track.duration ?? meta.duration) ||
          (track.duration ?? meta.duration) <= 0 ||
          (track.start ?? 0) +
            (track.duration ?? meta.duration - (track.start ?? 0)) >
            meta.duration ||
          !Number.isFinite(track.gain ?? 1) ||
          (track.gain ?? 1) < 0 ||
          (track.gain ?? 1) > 4 ||
          (track.muted !== undefined && typeof track.muted !== "boolean")
        ) {
          report(
            "error",
            "AUDIO_TRACKS",
            file,
            "Invalid or duplicate audio track",
          );
          continue;
        }
        ids.add(track.id);
        if (track.kind === "file") {
          try {
            localAsset(root, track.src, directory);
          } catch (error) {
            report("error", "LOCAL_ASSET", file, error.message);
          }
        } else if (
          !["./audio", "./audio.ts"].includes(record.audioLoadPath) ||
          !fs.existsSync(path.join(folder, "audio.ts"))
        )
          report(
            "error",
            "AUDIO_GENERATOR",
            file,
            "Generated audio requires loadAudio: () => import('./audio') and audio.ts",
          );
      }
    }
    projects.push({
      id: meta.id,
      directory,
      status: meta.status,
      renderer: meta.renderer,
      duration: meta.duration,
    });
    if (meta.id !== directory || seen.has(meta.id))
      report(
        "error",
        "PROJECT_ID",
        file,
        "Metadata id must match its directory and be globally unique",
      );
    seen.add(meta.id);
    if (
      meta.status !== undefined &&
      !["draft", "demo", "film"].includes(meta.status)
    )
      report(
        "error",
        "STATUS",
        file,
        "status must match the project schema enum when supplied",
      );
    if (!["canvas", "pixi", "three"].includes(meta.renderer))
      report("error", "RENDERER", file, "Unknown renderer");
    for (const key of ["title", "subtitle", "description"])
      if (
        typeof meta[key] !== "string" ||
        (key === "title" && !meta[key].trim())
      )
        report(
          "error",
          "METADATA_TEXT",
          file,
          key + " has an invalid schema value",
        );
    if (
      !Array.isArray(meta.tags) ||
      meta.tags.some((tag) => typeof tag !== "string")
    )
      report("error", "TAGS", file, "tags must be a string array");
    if (
      !Number.isFinite(meta.duration) ||
      meta.duration <= 0 ||
      meta.duration > 3600
    )
      report(
        "error",
        "DURATION",
        file,
        "Duration must be finite, positive, and at most 3600 seconds",
      );
    if (!Number.isInteger(meta.fps) || meta.fps < 12 || meta.fps > 60)
      report("error", "FPS", file, "FPS must be an integer from 12 to 60");
    if (loadPath !== "./scene" && loadPath !== "./scene.ts")
      report(
        "error",
        "SCENE_ENTRY",
        file,
        'load must import this project\'s "./scene"',
      );
    if (!fs.existsSync(path.join(folder, "scene.ts")))
      report(
        "error",
        "SCENE_MISSING",
        file,
        "Registered project has no scene.ts; this can break the whole gallery",
      );
    for (const key of ["poster", "audio", "research"]) {
      if (key !== "poster" && meta[key] === undefined) continue;
      try {
        localAsset(root, meta[key], directory);
      } catch (error) {
        report("error", "LOCAL_ASSET", file, key + ": " + error.message);
      }
    }
    const beats = Array.isArray(meta.beats) ? meta.beats : [];
    if (!Array.isArray(meta.beats))
      report("error", "BEATS", file, "beats must be an array");
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      if (
        !beat ||
        !Number.isFinite(beat.at) ||
        beat.at < 0 ||
        beat.at >= meta.duration ||
        (i && beat.at <= beats[i - 1]?.at) ||
        typeof beat.title !== "string" ||
        !beat.title.trim()
      )
        report(
          "error",
          "BEATS",
          file,
          `Shot marker ${i} is unordered, duplicated, unnamed, or outside duration`,
        );
    }
    if (!Array.isArray(meta.subtitles))
      report("error", "SUBTITLES", file, "subtitles must be an array");
    for (
      let i = 0;
      i < (Array.isArray(meta.subtitles) ? meta.subtitles.length : 0);
      i++
    ) {
      const cue = meta.subtitles[i],
        previous = meta.subtitles[i - 1];
      if (
        !cue ||
        !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) ||
        cue.start < 0 ||
        cue.end <= cue.start ||
        cue.end > meta.duration ||
        (previous && cue.start < previous.end) ||
        typeof cue.text !== "string" ||
        !cue.text.trim()
      )
        report(
          "error",
          "SUBTITLES",
          file,
          `Subtitle ${i} is empty, overlapping, unordered, or outside duration`,
        );
    }
    if (!Array.isArray(meta.credits))
      report("error", "CREDITS", file, "credits must be a string array");
    for (const credit of Array.isArray(meta.credits) ? meta.credits : []) {
      if (typeof credit !== "string") {
        report("error", "CREDITS", file, "Credit must be a string");
        continue;
      }
      for (const match of credit.matchAll(
        /(?:docs|production|public)\/[A-Za-z0-9_./-]+\.(?:md|json|html)\b/g,
      ))
        if (!fs.existsSync(path.join(root, match[0])))
          report(
            "warning",
            "BROKEN_DOC_LINK",
            file,
            "Credited local document does not exist: " + match[0],
          );
    }
    if (meta.audio) {
      const entries = catalog.filter((item) => item?.url === meta.audio);
      if (entries.length !== 1)
        report(
          "warning",
          "AUDIO_CATALOG",
          file,
          "The soundtrack must have one asset-catalog entry",
        );
      else {
        const item = entries[0];
        if (typeof item.license !== "string" || !item.license.trim())
          report(
            "warning",
            "AUDIO_LICENSE",
            file,
            "Resource source/license metadata is missing",
          );
        try {
          if (
            item.type !== "audio" ||
            item.bytes !== fs.statSync(localAsset(root, meta.audio)).size
          )
            report(
              "warning",
              "AUDIO_CATALOG",
              file,
              "Soundtrack catalog type or byte size is stale",
            );
        } catch {}
      }
    }
    const engineering = path.join(folder, "README.md");
    if (!fs.existsSync(engineering))
      report(
        "warning",
        "ENGINEERING_ENTRY",
        file,
        "Add projects/" +
          directory +
          "/README.md to index source files, dependencies, script inputs/outputs and tests",
      );
    for (const codeFile of codeFiles(folder)) {
      let source;
      try {
        source = sourceFile(codeFile);
      } catch (error) {
        report("error", "SOURCE_SYNTAX", codeFile, error.message);
        continue;
      }
      const emit = (code, node, message) =>
        report("error", code, codeFile, message, node.loc?.start.line ?? 1);
      const visit = (node) => {
        if (
          [
            "CallExpression",
            "OptionalCallExpression",
            "NewExpression",
          ].includes(node.type)
        ) {
          const expression = expressionName(node.callee);
          if (
            /^(?:(?:window|globalThis)\.)?(?:requestAnimationFrame|setInterval)$/.test(
              expression,
            ) ||
            /\.setAnimationLoop$/.test(expression)
          )
            emit(
              "OWN_CLOCK",
              node,
              "Scenes may not start their own animation loop",
            );
          if (
            /^(?:Math\.random|Date\.now|performance\.now)$/.test(expression) ||
            (expression === "Date" &&
              node.type === "NewExpression" &&
              !node.arguments?.length)
          )
            emit(
              "NONDETERMINISTIC_TIME",
              node,
              "Use absolute render(time) and seeded initial data",
            );
          if (
            /^(?:(?:window|globalThis)\.)?(?:Audio|AudioContext|webkitAudioContext)$/.test(
              expression,
            )
          )
            emit(
              "OWN_AUDIO",
              node,
              "Scenes must use the shared AudioTransport, not independent audio",
            );
          const first = node.arguments?.[0];
          if (
            first &&
            first.type === "StringLiteral" &&
            /^https?:\/\//.test(first.value) &&
            /(?:^fetch$|\.load$|^loadGltf$|^URL$)/.test(expression)
          )
            emit(
              "REMOTE_RUNTIME_ASSET",
              node,
              "Runtime assets must be local and have recorded licensing",
            );
        }
        const spec = [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
          "ImportExpression",
        ].includes(node.type)
          ? node.source
          : undefined;
        if (spec?.type === "StringLiteral") {
          if (
            /^(?:node:|fs$|path$|child_process$|os$|worker_threads$)/.test(
              spec.value,
            )
          )
            emit(
              "NODE_RUNTIME_IMPORT",
              node,
              "Browser project code cannot import Node APIs",
            );
          if (/^(?:https?:)?\/\//.test(spec.value))
            emit(
              "REMOTE_IMPORT",
              node,
              "Runtime CDN imports are not permitted",
            );
          if (spec.value.startsWith(".")) {
            const resolved = importFile(codeFile, spec.value);
            if (!resolved)
              emit(
                "IMPORT_MISSING",
                node,
                "Missing local import: " + spec.value,
              );
            else if (inside(projectRoot, resolved) && !inside(folder, resolved))
              emit(
                "CROSS_PROJECT_IMPORT",
                node,
                "Do not depend on another film's private source; use a reviewed engine/shared module",
              );
            else if (
              !inside(folder, resolved) &&
              !inside(path.join(root, "src/engine"), resolved)
            )
              emit(
                "PRIVATE_PLATFORM_IMPORT",
                node,
                "Projects may only import their own files and public src/engine modules",
              );
          }
        }
      };
      visitNodes(source, visit);
    }
  }
  const counts = {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    root,
    strict: Boolean(options.strict),
    projects,
    issues,
    ...counts,
    passed: counts.errors === 0 && (!options.strict || counts.warnings === 0),
    limitation:
      "Static code and file-layout checks only; runtime behavior, complete lifecycle, filesystem concurrency and legal rights require separate verification.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2),
    flags = args.filter((arg) => arg.startsWith("--"));
  if (flags.some((flag) => !["--json", "--strict"].includes(flag))) {
    console.error("Usage: pnpm project:check [id ...] [--strict] [--json]");
    process.exitCode = 2;
  } else {
    const report = checkProjects(process.cwd(), {
      ids: args.filter((arg) => !arg.startsWith("--")),
      strict: args.includes("--strict"),
    });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      for (const issue of report.issues)
        console.log(
          `[${issue.severity.toUpperCase()} ${issue.code}] ${issue.file}${issue.line ? ":" + issue.line : ""}: ${issue.message}`,
        );
      console.log(
        `${report.projects.length} projects; ${report.errors} errors; ${report.warnings} warnings. ${report.passed ? "Engineering checks passed" : "Engineering checks failed"}. No content-policy checks.`,
      );
    }
    process.exitCode = report.passed ? 0 : 1;
  }
}

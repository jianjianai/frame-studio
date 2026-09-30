import fs from "node:fs";
import { authoringState } from "./authoring-state.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readProject, validProjectId } from "./project-metadata.mjs";
import { projectPath } from "./project-paths.mjs";
import { checkProjects } from "./check-projects.mjs";
import { inspectProjectScope } from "./project-scope-report.mjs";
import { inputManifest } from "./production-input.mjs";
import { toolError } from "./work-tool-client.mjs";

const pick = (object, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => object?.[key] !== undefined)
      .map((key) => [key, object[key]]),
  );
const boundedRead = (file, limit) => {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    fs.readSync(fd, bytes, 0, bytes.length, 0);
    return { text: bytes.toString("utf8"), truncated: stat.size > limit };
  } finally {
    fs.closeSync(fd);
  }
};

export function creatorWorkspace(root, options = {}, env = process.env) {
  let task = null;
  const file = path.join(root, "task.json");
  if (fs.existsSync(file)) {
    const raw = boundedRead(file, 512 * 1024);
    if (!raw || raw.truncated)
      throw toolError(
        "INVALID_TASK_CONTEXT",
        "Task context is not a bounded regular file.",
        "Inspect the task workspace, not its credentials.",
      );
    try {
      task = JSON.parse(raw.text);
    } catch {
      throw toolError(
        "INVALID_TASK_CONTEXT",
        "Task context is invalid JSON.",
        "Inspect the task workspace, not its credentials.",
      );
    }
  }
  const activeProject = env.FRAME_PROJECT || task?.project;
  const id = options.project ?? activeProject;
  if (!validProjectId(id))
    throw toolError(
      "PROJECT_REQUIRED",
      "Supply a valid project outside an active task.",
      'node scripts/work-tool.mjs context \'{"project":"my-film"}\'',
    );
  if (
    (activeProject && id !== activeProject) ||
    (task?.project && id !== task.project)
  )
    throw toolError(
      "PROJECT_MISMATCH",
      "An active task cannot switch to a different work.",
      "Continue in the current task's project.",
    );
  const folder = projectPath(root, id);
  if (!fs.existsSync(folder))
    throw toolError(
      "UNKNOWN_PROJECT",
      "Project does not exist: " + id,
      "Use pnpm --silent film list --json.",
    );
  return { root, id, folder, task };
}

function sourceIndex(folder) {
  const files = [];
  let visited = 0,
    truncated = false;
  const walk = (directory, depth = 0) => {
    if (depth > 8) {
      truncated = true;
      return;
    }
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 500 || files.length >= 80) {
        truncated = true;
        return;
      }
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        ["exports", "node_modules", "records"].includes(entry.name)
      )
        continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (
        entry.isFile() &&
        /\.(?:[cm]?[jt]sx?|json|md|srt)$/.test(entry.name)
      )
        files.push(path.relative(folder, file).replaceAll("\\", "/"));
    }
  };
  walk(folder);
  return { files, truncated };
}

function scopeReport(root, id) {
  try {
    return inspectProjectScope(root, id, { limit: 12 });
  } catch {
    return {
      status: "not_run",
      passed: false,
      nextAction:
        "Git scope could not be read. Check the repository/ownership and establish a task baseline; do not reset another checkout.",
    };
  }
}

/** Read-only and still useful when metadata or the asset catalog is broken. */
export function readCreatorContext(root, options = {}, env = process.env) {
  const { id, folder, task } = creatorWorkspace(root, options, env);
  const diagnostics = [];
  let entry = null, state = null;
  try {
    entry = readProject(projectPath(root, id, "project.ts"));
    state = authoringState(entry);
  } catch (error) {
    diagnostics.push({
      code: "STATIC_METADATA",
      path: `projects/${id}/project.ts`,
      message: error.message,
    });
  }
  let structure;
  try {
    structure = checkProjects(root, { ids: [id], strict: true });
  } catch (error) {
    diagnostics.push({ code: "STRUCTURE_UNAVAILABLE", message: error.message });
  }
  const meta = entry?.meta;
  const request = pick(task?.input?.context, [
    "time",
    "start",
    "end",
    "assets",
    "previewTask",
    "sourceCommit",
    "shotId",
  ]);
  const reference = pick(task?.reviewReference, [
    "status",
    "previewTask",
    "sourceCommit",
    "fingerprint",
    "disposition",
    "executionCommit",
    "shotId",
    "path",
  ]);
  const stale = reference.disposition === "compare-to-latest";
  const beats = Array.isArray(meta?.beats)
    ? meta.beats
        .filter((beat) => beat && Number.isFinite(beat.at))
        .sort((a, b) => a.at - b.at)
    : [];
  const focusTime = stale ? null : (request.start ?? request.time ?? null);
  const subtitles = Array.isArray(meta?.subtitles) ? meta.subtitles : [];
  const scope = scopeReport(root, id);
  return {
    schemaVersion: 1,
    status: structure?.passed && !diagnostics.length ? "ready" : "needs_repair",
    project: id,
    task: task ? { id: task.id ?? null, kind: task.kind ?? null } : null,
    boundary: `projects/${id}/`,
    source: sourceIndex(folder),
    projectInfo: meta
      ? pick(meta, ["title", "renderer", "duration", "fps", "composition"])
      : null,
    ...(state ?? { entrypoints: { metadata: "project.ts" }, audioTracks: [], authority: { status: "needs_repair" } }),
    timeline: {
      shotCount: beats.length,
      shots: beats.slice(0, 48),
      truncated: beats.length > 48,
      subtitleCount: subtitles.length,
    },
    request,
    reference,
    focus: {
      mapping: stale ? "requires_comparison" : "current_or_unversioned",
      time: focusTime,
      shot:
        focusTime === null
          ? null
          : ([...beats].reverse().find((beat) => beat.at <= focusTime) ?? null),
      captions:
        focusTime === null
          ? []
          : subtitles
              .filter(
                (caption) =>
                  caption &&
                  caption.start <= (request.end ?? focusTime) &&
                  caption.end > focusTime,
              )
              .slice(0, 8),
      note: stale
        ? "Review timecodes belong to an older preview. Compare the supplied read-only reference before choosing a current start/end; do not overwrite the current work."
        : "This is a review location, not a guarantee that edits affect only this range.",
    },
    files: {
      readme: boundedRead(projectPath(root, id, "README.md"), 4000),
      brief: boundedRead(projectPath(root, id, "production/brief.md"), 6000),
    },
    engineering: {
      passed: structure?.passed ?? false,
      issues: [...diagnostics, ...(structure?.issues ?? [])].slice(0, 40),
    },
    scope,
    platformTools: {
      available: Boolean(env.FRAME_AGENT_URL && env.FRAME_AGENT_TOKEN),
      help: "node scripts/work-tool.mjs help --json",
      assets: 'node scripts/work-tool.mjs assets \'{"limit":30,"offset":0}\'',
      speech: "node scripts/work-tool.mjs engines",
    },
    commands: {
      check: `node scripts/work-tool.mjs check '{"project":"${id}"}'`,
      runtimeCheck: `node scripts/work-tool.mjs check '{"project":"${id}","runtime":true}'`,
      readMetadata: `pnpm --silent film read ${id} --path project.ts --json`,
      browserTests: `pnpm --silent film test-e2e ${id} --json`,
      checkpoint: `pnpm --silent film checkpoint ${id} --label before-edit --json`,
      review: `pnpm --silent film review ${id} --start 0 --end ${Math.min(meta?.duration || 2, 2)} --json`,
      export: `pnpm --silent film export ${id} --json`,
    },
    guide: "docs/CREATOR-WORKFLOW.md",
    acceptance: {
      engineering: structure?.passed ? "structure_only" : "needs_repair",
      runtime: "not_run",
      media: "not_run",
      visual: "not_run",
      listening: "not_run",
    },
  };
}

export function creatorSampleRange(context, options) {
  const duration = context.projectInfo?.duration;
  if (
    context.reference.disposition === "compare-to-latest" &&
    options.start === undefined
  )
    throw toolError(
      "REVIEW_MAPPING_REQUIRED",
      "The selected range belongs to an older preview.",
      "Compare the reference with current source, then explicitly supply a current start (and optional end).",
    );
  const start =
    options.start ?? context.request.start ?? context.request.time ?? 0;
  const end =
    options.end ??
    Math.min(
      duration,
      start + 2,
      options.start === undefined
        ? (context.request.end ?? duration)
        : duration,
    );
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > duration ||
    end - start > 6
  )
    throw toolError(
      "INVALID_SAMPLE_RANGE",
      "Choose a current range inside the work, at most 6 seconds long.",
      "Set start/end explicitly. Longer checks remain available through film playback/review.",
    );
  return { start, end, sampled: true };
}

/** Compose existing validators; do not create a second validation or render implementation. */
export async function checkCreatorWork(root, options = {}, env = process.env) {
  const context = readCreatorContext(root, options, env);
  const id = context.project;
  const report = {
    schemaVersion: 1,
    project: id,
    status: "failed",
    checks: {},
    contentReview: { visual: "not_run", listening: "not_run" },
    media: { status: "not_run" },
    errors: [],
  };
  const checks = report.checks;
  checks.scope = context.scope;
  const directory = projectPath(
    root,
    id,
    "exports/creator-checks/" + randomUUID(),
  );
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "report.json");
  const summary = {};
  try {
    if (!context.engineering.passed) {
      checks.engineering = {
        status: "failed",
        issues: context.engineering.issues,
      };
    } else {
      const { executeProject, runProcess } =
        await import("./project-execution.mjs");
      const before = inputManifest(root, id);
      report.input = before;
      checks.engineering = await executeProject(root, id, "validate");
      if (checks.engineering.status === "passed" && options.runtime) {
        const range = creatorSampleRange(context, options);
        report.range = range;
        const { checkPlayback } = await import("./playback-check.mjs");
        checks.playback = await checkPlayback(root, id, {
          start: range.start,
          duration: range.end - range.start,
        });
        const times = [
          ...new Set([
            range.start,
            (range.start + range.end) / 2,
            Math.max(range.start, range.end - 1 / context.projectInfo.fps),
          ]),
        ];
        const image = path.join(directory, "storyboard.png");
        checks.storyboard = await runProcess(
          process.execPath,
          [
            path.join(root, "scripts/film.mjs"),
            "storyboard",
            id,
            "--times",
            times.join(","),
            "--width",
            "480",
            "--out",
            image,
            "--json",
          ],
          { root },
        );
        if (checks.storyboard.status === "passed" && fs.existsSync(image))
          summary.storyboard = image;
        else if (checks.storyboard.status === "passed")
          checks.storyboard.status = "failed";
      }
      if (inputManifest(root, id).fingerprint !== before.fingerprint)
        throw toolError(
          "INPUT_CHANGED",
          "Source changed during this check.",
          "Repeat checks against one stable version before claiming acceptance.",
        );
      // Re-read scope after tool execution so unexpected runtime root writes are caught.
      checks.scope = scopeReport(root, id);
    }
    checks.playback ??= { status: "not_run" };
    checks.storyboard ??= { status: "not_run" };
    report.status =
      checks.scope.passed &&
      checks.engineering.status === "passed" &&
      !Object.values(checks).some((check) => check.status === "failed")
        ? "passed"
        : "failed";
  } catch (error) {
    report.errors.push({
      code: error.code || "CHECK_FAILED",
      message: error.message,
      nextAction:
        error.nextAction ||
        "Inspect the report and repair the failed stage before retrying.",
    });
  }
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  const engineering = checks.engineering?.engineering;
  return {
    schemaVersion: 1,
    project: id,
    status: report.status,
    report: file,
    input: report.input
      ? {
          fingerprint: report.input.fingerprint,
          fileCount: report.input.files.length,
        }
      : null,
    stages: {
      scope: checks.scope.passed
        ? "passed"
        : checks.scope.status === "not_run"
          ? "not_run"
          : "failed",
      engineering: checks.engineering?.status ?? "not_run",
      tests: engineering?.tests?.status ?? "not_run",
      playback: checks.playback?.status ?? "not_run",
      storyboard: checks.storyboard?.status ?? "not_run",
      media: "not_run",
    },
    range: report.range ?? null,
    artifacts: summary,
    diagnostics: {
      issues: checks.engineering?.issues ?? [],
      scope: checks.scope.passed ? null : checks.scope,
      errors: report.errors,
      types:
        engineering?.types?.status === "failed"
          ? engineering.types.output.slice(-6000)
          : null,
      tests:
        engineering?.tests?.status === "failed"
          ? engineering.tests.output.slice(-6000)
          : null,
      playback: checks.playback?.errors ?? [],
      storyboard:
        checks.storyboard?.status === "failed"
          ? checks.storyboard.output.slice(-4000)
          : null,
    },
    contentReview: report.contentReview,
    nextAction:
      report.status !== "passed"
        ? "Repair the reported stage and rerun check; do not discard unrelated changes."
        : options.runtime
          ? "Open artifacts.storyboard with an image-reading tool. Review sound/timing with film review, and export/verify only when a final deliverable is requested. Technical samples are not full-film or listening acceptance."
          : "Engineering checks passed. Run check with runtime:true for sampled playback and frames; use film test-e2e for project browser tests.",
  };
}

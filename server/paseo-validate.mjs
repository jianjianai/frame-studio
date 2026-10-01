import fs from "node:fs/promises";
import path from "node:path";
import { command } from "./process.mjs";
import { fileURLToPath } from "node:url";
import { createRenderSession, framePng } from "../scripts/render-session.mjs";
import { readProject } from "../scripts/project-metadata.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { confinedAsync, treeHash } from "./project-files.mjs";
import { validateProject } from "./project-validation.mjs";

/** Probe the actual shared browser renderer and short float audio; never encode a movie. */
export async function probePaseoRuntime({
  work,
  project,
  signal,
  sessionFactory = createRenderSession,
}) {
  const { meta } = readProject(
    path.join(work, "projects", project, "project.ts"),
  );
  const session = await sessionFactory({ root: work, width: 320, signal });
  let page;
  const samples = [];
  try {
    page = await session.page(project, { purpose: "media" });
    for (const at of [...new Set([0, meta.duration / 2])]) {
      signal?.throwIfAborted();
      const png = await framePng(page, at, false);
      if (
        png.length < 8 ||
        !png
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw Error("Runtime frame did not produce PNG bytes");
      const duration = Math.min(0.125, meta.duration - at);
      if (duration <= 0) continue;
      const encoded = await page.evaluate(
        ({ at, duration }) =>
          window.__FRAME_STUDIO__.audioChunk(
            at,
            duration,
            undefined,
            "float32",
          ),
        { at, duration },
      );
      const pcm = Buffer.from(encoded, "base64");
      if (!pcm.length || pcm.length % 8)
        throw Error("Runtime audio has invalid stereo float32 length");
      for (let offset = 0; offset < pcm.length; offset += 4)
        if (!Number.isFinite(pcm.readFloatLE(offset)))
          throw Error("Runtime audio contains non-finite samples");
      samples.push({
        time: at,
        duration,
        audioFrames: pcm.length / 8,
        pngBytes: png.length,
      });
      const errors = page.frameDiagnostics?.().errors || [];
      if (errors.length)
        throw Error("Runtime probe failed: " + errors.join("\n"));
    }
    return { status: "passed", width: 320, samples };
  } finally {
    try {
      await page?.close();
    } finally {
      await session.close();
    }
  }
}

function boundedRun(work, signal) {
  return (bin, args) =>
    command(bin, args, {
      cwd: work,
      signal,
      timeout: 120000,
      max: 8 * 1024 * 1024,
    });
}

/** Runs inside a candidate-owned validation worker; no access to the live draft is required. */
export async function validatePaseoCandidate({
  core,
  work,
  project,
  baselineCommit,
  fingerprint,
  modeFingerprint,
  runtimeFingerprint,
  signal,
  run = boundedRun(work, signal),
  runtimeProbe = probePaseoRuntime,
}) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(project) || project.length > 64)
    throw Error("Invalid Paseo project identity");
  if (!/^[a-f0-9]{40}$/.test(baselineCommit || ""))
    throw Error("Candidate needs an actual Git baseline commit");
  const source = await confinedAsync(work, "projects/" + project);
  const before = await treeHash(source);
  const beforeMode = await treeHash(source, { includeExecutableMode: true });
  if (
    (fingerprint && before !== fingerprint) ||
    (modeFingerprint && beforeMode !== modeFingerprint)
  )
    throw Error("Candidate source differs from its frozen snapshot");
  const runtime = await runtimeIdentity(core);
  if (runtimeFingerprint && runtime.fingerprint !== runtimeFingerprint)
    throw Error("Candidate validator runtime differs from the frozen runtime");
  const validation = [],
    metrics = {};
  const measured = async (name, callback, { check = false } = {}) => {
    signal?.throwIfAborted();
    const started = performance.now();
    try {
      const value = await callback();
      metrics[name] = Math.round(performance.now() - started);
      if (check)
        validation.push({ name, status: "passed", durationMs: metrics[name] });
      return value;
    } catch (error) {
      metrics[name] = Math.round(performance.now() - started);
      if (check)
        validation.push({ name, status: "failed", durationMs: metrics[name] });
      throw error;
    }
  };
  await validateProject({ core, work, project, baselineCommit, run, measured });
  const probe = await measured(
    "runtime",
    () => runtimeProbe({ work, project, signal }),
    { check: true },
  );
  if (
    (await treeHash(source)) !== before ||
    (await treeHash(source, { includeExecutableMode: true })) !== beforeMode
  )
    throw Error("Candidate source changed during validation");
  return {
    status: "passed",
    previewMode: "live",
    fingerprint: before,
    modeFingerprint: beforeMode,
    runtime,
    runtimeFingerprint: runtime.fingerprint,
    validation,
    metrics,
    probe,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const work = process.env.FRAME_EXECUTOR_WORK || "/workspace";
  const cancellation = new AbortController();
  const stop = () => cancellation.abort(Error("Validation cancelled"));
  process.once("SIGTERM", stop);
  try {
    const task = JSON.parse(
      await fs.readFile(path.join(work, "task.json"), "utf8"),
    );
    const result = await validatePaseoCandidate({
      core: process.env.FRAME_EXECUTOR_CORE || "/opt/frame",
      work,
      project: task.project,
      baselineCommit: task.baselineCommit,
      fingerprint: task.fingerprint,
      modeFingerprint: task.modeFingerprint,
      runtimeFingerprint: task.runtimeFingerprint,
      signal: cancellation.signal,
    });
    await fs.writeFile(path.join(work, "result.json"), JSON.stringify(result));
  } catch (error) {
    const message = String(error.message);
    await fs.writeFile(
      path.join(work, "result.json"),
      JSON.stringify({ status: "failed", error: message }),
    );
    console.error(message);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", stop);
  }
}

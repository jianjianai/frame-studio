import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createExportPlan } from "../../src/engine/export-plan.mjs";
import { readProject } from "../project-metadata.mjs";
import { fail, MAX_FILE } from "./workspace.mjs";

const ACTIVE = new Set(["running", "cancelling"]);
const mime = (file) =>
  file.endsWith(".png")
    ? "image/png"
    : file.endsWith(".json")
      ? "application/json"
      : "video/mp4";
const validJobId = (id) =>
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);

/** No client-supplied executable, command line, URL, output path or PID. */
export class Jobs {
  constructor(workspace, { timeoutMs = 600000, persistent = false } = {}) {
    this.workspace = workspace;
    this.timeoutMs = timeoutMs;
    this.running = new Map();
    this.closed = false;
    this.persistent = persistent;
  }
  folder(id, jobId) {
    if (!validJobId(jobId)) fail("INVALID_JOB", "Invalid job id.");
    return this.workspace.file(id, "exports/mcp/" + jobId);
  }
  persist(state) {
    const directory = this.folder(state.project, state.id);
    const temp = path.join(directory, "job.json.tmp");
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(temp, path.join(directory, "job.json"));
  }
  start(id, kind, options) {
    this.workspace.writable();
    if (this.closed) fail("SHUTTING_DOWN", "Server is shutting down.");
    if (this.running.size >= 2)
      fail(
        "JOB_LIMIT",
        "Two render jobs are already running; wait or cancel one.",
      );
    const validation = this.workspace.check(id);
    if (!validation.passed)
      fail("VALIDATION_FAILED", "Fix strict project checks before rendering.", {
        validation,
      });
    const { meta } = readProject(this.workspace.file(id, "project.ts"));
    const width = options.width ?? (kind === "render" ? 1280 : 640);
    const plan = createExportPlan({
      duration: meta.duration,
      fps: options.fps ?? meta.fps,
      width,
      start: options.start ?? 0,
      end: options.end ?? meta.duration,
    });
    const args = [id, "--width", String(width)];
    let script, outputName;
    if (kind === "render") {
      script = "render.mjs";
      outputName = "video.mp4";
      args.push(
        "--fps",
        String(plan.fps),
        "--start",
        String(plan.start),
        "--end",
        String(plan.end),
      );
    } else if (kind === "frame") {
      script = "render.mjs";
      outputName = "frame.png";
      const time = options.time ?? 0;
      if (time >= meta.duration)
        fail("INVALID_TIME", "Frame time must be inside the project duration.");
      args.push("--frame-mode", "--time", String(time));
    } else if (kind === "storyboard") {
      script = "storyboard.mjs";
      outputName = "storyboard.png";
      const times =
        options.times ??
        [
          ...new Set([
            0,
            ...meta.beats.map((b) => b.at),
            (plan.frames - 1) / plan.fps,
          ]),
        ].sort((a, b) => a - b);
      if (
        times.length > 48 ||
        times.some((time) => time < 0 || time >= meta.duration)
      )
        fail(
          "INVALID_TIME",
          "Select at most 48 timestamps inside the project.",
        );
      args.push("--times", times.join(","));
    } else if (
      [
        "validate",
        "typecheck",
        "test",
        "test-e2e",
        "build",
        "review",
        "verify",
        "export",
        "narrate",
        "playback",
      ].includes(kind)
    ) {
      script = "production-job.mjs";
      outputName = "result.json";
      args.splice(
        0,
        args.length,
        id,
        "--kind",
        kind,
        "--options",
        JSON.stringify(options),
      );
    } else fail("INVALID_JOB", "Unknown job kind.");
    if (options.subtitles === false) args.push("--no-subtitles");
    const release = this.workspace.lock(id, kind);
    const jobId = randomUUID();
    const directory = this.folder(id, jobId);
    let child;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const output = path.join(directory, outputName);
      args.push("--out", output);
      const state = {
        schemaVersion: 1,
        persistent: this.persistent,
        id: jobId,
        project: id,
        kind,
        status: "running",
        startedAt: new Date().toISOString(),
        sourceFingerprint: this.workspace.fingerprint(id),
        options,
        artifacts: [],
        log: "",
        timeoutMs: this.timeoutMs,
      };
      this.persist(state);
      child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../" + script, import.meta.url)), ...args],
        {
          cwd: this.workspace.root,
          env: { ...process.env, FRAME_TASK_ID: jobId },
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const entry = { state, child, done, reason: null, exited: false };
      this.running.set(jobId, entry);
      const heartbeat = this.persistent
        ? setInterval(() => {
            state.heartbeatAt = new Date().toISOString();
            this.persist(state);
            if (fs.existsSync(path.join(directory, "cancel.request")))
              void this.stop(entry, "cancelled");
          }, 1000)
        : null;
      const log = (chunk) => {
        state.log = (state.log + chunk.toString()).slice(-32768);
        for (const match of state.log.matchAll(/Frame (\d+)\/(\d+)/g))
          state.progress = {
            completed: Number(match[1]),
            total: Number(match[2]),
          };
        this.persist(state);
      };
      child.stdout.on("data", log);
      child.stderr.on("data", log);
      child.on("error", (error) => {
        entry.spawnError = error.message;
      });
      const timer = setTimeout(() => {
        void this.stop(entry, "timed_out");
      }, this.timeoutMs);
      timer.unref();
      child.once("exit", () => {
        entry.exited = true;
      });
      child.once("close", (code) => {
        if (heartbeat) clearInterval(heartbeat);
        clearTimeout(timer);
        state.finishedAt = new Date().toISOString();
        state.exitCode = code;
        state.status =
          entry.reason ??
          (code === 0 && !entry.spawnError ? "succeeded" : "failed");
        try {
          if (state.status === "succeeded" && !fs.existsSync(output)) {
            state.status = "failed";
            state.error = "Renderer exited without its expected artifact.";
          }
          if (state.status === "succeeded") {
            state.artifacts = fs
              .readdirSync(directory)
              .filter(
                (name) => name !== "job.json" && /\.(png|mp4|json)$/.test(name),
              )
              .map((name) => this.describe(id, jobId, name));
          } else {
            state.error ??=
              entry.spawnError ?? "Job " + state.status + "; see log.";
            // Delete only this freshly-created job's files, after its process tree exits.
            for (const name of fs.readdirSync(directory)) {
              if (name !== "job.json")
                fs.rmSync(
                  this.workspace.file(
                    id,
                    "exports/mcp/" + jobId + "/" + name,
                    true,
                  ),
                  { force: true },
                );
            }
          }
          this.persist(state);
        } catch (error) {
          state.status = "failed";
          state.error = "Job finalization failed: " + error.message;
          try {
            this.persist(state);
          } catch {}
        } finally {
          try {
            const snapshots = this.workspace.file(
              id,
              ".cache/production",
              true,
            );
            if (fs.existsSync(snapshots))
              for (const name of fs.readdirSync(snapshots)) {
                if (!validJobId(name)) continue;
                const directory = this.workspace.file(
                  id,
                  ".cache/production/" + name,
                  true,
                );
                const owner = path.join(directory, ".owner.json");
                if (
                  fs.existsSync(owner) &&
                  JSON.parse(fs.readFileSync(owner, "utf8")).task === jobId
                ) {
                  const dependencies = path.join(directory, "node_modules");
                  if (fs.existsSync(dependencies)) fs.unlinkSync(dependencies);
                  fs.rmSync(directory, {
                    recursive: true,
                    force: true,
                    maxRetries: 5,
                    retryDelay: 200,
                  });
                }
              }
            const renders = this.workspace.file(id, "exports/renders", true);
            if (fs.existsSync(renders)) {
              for (const name of fs.readdirSync(renders)) {
                if (!validJobId(name)) continue;
                const lock = this.workspace.file(
                  id,
                  "exports/renders/" + name + "/render.lock",
                  true,
                );
                // The owned process tree has exited. Never clear another job's lock.
                if (
                  fs.existsSync(lock) &&
                  JSON.parse(fs.readFileSync(lock, "utf8")).task === jobId
                )
                  fs.unlinkSync(lock);
              }
            }
            release();
          } catch (error) {
            state.status = "failed";
            state.error = "Lock cleanup failed: " + error.message;
            try {
              this.persist(state);
            } catch {}
          }
          this.running.delete(jobId);
          resolveDone();
        }
      });
      return this.status(id, jobId);
    } catch (error) {
      if (child && child.pid) child.kill();
      release();
      throw error;
    }
  }
  async stop(entry, reason) {
    if (
      entry.exited ||
      entry.child.exitCode !== null ||
      entry.child.signalCode !== null
    )
      return entry.done;
    if (entry.stopping) return entry.done;
    entry.stopping = true;
    entry.reason = reason;
    entry.state.status = "cancelling";
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const killer = spawn(
          "taskkill",
          ["/PID", String(entry.child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", () => {
          entry.child.kill();
          resolve();
        });
        killer.once("close", (code) => {
          if (code !== 0 && !entry.exited) entry.child.kill();
          resolve();
        });
      });
    } else {
      try {
        process.kill(-entry.child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") entry.child.kill("SIGKILL");
      }
    }
    return entry.done;
  }
  async cancel(id, jobId) {
    this.workspace.writable();
    this.folder(id, jobId);
    const entry = this.running.get(jobId);
    if (entry && entry.state.project === id)
      await this.stop(entry, "cancelled");
    return this.status(id, jobId);
  }
  status(id, jobId) {
    const directory = this.folder(id, jobId);
    const entry = this.running.get(jobId);
    let state;
    if (entry?.state.project === id) state = structuredClone(entry.state);
    else {
      const file = this.workspace.file(
        id,
        "exports/mcp/" + jobId + "/job.json",
      );
      if (!fs.existsSync(file))
        fail("UNKNOWN_JOB", "Job was not found in this project.");
      if (fs.statSync(file).size > MAX_FILE)
        fail("TOO_LARGE", "Job report exceeds limit.");
      state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.id !== jobId || state.project !== id)
        fail("INVALID_JOB", "Job report identity mismatch.");
      if (
        ACTIVE.has(state.status) &&
        !(
          state.persistent &&
          Date.now() - Date.parse(state.heartbeatAt ?? state.startedAt) < 5000
        )
      ) {
        state.status = "unobserved";
        state.error =
          "This job is not owned by this session. Its original server may still be running. Inspect its lock before recovery; never infer completion from an old report.";
      }
    }
    try {
      state.sourceChanged =
        this.workspace.fingerprint(id) !== state.sourceFingerprint;
    } catch {
      state.sourceChanged = true;
    }
    return { ...state, directory };
  }
  describe(id, jobId, name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.(png|json|mp4)$/.test(name))
      fail("INVALID_ARTIFACT", "Unsupported artifact name.");
    const full = this.workspace.file(id, "exports/mcp/" + jobId + "/" + name);
    const stat = fs.statSync(full);
    if (!stat.isFile())
      fail("INVALID_ARTIFACT", "Artifact is not a regular file.");
    return {
      name,
      path: full,
      bytes: stat.size,
      mimeType: mime(name),
      uri: "frame://artifacts/" + id + "/" + jobId + "/" + name,
    };
  }
  artifact(id, jobId, name) {
    this.folder(id, jobId);
    const state = this.status(id, jobId);
    if (
      state.status !== "succeeded" ||
      !state.artifacts.some((item) => item.name === name)
    )
      fail(
        "ARTIFACT_NOT_READY",
        "Only declared artifacts from successful jobs can be read.",
      );
    const info = this.describe(id, jobId, name);
    if (info.mimeType === "video/mp4") return { info };
    const max = info.mimeType === "image/png" ? 6 * MAX_FILE : MAX_FILE;
    if (info.bytes > max)
      fail(
        "TOO_LARGE",
        "Artifact exceeds inline limit; open its local path or generate a smaller preview.",
      );
    return { info, bytes: fs.readFileSync(info.path) };
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.running.values()].map((entry) => this.stop(entry, "cancelled")),
    );
  }
}

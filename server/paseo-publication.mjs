import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { confinedAsync, treeHash, projectInventory, exists } from "./project-files.mjs";
import { atomicPaseoJson } from "./paseo-manager.mjs";
import { hash, problem } from "./security.mjs";
import { command } from "./process.mjs";

const core = fileURLToPath(new URL("../", import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Validated snapshots use the existing durable task publication and apply journal. */
export class PaseoPublication {
  constructor({ data, db, repos, works, tasks, manager, store, localMode = process.env.FRAME_LOCAL_MODE === "1", runCommand = command }) {
    Object.assign(this, { data, db, repos, works, tasks, manager, store, localMode, runCommand });
    this.workers = new Map();
  }
  async prepare(candidate) {
    const run = await confinedAsync(this.data, "runs/" + candidate.runId);
    const work = await this.works.get(candidate.workId, { active: true });
    const { dir } = await this.repos.project(work.repo, work.project);
    const inventory = await projectInventory(dir, { includeExecutableMode: true });
    if (hash(JSON.stringify(inventory)) !== candidate.baselineModeFingerprint ||
        hash(JSON.stringify(inventory.map(row => row.slice(0, 2)))) !== candidate.baselineFingerprint)
      throw problem(409, "Canonical source changed before candidate verification; draft retained");
    await this.manager.prepareRuntime(run, work, { fingerprint: candidate.runtimeFingerprint });
    const marker = path.join(run, "validation-input.json");
    if (await exists(marker)) {
      const old = JSON.parse(await fs.readFile(marker, "utf8"));
      if (old.candidateId !== candidate.id || old.fingerprint !== candidate.snapshotFingerprint ||
          old.modeFingerprint !== candidate.snapshotModeFingerprint || old.runtimeFingerprint !== candidate.runtimeFingerprint)
        throw Error("Frozen candidate validation identity changed");
      return { run, input: old };
    }
    const git = (args, options = {}) => this.runCommand("git", args, { cwd: run, timeout: 120000, max: 256 * 1024, ...options });
    await git(["init", "-b", "frame-candidate"]);
    await git(["config", "user.name", "FRAME"]);
    await git(["config", "user.email", "frame@localhost"]);
    await fs.appendFile(path.join(run, ".gitignore"), "/candidate.json\n/validation-input.json\n/task.json\n/result.json\n/validation.log\n");
    await git(["add", "--", "."]);
    await git(["rm", "--cached", "-r", "--ignore-unmatch", "--", "projects/" + candidate.project]);
    // Stage the canonical baseline directly into this run's own Git index.
    // Candidate files stay immutable in its working tree; large media is not copied again.
    const canonicalRoot = path.dirname(path.dirname(dir));
    const names = inventory.map(([relative]) => "projects/" + candidate.project + "/" + relative);
    await git(["--git-dir=" + path.join(run, ".git"), "--work-tree=" + canonicalRoot, "add", "-f",
      "--pathspec-from-file=-", "--pathspec-file-nul"], { input: names.join("\0") + (names.length ? "\0" : "") });
    if (await treeHash(dir, { includeExecutableMode: true }) !== candidate.baselineModeFingerprint)
      throw problem(409, "Canonical source changed during baseline indexing");
    await git(["commit", "--allow-empty", "-m", "FRAME candidate canonical baseline"]);
    const baselineCommit = await git(["rev-parse", "HEAD"]);
    const input = { candidateId: candidate.id, project: candidate.project, baselineCommit,
      fingerprint: candidate.snapshotFingerprint, modeFingerprint: candidate.snapshotModeFingerprint,
      runtimeFingerprint: candidate.runtimeFingerprint };
    await atomicPaseoJson(marker, input);
    await atomicPaseoJson(path.join(run, "task.json"), { ...input, kind: "paseo-verify" });
    return { run, input };
  }
  async validate(candidate, { signal } = {}) {
    if (this.workers.has(candidate.id)) return this.workers.get(candidate.id);
    const operation = this.validateOwned(candidate, { signal });
    this.workers.set(candidate.id, operation);
    try { return await operation; } finally { this.workers.delete(candidate.id); }
  }
  async validateOwned(candidate, { signal }) {
    signal?.throwIfAborted();
    const run = await confinedAsync(this.data, "runs/" + candidate.runId);
    const finished = await fs.readFile(path.join(run, "result.json"), "utf8").then(JSON.parse).catch(error => {
      if (error.code !== "ENOENT") throw error; return null;
    });
    if (finished?.status === "passed" && finished.fingerprint === candidate.snapshotFingerprint &&
        finished.modeFingerprint === candidate.snapshotModeFingerprint && finished.runtimeFingerprint === candidate.runtimeFingerprint) {
      const source = await confinedAsync(run, "projects/" + candidate.project);
      if (await treeHash(source) !== candidate.snapshotFingerprint ||
          await treeHash(source, { includeExecutableMode: true }) !== candidate.snapshotModeFingerprint)
        throw Error("Validated candidate source changed after its receipt was recorded");
      return finished;
    }
    const prepared = await this.prepare(candidate);
    if (this.localMode) {
      return JSON.parse(await this.runCommand(process.execPath, [path.join(core, "server/paseo-validate.mjs")],
        { cwd: prepared.run, env: { FRAME_EXECUTOR_WORK: run, FRAME_EXECUTOR_CORE: core },
          timeout: 300000, signal, max: 256 * 1024 }).then(() => fs.readFile(path.join(run, "result.json"), "utf8")));
    }
    await this.tasks.assertLeadership();
    const name = "frame-paseo-validation-" + candidate.runId;
    const binding = await this.store.getWork(candidate.workId);
    if (!binding?.image || binding.runtimeFingerprint !== candidate.runtimeFingerprint)
      throw problem(409, "Candidate runtime is no longer available; current draft is retained");
    let container = await this.runCommand("docker", ["inspect", "--format", "{{json .}}", name],
      { timeout: 10000, max: 256 * 1024 }).then(JSON.parse).catch(() => null);
    if (container && (container.Config.Labels?.["frame.paseo.candidate"] !== candidate.id ||
        container.Config.Labels?.["frame.paseo.runtime"] !== candidate.runtimeFingerprint ||
        container.Config.Labels?.["frame.paseo.work"] !== candidate.workId || container.Image !== binding.image ||
        container.Mounts?.length !== 1 || container.Mounts[0].Type !== "bind" || !container.Mounts[0].RW ||
        container.Mounts[0].Destination !== "/workspace" ||
        path.resolve(container.Mounts[0].Source) !== path.resolve(this.manager.host("runs/" + candidate.runId))))
      throw Error("Candidate worker identity conflict");
    if (container && !container.State.Running) {
      await this.tasks.assertLeadership();
      await this.runCommand("docker", ["rm", name]);
      container = null;
    }
    if (!container) {
      await fs.rm(path.join(run, "result.json"), { force: true });
      await this.runCommand("chown", ["-R", "1000:1000", run]);
      await this.tasks.assertLeadership();
      await this.runCommand("docker", ["run", "-d", "--name", name, "--label", "frame.paseo.candidate=" + candidate.id,
        "--label", "frame.paseo.work=" + candidate.workId, "--label", "frame.paseo.runtime=" + candidate.runtimeFingerprint,
        "--memory", "4g", "--cpus", "2", "--pids-limit", "512", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "1000:1000", "--network", "bridge",
        "--mount", "type=bind,source=" + this.manager.host("runs/" + candidate.runId) + ",target=/workspace",
        "-e", "FRAME_EXECUTOR_WORK=/workspace", "-e", "FRAME_EXECUTOR_CORE=/opt/frame", "-w", "/workspace",
        binding.image, "node", "/opt/frame/server/paseo-validate.mjs"], { timeout: 120000, max: 256 * 1024 });
    }
    const abort = () => void this.tasks.assertLeadership().then(() => this.runCommand("docker", ["stop", "--time", "10", name], { timeout: 20000 })).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + 5 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        await this.tasks.assertLeadership();
        const state = JSON.parse(await this.runCommand("docker", ["inspect", "--format", "{{json .State}}", name], { timeout: 10000, max: 65536 }));
        if (!state.Running) {
          const result = JSON.parse(await fs.readFile(path.join(run, "result.json"), "utf8"));
          if (state.ExitCode !== 0 || result.status !== "passed") throw Error(result.error || "Candidate validation failed");
          if (result.fingerprint !== candidate.snapshotFingerprint || result.modeFingerprint !== candidate.snapshotModeFingerprint ||
              result.runtimeFingerprint !== candidate.runtimeFingerprint) throw Error("Candidate validation result identity differs");
          return result;
        }
        await sleep(500);
      }
      await this.tasks.assertLeadership();
      await this.runCommand("docker", ["stop", "--time", "10", name], { timeout: 20000 });
      throw Error("Candidate verification timed out; snapshot retained for retry");
    } finally {
      signal?.removeEventListener("abort", abort);
      await this.tasks.assertLeadership().then(async () => {
        const status = JSON.parse(await this.runCommand("docker", ["inspect", "--format", "{{json .State}}", name], { max: 65536 }));
        if (!status.Running) await this.runCommand("docker", ["rm", name], { timeout: 10000 });
      }).catch(() => {});
    }
  }
  async beforeApply(task) {
    if (task.kind !== "paseo") return;
    const candidate = await this.store.getCandidate(task.input.candidateId);
    if (!candidate || candidate.runId !== task.id) throw Error("Paseo publication candidate identity changed");
    const source = await confinedAsync(this.data, "runs/" + candidate.runId + "/projects/" + candidate.project);
    if (await treeHash(source) !== candidate.snapshotFingerprint ||
        await treeHash(source, { includeExecutableMode: true }) !== candidate.snapshotModeFingerprint)
      throw Error("Frozen candidate source changed after verification");
    const { dir } = await this.repos.project(task.repo, task.project);
    // Recover a crash after the atomic apply without discarding a newer live draft.
    if (await treeHash(dir, { includeExecutableMode: true }) === candidate.snapshotModeFingerprint) return;
    const binding = await this.store.getWork(candidate.workId);
    if (binding.generation !== candidate.generation || binding.draftRevision !== candidate.revision)
      throw problem(409, "A newer draft superseded this candidate before application");
    const native = await this.manager.observe(candidate.workId, { refresh: true });
    if (native.incomplete || native.activeAgents?.length || native.pendingPermissions || native.activeTerminals)
      throw problem(409, "Native work resumed; verified candidate retained until idle");
    if (!task.base_commit) {
      const before = await this.repos.checkpoint(task.repo, task.project, "Paseo 修改前自动保存");
      await this.db.pool.query("UPDATE tasks SET base_commit=$2,source_commit=COALESCE(source_commit,$2) WHERE id=$1 AND base_commit IS NULL", [task.id, before]);
      task.base_commit = before;
    }

  }
  async publish(candidate) {
    await this.tasks.assertLeadership();
    const result = candidate.result;
    if (result?.status !== "passed") throw Error("Only a verified candidate may be published");
    const id = candidate.runId;
    await this.db.pool.query("INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint,source_commit,base_commit,started,expires) VALUES($1,$2,$3,'paseo','publishing',$4,$5,$6,$7,$7,now(),NULL) ON CONFLICT(id) DO NOTHING",
      [id, candidate.repo, candidate.project, { candidateId: candidate.id, origin: candidate.origin, previewMode: "live",
        prompt: "Paseo draft", modeFingerprint: candidate.snapshotModeFingerprint }, result,
        candidate.baselineModeFingerprint, candidate.baselineCommit || null]);
    const task = await this.tasks.get(id);
    if (task.kind !== "paseo" || task.input.candidateId !== candidate.id) throw Error("Publication run identity conflict");
    if (task.state === "succeeded") return task.result;
    if (task.state === "publish_failed") await this.tasks.retryPublication(id);
    await this.tasks.publish(await this.tasks.get(id));
    const final = await this.tasks.get(id);
    if (final.state !== "succeeded") throw Error(final.error || "Candidate publication did not complete");
    return final.result;
  }
}

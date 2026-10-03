import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { command } from "./process.mjs";
import { problem } from "./security.mjs";
import { snapshotVersion, versionTree } from "./version-review.mjs";
import { TaskPublication } from "./task-publication.mjs";
import { TaskMonitor } from "./task-monitor.mjs";
import { copyTree, treeHash } from "./project-files.mjs";
import { seedPreviewAudio } from "./preview-audio-seed.mjs";
import { executionRuntime } from "./execution-runtime.mjs";
import { runtimeLimits, diskCapacity } from "./runtime-status.mjs";
import { executableTaskKindSchema } from "../src/contracts/platform.mjs";
import { ControllerLease } from "./controller-lease.mjs";
import { LocalProcesses } from "./local-processes.mjs";
import { freezeRenderWorkspace, assertFrozenWorkspace, cleanTaskWorkspace, assertTaskContainer, cleanOrphanTaskWorkspaces, taskDirectory } from "./task-workspace.mjs";
import { taskSummaryColumns } from "./task-summary.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
function sameTaskRequest(existing, requested) {
  return isDeepStrictEqual(existing.request_input ?? existing.input, requested);
}
export class Tasks {
  constructor(db, data, repos, secrets, { runCommand = command } = {}) {
    this.command = async (...args) => {
      if (args[0] === "docker" && ["run", "stop", "rm"].includes(args[1]?.[0])) await this.assertLeadership();
      return runCommand(...args);
    };
    this.controllerId = randomUUID();
    this.limits = runtimeLimits();
    this.queueBlocked = null;
    this.db = db;
    this.data = data;
    this.repos = repos;
    this.secrets = secrets;
    this.localProcesses = process.env.FRAME_LOCAL_MODE === "1" ? new LocalProcesses(data) : null;
    this.publication = new TaskPublication({
      db, data, repos, get: id => this.get(id), finishCancellation: id => this.finishCancellation(id), cleanup: task => this.cleanup(task),
    });
    this.monitor = new TaskMonitor({
      db, data, command: (...args) => this.command(...args), get: id => this.get(id), localProcesses: this.localProcesses,
      complete: (task, exit) => this.complete(task, exit), failTask: (task, message) => this.failTask(task, message),
      cleanup: task => this.cleanup(task),
    });
    this.ticking = false;
    this.closed = false;
    this.validations = new Map();
    fs.mkdirSync(path.join(data, "runs"), { recursive: true });
  }
  async create({
    repo,
    project,
    kind,
    input = {},
    requestKey = null,
    prepareInput = null,
  }) {
    input = JSON.parse(JSON.stringify(input));
    const requestedInput = JSON.parse(JSON.stringify(input));
    if (!executableTaskKindSchema.safeParse(kind).success)
      throw problem(400, "Unknown task kind");
    if (kind === "tools-update") {
      if (
        !["codex", "claude"].includes(input.provider) ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version)
      )
        throw problem(400, "Choose a provider and explicit semver version");
    } else await this.repos.project(repo, project, { exists: kind !== "new" });
    if (input.version && kind !== "tools-update") {
      if (kind !== "build") throw problem(400, "历史版本只支持只读预览");
      await versionTree(this.repos, { repo, project }, input.version);
    }
    const id = randomUUID();
    const insert = async () => {
      if (this.desktopClosing) throw problem(409, "工作台正在退出，请重新打开后再开始任务。");
      if (requestKey) {
        const existing = await this.db.one(
          "SELECT * FROM tasks WHERE request_key=$1",
          [requestKey],
        );
        if (existing) {
          if (
            existing.repo !== repo ||
            existing.project !== project ||
            existing.kind !== kind ||
            !sameTaskRequest(existing, requestedInput)
          )
            throw problem(409, "Message request key already used");
          return existing;
        }
      }
      if (repo) {
        // Recheck inside the work lock: a purge may have completed after the first lookup.
        await this.repos.project(repo, project, { exists: kind !== "new" });
        const work = await this.db.one("SELECT id,deleted FROM works WHERE repo=$1 AND project=$2", [repo, project]);
        if (work?.deleted || await this.db.setting(`purged-work:${repo}:${project}`))
          throw problem(409, "作品已删除，请先恢复作品或创建新作品");
      }
      if (repo && kind === "new") await this.repos.writable(repo, project);
      if (
        kind === "tools-update" &&
        (await this.db.one(
          "SELECT id FROM tasks WHERE kind='tools-update' AND state IN ('queued','running','cancelling','publishing','publish_failed') LIMIT 1",
        ))
      )
        throw problem(409, "Another tool upgrade is running");
      const prepared = prepareInput ? await prepareInput(JSON.parse(JSON.stringify(input))) : {};
      input = JSON.parse(JSON.stringify(prepared.input ?? input));
      if (this.desktopClosing) throw problem(409, "工作台正在退出，请重新打开后再开始任务。");
      let snapshot = null;
      try {
        if (kind === "render") {
          const runtime = await this.renderRuntime();
          snapshot = await freezeRenderWorkspace({ data: this.data, repos: this.repos,
            task: { id, repo, project, kind, input }, runtime });
        }
        return await this.db.one(
          "INSERT INTO tasks(id,repo,project,kind,input,request_key,request_input,fingerprint,source_commit,base_commit,runtime,frozen) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) RETURNING *",
          [id, repo || null, project || null, kind, input, requestKey, requestedInput,
            snapshot?.fingerprint || null, snapshot?.sourceCommit || null, snapshot?.runtime || null, snapshot?.frozen || null],
        );
      } catch (error) {
        // A lost INSERT response can still have admitted this task. Never remove
        // its frozen input unless a fresh read confirms it was not persisted.
        if (snapshot) {
          const saved = await this.db.one("SELECT id FROM tasks WHERE id=$1", [id]);
          if (!saved) await fs.promises.rm(taskDirectory(this.data, id), { recursive: true, force: true });
        }
        throw error;
      }
    };
    return this.db.lock(repo ? `${repo}:${project}` : "tools-update", insert);
  }
  async get(id) {
    const row = await this.db.one("SELECT * FROM tasks WHERE id=$1", [id]);
    if (!row) throw problem(404, "Task not found");
    return row;
  }
  async renderRuntime() {
    if (process.env.FRAME_ROLE !== "api" || this.localProcesses)
      return executionRuntime({ command: this.command });
    const controller = await this.db.setting("controller-runtime"), current = await runtimeIdentity();
    const runtime = controller?.executorRuntime;
    if (!controller?.leader || !controller.docker?.ok || Date.now() - Number(controller.checked) > 40000 ||
        controller.runtimeFingerprint !== current.fingerprint || runtime?.fingerprint !== current.fingerprint ||
        !/^sha256:[a-f0-9]{64}$/.test(runtime?.image || ""))
      throw problem(503, "导出控制器尚未就绪或与当前工作台版本不一致，请稍后重新提交导出。");
    return structuredClone(runtime);
  }
  async summary(id) {
    const row = await this.db.one(
      `SELECT ${taskSummaryColumns(this.db)} FROM tasks WHERE id=$1`,
      [id],
    );
    if (!row) throw problem(404, "Task not found");
    return row;
  }
  async cancel(id) {
    // One statement decides from the CURRENT state; a stale queued read must not
    // miss a concurrent transition to running.
    const changed = await this.db.one(
      "UPDATE tasks SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,finished=CASE WHEN state='queued' THEN now() ELSE finished END,expires=CASE WHEN state='queued' THEN now()+interval '7 days' ELSE expires END WHERE id=$1 AND state IN ('queued','running') RETURNING *",
      [id],
    );
    if (changed?.state === "cancelled") await this.cleanup(changed);
    const current = changed || await this.get(id);
    if (current.state === "cancelling") this.validations.get(id)?.abort.abort(Error("验证已取消"));
    if (["publishing", "publish_failed"].includes(current.state))
      throw problem(409, "执行已经结束，结果正在保存或等待恢复，请使用重试发布而不是取消");
    return current;
  }
  async finishCancellation(id) {
    await this.db.pool.query(
      "UPDATE tasks SET state='cancelled',finished=now(),expires=now()+interval '7 days' WHERE id=$1 AND state IN ('queued','running','cancelling')",
      [id],
    );
    await this.cleanup(await this.get(id));
  }
  host(relative) {
    return path.posix.join(process.env.FRAME_HOST_DATA || this.data, relative);
  }
  async assertLeadership() {
    if (this.closed) throw Object.assign(new Error("Controller is stopping"), { leadershipLost: true });
    if (this.lease) await this.lease.assert();
  }
  async start(t) {
    await this.assertLeadership();
    if (t.kind === "validate") {
      const claimed = await this.db.one(
        "UPDATE tasks SET state='running',started=now(),container=NULL,controller_id=$2,progress=$3 WHERE id=$1 AND state='queued' RETURNING *",
        [t.id, this.controllerId, { stage: "检查当前作品工作区" }],
      );
      if (claimed) this.launchValidation(claimed);
      return;
    }
    // Frozen rendering needs no lock on the live work while preparing/encoding.
    const lock = t.frozen || !this.db.lock ? fn => fn() : fn => this.db.lock(t.repo ? `${t.repo}:${t.project}` : "tools-update", fn);
    return lock(async () => {
      const container = "frame-task-" + t.id;
      const claimed = await this.db.one(
        "UPDATE tasks SET state='running',started=now(),container=$2,controller_id=$3,progress=$4,metrics=metrics||$5::jsonb WHERE id=$1 AND state='queued' RETURNING id",
        [t.id, container, this.controllerId, { stage: "准备隔离工作副本" }, { queueMs: Math.max(0, Date.now() - new Date(t.created).getTime()) }],
      );
      if (!claimed) return;
      try {
        return await this.prepareAndLaunch(t, container);
      }
      catch (error) {
        const current = await this.get(t.id);
        if (!error.leadershipLost && !current.launch_attempted_at) {
          await this.assertLeadership();
          await this.failTask(current, error.message);
        }
        throw error;
      }
    });
  }
  async prepareAndLaunch(t, container) {
    const preparationStarted = performance.now();
    if ((await this.get(t.id)).state === "cancelling") { await this.finishCancellation(t.id); return; }
    await this.assertLeadership();
    const run = path.join(this.data, "runs", t.id);
    fs.mkdirSync(run, { recursive: true });
    let fingerprint = t.fingerprint || null;
    let sourceCommit = t.source_commit || null;
    if (t.kind === "render") {
      await assertFrozenWorkspace(this.data, t);
    } else if (t.repo && t.kind === "build" && t.input.version) {
      const destination = path.join(run, "projects", t.project);
      await snapshotVersion(this.repos, t, t.input.version, destination);
      fingerprint = await treeHash(destination);
      sourceCommit = t.input.version;
    } else if (t.repo) {
      const { dir } = await this.repos.project(t.repo, t.project, {
        exists: t.kind !== "new",
      });
      if (t.kind === "new" && fs.existsSync(dir))
        throw problem(409, "Project already exists");
      fingerprint = await treeHash(dir);
      if (fs.existsSync(dir)) {
        const snapshot = path.join(run, "projects", t.project);
        await copyTree(dir, snapshot);
        if (await treeHash(snapshot) !== fingerprint || await treeHash(dir) !== fingerprint)
          throw problem(409, "Source changed while preparing the isolated task");
      }
      if (t.kind !== "new")
        sourceCommit = await this.repos.checkpoint(
          t.repo,
          t.project,
          "生成只读预览前保存",
        );
    }
    await seedPreviewAudio({ db: this.db, data: this.data, task: t, run });
    const runtime = t.frozen ? t.runtime : await executionRuntime({ command: this.command });
    const payload = { runtime, sourceCommit, id: t.id, project: t.project, kind: t.kind, input: t.input,
      ...(t.frozen ? { frozen: t.frozen } : {}) };
    fs.writeFileSync(path.join(run, "task.json"), JSON.stringify(payload));
    await fs.promises.mkdir(path.join(run, ".cache", "home"), { recursive: true });
    if (!this.localProcesses) await this.command("chown", ["-R", "1000:1000", run]);
    const env = { FRAME_RUNTIME_IMAGE: runtime.image };
    const flags = ["-e", "FRAME_RUNTIME_IMAGE"];
    const image = runtime.image;
    await this.assertLeadership();
    const prepared = await this.db.one(
      "UPDATE tasks SET fingerprint=$2,source_commit=$3,base_commit=$3,runtime=$4,metrics=metrics||$6::jsonb WHERE id=$1 AND state='running' AND controller_id=$5 RETURNING id",
      [t.id, fingerprint, sourceCommit, runtime, this.controllerId, { prepareMs: Math.round(performance.now() - preparationStarted) }],
    );
    if (!prepared) {
      if ((await this.get(t.id)).state === "cancelling") await this.finishCancellation(t.id);
      return;
    }
    if (this.localProcesses) {
      if ((await this.get(t.id)).state !== "running") { await this.finishCancellation(t.id); return; }
      const claim = await this.db.one(
        "UPDATE tasks SET launch_attempted_at=now() WHERE id=$1 AND state='running' AND controller_id=$2 AND launch_attempted_at IS NULL RETURNING id",
        [t.id, this.controllerId],
      );
      if (!claim) return;
      const pid = this.localProcesses.launch(t.id, { ...process.env, ...env, FRAME_LOCAL_MODE: "1" });
      await this.db.pool.query("UPDATE tasks SET container=$2 WHERE id=$1", [t.id, String(pid)]);
      await this.db.event(t.id, "state", { state: "running" });
      return;
    }
    const args = [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "frame.task=" + t.id,
      "--memory",
      "4g",
      "--cpus",
      "2",
      // Remotion uses native Chromium alongside the Frame audio/preview browser.
      "--pids-limit",
      "512",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--network",
      "bridge",
      "-e",
      "HOME=/workspace/.cache/home",
      "-v",
      this.host("runs/" + t.id) + ":/workspace",
      "-v",
      this.host("tools") + ":/tools" + (t.kind === "tools-update" ? "" : ":ro"),
      ...flags,
      image,
      "node",
      "server/executor.mjs",
    ];
    if (t.kind === "tools-update") {
      fs.mkdirSync(path.join(this.data, "tools"), { recursive: true });
      await this.command("chmod", ["u+rwx", path.join(this.data, "tools")]);
    }
    if ((await this.get(t.id)).state !== "running") {
      await this.finishCancellation(t.id);
      return;
    }
    await this.assertLeadership();
    const launch = await this.db.one(
      "UPDATE tasks SET launch_attempted_at=now() WHERE id=$1 AND state='running' AND controller_id=$2 AND launch_attempted_at IS NULL RETURNING id",
      [t.id, this.controllerId],
    );
    if (!launch) {
      if ((await this.get(t.id)).state === "cancelling") await this.finishCancellation(t.id);
      return;
    }
    await this.command("docker", args, { env, timeout: 120000 });
    // Cancellation after this last check remains durable as 'cancelling'; the
    // scheduler stops the container instead of overwriting it with 'running'.
    await this.db.event(t.id, "state", { state: (await this.get(t.id)).state });
  }
  retryPublication(id) { return this.publication.retryPublication(id); }
  publicationError(task, error) { return this.publication.publicationError(task, error); }
  async complete(task, exit) { await this.assertLeadership(); return this.publication.complete(task, exit); }
  async publish(task) { await this.assertLeadership(); return this.publication.publish(task); }
  monitorWarning(task, phase, error) { return this.monitor.monitorWarning(task, phase, error); }
  observeTask(task) { return this.monitor.observeTask(task); }
  launchValidation(task) {
    if (this.validations.has(task.id)) return this.validations.get(task.id).promise;
    const abort = new AbortController();
    const promise = Promise.resolve().then(async () => {
      if (task.state === "cancelling" && !task.result?.validationReportId) {
        await this.finishCancellation(task.id);
        return;
      }
      if (!this.validateWorkspace) throw Error("当前作品工作区验证服务尚未就绪。");
      const onReport = async report => {
        await this.assertLeadership();
        await this.db.pool.query(
          "UPDATE tasks SET result=$2,fingerprint=$3,progress=$4 WHERE id=$1 AND state IN ('running','cancelling')",
          [task.id, { validationReportId: report.id, sourceRevision: report.revision }, report.revision,
            { stage: report.state === "queued" ? "等待当前工作区验证" : "验证当前作品工作区" }],
        );
        if ((await this.get(task.id)).state === "cancelling") abort.abort(Error("验证已取消"));
      };
      const report = await this.validateWorkspace(task, { wait: true, signal: abort.signal,
        reportId: task.result?.validationReportId, onReport });
      if (this.closed) return;
      await this.assertLeadership();
      const current = await this.get(task.id);
      const result = { ...report.result, validationReportId: report.id, sourceRevision: report.revision,
        runtimeFingerprint: report.runtimeFingerprint, validationState: report.state, artifacts: [] };
      if (current.state === "cancelling" || report.state === "cancelled") {
        await this.db.pool.query("UPDATE tasks SET result=$2,fingerprint=$3 WHERE id=$1", [task.id, result, report.revision]);
        await this.finishCancellation(task.id);
        return;
      }
      if (report.state !== "passed") {
        await this.db.pool.query("UPDATE tasks SET result=$2,fingerprint=$3 WHERE id=$1", [task.id, result, report.revision]);
        await this.failTask(current, report.error || (report.state === "stale" ? "验证期间作品已更新，此报告已过时，请检查当前版本。" : "作品验证失败，请查看验证报告。"));
        return;
      }
      const finished = await this.db.one(
        "UPDATE tasks SET state='succeeded',result=$2,fingerprint=$3,error=NULL,finished=now(),expires=now()+interval '7 days',workspace_cleaned=now() WHERE id=$1 AND state='running' RETURNING id",
        [task.id, result, report.revision],
      );
      if (finished) await this.db.event(task.id, "result", result);
      else if ((await this.get(task.id)).state === "cancelling") await this.finishCancellation(task.id);
    }).catch(async error => {
      if (this.closed || error.leadershipLost) return;
      const current = await this.get(task.id);
      if (current.state === "cancelling" || abort.signal.aborted) await this.finishCancellation(task.id);
      else await this.failTask(current, error.message);
    }).finally(() => this.validations.delete(task.id));
    this.validations.set(task.id, { abort, promise });
    // Keep scheduler ticks responsive while the existing work runtime validates.
    void promise.catch(error => console.error("Workspace task validation:", error.message));
    return promise;
  }
  async failTask(t, message) {
    const failed = await this.db.one(
      "UPDATE tasks SET state='failed',error=$2,monitor=NULL,finished=now(),expires=now()+interval '14 days' WHERE id=$1 AND state IN ('queued','running') RETURNING id",
      [t.id, message],
    );
    if (failed) {
      await this.db.event(t.id, "error", { message });
      await this.cleanup(await this.get(t.id));
    } else if ((await this.get(t.id)).state === "cancelling") {
      await this.finishCancellation(t.id);
    }
  }
  async cleanup(task) {
    if (!["succeeded", "failed", "cancelled", "publishing", "publish_failed"].includes(task.state) || task.workspace_cleaned ||
        (task.kind === "new" && ["publishing", "publish_failed"].includes(task.state))) return false;
    try {
      if (task.container) {
        if (this.localProcesses) {
          // Missing exit records may mean a live orphan. Check the actual process,
          // and keep input until its identity is no longer running.
          try { if (this.localProcesses.inspect(task.id, task.container).Running) throw Error("执行进程仍在运行，待确认退出后清理。"); }
          catch (error) {
            if (!/not running and has no exit record/.test(error.message)) throw error;
          }
        } else {
          let inspected;
          try { inspected = JSON.parse(await this.command("docker", ["inspect", "--format", "{{json .}}", task.container], { timeout: 10000, max: 256 * 1024 })); }
          catch (error) {
            if (!/No such (?:object|container)/i.test(error.message)) throw error;
            await this.command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10000 });
          }
          if (inspected) {
            const state = assertTaskContainer(inspected, task, this.host("runs/" + task.id));
            if (state.Running) throw Error("执行容器仍在运行，待确认退出后清理。");
            await this.command("docker", ["rm", task.container], { timeout: 10000 });
          }
        }
      }
      await cleanTaskWorkspace(this.data, task);
      await this.db.pool.query("UPDATE tasks SET workspace_cleaned=now(),cleanup_error=NULL WHERE id=$1", [task.id]);
      return true;
    } catch (error) {
      const message = String(error.message).slice(0, 2000);
      if (message !== task.cleanup_error) {
        await this.db.pool.query("UPDATE tasks SET cleanup_error=$2 WHERE id=$1", [task.id, message]);
        await this.db.event(task.id, "cleanup-warning", { message });
      }
      return false;
    }
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      await this.assertLeadership();
      const running = await this.db.all("SELECT * FROM tasks WHERE state IN ('running','cancelling','publishing') AND (publication_retry_at IS NULL OR publication_retry_at<=now()) ORDER BY created");
      for (const t of running) {
        await this.assertLeadership();
        try {
          if (t.kind === "validate" && !t.container) {
            if (t.state === "cancelling") this.validations.get(t.id)?.abort.abort(Error("验证已取消"));
            this.launchValidation(t);
          }
          else if (t.state === "publishing") {
            await this.complete(t, 0);
            await this.cleanup(await this.get(t.id));
          } else await this.observeTask(t);
        }
        catch (e) { await this.monitorWarning(t, "controller", e); }
      }
      for (const task of await this.db.all("SELECT * FROM tasks WHERE workspace_cleaned IS NULL AND kind IN ('new','validate','frame','storyboard','render','build','tools-update') AND state IN ('succeeded','failed','cancelled','publishing','publish_failed') ORDER BY finished LIMIT 30"))
        await this.cleanup(task);
      if (!this.lastOrphanSweep || Date.now() - this.lastOrphanSweep > 60000) {
        await cleanOrphanTaskWorkspaces({ data: this.data, db: this.db });
        this.lastOrphanSweep = Date.now();
      }
      const count = await this.db.one("SELECT count(*)::int AS n FROM tasks WHERE state IN ('running','cancelling')");
      if (count.n < this.limits.concurrency) {
        try {
          const disk = await diskCapacity(this.data);
          this.queueBlocked = disk.freeBytes < this.limits.minFreeBytes ? "可用空间低于安全阈值，新任务保留排队；正在执行的任务不会因此被终止。" : null;
        } catch {
          this.queueBlocked = "暂时无法读取磁盘容量，新任务保留排队。";
        }
        if (this.queueBlocked) return;
        const t = await this.db.one(
          `SELECT t.* FROM tasks t WHERE t.state='queued' AND NOT EXISTS(SELECT 1 FROM tasks r WHERE (r.repo=t.repo AND r.project=t.project AND r.frozen IS NULL AND t.frozen IS NULL AND r.state IN ('running','cancelling','publishing','publish_failed')))
          AND NOT EXISTS(SELECT 1 FROM work_undos u JOIN works w ON w.id=u.work WHERE w.repo=t.repo AND w.project=t.project AND u.state IN ('applying','failed'))
          ORDER BY t.created LIMIT 1`,
        );
        if (t) {
          await this.assertLeadership();
          try { await this.start(t); }
          catch (e) {
            const current = await this.get(t.id);
            // docker run may have succeeded before its response was lost. Inspect
            // the assigned container on later ticks; never kill it on uncertainty.
            if (["running", "cancelling"].includes(current.state) && current.container)
              await this.monitorWarning(current, "startup", e);
            else if (current.state === "queued") await this.failTask(current, e.message);
            else if (current.state === "cancelled") await this.cleanup(current);
          }
        }
      }
    } finally { this.ticking = false; }
  }
  startLoop({ onLeadership = () => {}, onCycle = () => {} } = {}) {
    if (this.loopStarted) return;
    this.loopStarted = true;
    this.lease = this.localProcesses
      ? { id: this.controllerId, held: true, acquire: async () => true, assert: async () => {}, close() { this.held = false; } }
      : new ControllerLease(this.db.pool);
    this.controllerId = this.lease.id;
    const cycle = async () => {
      if (this.closed || this.loopPromise) return;
      this.loopPromise = (async () => {
        let leader = false;
        try {
          leader = await this.lease.acquire();
          await onLeadership(leader);
          if (leader) await this.tick();
        } catch (error) { console.error("Scheduler:", error.message); }
        finally {
          if (!this.lease.held || this.closed) await onLeadership(false);
          await Promise.resolve().then(() => onCycle({ leader: this.lease.held && !this.closed, controllerId: this.controllerId })).catch(error => console.error("Controller status:", error.message));
        }
      })();
      try { await this.loopPromise; }
      catch (error) { console.error("Controller cycle:", error.message); }
      finally { this.loopPromise = null; }
    };
    this.timer = setInterval(() => void cycle(), 1500);
    void cycle();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.loopPromise?.catch(() => {});
    for (const entry of this.validations.values()) entry.abort.abort(Error("工作台正在退出"));
    await Promise.allSettled([...this.validations.values()].map(entry => entry.promise));
    await this.localProcesses?.close();
    this.lease?.close();
  }
}

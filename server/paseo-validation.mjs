import path from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "./process.mjs";
import { validatePaseoWorkspace } from "./paseo-validate.mjs";

const core = fileURLToPath(new URL("../", import.meta.url));

/** Validation reuses the live work runtime. No publication or source replacement exists. */
export class PaseoValidation {
  constructor({ works, repos, manager, store, tasks, localMode = process.env.FRAME_LOCAL_MODE === "1", runCommand = command }) {
    Object.assign(this, { works, repos, manager, store, tasks, localMode, runCommand });
    this.workers = new Map();
  }
  async validate(report, { signal } = {}) {
    const active = this.workers.get(report.workId);
    if (active) {
      if (active.reportId !== report.id) throw Error("当前作品的其他版本正在验证，请等待结束");
      return active.operation;
    }
    const operation = this.validateOwned(report, { signal });
    this.workers.set(report.workId, { reportId: report.id, operation });
    try { return await operation; } finally { this.workers.delete(report.workId); }
  }
  async validateOwned(report, { signal }) {
    signal?.throwIfAborted();
    const work = await this.works.get(report.workId, { active: true });
    const { dir } = await this.repos.project(work.repo, work.project);
    const workspaceRoot = path.dirname(path.dirname(dir));
    const baselineCommit = await this.runCommand("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, timeout: 10000 });
    const input = { reportId: report.id, project: work.project, baselineCommit,
      modeFingerprint: report.revision, runtimeFingerprint: report.runtimeFingerprint };
    if (this.localMode) return validatePaseoWorkspace({ ...input, core, work: workspaceRoot, signal });
    await this.tasks.assertLeadership();
    const binding = await this.store.getWork(report.workId);
    if (binding?.state !== "ready" || !binding.container || binding.runtimeFingerprint !== report.runtimeFingerprint)
      throw Error("作品创作运行环境已更新，请重新验证当前版本");
    const abort = () => void this.manager.cancelValidation(report.workId, report.id).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const output = await this.runCommand("docker", ["exec", "--workdir", "/workspace", binding.container,
        "node", "/opt/frame/server/paseo-validate.mjs", JSON.stringify(input)], { timeout: 310000, max: 256 * 1024, signal });
      return JSON.parse(output);
    } catch (error) {
      await this.manager.cancelValidation(report.workId, report.id).catch(() => {});
      throw error;
    } finally { signal?.removeEventListener("abort", abort); }
  }
}

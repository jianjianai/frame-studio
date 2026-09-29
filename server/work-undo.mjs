import fs from "node:fs/promises";
import path from "node:path";
import { gitData } from "./git-data.mjs";
import { problem } from "./security.mjs";
import { treeHash, exists } from "./project-files.mjs";
import { snapshotVersion, versionTree } from "./version-review.mjs";
import { applyProject } from "./apply-project.mjs";

export const resultVersions = task => ({ before: task.base_commit || task.result?.runtime?.sourceCommit || null, after: task.result?.commit || null });
const conflict = (message, code = "UNDO_CONFLICT") => Object.assign(problem(409, message), { code, recovery: "review-result", retryable: false });
const summary = row => ({ id: row.id, work: row.work, task: row.task, state: "succeeded", commit: row.commit });

/** Invert only this turn in a temporary index. Later unrelated edits survive; unresolved conflicts never reach live files. */
export class WorkUndo {
  constructor({ db, data, works, repos, tasks, apply = applyProject }) { Object.assign(this, { db, data, works, repos, tasks, apply }); }
  async undo(args) {
    const work = await this.works.get(args.id, { active: true });
    let fresh = false;
    const value = await this.db.lock(`${work.repo}:${work.project}`, async () => {
      let row = await this.db.one("SELECT * FROM work_undos WHERE id=$1 OR task=$2 ORDER BY created LIMIT 1", [args.requestKey, args.task]);
      if (row) {
        if (row.work !== work.id || row.task !== args.task) throw conflict("撤销请求标识已经用于其他作品", "UNDO_REQUEST_REUSED");
        if (row.id !== args.requestKey) {
          if (row.state === "succeeded") return summary(row);
          throw conflict("本次修改已有待恢复的撤销，请使用原撤销请求继续", "UNDO_RECOVERY_REQUIRED");
        }
        if (row.expected_commit !== args.expectedCommit || row.expected_revision !== args.expectedRevision)
          throw conflict("不能用同一个撤销请求修改其版本条件", "UNDO_REQUEST_REUSED");
        if (row.state === "succeeded") return summary(row);
      } else {
        await this.repos.writable(work.repo, work.project);
        const task = await this.db.one("SELECT * FROM tasks WHERE id=$1 AND repo=$2 AND project=$3 AND kind='agent' AND state='succeeded'", [args.task, work.repo, work.project]);
        if (!task) throw problem(404, "没有可撤销的创作结果");
        const { before, after } = resultVersions(task);
        if (!before || !after || before === after) throw conflict("这个结果没有可证明的修改前后版本，不能自动撤销", "UNDO_HISTORY_UNAVAILABLE");
        const plan = await this.plan(work, task, args, before, after);
        row = await this.db.one(
          "INSERT INTO work_undos(id,work,task,expected_commit,expected_revision,state,commit,output_revision) VALUES($1,$2,$3,$4,$5,'applying',$6,$7) RETURNING *",
          [args.requestKey, work.id, task.id, args.expectedCommit, args.expectedRevision, plan.commit, plan.outputRevision],
        );
      }
      try {
        const result = await this.finish(work, row);
        fresh = true;
        return result;
      } catch (error) {
        await this.db.pool.query("UPDATE work_undos SET state='failed',error=$2 WHERE id=$1 AND state<>'succeeded'", [row.id, String(error.message).slice(0, 2000)]).catch(() => {});
        throw Object.assign(problem(409, "撤销结果已保留，尚未全部保存。请重试完成撤销，不要再次运行 AI。"), { code: "UNDO_RECOVERY_REQUIRED", recovery: "retry-undo", retryable: true });
      }
    });
    let preview = await this.db.one("SELECT id FROM tasks WHERE request_key=$1 AND kind='build'", [value.id]);
    if (fresh && !preview) {
      // Preview is a separate durable task. Failure to queue it must not misreport a completed undo as failed.
      try { preview = await this.tasks.create({ repo: work.repo, project: work.project, kind: "build", requestKey: value.id }); }
      catch { /* Another queued modification can own the work; its next preview will supersede this one. */ }
    }
    return { ...value, previewTask: preview?.id || null };
  }
  run(id) { return path.join(this.data, "restores", "undo-" + id); }
  async plan(work, task, args, before, after) {
    const { repo, dir } = await this.repos.project(work.repo, work.project);
    const head = (await gitData(repo.root, ["rev-parse", "HEAD"])).trim();
    if (head !== args.expectedCommit || await treeHash(dir) !== args.expectedRevision)
      throw conflict("作品在审查后已有变化，请刷新结果后再撤销", "UNDO_BASE_CHANGED");
    if ((await gitData(repo.root, ["status", "--porcelain", "--untracked-files=all"])).trim())
      throw conflict("当前作品存在未保存的修改，请先保存版本再撤销", "UNDO_DIRTY_WORK");
    await versionTree(this.repos, work, before);
    await versionTree(this.repos, work, after);
    const patch = await gitData(repo.root, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", after, before, "--", `projects/${work.project}/`]);
    if (!patch.trim()) throw conflict("这次创作没有作品文件变化，无需撤销", "UNDO_EMPTY");
    const run = this.run(args.requestKey);
    // No SQL journal exists yet, therefore no live application has started for this request.
    await fs.rm(run, { recursive: true, force: true });
    await fs.mkdir(run, { recursive: true });
    const env = { GIT_INDEX_FILE: path.join(run, "inverse.index") };
    await gitData(repo.root, ["read-tree", head], { env });
    try { await gitData(repo.root, ["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], { env, input: patch }); }
    catch (error) {
      const unmerged = await gitData(repo.root, ["diff", "--name-only", "--diff-filter=U", "-z"], { env }).catch(() => "");
      const paths = unmerged.split("\0").filter(Boolean).slice(0, 12).map(file => file.replace(`projects/${work.project}/`, ""));
      throw conflict("本次修改与后续修改发生冲突，正式作品保持不变。" + (paths.length ? "冲突文件：" + paths.join("、") : "请先比较版本并由 AI 处理冲突。"));
    }
    const tree = (await gitData(repo.root, ["write-tree"], { env })).trim();
    const originalTree = (await gitData(repo.root, ["rev-parse", "HEAD^{tree}"])).trim();
    if (tree === originalTree) throw conflict("当前内容已经不包含可撤销的差异", "UNDO_EMPTY");
    const ref = (await gitData(repo.root, ["symbolic-ref", "HEAD"])).trim();
    if (ref !== "refs/heads/" + repo.branch) throw conflict("作品分支已切换，请先恢复工作区", "UNDO_BRANCH_CHANGED");
    const commit = (await gitData(repo.root, ["-c", "user.name=FRAME", "-c", "user.email=frame@localhost", "commit-tree", tree, "-p", head], {
      input: `撤销 AI 修改 ${task.id.slice(0, 8)}\n\nFRAME-Undo: ${args.requestKey}\n`,
    })).trim();
    const source = path.join(run, "source");
    await snapshotVersion(this.repos, work, commit, source, { detached: true });
    const plan = { id: args.requestKey, work: work.id, task: task.id, head, ref, originalTree, tree, commit, fingerprint: args.expectedRevision, outputRevision: await treeHash(source) };
    const handle = await fs.open(path.join(run, "plan.json"), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(plan)); await handle.sync(); } finally { await handle.close(); }
    return plan;
  }
  async finish(work, row) {
    const run = this.run(row.id);
    const plan = JSON.parse(await fs.readFile(path.join(run, "plan.json"), "utf8"));
    if (plan.id !== row.id || plan.work !== work.id || plan.task !== row.task || plan.commit !== row.commit || plan.head !== row.expected_commit || plan.fingerprint !== row.expected_revision || plan.outputRevision !== row.output_revision)
      throw Error("Undo recovery journal does not match the durable request");
    const live = await this.db.one("SELECT id FROM tasks WHERE repo=$1 AND project=$2 AND state IN ('running','cancelling','publishing','publish_failed') LIMIT 1", [work.repo, work.project]);
    if (live) throw Error("A live task still owns this work");
    const { repo, dir } = await this.repos.project(work.repo, work.project);
    const head = (await gitData(repo.root, ["rev-parse", "HEAD"])).trim();
    const ref = (await gitData(repo.root, ["symbolic-ref", "HEAD"])).trim();
    if (ref !== plan.ref || ![plan.head, plan.commit].includes(head)) throw Error("Work history changed while finishing the undo");
    const currentIndex = (await gitData(repo.root, ["write-tree"])).trim();
    if (![plan.originalTree, plan.tree].includes(currentIndex)) throw Error("Work index changed outside the undo");
    await this.repos.revisions?.invalidate(work.repo, work.project);
    if (await treeHash(dir) !== plan.outputRevision) {
      if (head !== plan.head) throw Error("Published undo files have changed; automatic recovery stopped");
      await this.apply({ source: path.join(run, "source"), destination: dir, run, id: row.id, fingerprint: plan.fingerprint });
    }
    if (await treeHash(dir) !== plan.outputRevision) throw Error("Applied undo content did not verify");
    if (head !== plan.commit) await gitData(repo.root, ["update-ref", "-m", "FRAME undo " + row.id, plan.ref, plan.commit, plan.head]);
    await gitData(repo.root, ["read-tree", plan.commit]);
    await this.works.discover(work.repo, work.project);
    await this.repos.revisions?.refresh(work.repo, work.project, { locked: true });
    const result = await this.db.one("UPDATE work_undos SET state='succeeded',error=NULL,finished=now() WHERE id=$1 RETURNING *", [row.id]);
    // Successful rows are enough for repeat requests; keep a failed journal until explicitly recovered.
    if (await exists(run)) await fs.rm(run, { recursive: true, force: true }).catch(() => {});
    return summary(result);
  }
}

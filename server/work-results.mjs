import { gitData, changesBetween } from "./git-data.mjs";
import { problem } from "./security.mjs";
import { treeHash } from "./project-files.mjs";
import { versionTree } from "./version-review.mjs";
import { WorkUndo, resultVersions } from "./work-undo.mjs";
import {
  workResultRequestSchema,
  workUndoRequestSchema,
  reviewRange,
  validationRecordSchema,
} from "../src/contracts/workflow.mjs";

export function workResultOperations({ add, db, data, works, repos, tasks }) {
  const undo = new WorkUndo({ db, data, works, repos, tasks });
  add(
    "works_undo",
    "Safely reverse one AI turn with optimistic version checks; later unrelated changes survive and conflicts leave source unchanged",
    workUndoRequestSchema,
    (args) => undo.undo(args),
  );
  add(
    "works_result",
    "Read this AI turn's exact before/after versions, file changes, verified checks and safe undo conditions",
    workResultRequestSchema,
    async ({ id, task: taskId }) => {
      const work = await works.get(id);
      const task = await db.one(
        "SELECT * FROM tasks WHERE id=$1 AND repo=$2 AND project=$3 AND kind IN ('agent','paseo')",
        [taskId, work.repo, work.project],
      );
      if (!task) throw problem(404, "创作结果不属于当前作品");
      const { before, after } = resultVersions(task);
      let current = null,
        revision = null,
        dirty = false,
        issue = null;
      let diff = { changes: [], total: 0, truncated: false };
      try {
        const { repo, dir } = await repos.project(work.repo, work.project);
        current = (await gitData(repo.root, ["rev-parse", "HEAD"])).trim();
        revision = await treeHash(dir);
        dirty = !!(
          await gitData(repo.root, [
            "status",
            "--porcelain",
            "--untracked-files=all",
          ])
        ).trim();
        if (before && after) {
          await versionTree(repos, work, before);
          await versionTree(repos, work, after);
          diff = await changesBetween(repo.root, work.project, before, after);
        }
      } catch (error) {
        issue = String(error.message);
      }
      const reversal = await db.one("SELECT * FROM work_undos WHERE task=$1", [
        task.id,
      ]);
      const blocking = await db.one(
        "SELECT id,state,kind FROM tasks WHERE repo=$1 AND project=$2 AND state IN ('queued','running','cancelling','publishing','publish_failed') ORDER BY created LIMIT 1",
        [work.repo, work.project],
      );
      const reason = work.deleted
        ? "请先恢复作品"
        : reversal?.state === "succeeded"
          ? "本次修改已撤销"
          : reversal
            ? null
            : issue ||
              (task.state !== "succeeded"
                ? "请先等待创作和结果保存完成"
                : !before || !after
                  ? "旧任务没有完整的修改前后版本记录"
                  : !diff.total
                    ? "本次没有作品文件变化"
                    : blocking && !reversal
                      ? "作品有正在执行或排队的任务"
                      : dirty && !reversal
                        ? "请先保存未提交修改"
                        : null);
      return {
        task: task.id,
        state: task.state,
        before,
        after,
        current,
        ...diff,
        execution: task.execution || null,
        reference: task.review_reference || null,
        requestedRange: reviewRange(task.input?.context),
        rangeMeaning: "user-request-not-proven-impact",
        validation: (task.result?.validation || []).filter(
          (value) => validationRecordSchema.safeParse(value).success,
        ),
        metrics: task.metrics || {},
        executorMetrics: task.result?.executorMetrics || null,
        buildMetrics: task.result?.buildMetrics || null,
        undo: {
          available: !reason,
          reason,
          expectedCommit: reversal?.expected_commit || current,
          expectedRevision: reversal?.expected_revision || revision,
          ...(reversal
            ? {
                requestKey: reversal.id,
                state: reversal.state,
                commit: reversal.commit,
                recovery: reversal.state !== "succeeded",
                error: reversal.error,
              }
            : {}),
        },
      };
    },
  );
  return undo;
}

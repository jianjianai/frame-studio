import fs from "node:fs";
import path from "node:path";
import { confined, problem } from "./security.mjs";
import { treeHash } from "./project-files.mjs";
import { applyProject } from "./apply-project.mjs";
import { fileSha256 } from "./project-files.mjs";

/** Durable publication is independent from worker/container lifetime. */
export class TaskPublication {
  constructor({ db, data, repos, get, finishCancellation, cleanup }) {
    Object.assign(this, { db, data, repos, get, finishCancellation, cleanup });
  }
  async retryPublication(id) {
    const task = await this.db.one(
      "UPDATE tasks SET state='publishing',error=NULL,monitor=NULL,publication_attempts=0,publication_retry_at=NULL WHERE id=$1 AND state='publish_failed' RETURNING *",
      [id],
    );
    if (!task) throw problem(409, "此任务没有等待恢复的发布结果");
    return task;
  }
  async publicationError(t, error) {
    await this.db.pool.query(
      "UPDATE tasks SET state=CASE WHEN publication_attempts+1>=3 THEN 'publish_failed' ELSE 'publishing' END,publication_attempts=publication_attempts+1,publication_retry_at=now()+interval '15 seconds',error=$2,expires=NULL,progress=$3 WHERE id=$1 AND state='publishing'",
      [
        t.id,
        "执行结果已保留，保存或发布尚未完成：" +
          String(error.message).slice(0, 2000),
        { stage: "等待恢复结果保存（不会重新执行任务）" },
      ],
    );
  }
  async complete(t, exit) {
    t = await this.get(t.id);
    if (
      ["cancelled", "succeeded", "failed", "publish_failed"].includes(t.state)
    )
      return;
    if (t.state === "cancelling") {
      await this.finishCancellation(t.id);
      return;
    }
    if (t.state !== "publishing") {
      let result;
      try {
        result = JSON.parse(
          fs.readFileSync(
            path.join(this.data, "runs", t.id, "result.json"),
            "utf8",
          ),
        );
        if (
          exit !== 0 ||
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          result.error ||
          result.status === "failed"
        )
          throw Error(result?.error || "Task failed; inspect task events");
      } catch (error) {
        throw Object.assign(error, { executionFailed: true });
      }
      const claimed = await this.db.one(
        "UPDATE tasks SET state='publishing',result=$2,expires=NULL,error=NULL,monitor=NULL,progress=$3,metrics=metrics||$4::jsonb WHERE id=$1 AND state='running' RETURNING *",
        [
          t.id,
          result,
          { stage: "正在保存可下载结果" },
          { publicationStartedAt: new Date().toISOString() },
        ],
      );
      if (!claimed) {
        const latest = await this.get(t.id);
        if (latest.state === "cancelling") await this.finishCancellation(t.id);
        return;
      }
      t = claimed;
    }
    // Publication is durable and re-entrant, independent of container lifetime.
    // A crash after replacing files or committing Git resumes the SAME result.
    try {
      await this.publish(t);
    } catch (error) {
      await this.publicationError(t, error);
    }
    await this.cleanup?.(await this.get(t.id));
  }
  async publish(t) {
    const run = path.join(this.data, "runs", t.id);
    let result = { ...t.result };
    if (t.repo && t.kind === "new")
      await this.db.lock(`${t.repo}:${t.project}`, async () => {
        const { dir } = await this.repos.project(t.repo, t.project, {
          exists: false,
        });
        const source = confined(run, "projects/" + t.project);
        const hashSource = treeHash;
        await this.beforeApply?.(t);
        // After a process restart, an already applied identical result is safe to finish publishing.
        await this.repos.revisions?.invalidate(t.repo, t.project);
        if ((await hashSource(dir)) !== (await hashSource(source)))
          await applyProject({
            source,
            destination: dir,
            run,
            id: t.id,
            fingerprint: t.fingerprint,
            hashTree: hashSource,
          });
        result.commit = await this.repos.checkpoint(
          t.repo,
          t.project,
          "创建作品",
        );
      });
    const artifacts = [];
    const base = path.join(run, "projects", t.project || "", "exports");
    const walk = async (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith(".") || /\.tmp(?:\.|$)/i.test(item.name)) continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await walk(file);
        else if (/\.(png|mp4|webm|wav|html|srt|json)$/.test(item.name))
          artifacts.push({
            name: path.relative(base, file).replaceAll("\\", "/"),
            path: path.relative(run, file).replaceAll("\\", "/"),
            bytes: fs.statSync(file).size,
            ...(t.kind === "render" ? { sha256: await fileSha256(file) } : {}),
          });
      }
    };
    await walk(base);
    if (t.kind === "render" && !artifacts.some(file => /\.mp4$/i.test(file.path) && file.bytes > 0))
      throw Error("导出执行结束但未找到可下载的成片，结果保存不能标记为完成。");
    result = {
      ...result,
      artifacts,
      sourceRevision: t.frozen?.sourceRevision || t.fingerprint || null,
      ...(t.frozen ? { frozenAt: t.frozen.acceptedAt, exportParameters: t.frozen.input } : {}),
      ...(t.kind === "build" && t.input.version
        ? { readonlyVersion: t.input.version }
        : {}),
    };
    if (t.repo && t.kind === "new") {
      await this.repos.onChange?.(t.repo, t.project);
      if (!this.repos.onChange) await this.repos.revisions?.refresh(t.repo, t.project);
    }
    await this.db.pool.query(
      "INSERT INTO events(task,kind,data,source_offset) VALUES($1,'result',$2,-1) ON CONFLICT DO NOTHING",
      [t.id, result],
    );
    await this.db.pool.query(
      "UPDATE tasks SET state='succeeded',result=$2,error=NULL,monitor=NULL,source_commit=COALESCE($3,source_commit),finished=now(),expires=now()+interval '7 days',publication_retry_at=NULL,metrics=metrics||$4::jsonb WHERE id=$1 AND state='publishing'",
      [
        t.id,
        result,
        result.commit || null,
        t.metrics?.publicationStartedAt
          ? {
              publicationMs: Math.max(
                0,
                Date.now() - new Date(t.metrics.publicationStartedAt).getTime(),
              ),
            }
          : {},
      ],
    );
  }
}

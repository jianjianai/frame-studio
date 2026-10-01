import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { confined, problem } from "./security.mjs";
import { treeHash } from "./project-files.mjs";
import { applyProject } from "./apply-project.mjs";
import { PREVIEW_VERSION } from "./preview-version.mjs";

/** Durable publication is independent from worker/container lifetime. */
export class TaskPublication {
  constructor({ db, data, repos, get, finishCancellation }) {
    Object.assign(this, { db, data, repos, get, finishCancellation });
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
        { stage: "等待恢复结果发布（不会重新执行 AI）" },
      ],
    );
    await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [t.id]);
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
      if (t.kind === "agent") result.previewTask = randomUUID();
      const claimed = await this.db.one(
        "UPDATE tasks SET state='publishing',result=$2,expires=NULL,error=NULL,monitor=NULL,progress=$3,metrics=metrics||$4::jsonb WHERE id=$1 AND state='running' RETURNING *",
        [
          t.id,
          result,
          { stage: "正在保存版本并发布预览" },
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
  }
  async publish(t) {
    const run = path.join(this.data, "runs", t.id);
    let result = { ...t.result };
    if (t.repo && ["agent", "new"].includes(t.kind))
      await this.db.lock(`${t.repo}:${t.project}`, async () => {
        const { dir } = await this.repos.project(t.repo, t.project, {
          exists: false,
        });
        const source = confined(run, "projects/" + t.project);
        // After a process restart, an already applied identical result is safe to finish publishing.
        await this.repos.revisions?.invalidate(t.repo, t.project);
        if ((await treeHash(dir)) !== (await treeHash(source)))
          await applyProject({
            source,
            destination: dir,
            run,
            id: t.id,
            fingerprint: t.fingerprint,
          });
        result.commit = await this.repos.checkpoint(
          t.repo,
          t.project,
          "AI · " + (t.input.prompt || "创建作品").slice(0, 120),
        );
      });
    if (t.chat && result.upstream)
      await this.db.pool.query(
        "UPDATE chats SET upstream=$2,upstream_execution=$3 WHERE id=$1",
        [t.chat, result.upstream, t.execution?.sessionKey || null],
      );
    const artifacts = [];
    const base = path.join(run, "projects", t.project || "", "exports");
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) walk(file);
        else if (/\.(png|mp4|webm|wav|html|srt|json)$/.test(item.name))
          artifacts.push({
            name: path.relative(base, file).replaceAll("\\", "/"),
            path: path.relative(run, file).replaceAll("\\", "/"),
            bytes: fs.statSync(file).size,
          });
      }
    };
    walk(base);
    result = {
      ...result,
      artifacts,
      ...(t.kind === "build" && t.input.version
        ? { readonlyVersion: t.input.version }
        : {}),
    };
    if (t.repo && t.kind === "agent") {
      await this.db.pool.query(
        "UPDATE works SET updated=now() WHERE repo=$1 AND project=$2",
        [t.repo, t.project],
      );
      // Source publication is observed by V8 live sessions. Retain compatibility
      // with already completed pre-V8 turns that carry immutable preview artifacts.
      if (result.previewArtifacts) {
        const preview = result.previewTask,
          previewRun = path.join(this.data, "runs", preview);
        fs.mkdirSync(previewRun, { recursive: true });
        const directories = new Set(
          result.previewArtifacts.map((a) => path.posix.dirname(a.path)),
        );
        for (const relative of directories) {
          if (!relative.startsWith(`projects/${t.project}/exports/`))
            throw new Error("Invalid preview output");
          await fs.promises.cp(
            confined(run, relative),
            confined(previewRun, relative),
            {
              recursive: true,
              filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
            },
          );
        }
        const { dir } = await this.repos.project(t.repo, t.project);
        await this.db.pool.query(
          "INSERT INTO tasks(id,repo,project,kind,state,input,result,fingerprint,source_commit,created,started,finished,expires) VALUES($1,$2,$3,'build','succeeded','{}',$4,$5,$6,now(),now(),now(),now()+interval '7 days') ON CONFLICT(id) DO NOTHING",
          [
            preview,
            t.repo,
            t.project,
            {
              previewVersion: result.previewVersion ?? PREVIEW_VERSION,
              runtime: result.runtime || null,
              runtimeFingerprint: result.runtimeFingerprint || null,
              artifacts: result.previewArtifacts,
            },
            await treeHash(dir),
            result.commit || t.source_commit,
          ],
        );
      } else if (result.previewMode !== "live") {
        // Compatibility for completed pre-V8 turns. V8 editing sessions already
        // observe source publication and must never enqueue a full audio build.
        await this.db.pool.query(
          "INSERT INTO tasks(id,repo,project,kind,input) VALUES($1,$2,$3,'build','{}') ON CONFLICT(id) DO NOTHING",
          [result.previewTask, t.repo, t.project],
        );
      }
      await this.repos.onChange?.(t.repo, t.project);
    }
    if (
      t.repo &&
      !t.input.version &&
      (["new", "build"].includes(t.kind) ||
        (t.kind === "agent" && !this.repos.onChange))
    )
      await this.repos.revisions?.refresh(t.repo, t.project);
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
    await this.db.pool.query("DELETE FROM agent_tokens WHERE task=$1", [t.id]);
  }
}

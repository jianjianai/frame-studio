import { acquireDatabaseClient } from "./scoped-pool.mjs";
import fs from "node:fs";
import path from "node:path";
import { confined, problem } from "./security.mjs";
import { validProjectId } from "../scripts/project-metadata.mjs";
import { operationError } from "../src/contracts/errors.mjs";

const purgeKey = (id) => "work-purge:" + id;
export const purgedWorkKey = (repo, project) =>
  `purged-work:${repo}:${project}`;

function ownedPath(data, folder, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw problem(409, "作品清理路径无效");
  const root = path.resolve(data, folder),
    target = path.resolve(root, id);
  if (
    path.dirname(target) !== root ||
    (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
  )
    throw problem(409, "作品清理路径不安全");
  return target;
}

export async function purgeWork(works, id, confirm) {
  const { db, repos, data, assets } = works,
    initial = await works.get(id);
  return db.lock(`${initial.repo}:${initial.project}`, async () => {
    const work = await works.get(id);
    if (!work.deleted) throw problem(409, "只有回收站中的作品可以永久删除");
    if (confirm !== work.title)
      throw problem(400, "请输入完整作品名称确认永久删除");
    if (
      !validProjectId(work.project) ||
      work.branch !== "works/" + work.project
    )
      throw problem(409, "作品分支信息异常，请先刷新仓库后重试");
    await repos.writable(work.repo, work.project, { purging: true });
    // Artifact admission shares the work lock, so no new reader can race this check.
    if (
      await db.one(
        "SELECT a.id FROM artifact_leases a JOIN tasks t ON t.id=a.task WHERE t.repo=$1 AND t.project=$2 AND a.expires>now() LIMIT 1",
        [work.repo, work.project],
      )
    )
      throw problem(409, "作品预览或导出正在读取，请关闭后重试");

    if (works.paseo) {
      await works.paseo.workspace.stop(id);
      // A deleted work cannot admit a new native session; its daemon is stopped by the controller.
      const native = await works.paseo.store.getWork(id);
      if (native?.container) throw problem(409, "Paseo 正在关闭此作品环境，请稍后重试永久删除。");
    }
    const repository = await repos.get(work.repo);
    if (work.branch === repository.branch)
      throw problem(409, "作品分支不能是仓库主分支，请先修复分支配置");
    const target = ownedPath(data, "works", id);
    const tasks = await db.all(
      "SELECT id FROM tasks WHERE repo=$1 AND project=$2",
      [work.repo, work.project],
    );
    const versions = await db.all(
      "SELECT id FROM work_versions WHERE work=$1",
      [id],
    );
    const undos = await db.all("SELECT id FROM work_undos WHERE work=$1", [id]);
    const folders = [
      ...tasks.flatMap(({ id }) => [
        ownedPath(data, "runs", id),
        ownedPath(data, "sessions", id),
      ]),
      ...(works.paseo ? [ownedPath(data, "paseo", id)] : []),
      ...versions.map(({ id }) => ownedPath(data, "versions", id)),
      ...undos.map(({ id }) => path.join(data, "restores", "undo-" + id)),
    ];
    const legacy = confined(repository.root, "projects/" + work.project);
    const ref = "refs/heads/" + work.branch;
    await db.lock("git-layout:" + work.repo, async () => {
      if (repository.url) {
        try {
          const remote = await repos.git(
            repository.root,
            ["ls-remote", "--refs", "origin", ref],
            true,
          );
          const sha = remote
            .split("\n")
            .map((line) => line.split(/\s+/))
            .find((parts) => parts[1] === ref)?.[0];
          if (sha) {
            if (!/^[a-f0-9]{40,64}$/.test(sha))
              throw Error("Invalid remote revision");
            await repos.git(
              repository.root,
              [
                "push",
                "--porcelain",
                "--force-with-lease=" + ref + ":" + sha,
                "origin",
                ":" + ref,
              ],
              true,
            );
          }
        } catch {
          throw Object.assign(
            problem(
              502,
              "远端作品分支删除失败，请检查网络、GitHub 登录或分支保护后重试；作品仍在回收站",
            ),
            {
              expose: true,
              code: "WORK_REMOTE_DELETE_FAILED",
              recovery: "retry-purge",
              retryable: true,
            },
          );
        }
      }
      // A failed local cleanup is resumable; restoration and new writes remain blocked.
      await db.setting(purgeKey(id), {
        repo: work.repo,
        project: work.project,
      });
      const layout = await repos.git(repository.root, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      if (layout.split("\0").includes("worktree " + target))
        await repos.git(repository.root, [
          "worktree",
          "remove",
          "--force",
          "--",
          target,
        ]);
      else await fs.promises.rm(target, { recursive: true, force: true });
      const local = await repos.git(repository.root, [
        "for-each-ref",
        "--format=%(refname)",
        ref,
      ]);
      if (local.split("\n").includes(ref))
        await repos.git(repository.root, ["branch", "-D", "--", work.branch]);
      await repos.git(repository.root, [
        "update-ref",
        "-d",
        "refs/remotes/origin/" + work.branch,
      ]);
      for (const folder of [...folders, legacy])
        await fs.promises.rm(folder, { recursive: true, force: true });
      await fs.promises.rm(path.join(data, "metadata-recovery", id + ".json"), {
        force: true,
      });

      const client = await acquireDatabaseClient(db);
      let broken = false;
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM work_undos WHERE work=$1", [id]);
        await client.query("DELETE FROM work_versions WHERE work=$1", [id]);
        for (const task of tasks) {
          await client.query("DELETE FROM events WHERE task=$1", [task.id]);
          await client.query(
            "DELETE FROM settings WHERE (key LIKE 'preview:%' OR key LIKE 'preview-link:%') AND value->>'task'=$1",
            [task.id],
          );
        }
        await client.query("DELETE FROM tasks WHERE repo=$1 AND project=$2", [
          work.repo,
          work.project,
        ]);
        await client.query(
          "DELETE FROM asset_refs WHERE repo=$1 AND project=$2",
          [work.repo, work.project],
        );
        // Legacy content may still exist in the repository's main history. Never rediscover it.
        await client.query(
          "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
          [
            purgedWorkKey(work.repo, work.project),
            { branch: work.branch, purged: new Date().toISOString() },
          ],
        );
        await client.query("DELETE FROM works WHERE id=$1 AND deleted=true", [
          id,
        ]);
        await client.query("DELETE FROM settings WHERE key=$1", [purgeKey(id)]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        throw error;
      } finally {
        client.release(broken);
      }
    });
    assets.invalidateReferences(work.repo, work.project);
    return {
      ok: true,
      id,
      branch: work.branch,
      remoteDeleted: !!repository.url,
    };
  });
}

export async function purgeTrash(works, repo, confirm) {
  if (confirm !== "清空回收站") throw problem(400, "请输入“清空回收站”确认");
  if (repo) await works.repos.get(repo);
  const rows = await works.db.all(
    "SELECT id,title FROM works WHERE deleted=true AND ($1::uuid IS NULL OR repo=$1) ORDER BY updated,id",
    [repo || null],
  );
  const purged = [],
    failed = [];
  for (const work of rows) {
    try {
      purged.push(await purgeWork(works, work.id, work.title));
    } catch (error) {
      failed.push({
        id: work.id,
        title: work.title,
        error: operationError(error).error,
      });
    }
  }
  return { ok: failed.length === 0, total: rows.length, purged, failed };
}

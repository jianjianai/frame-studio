/** Read bounded queue explanations from authoritative task/controller state. No speculative percentage or completion estimate. */
export async function workQueueStatus({
  db,
  works,
  tasks,
  id,
  now = Date.now(),
}) {
  const work = await works.get(id);
  const rows = await db.all(
    `SELECT t.id,t.created,
    (SELECT jsonb_build_object('id',r.id,'kind',r.kind,'state',r.state,'sameWork',r.repo=t.repo AND r.project=t.project)
      FROM tasks r WHERE r.id<>t.id AND
      r.repo=t.repo AND r.project=t.project AND r.state IN ('running','cancelling','publishing','publish_failed')
      AND r.kind<>'validate' AND NOT (r.kind='render' AND r.frozen IS NOT NULL) AND t.frozen IS NULL
      ORDER BY r.created LIMIT 1) AS blocker,
    (SELECT count(*)::int FROM tasks q WHERE q.repo=t.repo AND q.project=t.project AND q.state='queued' AND (q.created,q.id)<(t.created,t.id)) AS ahead
    FROM tasks t WHERE t.repo=$1 AND t.project=$2 AND t.state='queued' ORDER BY t.created,t.id LIMIT 100`,
    [work.repo, work.project],
  );
  const runtime = await db.setting("controller-runtime");
  const controllerReady = db.kind === "sqlite" || (
    !!runtime?.leader &&
    !!runtime?.docker?.ok &&
    now - Number(runtime.checked) >= 0 &&
    now - Number(runtime.checked) < 45000);
  const concurrency = Math.max(
    1,
    Math.min(
      64,
      Number(runtime?.limits?.concurrency ?? tasks.limits?.concurrency) || 2,
    ),
  );
  const running = (
    await db.one(
      "SELECT count(*)::int AS n FROM tasks WHERE state IN ('running','cancelling')",
    )
  ).n;
  return {
    now: new Date(now).toISOString(),
    controllerReady,
    concurrency,
    items: rows.map((row) => {
      let code, reason;
      if (row.blocker) {
        code = "work-busy";
        reason =
          row.blocker.state === "publish_failed"
            ? "前一项任务等待恢复保存"
            : "等待这个作品的前一项任务完成";

      } else if (row.ahead > 0) {
        code = "work-queue";
        reason = `此作品前面还有 ${row.ahead} 项排队任务`;
      } else if (!controllerReady) {
        code = "controller-unavailable";
        reason = "调度器心跳尚未就绪；请求已保存，不需要重复发送";
      } else if (runtime?.queueBlocked) {
        code = "resource-blocked";
        reason = String(runtime.queueBlocked).slice(0, 1000);
      } else if (running >= concurrency) {
        code = "capacity";
        reason = `执行槽位已占用（${running}/${concurrency}），等待正在运行的任务结束`;
      } else {
        code = "waiting-claim";
        reason = "请求已保存，等待调度器领取";
      }
      return {
        id: row.id,
        code,
        reason,
        ahead: row.ahead,
        blocker: row.blocker || null,
        queuedMs: Math.max(0, now - new Date(row.created).getTime()),
      };
    }),
  };
}

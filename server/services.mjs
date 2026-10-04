import fs from "node:fs";
import path from "node:path";
import { database } from "./db.mjs";
import { vault } from "./security.mjs";
import { Repositories } from "./repositories.mjs";
import { Assets } from "./assets.mjs";
import { Tasks } from "./tasks.mjs";
import { operations } from "./operations.mjs";
import { GitHubAuthorization } from "./github-authorization.mjs";
import { GitHub } from "./github.mjs";
import { Retention } from "./retention.mjs";
import { seedSpeech } from "./speech.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { LivePreviewSessions } from "./live-preview.mjs";
import { AiStore } from "./ai-store.mjs";
import { AiWork } from "./ai-work.mjs";
import { AiManager } from "./ai-manager.mjs";
import { AiWorkspace } from "./ai-workspace.mjs";
import { AiValidation } from "./ai-validation.mjs";

/** Shared domain assembly, without HTTP listeners or a privileged scheduler. */
export async function createServices({
  db,
  data = process.env.FRAME_DATA || "/data",
  masterKey = process.env.FRAME_MASTER_KEY,
  initialize = true,
} = {}) {
  if (process.env.HOME?.startsWith("/tmp/"))
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(data, "tools"), { recursive: true });
  db ||= await database(
    process.env.DATABASE_URL,
    process.env.FRAME_ADMIN_PASSWORD,
  );
  await runtimeIdentity(); // Warm once, never hash platform code for each preview subscription.
  const secrets = vault(masterKey),
    repos = new Repositories(db, data, secrets),
    assets = new Assets(db, data, repos),
    tasks = new Tasks(db, data, repos, secrets);
  const github = new GitHub(db, secrets, repos, data),
    retention = new Retention(db, data);
  const livePreview = new LivePreviewSessions({ db, data, repos });
  const githubAuth = new GitHubAuthorization({ db, data, github });
  const actions = operations({
    db,
    data,
    repos,
    assets,
    tasks,
    secrets,
    githubAuth,
    github,
    retention,
    livePreview,
  });
  const aiStore = await new AiStore({ db }).initialize();
  const aiWork = new AiWork({ db, data, repos, works: actions.works, livePreview, store: aiStore });
  const aiManager = new AiManager({ db, data, tasks, store: aiStore, workService: aiWork });
  aiWork.manager = aiManager;
  aiWork.authorizeThread = (work, threadId, options) => aiManager.thread(work.id, threadId, { ...options, allowDraft: true });
  const aiValidation = new AiValidation({ db, data, repos, works: actions.works, tasks, manager: aiManager, store: aiStore });
  const aiWorkspace = new AiWorkspace({ db, data, works: actions.works, repos, store: aiStore, manager: aiManager,
    concurrency: tasks.limits.concurrency,
    validate: (report, options) => aiValidation.validate(report, options),
    onChange: async workId => {
      const work = await actions.works.get(workId, { active: true });
      await repos.revisions?.refresh(work.repo, work.project);
      assets.invalidateReferences(work.repo, work.project);
    },
    onError: (_workId, error) => console.error("Ai workspace:", error.message),
  });
  tasks.externalActivity = options => aiManager.active(options);
  repos.nativeActivity = async (repo, project) => (await aiManager.active({ repo, project })).length > 0;
  actions.works.ai = { manager: aiManager, workspace: aiWorkspace, store: aiStore, work: aiWork };
  tasks.validateWorkspace = async (task, options = {}) => {
    const work = await db.one("SELECT id FROM works WHERE repo=$1 AND project=$2 AND NOT deleted", [task.repo, task.project]);
    if (!work) throw Object.assign(Error("作品已不存在，请刷新作品列表"), { statusCode: 404 });
    const report = await aiWorkspace.request(work.id, { ...options, wait: false });
    await options.onReport?.(report);
    return options.wait === false ? report : aiWorkspace.request(work.id, { ...options, reportId: report.id, wait: true });
  };
  aiManager.onReconcile = async workId => {
    if (!aiWorkspace.entries.has(workId)) await aiWorkspace.start(workId);
  };
  aiManager.onStopped = workId => aiWorkspace.stop(workId);
  aiManager.onNativeEvent = (workId, event) => {
    if (event.type === "thread.ended") void aiWorkspace.reconcile(workId, { force: true }).catch(() => {});
  };
  aiManager.onActivityError = error => console.error("Ai activity:", error.message);
  if (db.kind !== "sqlite") aiManager.on("activity", change => {
    void db.pool.query("SELECT pg_notify('frame_changes',$1)", [JSON.stringify(change)])
      .catch(aiManager.onActivityError);
  });
  let aiTimer;
  const startAiLoop = () => {
    if (aiTimer) return;
    aiTimer = setInterval(() => {
      if (tasks.lease?.held || process.env.FRAME_LOCAL_MODE === "1") void aiManager.tick().catch(error => console.error("Ai controller:", error.message));
    }, 5000);
    aiTimer.unref();
  };
  repos.onChange = async (id, project = null) => {
    if (!project) await assets.indexRepository(id);
    await actions.works.discover(id, project);
    assets.invalidateReferences(id, project);
  };
  if (initialize) {
    await aiManager.control();
    await github.migrate();
    await assets.migrate();
    await actions.works.discover();
    await db.pool.query(
      "UPDATE tasks SET expires=finished+interval '7 days' WHERE finished IS NOT NULL AND expires IS NULL",
    );
    await seedSpeech(db, secrets);
  } else {
    actions.works.discovered = true;
  }
  return {
    db,
    data,
    secrets,
    repos,
    assets,
    tasks,
    githubAuth,
    github,
    retention,
    actions,
    livePreview,
    aiStore, aiWork, aiManager, aiWorkspace, aiValidation, startAiLoop,
    async close() {
      clearInterval(aiTimer);
      await aiWorkspace.close();
      await aiManager.close();
      await livePreview.close();
      await tasks.close();
      await retention.close();
      await assets.close();
      githubAuth.close();
      await db.pool.end();
    },
  };
}
